import WebSocket from 'ws';
import { FIREHOSE_URL, WANTED_COLLECTION } from './config.js';
import { lookupArticle } from './database.js';
import { issueLabelsForPost, stats } from './labeler.js';

export let socket: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let watchdogTimeout: NodeJS.Timeout | null = null;

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

/**
 * Connects to the Jetstream firehose endpoint and subscribes to commits.
 */
function connect() {
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

        for (const url of nytUrls) {
          try {
            const article = await lookupArticle(url);
            if (article) {
              console.log(`🎯 [DB MATCH] Found article in nytdata: "${article.title}" [Section: ${article.section}, Subsection: ${article.subsection || 'None'}, Authors: ${article.authors.join(', ')}]`);
              
              await issueLabelsForPost(postUri, authorDid, postText, {
                section: article.section,
                subsection: article.subsection,
                authors: article.authors,
                title: article.title,
              });
            } else {
              console.log(`🫙 [NO DB MATCH] URL not found in database: ${url}`);
            }
          } catch (err) {
            console.error('❌ Error processing link %s for post %s:', url, postUri, err);
          }
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

  // Calculate exponential backoff delay with 25% random jitter
  const jitter = Math.random() * 0.25 * reconnectDelay;
  const delay = reconnectDelay + jitter;

  stats.reconnectCount++;
  console.log(`🔄 Attempting reconnect to Jetstream in ${Math.round(delay)}ms...`);

  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, delay);
}

/**
 * Starts the Jetstream listener subscribing to the live Bluesky firehose.
 */
export function startFirehoseListener() {
  connect();
}
