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

function getLeadership(): LeaderElection {
  leadership ??= new LeaderElection({
    lockKey: `nytlabeler:firehose:${ENV}`,
    createClient: createLeaderClient,
    retryMs: leaderRetryMs,
    onAcquire: () => {
      leaderGeneration++;
      stats.firehoseLeader = true;
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
export async function configureFirehoseLeadership(options: { createClient: () => LeaderClient; retryMs: number }) {
  await leadership?.stop();
  leadership = null;
  createLeaderClient = options.createClient;
  leaderRetryMs = options.retryMs;
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

  const finalUrl = url.toString();
  console.log(`📡 Connecting to Jetstream firehose at: ${finalUrl}`);
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

    if (dataObj.kind === 'commit' && dataObj.commit && dataObj.commit.collection === WANTED_COLLECTION) {
      stats.postsProcessed++;
      stats.lastEventTime = new Date().toISOString();

      if (dataObj.commit.operation === 'create' && dataObj.commit.record) {
        const record = dataObj.commit.record;
        const nytUrls = extractNytUrls(record);
        if (nytUrls.length === 0) return;

        stats.nytLinksDetected++;
        const postUri = `at://${dataObj.did}/${WANTED_COLLECTION}/${dataObj.commit.rkey}`;
        const authorDid = dataObj.did;
        const postText = record.text || '';

        console.log(`🔍 [NYT LINK] Detected NY Times URL(s) in post ${postUri}: ${nytUrls.join(', ')}`);

        // Look up each distinct article once; links often differ only by tracking parameters
        const articles = new Map<number, ArticleMatch>();
        for (const url of new Set(nytUrls.map(normalizeNytUrl))) {
          try {
            const article = await lookupArticle(url);
            if (article) {
              console.log(`🎯 [DB MATCH] Found article in nytdata: "${article.title}" [Section: ${article.section}, Subsection: ${article.subsection || 'None'}, Authors: ${article.authors.join(', ')}]`);
              articles.set(article.id, article);
            } else {
              console.log(`🫙 [NO DB MATCH] URL not found in database: ${url}`);
            }
          } catch (err) {
            console.error('❌ Error processing link %s for post %s:', url, postUri, err);
          }
        }

        // Leadership may have changed during the lookups; the new leader handles new posts
        if (generation !== leaderGeneration || !getLeadership().isLeader) {
          console.log(`⏸️ Dropping post ${postUri}: firehose leadership changed while processing it.`);
          return;
        }
        if (articles.size === 0) return;

        // One call per post, so each label value is issued at most once
        try {
          await issueLabelsForPost(postUri, authorDid, postText, [...articles.values()]);
        } catch (err) {
          console.error('❌ Error labeling post %s:', postUri, err);
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

    try {
      socket.close();
    } catch (err) {
      console.error('❌ Error closing Jetstream socket:', err);
    }
    socket = null;
  }
}
