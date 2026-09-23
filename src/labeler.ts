import { fromBytes } from '@atcute/cbor';
import { LabelerServer } from 'labeler';
import { DID, SIGNING_KEY, DRY_RUN, ENV } from './config.js';
import { pool, getActiveAuthors, slugify, syncLabelToPostgres } from './database.js';
import { migrateLegacyLabels, parseSigningKey } from './migrate-labels.js';

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
  /** Whether this instance holds firehose leadership (only the leader connects). */
  firehoseLeader: false,
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

/** Postgres table the LabelerServer stores labels in, one per environment. */
export const LABELS_TABLE = `labeler.labels_${ENV.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

// Standard LabelerServer initialization
export let labelerServer: LabelerServer | null = null;

if (!DRY_RUN && DID && SIGNING_KEY) {
  try {
    console.log(`🔑 Initializing LabelerServer for DID: ${DID} using Postgres table ${LABELS_TABLE}`);
    labelerServer = new LabelerServer({
      did: DID,
      signingKey: SIGNING_KEY,
      postgres: { pool, table: LABELS_TABLE },
    });
  } catch (err) {
    console.error('❌ Failed to initialize LabelerServer:', err);
  }
} else {
  console.log('ℹ️ Running in Dry Run / Mock Labeler mode. No label server initialized.');
}

// Gate that holds labeler requests until the label table is ready (and migrated) on startup,
// so subscribers don't see an empty table and get a FutureCursor error.
let resolveLabelStoreReady: () => void = () => {};
export let labelStoreReady = Promise.resolve();

/**
 * Arms the startup gate. Call before the web server starts accepting connections.
 */
export function initLabelStoreGate(): void {
  labelStoreReady = new Promise<void>((resolve) => {
    resolveLabelStoreReady = resolve;
  });
}

/**
 * Waits for the label table to exist, copies the legacy "_Labels" history into it on first
 * run, then opens the startup gate. Throws if the migration fails its signature check; the
 * gate then stays closed (the process exits).
 */
export async function prepareLabelStore(): Promise<void> {
  if (labelerServer) {
    await labelerServer.ready();

    console.log(`🔋 [MIGRATE] Checking whether ${LABELS_TABLE} needs the legacy label history...`);
    const result = await migrateLegacyLabels(pool, {
      targetTable: LABELS_TABLE,
      environment: ENV,
      signingKey: parseSigningKey(SIGNING_KEY),
    });
    if (result.skipped === 'target-not-empty') {
      console.log(`🔋 [MIGRATE] ${LABELS_TABLE} already has labels; nothing to migrate.`);
    } else if (result.skipped === 'no-legacy-table') {
      console.log('🔋 [MIGRATE] No legacy "_Labels" table found; starting with an empty label table.');
    } else {
      console.log(
        `✅ [MIGRATE] Copied ${result.migrated} labels from "_Labels" into ${LABELS_TABLE} ` +
          `(${result.checkedSignatures} signatures re-checked).`,
      );
    }
  } else {
    console.log('ℹ️ No LabelerServer initialized. Skipping label store preparation.');
  }
  resolveLabelStoreReady();
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

  // Publish labels if a server is available (it's only created outside dry-run mode)
  const server = labelerServer;
  if (server) {
    try {
      // Don't write labels until the startup migration has finished: a label in the empty
      // table (e.g. from a dashboard firehose toggle) would make the migration skip.
      await labelStoreReady;

      for (const token of labelTokens) {
        const saved = await server.createLabel({
          uri: uri,
          val: token,
          neg: false,
        });

        // Keep the legacy "_Labels" table in sync for one release, so rolling back to the
        // previous (SQLite) version doesn't lose labels.
        await syncLabelToPostgres({
          id: saved.id,
          src: saved.src,
          uri: saved.uri,
          cid: saved.cid ?? null,
          val: saved.val,
          neg: Boolean(saved.neg),
          cts: saved.cts,
          exp: saved.exp ?? null,
          sig: Buffer.from(fromBytes(saved.sig)),
        });
        console.log(`🔋 [LEGACY SYNC] Copied label ${saved.id} to "_Labels" for token: ${token}`);
      }
      console.log(`✅ Successfully published labels for: ${uri}`);
    } catch (error) {
      console.error('❌ Failed to publish labels for %s:', uri, error);
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
