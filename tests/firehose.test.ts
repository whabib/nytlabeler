import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

// Point the firehose at a local mock Jetstream BEFORE importing the module
process.env.FIREHOSE_URL = 'ws://127.0.0.1:14301/subscribe';

const {
  startFirehoseListener, stopFirehoseListener, configureFirehoseLeadership, releaseFirehoseLeadership, HANDOFF_CHANNEL, RESUME_REWIND_US,
} = await import('../src/jetstream.js');
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
  const connectionUrls: string[] = []; // The URL of each connection, cursor included
  const open = () => connections.filter((ws) => ws.readyState === WebSocket.OPEN);
  const cursorOf = (index: number) => new URL(connectionUrls[index], 'ws://x').searchParams.get('cursor');

  // Test-controlled database state
  let savedSetting: string | null = 'true';
  let lookupDelayMs = 0;
  let labelDelayMs = 0;
  // While set, the fake Jetstream holds new handshakes, leaving the client connecting
  let holdHandshakes = false;
  const heldHandshakes: ((accept: boolean, code?: number) => void)[] = []; // How long each createLabel takes; Infinity waits until released
  const stuckLabels: (() => void)[] = [];
  let lookups = 0;
  let lockFree = false;
  let clients: FakeClient[] = [];
  const created: string[] = [];
  const originalQuery = pool.query;

  before(async () => {
    jetstream = new WebSocketServer({
      port: 14301,
      host: '127.0.0.1',
      verifyClient: (_info: unknown, done: (accept: boolean, code?: number) => void) => {
        if (holdHandshakes) heldHandshakes.push(done);
        else done(true);
      },
    });
    jetstream.on('connection', (ws, request) => {
      connections.push(ws);
      connectionUrls.push(request.url ?? '');
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
        if (labelDelayMs === Infinity) await new Promise<void>((resolve) => stuckLabels.push(resolve));
        if (labelDelayMs) await wait(labelDelayMs);
        created.push(label.val);
        return { id: created.length, ...label };
      },
    });
  });

  beforeEach(async () => {
    savedSetting = 'true';
    lookupDelayMs = 0;
    labelDelayMs = 0;
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
      drainTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    stopFirehoseListener();
    await releaseFirehoseLeadership();
    for (const ws of connections) ws.terminate();
    connections.length = 0;
    connectionUrls.length = 0;
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

  function sendNytPost(ws: WebSocket, rkey: string, text = 'Read this https://www.nytimes.com/2026/09/23/us/story.html', timeUs?: number) {
    ws.send(JSON.stringify({
      ...(timeUs === undefined ? {} : { time_us: timeUs }),
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

  test('hands the firehose to a newer instance: disconnects before releasing the lock', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    const client = clients[clients.length - 1];
    const queries: string[] = [];
    const originalQuery = client.query.bind(client);
    client.query = async (text: string) => {
      // The Jetstream connection must already be closing when the lock is released
      if (text.includes('pg_advisory_unlock')) queries.push(`unlock (leader: ${stats.firehoseLeader}, socket open: ${open().length > 0 && stats.firehoseConnected})`);
      return originalQuery(text);
    };

    // An older instance's request changes nothing
    client.emit('notification', { channel: HANDOFF_CHANNEL, payload: JSON.stringify({ instanceId: 'older', startedAt: 0 }) });
    await wait(50);
    assert.strictEqual(stats.firehoseLeader, true);
    assert.strictEqual(open().length, 1);

    // A newer one takes over; this instance stops and stays on standby
    lockFree = false; // The newer instance holds the lock from here on
    const closed = new Promise<void>((resolve) => connections[0].once('close', () => resolve()));
    client.emit('notification', { channel: HANDOFF_CHANNEL, payload: JSON.stringify({ instanceId: 'newer', startedAt: Date.now() + 60_000 }) });
    await closed;
    assert.strictEqual(stats.firehoseLeader, false);
    assert.strictEqual(stats.firehoseEnabled, true, 'The listener stays enabled for when it leads again');
    assert.deepStrictEqual(queries, ['unlock (leader: false, socket open: false)']);
    await wait(100);
    assert.strictEqual(open().length, 0, 'It must not reconnect while on standby');
  });

  test('resumes after a dropped connection from just before the last event, labeling each post once', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    assert.strictEqual(cursorOf(0), null, 'The first connection starts live');

    const lastEventUs = Date.now() * 1000;
    sendNytPost(open()[0], 'resume-before', undefined, lastEventUs - 1_000_000);
    sendNytPost(open()[0], 'resume-last', undefined, lastEventUs);
    await waitFor(() => created.length === 2);

    // The connection drops (like Jetstream closing it with 1006); the reconnect replays
    connections[0].terminate();
    await waitFor(() => connectionUrls.length === 2 && open().length === 1, 4000);
    assert.strictEqual(cursorOf(1), String(lastEventUs - RESUME_REWIND_US));
    // The dashboard reports the URL it actually connected to
    assert.strictEqual(new URL(stats.activeEndpoint).searchParams.get('cursor'), String(lastEventUs - RESUME_REWIND_US));

    // Jetstream replays the posts from the rewind, then sends one that was missed
    sendNytPost(open()[0], 'resume-before', undefined, lastEventUs - 1_000_000);
    sendNytPost(open()[0], 'resume-last', undefined, lastEventUs);
    sendNytPost(open()[0], 'resume-missed', undefined, lastEventUs + 2_000_000);
    await waitFor(() => created.length === 3);
    await wait(50);
    assert.deepStrictEqual(created, ['us', 'us', 'us'], 'Replayed posts must not be labeled again');
  });

  test('starts live after losing and regaining leadership, or turning the firehose off and on', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    sendNytPost(open()[0], 'live-1', undefined, Date.now() * 1000);
    await waitFor(() => created.length === 1);

    // Another instance may have handled the firehose in between, so no replay
    loseLeadership();
    lockFree = true;
    await waitFor(() => connectionUrls.length === 2 && open().length === 1);
    assert.strictEqual(cursorOf(1), null);

    sendNytPost(open()[0], 'live-2', undefined, Date.now() * 1000);
    await waitFor(() => created.length === 2);
    stopFirehoseListener();
    startFirehoseListener();
    await waitFor(() => connectionUrls.length === 3 && open().length === 1);
    assert.strictEqual(cursorOf(2), null);
  });

  test('starts live instead of replaying a gap of over an hour', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    sendNytPost(open()[0], 'stale-1', undefined, (Date.now() - 2 * 60 * 60 * 1000) * 1000);
    await waitFor(() => created.length === 1);
    connections[0].terminate();
    await waitFor(() => connectionUrls.length === 2 && open().length === 1, 4000);
    assert.strictEqual(cursorOf(1), null);
  });

  /** Sends the leader a step-down request from a newer instance; resolves with what happened, in order. */
  async function handOverWhileLabeling() {
    const client = clients[clients.length - 1];
    const order: string[] = [];
    const originalQuery = client.query.bind(client);
    client.query = async (text: string) => {
      if (text.includes('pg_advisory_unlock')) order.push(`unlock (labels written: ${created.length})`);
      return originalQuery(text);
    };
    lockFree = false; // The newer instance holds the lock from here on
    client.emit('notification', { channel: HANDOFF_CHANNEL, payload: JSON.stringify({ instanceId: 'newer', startedAt: Date.now() + 60_000 }) });
    return order;
  }

  test('on handoff, lets a post already being labeled finish before releasing the lock', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    labelDelayMs = 150;
    sendNytPost(open()[0], 'drain-1');
    await waitFor(() => lookups === 1); // Past the lookup; now writing its label
    await wait(20);

    const order = await handOverWhileLabeling();
    await waitFor(() => order.length === 1);
    assert.deepStrictEqual(order, ['unlock (labels written: 1)'], 'The label was written before the lock was released');
    assert.strictEqual(stats.firehoseLeader, false);
  });

  test('on handoff, stops waiting for stuck labeling after the drain timeout', async () => {
    lockFree = true;
    startFirehoseListener();
    await waitFor(() => open().length === 1 && stats.firehoseConnected);
    labelDelayMs = Infinity;
    sendNytPost(open()[0], 'drain-stuck');
    await waitFor(() => lookups === 1);
    await wait(20);

    try {
      const startedAt = Date.now();
      const order = await handOverWhileLabeling();
      await waitFor(() => order.length === 1, 2000);
      const waited = Date.now() - startedAt;
      assert.ok(waited >= 250 && waited < 1500, `Released after ${waited} ms (timeout 300 ms)`);
    } finally {
      // Let the stuck write finish, so no labeling is left in flight for later tests
      for (const release of stuckLabels.splice(0)) release();
      await waitFor(() => created.length === 1);
    }
  });

  test('stopping while a connection is still being established does not crash the process', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    holdHandshakes = true;
    try {
      lockFree = true;
      startFirehoseListener();
      await waitFor(() => heldHandshakes.length === 1); // Connecting: the handshake is on hold
      stopFirehoseListener();
      await wait(100);
      assert.deepStrictEqual(uncaught.map(String), [], 'Closing a connecting socket must not throw');
    } finally {
      holdHandshakes = false;
      for (const done of heldHandshakes.splice(0)) done(false, 503);
      process.off('uncaughtException', onUncaught);
    }
  });

  test('uses a handoff channel that is a plain Postgres identifier', () => {
    assert.match(HANDOFF_CHANNEL, /^nytlabeler_firehose_handoff_[a-z0-9_]+$/);
    assert.ok(HANDOFF_CHANNEL.length <= 63);
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
