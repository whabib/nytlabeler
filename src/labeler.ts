import { LabelerServer } from '@skyware/labeler';
import fs from 'node:fs';
import path from 'node:path';
import { DID, SIGNING_KEY, DRY_RUN } from './config.js';
import { getActiveAuthors, slugify, syncLabelToPostgres, fetchLabelsFromPostgres, LabelRecord } from './database.js';

// Define matching types
export interface IssuedLabelLog {
  id: string;
  uri: string;
  authorDid: string;
  text: string;
  labels: string[];
  title: string | null;
  timestamp: string;
}

// Memory logs and statistics for the dashboard
export const recentLabels: IssuedLabelLog[] = [];
export const stats = {
  postsProcessed: 0,
  nytLinksDetected: 0,
  labelsEmitted: 0,
  startTime: new Date().toISOString(),
  firehoseConnected: false,
  lastEventTime: null as string | null,
  reconnectCount: 0,
  activeEndpoint: '',
  firehoseEnabled: true,
};

// Set of active opinion author slugs to filter which author labels we publish
export let activeAuthorSlugsSet = new Set<string>();

/**
 * Initializes the active authors list from the database.
 * This runs on startup and can be refreshed manually.
 */
export async function loadActiveAuthors() {
  console.log('🔄 Loading active opinion authors from PostgreSQL...');
  try {
    const authors = await getActiveAuthors();
    const slugs = authors.map((auth) => slugify(auth.name));
    activeAuthorSlugsSet = new Set(slugs);
    console.log(`✅ Loaded ${activeAuthorSlugsSet.size} active authors:`, Array.from(activeAuthorSlugsSet));
  } catch (error) {
    console.error('⚠️ Failed to load active authors from DB, falling back to empty set.', error);
    activeAuthorSlugsSet = new Set();
  }
}

// Standard LabelerServer initialization
export let labelerServer: LabelerServer | null = null;

if (!DRY_RUN && DID && SIGNING_KEY) {
  try {
    let dbPath = './labels.db';

    // In Cloud Run (production/development serverless containers), the workspace root is read-only.
    // We copy the bundled labels.db to the writable /tmp directory if running on Cloud Run.
    if (process.env.K_SERVICE) {
      dbPath = '/tmp/labels.db';
      try {
        const srcDb = path.resolve(process.cwd(), 'labels.db');
        if (fs.existsSync(srcDb)) {
          console.log(`📦 Cloud Run detected: Copying bundled database from ${srcDb} to ${dbPath}...`);
          fs.copyFileSync(srcDb, dbPath);
          
          // Also copy WAL files if they exist in workspace to ensure DB integrity
          const srcShm = srcDb + '-shm';
          const srcWal = srcDb + '-wal';
          if (fs.existsSync(srcShm)) fs.copyFileSync(srcShm, dbPath + '-shm');
          if (fs.existsSync(srcWal)) fs.copyFileSync(srcWal, dbPath + '-wal');
          
          console.log(`✅ Successfully copied database files to /tmp`);
        } else {
          console.log(`ℹ️ No bundled database found at ${srcDb}. A new SQLite database will be initialized at ${dbPath}`);
        }
      } catch (err) {
        console.error('❌ Failed to copy bundled database to /tmp:', err);
      }
    }

    console.log(`🔑 Initializing LabelerServer for DID: ${DID} using dbPath: ${dbPath}`);
    labelerServer = new LabelerServer({
      did: DID,
      signingKey: SIGNING_KEY,
      dbPath: dbPath,
    });
  } catch (err) {
    console.error('❌ Failed to initialize LabelerServer:', err);
  }
} else {
  console.log('ℹ️ Running in Dry Run / Mock Labeler mode. No label server initialized.');
}

export let localMaxId = 0;

// Rehydration gate promise and resolver to hold incoming cursor requests on startup
let resolveRehydration: () => void = () => {};
export let rehydrationComplete = Promise.resolve();

/**
 * Initializes/arms the startup rehydration gate.
 */
export function initRehydrationGate(): void {
  console.log('🔌 [REHYDRATE GATE] Arming startup rehydration gate...');
  rehydrationComplete = new Promise<void>((resolve) => {
    resolveRehydration = resolve;
  });
}

/**
 * Sets the localMaxId sequence cache value. Useful for unit testing.
 */
export function setLocalMaxId(val: number): void {
  localMaxId = val;
  console.log(`🔌 [SEQ CACHE] Manually set localMaxId to ${val}`);
}

/**
 * Rehydrates the local SQLite database from the environment-aware PostgreSQL DB upon startup.
 */
