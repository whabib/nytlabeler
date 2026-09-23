import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { LeaderElection, type LeaderClient } from '../src/firehose-leader.js';

/** A stand-in for a pg Client whose advisory lock result and health the test controls. */
class FakeClient extends EventEmitter implements LeaderClient {
  ended = false;
  broken = false;
  constructor(private readonly lockAvailable: () => boolean) {
    super();
  }
  async connect() {}
  async query(text: string) {
    if (this.broken) throw new Error('connection lost');
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired: this.lockAvailable() }] };
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// These tests provoke connection failures on purpose. Their logged stack traces can garble
// the test runner's IPC stream ("Unable to deserialize cloned data"), so keep them quiet.
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = console.warn = console.error = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

describe('LeaderElection', () => {
  test('acquires leadership when the lock is free', async () => {
    let acquired = 0;
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => new FakeClient(() => true),
      retryMs: 10,
      onAcquire: () => acquired++,
      onLose: () => {},
    });
    election.start();
    await wait(30);
    assert.strictEqual(election.isLeader, true);
    assert.strictEqual(acquired, 1, 'onAcquire should fire once, not on every heartbeat');
    await election.stop();
  });

  test('stays on standby while another session holds the lock, then takes over', async () => {
    let lockFree = false;
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => new FakeClient(() => lockFree),
      retryMs: 10,
      onAcquire: () => {},
      onLose: () => {},
    });
    election.start();
    await wait(40);
    assert.strictEqual(election.isLeader, false);

    lockFree = true;
    await wait(40);
    assert.strictEqual(election.isLeader, true);
    await election.stop();
  });

  test('gives up leadership when its connection fails, and competes again', async () => {
    const clients: FakeClient[] = [];
    let lost = 0;
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => {
        const client = new FakeClient(() => true);
        clients.push(client);
        return client;
      },
      retryMs: 10,
      onAcquire: () => {},
      onLose: () => lost++,
    });
    election.start();
    await wait(30);
    assert.strictEqual(election.isLeader, true);

    // The connection drops: the heartbeat fails and leadership is released
    clients[0].broken = true;
    await wait(15);
    assert.strictEqual(lost, 1);
    assert.strictEqual(clients[0].ended, true);

    // A fresh connection is opened and leadership re-acquired
    await wait(40);
    assert.strictEqual(election.isLeader, true);
    assert.ok(clients.length >= 2);
    await election.stop();
  });

  test('treats a closed connection as lost leadership', async () => {
    const clients: FakeClient[] = [];
    let lost = 0;
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => {
        const client = new FakeClient(() => true);
        clients.push(client);
        return client;
      },
      retryMs: 1000,
      onAcquire: () => {},
      onLose: () => lost++,
    });
    election.start();
    await wait(20);
    assert.strictEqual(election.isLeader, true);

    clients[0].emit('end');
    await wait(10);
    assert.strictEqual(election.isLeader, false);
    assert.strictEqual(lost, 1);
    await election.stop();
  });

  test('releases leadership and its connection on stop', async () => {
    const clients: FakeClient[] = [];
    let lost = 0;
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => {
        const client = new FakeClient(() => true);
        clients.push(client);
        return client;
      },
      retryMs: 10,
      onAcquire: () => {},
      onLose: () => lost++,
    });
    election.start();
    await wait(30);
    await election.stop();
    assert.strictEqual(election.isLeader, false);
    assert.strictEqual(lost, 1);
    assert.ok(clients.every((client) => client.ended));
  });
});

// Runs only against a disposable database. Never point this at the shared nytdata database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe('LeaderElection (Postgres)', { skip: !testDatabaseUrl && 'TEST_DATABASE_URL is not set' }, () => {
  test('only one instance leads, and a standby takes over when the leader stops', async () => {
    const lockKey = `nytlabeler:test:${Date.now()}:${Math.random()}`;
    const make = () =>
      new LeaderElection({
        lockKey,
        createClient: () => new pg.Client({ connectionString: testDatabaseUrl }),
        retryMs: 50,
        onAcquire: () => {},
        onLose: () => {},
      });
    const a = make();
    const b = make();
    try {
      a.start();
      await wait(200);
      b.start();
      await wait(300);
      assert.strictEqual(a.isLeader, true);
      assert.strictEqual(b.isLeader, false, 'The second instance must wait while the first holds the lock');

      // The old leader goes away (like an old revision's instance shutting down)
      await a.stop();
      await wait(300);
      assert.strictEqual(b.isLeader, true);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });
});
