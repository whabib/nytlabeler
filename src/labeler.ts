import { LabelerServer } from 'labeler';
import { DID, SIGNING_KEY, DRY_RUN, ENV } from './config.js';
import { pool, getActiveAuthors, slugify } from './database.js';

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

// Gate that holds labeler requests until the label table is ready on startup.
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
 * Waits for the LabelerServer to create its label table, then opens the startup gate.
 * Throws if the table can't be created; the gate then stays closed (the process exits).
 */
export async function prepareLabelStore(): Promise<void> {
  if (labelerServer) {
    await labelerServer.ready();
    console.log(`✅ Label table ${LABELS_TABLE} is ready.`);
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
export interface ArticleMetadata {
  section: string;
  subsection: string | null;
  authors: string[];
  title: string | null;
}

/**
 * Issues labels for a post linking one or more NYT articles. Each label value is issued at
 * most once per post, even when several links point to the same or overlapping articles.
 */
export async function issueLabelsForPost(
  uri: string,
  authorDid: string,
  postText: string,
  articles: ArticleMetadata[],
) {
  const labelTokens: string[] = [];
  const addToken = (token: string) => {
    if (token && !labelTokens.includes(token)) labelTokens.push(token);
  };

  // Strict order across all linked articles: sections, then subsections, then authors
  // 1. Add section labels (simplified, no prefix, lowercase kebab-case)
  for (const metadata of articles) {
    if (metadata.section) {
      addToken(slugify(metadata.section));
    }
  }

  // 2. Add subsection labels (simplified, no prefix, lowercase kebab-case)
  for (const metadata of articles) {
    if (metadata.subsection && metadata.subsection.trim() !== '') {
      addToken(slugify(metadata.subsection));
    }
  }

  // 3. Add author labels if they are in the active/published author scope
  for (const metadata of articles) {
    for (const author of metadata.authors) {
      const slug = slugify(author);
      if (activeAuthorSlugsSet.has(slug)) {
        addToken(slug);
      }
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
    // Distinct titles only: repeating an identical title (e.g. a recurring column name) adds nothing
    title: [...new Set(articles.map((article) => article.title).filter(Boolean))].join(' | ') || null,
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

  console.log('🏷️ Labeling post %s with tokens: [%s]', uri, labelTokens.join(', '));

  // Publish labels if a server is available (it's only created outside dry-run mode)
  const server = labelerServer;
  if (server) {
    try {
      // Don't write labels until the label table is ready
      await labelStoreReady;

      for (const token of labelTokens) {
        await server.createLabel({
          uri: uri,
          val: token,
          neg: false,
        });
      }
      console.log('✅ Successfully published labels for: %s', uri);
    } catch (error) {
      console.error('❌ Failed to publish labels for %s:', uri, error);
    }
  } else {
    console.log('[DRY RUN] Would publish labels: %s for URI: %s', JSON.stringify(labelTokens), uri);
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
