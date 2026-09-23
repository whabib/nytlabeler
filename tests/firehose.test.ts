import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

// Point the firehose at a local mock Jetstream BEFORE importing the module
process.env.FIREHOSE_URL = 'ws://127.0.0.1:14301/subscribe';

const { startFirehoseListener, stopFirehoseListener, configureFirehoseLeadership, releaseFirehoseLeadership } = await import('../src/jetstream.js');
const { stats, setLabelerServer } = await import('../src/labeler.js');
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

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await wait(10);
  }
}

// These tests log heavily (connections, labels, lost leadership). That output can garble
// the test runner's IPC stream ("Unable to deserialize cloned data"), so keep it quiet.
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = console.warn = console.error = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

describe('Firehose leadership', () => {
  let jetstream: WebSocketServer;
  const connections: WebSocket[] = [];
  const open = () => connections.filter((ws) => ws.readyState === WebSocket.OPEN);

  // Test-controlled database state
  let savedSetting: string | null = 'true';
  let lookupDelayMs = 0;
  let lookups = 0;
  let lockFree = false;
  let clients: FakeClient[] = [];
  const created: string[] = [];
  const originalQuery = pool.query;

  before(async () => {
    jetstream = new WebSocketServer({ port: 14301, host: '127.0.0.1' });
    jetstream.on('connection', (ws) => {
      connections.push(ws);
      // Keep the watchdog quiet
      const keepAlive = setInterval(() => ws.send(JSON.stringify({ kind: 'identity' })), 1000);
      ws.on('close', () => clearInterval(keepAlive));
    });
    await new Promise<void>((resolve) => jetstream.on('listening', resolve));

    pool.query = (async (sql: string) => {
      if (sql.includes('"_Settings"')) return { rows: savedSetting === null ? [] : [{ value: savedSetting }] };
      if (sql.includes('FROM "Article"')) {
        lookups++;
        await wait(lookupDelayMs);
        return {
          rows: [{ id: 1, url: 'https://www.nytimes.com/x', section: 'us', subsection: null, title: 'T', author_name: null }],
        };
      }
      return { rows: [] };
    }) as any;

    setLabelerServer({
      createLabel: async (label: any) => {
        created.push(label.val);
        return { id: created.length, ...label };
      },
    });
  });

  beforeEach(async () => {
    savedSetting = 'true';
    lookupDelayMs = 0;
    lookups = 0;
    lockFree = false;
    clients = [];
    created.length = 0;
    await configureFirehoseLeadership({
      createClient: () => {
        const client = new FakeClient(() => lockFree);
        clients.push(client);
        return client;
      },
      retryMs: 20,
    });
  });

  afterEach(async () => {
    stopFirehoseListener();
    await releaseFirehoseLeadership();
    for (const ws of connections) ws.terminate();
    connections.length = 0;
  });

  after(async () => {
    pool.query = originalQuery;
    setLabelerServer(null);
    await new Promise<void>((resolve) => jetstream.close(() => resolve()));
    await pool.end();
  });

  /** Simulate the leader's database session ending (the lock is released). */
  function loseLeadership() {
    lockFree = false;
    clients[clients.length - 1].emit('end');
  }

  function sendNytPost(ws: WebSocket, rkey: string, text = 'Read this https://www.nytimes.com/2026/09/23/us/story.html') {
    ws.send(JSON.stringify({
      kind: 'commit',
      did: 'did:plc:poster',
      commit: {
        collection: 'app.bsky.feed.post',
        operation: 'create',
        rkey,
        record: { text },
      },
    }));
  }

  test('stays disconnected on standby, connects as leader, and disconnects when leadership is lost', async () => {
    startFirehoseListener();
    await wait(100);
    assert.strictEqual(connections.length, 0, 'A standby instance must not connect to the firehose');
    assert.strictEqual(stats.firehoseConnected, false);
    assert.strictEqual(stats.firehoseLeader, false);

    lockFree = true;
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    assert.strictEqual(stats.firehoseLeader, true);

    // Losing the leadership connection disconnects from the firehose, but the listener
    // stays enabled so it reconnects once leadership is regained
    const closed = new Promise<void>((resolve) => connections[0].once('close', () => resolve()));
    loseLeadership();
    await closed;
    assert.strictEqual(stats.firehoseLeader, false);
    assert.strictEqual(stats.firehoseConnected, false);
    assert.strictEqual(stats.firehoseEnabled, true);

    lockFree = true;
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
  });

  test('never opens a second subscription when leadership is regained during a pending reconnect', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);

    // Jetstream drops the connection: a reconnect is scheduled for ~1-1.25s from now
    connections[0].terminate();
    await waitFor(() => !stats.firehoseConnected);

    // Leadership is lost and regained before that reconnect fires
    loseLeadership();
    lockFree = true;
    await waitFor(() => stats.firehoseLeader && open().length === 1);

    // Past the old reconnect time there must still be exactly one subscription
    await wait(1500);
    assert.strictEqual(open().length, 1, 'A stale reconnect must not open a second subscription');
  });

  test('the leader follows the saved setting, whichever instance a toggle reached', async () => {
    savedSetting = 'false';
    lockFree = true;
    startFirehoseListener(); // Enabled locally, but the saved setting says off
    await waitFor(() => stats.firehoseLeader);
    await wait(100);
    assert.strictEqual(open().length, 0, 'The leader must honor the saved OFF setting');
    assert.strictEqual(stats.firehoseEnabled, false);

    // A toggle on another instance saves ON; the leader connects on its next heartbeat
    savedSetting = 'true';
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    assert.strictEqual(stats.firehoseEnabled, true);

    // ...and saves OFF again; the leader disconnects
    savedSetting = 'false';
    await waitFor(() => open().length === 0 && !stats.firehoseConnected);
    assert.strictEqual(stats.firehoseEnabled, false);
  });

  test('labels a post once when it links the same article more than once', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);

    // Two forms of the same URL: one lookup, one set of labels
    sendNytPost(
      open()[0],
      'variants',
      'https://www.nytimes.com/2026/09/23/us/story.html?smid=bs-share and https://nytimes.com/2026/09/23/us/story.html',
    );
    await waitFor(() => created.length > 0);
    await wait(50);
    assert.strictEqual(lookups, 1);
    assert.deepStrictEqual(created, ['us']);

    // Different URLs that resolve to the same article: still one set of labels
    created.length = 0;
    lookups = 0;
    sendNytPost(
      open()[0],
      'aliases',
      'https://www.nytimes.com/2026/09/23/us/story.html and https://www.nytimes.com/live/2026/09/23/us/story-updates',
    );
    await waitFor(() => lookups === 2 && created.length > 0);
    await wait(50);
    assert.deepStrictEqual(created, ['us']);
  });

  test('labels a post while leading, but drops it if leadership is lost while it is processed', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);

    // Control: a post processed while leading is labeled
    sendNytPost(open()[0], 'kept');
    await waitFor(() => created.length > 0);
    assert.deepStrictEqual(created, ['us']);

    // Leadership is lost during the article lookup: the post must not be labeled
    created.length = 0;
    lookupDelayMs = 100;
    sendNytPost(open()[0], 'dropped');
    await wait(30);
    loseLeadership();
    await wait(200);
    assert.deepStrictEqual(created, [], 'No labels after leadership was lost');
  });
});
