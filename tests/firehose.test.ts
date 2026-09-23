import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';

// Point the firehose at a local mock Jetstream BEFORE importing the module
process.env.FIREHOSE_URL = 'ws://127.0.0.1:14301/subscribe';

const { startFirehoseListener, stopFirehoseListener, configureFirehoseLeadership, releaseFirehoseLeadership } = await import('../src/jetstream.js');
const { stats } = await import('../src/labeler.js');
const { pool } = await import('../src/database.js');

/** A pg Client stand-in whose advisory lock result the test controls. */
class FakeClient extends EventEmitter {
  constructor(private readonly lockAvailable: () => boolean) {
    super();
  }
  async connect() {}
  async query(text: string) {
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired: this.lockAvailable() }] };
    return { rows: [] };
  }
  async end() {}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Firehose leadership', () => {
  let jetstream: WebSocketServer;
  const connections: WebSocket[] = [];

  before(async () => {
    jetstream = new WebSocketServer({ port: 14301, host: '127.0.0.1' });
    jetstream.on('connection', (ws) => {
      connections.push(ws);
      // Keep the watchdog quiet
      const keepAlive = setInterval(() => ws.send(JSON.stringify({ kind: 'identity' })), 1000);
      ws.on('close', () => clearInterval(keepAlive));
    });
    await new Promise<void>((resolve) => jetstream.on('listening', resolve));
  });

  after(async () => {
    stopFirehoseListener();
    for (const ws of connections) ws.terminate();
    await new Promise<void>((resolve) => jetstream.close(() => resolve()));
    await pool.end();
  });

  test('stays disconnected on standby, connects as leader, and disconnects when leadership is lost', async () => {
    let lockFree = false;
    const clients: FakeClient[] = [];
    await configureFirehoseLeadership({
      createClient: () => {
        const client = new FakeClient(() => lockFree);
        clients.push(client);
        return client;
      },
      retryMs: 20,
    });

    try {
      startFirehoseListener();
      await wait(100);
      assert.strictEqual(connections.length, 0, 'A standby instance must not connect to the firehose');
      assert.strictEqual(stats.firehoseConnected, false);
      assert.strictEqual(stats.firehoseLeader, false);

      lockFree = true;
      await wait(150);
      assert.strictEqual(connections.length, 1, 'The leader connects to the firehose');
      assert.strictEqual(stats.firehoseConnected, true);
      assert.strictEqual(stats.firehoseLeader, true);

      // Losing the leadership connection disconnects from the firehose, but the listener
      // stays enabled so it reconnects once leadership is regained
      lockFree = false;
      const closed = new Promise<void>((resolve) => connections[0].once('close', () => resolve()));
      clients[clients.length - 1].emit('end');
      await closed;
      assert.strictEqual(stats.firehoseLeader, false);
      assert.strictEqual(stats.firehoseConnected, false);
      assert.strictEqual(stats.firehoseEnabled, true);

      lockFree = true;
      await wait(150);
      assert.strictEqual(connections.length, 2, 'Reconnects after regaining leadership');
      assert.strictEqual(stats.firehoseConnected, true);
    } finally {
      stopFirehoseListener();
      await releaseFirehoseLeadership();
    }
  });
});