export async function rehydrateDatabase(): Promise<void> {
  if (!labelerServer) {
    console.log('ℹ️ No local LabelerServer initialized. Skipping SQLite database rehydration.');
    return;
  }

  try {
    console.log('🔋 [REHYDRATE] Fetching historical labels from PostgreSQL...');
    const pgLabels = await fetchLabelsFromPostgres();
    if (pgLabels.length === 0) {
      console.log('🔋 [REHYDRATE] No historical labels found in PostgreSQL for this environment.');
    } else {
      console.log(`🔋 [REHYDRATE] Found ${pgLabels.length} historical labels in PostgreSQL. Syncing into local SQLite...`);
      
      // We execute the inserts in a loop using labelerServer.db.execute.
      // "INSERT OR IGNORE" ensures that we don't crash or create duplicates if some records already exist.
      let syncedCount = 0;
      for (const label of pgLabels) {
        await labelerServer.db.execute({
          sql: `
            INSERT OR IGNORE INTO labels (id, src, uri, cid, val, neg, cts, exp, sig)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            label.id,
            label.src,
            label.uri,
            label.cid,
            label.val,
            label.neg ? 1 : 0,
            label.cts,
            label.exp,
            label.sig,
          ],
        });
        syncedCount++;
      }

      console.log(`✅ [REHYDRATE] Successfully synced ${syncedCount} labels into the local SQLite database!`);
    }
  } catch (err) {
    console.error('❌ Failed to rehydrate SQLite database from PostgreSQL:', err);
  } finally {
    // Initialize localMaxId from SQLite regardless of whether rehydration succeeded/ran
    try {
      const latest = await labelerServer.db.execute({
        sql: 'SELECT MAX(id) AS id FROM labels',
        args: [],
      });
      const maxId = Number(latest.rows[0]?.id || 0);
      localMaxId = maxId;
      console.log(`🔋 [REHYDRATE] Initialized localMaxId in-memory sequence cache to ${localMaxId}`);
    } catch (dbErr) {
      console.error('❌ Failed to initialize localMaxId from SQLite:', dbErr);
    }
    // Resolve the rehydration gate so waiting cursor queries can proceed
    resolveRehydration();
  }
}
let seqSyncPromise: Promise<void> | null = null;

/**
 * Ensures that the local SQLite database has a sequence number at least as large as the requested cursor.
 * This prevents @skyware/labeler from throwing a FutureCursor error and disconnecting the client.
 */
export async function ensureDatabaseSequence(cursor: number): Promise<void> {
  if (!labelerServer) return;
  if (Number.isNaN(cursor) || cursor <= 0) return;

  // Wait for database rehydration to finish before proceeding
  await rehydrationComplete;

  // Fast-path sequence cache: exit instantly (0ms) without any database queries or locks
  if (cursor <= localMaxId) {
    return;
  }

  // Wait for any active sync/padding promise to complete before proceeding
  while (seqSyncPromise) {
    await seqSyncPromise;
  }

  // Double check again in case a concurrent call completed and updated localMaxId
  if (cursor <= localMaxId) {
    return;
  }

  // Set up a new sequence synchronization promise immediately (synchronously) to lock the door
  let resolveSync: () => void = () => {};
  seqSyncPromise = new Promise<void>((resolve) => {
    resolveSync = resolve;
  });

  try {
    const latest = await labelerServer.db.execute({
      sql: 'SELECT MAX(id) AS id FROM labels',
      args: [],
    });
    const maxId = Number(latest.rows[0]?.id || 0);

    if (maxId > localMaxId) {
      localMaxId = maxId;
    }

    if (cursor <= maxId) {
      return;
    }

    console.log(`🔌 [SEQ SYNC] Requested cursor ${cursor} is larger than database max ID ${maxId} (localMaxId is ${localMaxId}). Padding database sequence...`);
    const syncPromises: Promise<void>[] = [];
    
    for (let id = maxId + 1; id <= cursor; id++) {
      const dummyUri = `at://${DID || 'did:plc:dummy'}/app.bsky.feed.post/dummy-${id}`;
      const dummyVal = 'dummy-sequence-pad';

      // Publish via LabelerServer so that a valid cryptographic signature (sig) is generated automatically
      await labelerServer.createLabel({
        uri: dummyUri,
        val: dummyVal,
        neg: false,
      });

      // Query the newly inserted row to fetch its sequence ID and signature
      const res = await labelerServer.db.execute({
        sql: 'SELECT * FROM labels WHERE uri = ? AND val = ? ORDER BY id DESC LIMIT 1',
        args: [dummyUri, dummyVal],
      });

      if (res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        // Fire off PostgreSQL synchronization asynchronously (parallelizing network requests)
        const syncPromise = syncLabelToPostgres({
          id: Number(row.id),
          src: String(row.src),
          uri: String(row.uri),
          cid: row.cid ? String(row.cid) : null,
          val: String(row.val),
          neg: Boolean(row.neg),
          cts: String(row.cts),
          exp: row.exp ? String(row.exp) : null,
          sig: row.sig ? (Buffer.isBuffer(row.sig) ? row.sig : Buffer.from(row.sig as any)) : null,
        }).catch((err) => {
          console.error(`❌ Background PostgreSQL sync failed for padded label ${row.id}:`, err);
        });
        syncPromises.push(syncPromise);
      }
    }

    // Await all PostgreSQL inserts to complete concurrently (minimizing network loop wait time)
    if (syncPromises.length > 0) {
      await Promise.all(syncPromises);
    }

    // Update in-memory sequence cache after successful padding
    if (cursor > localMaxId) {
      localMaxId = cursor;
    }
    console.log(`🔌 [SEQ SYNC] Successfully padded and synchronized database sequence up to ${cursor}`);
  } catch (err) {
    console.error('❌ Failed to ensure database sequence:', err);
  } finally {
    // Release lock and notify waiting callers
    seqSyncPromise = null;
    resolveSync();
  }
}

/**
 * Emits labels for an ATProto record.
 * @param uri The ATProto URI of the post, e.g. at://did:plc:xxx/app.bsky.feed.post/yyy
 * @param authorDid The DID of the post's author
 * @param postText The text content of the post
 * @param metadata The article metadata parsed from the database
 */
export async function issueLabelsForPost(
  uri: string,
  authorDid: string,
  postText: string,
  metadata: {
    section: string;
    subsection: string | null;
    authors: string[];
    title: string | null;
  }
) {
  const labelTokens: string[] = [];

  // 1. Add section label (simplified, no prefix, lowercase kebab-case)
  if (metadata.section) {
    labelTokens.push(slugify(metadata.section));
  }

  // 2. Add subsection label (simplified, no prefix, lowercase kebab-case)
  if (metadata.subsection && metadata.subsection.trim() !== '') {
    labelTokens.push(slugify(metadata.subsection));
  }

  // 3. Add author labels if they are in the active/published author scope
  for (const author of metadata.authors) {
    const slug = slugify(author);
    if (activeAuthorSlugsSet.has(slug)) {
      labelTokens.push(slug);
    }
  }

  if (labelTokens.length === 0) {
    return;
  }

  stats.labelsEmitted += labelTokens.length;

  // Log to recent labels for dashboard
  const logEntry: IssuedLabelLog = {
    id: Math.random().toString(36).substring(2, 9),
    uri,
    authorDid,
    text: postText,
    labels: labelTokens,
    title: metadata.title,
    timestamp: new Date().toISOString(),
  };

  recentLabels.unshift(logEntry);
  if (recentLabels.length > 500) {
    recentLabels.pop();
  }

  // Broadcast to Web Dashboard if server hook exists
  if (global.broadcastLog) {
    global.broadcastLog(logEntry);
  }

  console.log(`🏷️ Labeling post ${uri} with tokens: [${labelTokens.join(', ')}]`);

  // Actually publish labels if we are not in dry-run mode and server is available
  if (labelerServer && !DRY_RUN) {
    try {
      for (const token of labelTokens) {
        await labelerServer.createLabel({
          uri: uri,
          val: token,
          neg: false,
        });

        // Fetch the newly inserted row from SQLite to get the sequence id and signature
        const res = await labelerServer.db.execute({
          sql: 'SELECT * FROM labels WHERE uri = ? AND val = ? ORDER BY id DESC LIMIT 1',
          args: [uri, token],
        });

        if (res.rows && res.rows.length > 0) {
          const row = res.rows[0];
          const newId = Number(row.id);
          if (newId > localMaxId) {
            localMaxId = newId;
          }
          await syncLabelToPostgres({
            id: Number(row.id),
            src: String(row.src),
            uri: String(row.uri),
            cid: row.cid ? String(row.cid) : null,
            val: String(row.val),
            neg: Boolean(row.neg),
            cts: String(row.cts),
            exp: row.exp ? String(row.exp) : null,
            sig: row.sig ? (Buffer.isBuffer(row.sig) ? row.sig : Buffer.from(row.sig as any)) : null,
          });
          console.log(`🔋 [DOUBLE-WRITE] Synced label ${row.id} to PostgreSQL for token: ${token}`);
        }
      }
      console.log(`✅ Successfully published and synchronized labels to ATProto/PostgreSQL for: ${uri}`);
    } catch (error) {
      console.error(`❌ Failed to publish and sync labels to ATProto/PostgreSQL for ${uri}:`, error);
    }
  } else {
    console.log(`[DRY RUN] Would publish labels: ${JSON.stringify(labelTokens)} for URI: ${uri}`);
  }
}

// Global broadcast function type declaration
declare global {
  var broadcastLog: ((log: IssuedLabelLog) => void) | undefined;
}

/**
 * Sets the LabelerServer instance. Useful for unit testing and mocking.
 */
export function setLabelerServer(server: any) {
  labelerServer = server;
}
