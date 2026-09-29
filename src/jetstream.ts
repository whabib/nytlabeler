import pg from 'pg';
import WebSocket from 'ws';
import { DATABASE_URL, ENV, FIREHOSE_URL, WANTED_COLLECTION } from './config.js';
import { loadSetting, lookupArticle, normalizeNytUrl, type ArticleMatch } from './database.js';
import { LeaderElection, type LeaderClient } from './firehose-leader.js';
import { issueLabelsForPost, stats } from './labeler.js';

export let socket: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let watchdogTimeout: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

// Incremented whenever this instance gains or loses firehose leadership. Posts received
// under an earlier generation are dropped instead of labeled.
let leaderGeneration = 0;

// Where to resume after the connection drops: the newest event time (Jetstream's time_us)
// received in this leadership term, or null to start live. Without it, every post sent
// while the connection was down, or on a connection that stalled before dropping, is lost.
let resumeCursorUs: number | null = null;
/** Replay from a little before the newest event, for events in flight when it dropped. */
export const RESUME_REWIND_US = 5_000_000;
/** After a longer gap, start live rather than replay it. */
export const MAX_RESUME_AGE_US = 60 * 60 * 1_000_000;

// NYT posts handled recently, so a post replayed after a reconnect isn't labeled twice
const RECENT_POSTS_LIMIT = 10_000;
const recentPosts = new Set<string>();

/** Records a post as handled; true if it already was. */
function alreadyHandled(postUri: string): boolean {
  if (recentPosts.has(postUri)) return true;
  recentPosts.add(postUri);
  // Sets iterate in insertion order, so this drops the oldest
  if (recentPosts.size > RECENT_POSTS_LIMIT) recentPosts.delete(recentPosts.values().next().value!);
  return false;
}

// Posts being labeled right now, past the leadership check. A leader handing over waits for
// them before releasing the lock, so the old and new leader never publish at the same time.
let labelingInFlight = 0;
let labelingDrained: (() => void)[] = [];
let handoffDrainTimeoutMs = 10_000;

/** Resolves once no post is being labeled, or after the timeout (the handoff goes ahead). */
function waitForLabelingToFinish(timeoutMs: number): Promise<void> {
  if (labelingInFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      labelingDrained = labelingDrained.filter((waiter) => waiter !== finish);
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn(`⚠️ [LEADER] ${labelingInFlight} post(s) still being labeled after ${timeoutMs} ms; handing over anyway.`);
      finish();
    }, timeoutMs);
    labelingDrained.push(finish);
  });
}

// Regex to detect standard NY Times links in text (handles subdomains and is case-insensitive)
const NYT_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)?nytimes\.com\/[^\s"']+/gi;

/**
 * Checks whether a given URL is a valid NY Times URL.
 * Handles different protocols, subdomains, case insensitivity, and protects against spoof hostnames.
 */
export function isNytUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'nytimes.com' || url.hostname.endsWith('.nytimes.com'))
    );
  } catch {
    return false;
  }
}

/**
 * Extracts all NY Times URLs from a Bluesky post record.
 */
export function extractNytUrls(record: any): string[] {
  const urls = new Set<string>();
  if (!record) return [];

  // 1. Check external embed (link cards)
  if (record.embed && record.embed.$type === 'app.bsky.embed.external' && record.embed.external?.uri) {
    const uri = record.embed.external.uri;
    if (isNytUrl(uri)) {
      urls.add(uri);
    }
  }

  // 2. Check facets (richtext links)
  if (record.facets && Array.isArray(record.facets)) {
    for (const facet of record.facets) {
      if (facet.features && Array.isArray(facet.features)) {
        for (const feature of facet.features) {
          if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
            const uri = feature.uri;
            if (isNytUrl(uri)) {
              urls.add(uri);
            }
          }
        }
      }
    }
  }

  // 3. Fallback to regex text search
  if (record.text && typeof record.text === 'string') {
    let match;
    // Reset regex state
    NYT_REGEX.lastIndex = 0;
    while ((match = NYT_REGEX.exec(record.text)) !== null) {
      if (isNytUrl(match[0])) {
        urls.add(match[0]);
      }
    }
  }

  return Array.from(urls);
}

