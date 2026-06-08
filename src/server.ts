import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, DRY_RUN, ENV, SERVICE_URL } from './config.js';
import { recentLabels, stats, IssuedLabelLog } from './labeler.js';
import { getActiveAuthors, getDistinctCategories } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
export const server = http.createServer(app);

// Initialize WebSocket Server
export const wss = new WebSocketServer({ noServer: true });

// Track active WebSocket clients
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`🔌 Dashboard client connected (Total: ${clients.size})`);
  
  // Send initial stats on connection
  ws.send(JSON.stringify({ type: 'init', stats, recentLabels }));

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
setInterval(() => {
  const currentProcessed = stats.postsProcessed;
  const throughput = currentProcessed - lastProcessed;
  lastProcessed = currentProcessed;

  const heartbeat = JSON.stringify({
    type: 'heartbeat',
    stats: {
      ...stats,
      throughput,
      uptime: Math.floor((Date.now() - new Date(stats.startTime).getTime()) / 1000),
    }
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(heartbeat);
    }
  }
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
    serviceUrl: SERVICE_URL
  });
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
