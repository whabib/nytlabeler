import { LabelerServer } from '@skyware/labeler';
import fs from 'node:fs';
import path from 'node:path';
import { DID, SIGNING_KEY, DRY_RUN } from './config.js';
import { getActiveAuthors, slugify } from './database.js';

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

/**
 * Ensures that the local SQLite database has a sequence number at least as large as the requested cursor.
 * This prevents @skyware/labeler from throwing a FutureCursor error and disconnecting the client.
 */
export async function ensureDatabaseSequence(cursor: number): Promise<void> {
  if (!labelerServer) return;
  if (Number.isNaN(cursor) || cursor <= 0) return;

  try {
    const latest = await labelerServer.db.execute({
      sql: 'SELECT MAX(id) AS id FROM labels',
      args: [],
    });
    const maxId = Number(latest.rows[0]?.id || 0);

    if (cursor > maxId) {
      console.log(`🔌 [SEQ SYNC] Requested cursor ${cursor} is larger than database max ID ${maxId}. Padding database sequence...`);
      
      for (let id = maxId + 1; id <= cursor; id++) {
        await labelerServer.db.execute({
          sql: 'INSERT INTO labels (id, src, uri, val, cts) VALUES (?, ?, ?, ?, ?)',
          args: [
            id,
            DID || 'did:plc:dummy',
            `at://${DID || 'did:plc:dummy'}/app.bsky.feed.post/dummy-${id}`,
            'dummy-sequence-pad',
            new Date().toISOString(),
          ],
        });
      }
      console.log(`🔌 [SEQ SYNC] Successfully padded database sequence up to ${cursor}`);
    }
  } catch (err) {
    console.error('❌ Failed to ensure database sequence:', err);
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
      }
      console.log(`✅ Successfully published labels to ATProto for: ${uri}`);
    } catch (error) {
      console.error(`❌ Failed to publish labels to ATProto for ${uri}:`, error);
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