/**
 * Resets the 15-second inactivity watchdog.
 * If no messages (not even keepalives/pings) are received, the connection is forcefully terminated.
 */
function resetWatchdog() {
  if (watchdogTimeout) {
    clearTimeout(watchdogTimeout);
  }
  watchdogTimeout = setTimeout(() => {
    console.warn('⚠️ [WATCHDOG] No stream activity received for 15 seconds. Terminating stale connection...');
    if (socket) {
      socket.terminate(); // Force close the socket immediately
    }
  }, 15000);
}

// Only one instance runs the firehose at a time. While an old and a new deployment
// overlap (which can last up to the request timeout), the others wait on standby instead
// of labeling every post a second time.
let leadership: LeaderElection | null = null;
let createLeaderClient: () => LeaderClient = () =>
  new pg.Client({ connectionString: DATABASE_URL, keepAlive: true });
let leaderRetryMs = 10_000;

/** Channel on which a newer instance asks the leader to hand over (see LeaderElection). */
export const HANDOFF_CHANNEL = `nytlabeler_firehose_handoff_${ENV.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 63);

function getLeadership(): LeaderElection {
  leadership ??= new LeaderElection({
    lockKey: `nytlabeler:firehose:${ENV}`,
    createClient: createLeaderClient,
    retryMs: leaderRetryMs,
    // The newest instance takes over: after a deploy or an instance replacement, the old
    // instance can run for up to the request timeout, but new traffic goes to the new one
    handoffChannel: HANDOFF_CHANNEL,
    instanceId: `${process.env.K_REVISION ?? 'local'}/${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.parse(stats.startTime),
    onAcquire: () => {
      leaderGeneration++;
      stats.firehoseLeader = true;
      // A new term starts live: another instance handled the firehose until now
      resumeCursorUs = null;
      // Another instance may have toggled the firehose since this one started
      void syncWithSavedSetting().then(() => {
        if (stats.firehoseEnabled) {
          reconnectDelay = 1000;
          connect();
        }
      });
    },
    onLose: () => {
      leaderGeneration++;
      stats.firehoseLeader = false;
      closeSocket();
    },
    // Handing over: let posts already being labeled finish first
    beforeRelease: () => waitForLabelingToFinish(handoffDrainTimeoutMs),
    // Dashboard toggles may reach any instance; the leader follows the saved setting
    onLeaderTick: syncWithSavedSetting,
  });
  return leadership;
}

/**
 * Applies the saved firehose_enabled setting, which any instance's dashboard toggle
 * writes. Leaves the current state alone if the setting can't be read.
 */
async function syncWithSavedSetting() {
  const saved = await loadSetting('firehose_enabled', '');
  if (saved !== 'true' && saved !== 'false') return;
  const enabled = saved === 'true';
  if (enabled === stats.firehoseEnabled) return;

  console.log(`🔄 Applying saved firehose setting: ${enabled ? 'ON' : 'OFF'}`);
  if (enabled) {
    stats.firehoseEnabled = true;
    reconnectDelay = 1000;
    connect();
  } else {
    stats.firehoseEnabled = false;
    closeSocket();
  }
}

/**
 * Overrides how the leadership connection is made and how often it retries, discarding
 * any current election. Useful for unit testing.
 */
export async function configureFirehoseLeadership(options: { createClient: () => LeaderClient; retryMs: number; drainTimeoutMs?: number }) {
  await leadership?.stop();
  leadership = null;
  createLeaderClient = options.createClient;
  leaderRetryMs = options.retryMs;
  handoffDrainTimeoutMs = options.drainTimeoutMs ?? 10_000;
}

/**
 * Stops competing for firehose leadership, releasing it if held.
 */
