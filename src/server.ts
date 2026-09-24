import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, LABELER_PORT, DRY_RUN, ENV, DID, SERVICE_URL, BSKY_IDENTIFIER } from './config.js';
import { recentLabels, stats, IssuedLabelLog, labelerServer, labelStoreReady } from './labeler.js';
import { getActiveAuthors, getDistinctCategories, saveSetting } from './database.js';
import { startFirehoseListener, stopFirehoseListener } from './jetstream.js';
import { fetchLabelActivity, fetchRecentPostLabels } from './label-activity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
export const server = http.createServer(app);

// Initialize WebSocket Server for dashboard
export const wss = new WebSocketServer({ noServer: true });

// Initialize WebSocket Server for Labeler proxying
export const labelerProxyWss = new WebSocketServer({ noServer: true });

// Backlog per proxied subscriber at which the proxy stops reading from the LabelerServer,
// and the level it must drain to before reading resumes
export const PROXY_MAX_BUFFERED_BYTES = 1024 * 1024;
export const PROXY_RESUME_BUFFERED_BYTES = 256 * 1024;

// Track active WebSocket clients
const clients = new Set<WebSocket>();

function isSameOriginRequest(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;

  if (!origin || !host) {
    return false;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

wss.on('connection', (ws, request) => {
  clients.add(ws);
  console.log(`🔌 Dashboard client connected (Total: ${clients.size})`);
  const canToggleFirehose = isSameOriginRequest(request);

  // Send initial stats on connection
  ws.send(JSON.stringify({ type: 'init', stats, recentLabels }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'toggle') {
        if (!canToggleFirehose) {
          console.warn('⚠️ Ignoring unauthorized WS toggle request from non same-origin client');
          return;
        }
        const { enabled } = data;
        if (enabled === true) {
          startFirehoseListener();
          await saveSetting('firehose_enabled', 'true');
        } else if (enabled === false) {
          stopFirehoseListener();
          await saveSetting('firehose_enabled', 'false');
        }
        broadcastStats();
      }
    } catch (err) {
      console.error('❌ Failed to process WS message from dashboard:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`🔌 Dashboard client disconnected (Total: ${clients.size})`);
  });
});

// Handle connections to the Labeler Proxy WebSocket Server
labelerProxyWss.on('connection', async (clientWs, request) => {
  const urlObj = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);

  // Wait for the label table to be ready so a cursor isn't rejected as being in the future
  await labelStoreReady;

  // The subscriber may have given up while waiting; its close event has already fired
  if (clientWs.readyState !== WebSocket.OPEN) {
    return;
  }

  const targetUrl = `ws://127.0.0.1:${LABELER_PORT}${urlObj.pathname}${urlObj.search}`;
  
  console.log(`🔌 Establishing protocol-level proxy connection to LabelerServer: ${targetUrl}`);
  
  const targetWs = new WebSocket(targetUrl);
  
  let isClosed = false;
  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    try { clientWs.close(); } catch {}
    try { targetWs.close(); } catch {}
  };

  targetWs.on('open', () => {
    console.log(`✅ Protocol-level proxy connection opened to LabelerServer`);
  });

  clientWs.on('message', (data, isBinary) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    }
  });

  // Stop reading from the LabelerServer while a slow subscriber has a backlog, so the
  // LabelerServer's own backpressure (it pages replays and waits for its socket to drain)
  // applies end to end instead of the whole replay piling up in this process's memory
  const resumeWhenDrained = () => {
    if (targetWs.isPaused && clientWs.bufferedAmount <= PROXY_RESUME_BUFFERED_BYTES) {
      targetWs.resume();
    }
  };

  targetWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary }, resumeWhenDrained);
      if (clientWs.bufferedAmount > PROXY_MAX_BUFFERED_BYTES) {
        targetWs.pause();
      }
    }
  });

  clientWs.on('close', (code, reason) => {
    console.log(`🔌 WS Proxy: Client WebSocket closed (Code: ${code}, Reason: ${reason || 'None'})`);
    if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
      try {
        if (code && code !== 1005 && code !== 1006 && code !== 1015) {
          targetWs.close(code, reason);
        } else {
          targetWs.close();
        }
      } catch (err) {
        console.error('⚠️ WS Proxy: Error closing targetWs with code/reason, falling back to clean close:', err);
        try { targetWs.close(); } catch {}
      }
    }
    cleanup();
  });

  targetWs.on('close', (code, reason) => {
    console.log(`🔌 WS Proxy: LabelerServer WebSocket closed (Code: ${code}, Reason: ${reason || 'None'})`);
    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
      try {
        if (code && code !== 1005 && code !== 1006 && code !== 1015) {
          clientWs.close(code, reason);
        } else {
          clientWs.close();
        }
      } catch (err) {
        console.error('⚠️ WS Proxy: Error closing clientWs with code/reason, falling back to clean close:', err);
        try { clientWs.close(); } catch {}
      }
    }
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.error('❌ WS Proxy: Client WebSocket Error:', err);
    targetWs.terminate();
    cleanup();
  });

  targetWs.on('error', (err) => {
    console.error('❌ WS Proxy: LabelerServer WebSocket Error:', err);
    clientWs.terminate();
    cleanup();
  });
});

/**
 * Handle upgrade requests from HTTP to WebSocket.
 */
