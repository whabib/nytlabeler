import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, DRY_RUN, ENV, DID, SERVICE_URL, BSKY_IDENTIFIER } from './config.js';
import { recentLabels, stats, IssuedLabelLog } from './labeler.js';
import { getActiveAuthors, getDistinctCategories } from './database.js';
import { startFirehoseListener, stopFirehoseListener } from './jetstream.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
export const server = http.createServer(app);

// Initialize WebSocket Server
export const wss = new WebSocketServer({ noServer: true });

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

  ws.on('message', (message) => {
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
        } else if (enabled === false) {
          stopFirehoseListener();
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

/**
 * Handle upgrade requests from HTTP to WebSocket.
 */
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
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
}, 1000);

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

app.post('/api/firehose/toggle', (req, res) => {
  const { enabled } = req.body;
  if (enabled === true) {
    startFirehoseListener();
    broadcastStats();
    res.json({ success: true, firehoseEnabled: true });
  } else if (enabled === false) {
    stopFirehoseListener();
    broadcastStats();
    res.json({ success: true, firehoseEnabled: false });
  } else {
    res.status(400).json({ error: "Invalid 'enabled' value. Must be a boolean." });
  }
});

app.get('/api/history', (req, res) => {
  res.json(recentLabels);
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
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../src/public/index.html'));
});

/**
 * Starts the dashboard web server.
 */
export function startWebServer() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Web Dashboard running at http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Server listening at ws://localhost:${PORT}/ws`);
  });
}