export async function releaseFirehoseLeadership() {
  await leadership?.stop();
}

/**
 * Connects to the Jetstream firehose endpoint and subscribes to commits.
 */
function connect() {
  if (!stats.firehoseEnabled) {
    console.log('🔌 Skipped connection because Jetstream listener is disabled.');
    return;
  }
  if (!getLeadership().isLeader) {
    console.log('⏸️ Skipped connection because another instance is running the firehose (standby).');
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Never open a second subscription (every post would be labeled twice)
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const generation = leaderGeneration;

  const url = new URL(FIREHOSE_URL);
  if (!url.searchParams.has('wantedCollections')) {
    url.searchParams.set('wantedCollections', WANTED_COLLECTION);
  }

  // Reconnecting after a drop: replay what was missed instead of starting live
  if (resumeCursorUs !== null) {
    if (Date.now() * 1000 - resumeCursorUs <= MAX_RESUME_AGE_US) {
      url.searchParams.set('cursor', String(resumeCursorUs - RESUME_REWIND_US));
      console.log(`⏪ Resuming the firehose from ${new Date((resumeCursorUs - RESUME_REWIND_US) / 1000).toISOString()}`);
    } else {
      console.log('⏩ The firehose was down for over an hour; starting live instead of replaying the gap.');
      resumeCursorUs = null;
    }
  }

  const finalUrl = url.toString();
  console.log(`📡 Connecting to Jetstream firehose at: ${finalUrl}`);
  // The URL actually connected to, cursor included (the dashboard shows it on hover)
  stats.activeEndpoint = finalUrl;

  socket = new WebSocket(finalUrl);

  socket.on('open', () => {
    console.log('✅ Connected to Jetstream firehose!');
    stats.firehoseConnected = true;
    reconnectDelay = 1000; // Reset exponential backoff delay on successful connection
    resetWatchdog();
  });

  socket.on('message', async (data) => {
    resetWatchdog(); // Reset inactivity timer on any stream activity

    let dataObj;
    try {
      dataObj = JSON.parse(data.toString());
    } catch (err) {
      console.error('❌ Failed to parse Jetstream JSON message:', err);
      return;
    }

    // Remember how far this term has read, for resuming after a drop
    if (generation === leaderGeneration && Number.isSafeInteger(dataObj.time_us) && dataObj.time_us > (resumeCursorUs ?? 0)) {
      resumeCursorUs = dataObj.time_us;
    }

    if (dataObj.kind === 'commit' && dataObj.commit && dataObj.commit.collection === WANTED_COLLECTION) {
      stats.postsProcessed++;
      stats.lastEventTime = new Date().toISOString();

      if (dataObj.commit.operation === 'create' && dataObj.commit.record) {
        const record = dataObj.commit.record;
        const nytUrls = extractNytUrls(record);
        if (nytUrls.length === 0) return;

        const postUri = `at://${dataObj.did}/${WANTED_COLLECTION}/${dataObj.commit.rkey}`;
        // Replayed after a reconnect: it was already handled
        if (alreadyHandled(postUri)) return;
        stats.nytLinksDetected++;
        const authorDid = dataObj.did;
        const postText = record.text || '';

        // Post-derived values go in as arguments, never in the format string
        console.log('🔍 [NYT LINK] Detected NY Times URL(s) in post %s: %s', postUri, nytUrls.join(', '));

        // Look up each distinct article once; links often differ only by tracking parameters
        const articles = new Map<number, ArticleMatch>();
        for (const url of new Set(nytUrls.map(normalizeNytUrl))) {
          try {
            const article = await lookupArticle(url);
            if (article) {
              console.log(
                '🎯 [DB MATCH] Found article in nytdata: "%s" [Section: %s, Subsection: %s, Authors: %s]',
                article.title, article.section, article.subsection || 'None', article.authors.join(', '),
              );
              articles.set(article.id, article);
            } else {
              console.log('🫙 [NO DB MATCH] URL not found in database: %s', url);
            }
          } catch (err) {
            console.error('❌ Error processing link %s for post %s:', url, postUri, err);
          }
        }

        // Leadership may have changed during the lookups; the new leader handles new posts
        if (generation !== leaderGeneration || !getLeadership().isLeader) {
          console.log('⏸️ Dropping post %s: firehose leadership changed while processing it.', postUri);
          return;
        }
        if (articles.size === 0) return;

        // One call per post, so each label value is issued at most once. Counted from the
        // leadership check above (no await in between) until its labels are written.
        labelingInFlight++;
        try {
          await issueLabelsForPost(postUri, authorDid, postText, [...articles.values()]);
        } catch (err) {
          console.error('❌ Error labeling post %s:', postUri, err);
        } finally {
          labelingInFlight--;
          if (labelingInFlight === 0) for (const done of labelingDrained.slice()) done();
        }
      }
    }
  });

  socket.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'None';
    console.log(`🔌 Jetstream connection closed (Code: ${code}, Reason: ${reasonStr}).`);
    handleDisconnect();
  });

  socket.on('error', (error) => {
    console.error('❌ Jetstream client socket error:', error.message || error);

    // Ensure we reconnect even if the error does not lead to a 'close' event.
    if (socket && socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  });
}