server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`).pathname;
  } catch (err) {
    console.warn('⚠️ Failed to parse URL in upgrade handler:', err);
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('/xrpc/')) {
    if (!labelerServer) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    console.log(`🔀 Upgrading and proxying WebSocket connection for ${pathname} to LabelerServer on port ${LABELER_PORT}`);
    labelerProxyWss.handleUpgrade(request, socket, head, (ws) => {
      labelerProxyWss.emit('connection', ws, request);
    });
  } else {
    console.warn(`⚠️ Rejecting invalid WebSocket upgrade request on path: ${pathname}`);
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

// Configure broadcast hook for labeler.ts
global.broadcastLog = (logEntry: IssuedLabelLog) => {
  const message = JSON.stringify({ type: 'log', log: logEntry, stats });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
};

// Periodic stats heartbeat (every 1 second)
let lastProcessed = 0;
let lastThroughput = 0;

/**
 * Broadcasts the current stats to all active WebSocket clients.
 */
export function broadcastStats(updateThroughputWindow = false) {
  if (updateThroughputWindow) {
    const currentProcessed = stats.postsProcessed;
    lastThroughput = currentProcessed - lastProcessed;
    lastProcessed = currentProcessed;
  }

  const heartbeat = JSON.stringify({
    type: 'heartbeat',
    stats: {
      ...stats,
      throughput: lastThroughput,
      uptime: Math.floor((Date.now() - new Date(stats.startTime).getTime()) / 1000),
    }
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(heartbeat);
    }
  }
}

setInterval(() => {
  broadcastStats(true);
}, 1000).unref();

// Proxy HTTP requests to com.atproto.label (XRPC) to Fastify LabelerServer on LABELER_PORT
app.use('/xrpc', async (req, res) => {
  if (!labelerServer) {
    res.status(503).send('LabelerServer not initialized');
    return;
  }

  // Wait for the label table to be ready so queries don't see a partial history
  await labelStoreReady;

  const targetUrl = `http://127.0.0.1:${LABELER_PORT}${req.originalUrl}`;
  console.log(`🔀 Proxying HTTP ${req.method} request to LabelerServer: ${targetUrl}`);
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: LABELER_PORT,
      path: req.originalUrl,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${LABELER_PORT}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('❌ HTTP Proxy Request Error:', err);
    res.status(502).send('Bad Gateway');
  });

  req.pipe(proxyReq);
});

// Parse JSON payloads
app.use(express.json());

// API Endpoints
app.get('/api/stats', (req, res) => {
  res.json({
    ...stats,
    uptime: Math.floor((Date.now() - new Date(stats.startTime).getTime()) / 1000),
    env: ENV,
    dryRun: DRY_RUN,
    serviceUrl: SERVICE_URL,
    did: DID,
    bskyIdentifier: BSKY_IDENTIFIER
  });
});

app.post('/api/firehose/toggle', async (req, res) => {
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  // Express 5 leaves req.body undefined when the request has no JSON body
  const { enabled } = req.body ?? {};
  if (enabled === true) {
    startFirehoseListener();
    await saveSetting('firehose_enabled', 'true');
    broadcastStats();
    res.json({ success: true, firehoseEnabled: true });
  } else if (enabled === false) {
    stopFirehoseListener();
    await saveSetting('firehose_enabled', 'false');
    broadcastStats();
    res.json({ success: true, firehoseEnabled: false });
  } else {
    res.status(400).json({ error: "Invalid 'enabled' value. Must be a boolean." });
  }
});

app.get('/api/history', (req, res) => {
  res.json(recentLabels);
});

// Recent labels from the database, so a standby instance can show what the leader issued
app.get('/api/labels/recent', async (req, res) => {
  // No label table without a LabelerServer (e.g. dry-run mode); the dashboard uses its own log
  if (!labelerServer) {
    res.json([]);
    return;
  }
  try {
    // The label table exists once the startup gate opens
    await labelStoreReady;
    res.json(await fetchRecentPostLabels());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recent labels' });
  }
});

app.get('/api/authors', async (req, res) => {
  try {
    const authors = await getActiveAuthors();
    res.json(authors);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active authors' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const categories = await getDistinctCategories();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sections and subsections' });
  }
});

// Serve public static assets
app.use(express.static(path.resolve(__dirname, '../src/public')));

// Fallback all other routes to index.html for single page app experience
// (Express 5 requires a named wildcard; '/{*splat}' also matches '/')
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../src/public/index.html'));
});

/**
 * Starts the dashboard web server.
 */
const LABEL_ACTIVITY_REFRESH_MS = 30_000;

/**
 * Refreshes the database-backed label activity shown on the dashboard (all instances).
 */
export async function refreshLabelActivity(): Promise<void> {
  try {
    stats.labelStore = await fetchLabelActivity();
  } catch (error) {
    console.error('❌ Failed to refresh label activity from the database:', error);
  }
}

export function startWebServer() {
  // Without a LabelerServer (e.g. dry-run mode) there is no label table to read
  if (labelerServer) {
    // The label table exists once the startup gate opens
    void labelStoreReady.then(refreshLabelActivity);
    setInterval(() => void refreshLabelActivity(), LABEL_ACTIVITY_REFRESH_MS).unref();
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Web Dashboard running at http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Server listening at ws://localhost:${PORT}/ws`);
  });

  if (labelerServer) {
    labelerServer.start({ port: LABELER_PORT, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        console.error('❌ Failed to start LabelerServer Fastify instance:', err);
      } else {
        console.log(`🏷️ LabelerServer Fastify instance running at ${address}`);
      }
    });
  } else {
    console.log('ℹ️ No LabelerServer instance to start (dry run or credentials missing).');
  }
}