/**
 * Handles connection disconnections and triggers the exponential backoff reconnection.
 */
function handleDisconnect() {
  stats.firehoseConnected = false;
  if (watchdogTimeout) {
    clearTimeout(watchdogTimeout);
    watchdogTimeout = null;
  }

  if (!stats.firehoseEnabled || !getLeadership().isLeader) {
    console.log('🔌 Jetstream listener disabled or on standby. Skipping reconnection.');
    return;
  }

  // Calculate exponential backoff delay with 25% random jitter
  const jitter = Math.random() * 0.25 * reconnectDelay;
  const delay = reconnectDelay + jitter;

  stats.reconnectCount++;
  console.log(`🔄 Attempting reconnect to Jetstream in ${Math.round(delay)}ms...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, delay);
}

/**
 * Starts competing for firehose leadership, with the listener initially on or off.
 * Every instance competes even when the firehose is off, so a later toggle (saved in
 * the database) takes effect on whichever instance leads.
 */
export function initFirehose(enabled: boolean) {
  stats.firehoseEnabled = enabled;
  getLeadership().start();
}

/**
 * Starts the Jetstream listener subscribing to the live Bluesky firehose.
 * The connection opens once this instance holds firehose leadership.
 */
export function startFirehoseListener() {
  stats.firehoseEnabled = true;
  reconnectDelay = 1000;
  const election = getLeadership();
  election.start();
  if (election.isLeader) connect();
}

/**
 * Stops the Jetstream listener and closes any active connections.
 * Leadership is kept; the leader keeps following the saved setting.
 */
export function stopFirehoseListener() {
  stats.firehoseEnabled = false;
  closeSocket();
  console.log('🛑 Jetstream listener successfully stopped!');
}

/**
 * Closes the Jetstream connection without triggering a reconnect.
 */
function closeSocket() {
  stats.firehoseConnected = false;
  // An intentional close (leadership lost, or the firehose turned off) starts the next
  // connection live; only a dropped connection resumes
  resumeCursorUs = null;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (watchdogTimeout) {
    clearTimeout(watchdogTimeout);
    watchdogTimeout = null;
  }

  if (socket) {
    // Remove listeners to avoid triggering of handleDisconnect on intentional close
    socket.removeAllListeners('close');
    socket.removeAllListeners('error');
    // Closing a socket that is still connecting makes ws emit "WebSocket was closed before
    // the connection was established"; with no listener that's an uncaught exception, which
    // would crash the process
    socket.on('error', () => {});

    try {
      socket.close();
    } catch (err) {
      console.error('❌ Error closing Jetstream socket:', err);
    }
    socket = null;
  }
}
