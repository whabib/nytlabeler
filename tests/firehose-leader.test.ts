import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { LeaderElection, type LeaderClient } from '../src/firehose-leader.js';

/** A stand-in for a pg Client whose advisory lock result and health the test controls. */
class FakeClient extends EventEmitter implements LeaderClient {
  ended = false;
  broken = false;
  queries: string[] = [];
  constructor(private readonly lockAvailable: () => boolean, private readonly connectDelayMs = 0) {
    super();
  }
  async connect() {
    if (this.connectDelayMs) await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
  }
  async query(text: string) {
    this.queries.push(text);
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

  test('does not keep a connection that finished opening after stop()', async () => {
    const clients: FakeClient[] = [];
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => {
        const client = new FakeClient(() => true, 50);
        clients.push(client);
        return client;
      },
      retryMs: 10,
      onAcquire: () => {},
      onLose: () => {},
    });
    election.start();
    await wait(5); // The connection is still opening
    await election.stop();
    await wait(100);

    assert.strictEqual(election.isLeader, false);
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].ended, true, 'The late connection must be closed');
    assert.ok(
      !clients[0].queries.some((q) => q.includes('pg_try_advisory_lock')),
      'The lock must not be taken after stop()',
    );
  });

  test('runs the leader tick on each heartbeat, and a failing tick keeps leadership', async () => {
    let ticks = 0;
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => new FakeClient(() => true),
      retryMs: 10,
      onAcquire: () => {},
      onLose: () => {},
      onLeaderTick: () => {
        ticks++;
        if (ticks === 1) throw new Error('setting lookup failed');
      },
    });
    election.start();
    await wait(60);
    assert.ok(ticks >= 2, `expected several ticks, got ${ticks}`);
    assert.strictEqual(election.isLeader, true);
    await election.stop();
  });
});

/**
 * A stand-in for Postgres shared by several sessions: one advisory lock, LISTEN/NOTIFY, and
 * the lock released when its session ends.
 */
class FakeDatabase {
  lockOwner: FakeSession | null = null;
  /** Holds each LISTEN this long, to let a test act while one is in flight. */
  listenDelayMs = 0;
  readonly sessions = new Set<FakeSession>();
  notify(channel: string, payload: string) {
    for (const session of this.sessions) {
      if (session.listening.has(channel)) setImmediate(() => session.emit('notification', { channel, payload }));
    }
  }
}

class FakeSession extends EventEmitter implements LeaderClient {
  readonly listening = new Set<string>();
  readonly queries: string[] = [];
  failUnlock = false;
  constructor(private readonly db: FakeDatabase) {
    super();
  }
  async connect() {
    this.db.sessions.add(this);
  }
  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    if (text.includes('pg_try_advisory_lock')) {
      const acquired = !this.db.lockOwner || this.db.lockOwner === this;
      if (acquired) this.db.lockOwner = this;
      return { rows: [{ acquired }] };
    }
    if (text.includes('pg_advisory_unlock')) {
      if (this.failUnlock) throw new Error('connection lost');
      if (this.db.lockOwner === this) this.db.lockOwner = null;
    }
    const listen = /^(UN)?LISTEN "(.+)"$/.exec(text);
    if (listen && !listen[1] && this.db.listenDelayMs) await new Promise((resolve) => setTimeout(resolve, this.db.listenDelayMs));
    if (listen) {
      if (listen[1]) this.listening.delete(listen[2]);
      else this.listening.add(listen[2]);
    }
    if (text.includes('pg_notify')) this.db.notify(String(values[0]), String(values[1]));
    return { rows: [] };
  }
  async end() {
    this.db.sessions.delete(this);
    if (this.db.lockOwner === this) this.db.lockOwner = null;
  }
}

describe('LeaderElection handoff', () => {
  const CHANNEL = 'test_handoff';
  const events: string[] = [];
  let db: FakeDatabase;
  const elections: LeaderElection[] = [];

  function instance(name: string, startedAt: number, extra: Partial<ConstructorParameters<typeof LeaderElection>[0]> = {}) {
    const sessions: FakeSession[] = [];
    const election = new LeaderElection({
      lockKey: 'test',
      createClient: () => {
        const session = new FakeSession(db);
        sessions.push(session);
        return session;
      },
      retryMs: 20,
      handoffPollMs: 5,
      yieldGraceMs: 200,
      handoffChannel: CHANNEL,
      instanceId: name,
      startedAt,
      onAcquire: () => events.push(`${name} acquired`),
      onLose: () => events.push(`${name} lost (lock held: ${db.lockOwner !== null})`),
      ...extra,
    });
    elections.push(election);
    return { election, sessions };
  }

  // Samples every millisecond: at most one instance may ever believe it leads
  function watchForTwoLeaders() {
    let overlaps = 0;
    const timer = setInterval(() => {
      if (elections.filter((e) => e.isLeader).length > 1) overlaps++;
    }, 1);
    return () => {
      clearInterval(timer);
      return overlaps;
    };
  }

  test.beforeEach(() => {
    db = new FakeDatabase();
    events.length = 0;
    elections.length = 0;
  });

  test.afterEach(async () => {
    await Promise.all(elections.map((e) => e.stop()));
  });

  test('a newer instance takes over from a running leader within moments', async () => {
    const old = instance('old', 1_000);
    old.election.start();
    await wait(50);
    assert.strictEqual(old.election.isLeader, true);

    const stopWatching = watchForTwoLeaders();
    const newer = instance('new', 2_000);
    newer.election.start();
    await wait(100);
    const overlaps = stopWatching();

    assert.strictEqual(newer.election.isLeader, true);
    assert.strictEqual(old.election.isLeader, false);
    assert.strictEqual(overlaps, 0, 'Two instances led at the same time');
    // The old leader stopped leading (closing its firehose) while it still held the lock,
    // so the new one could only start after that
    assert.deepStrictEqual(events, ['old acquired', 'old lost (lock held: true)', 'new acquired']);
  });

  test('the old instance keeps its connection and stays on standby', async () => {
    const old = instance('old', 1_000);
    old.election.start();
    await wait(50);
    instance('new', 2_000).election.start();
    await wait(300); // Past the grace period: it competes again, and asks, but it's older
    assert.strictEqual(old.election.isLeader, false);
    assert.strictEqual(old.sessions.length, 1, 'It reuses its connection rather than reconnecting');
    assert.ok(old.sessions[0].queries.some((q) => q.includes('pg_advisory_unlock')));
    assert.deepStrictEqual(events, ['old acquired', 'old lost (lock held: true)', 'new acquired']);
  });

  test('ignores requests from an older instance', async () => {
    const leader = instance('leader', 2_000);
    leader.election.start();
    await wait(50);
    const older = instance('older', 1_000);
    older.election.start();
    await wait(150);
    assert.strictEqual(leader.election.isLeader, true);
    assert.strictEqual(older.election.isLeader, false);
    assert.ok(older.sessions[0].queries.some((q) => q.includes('pg_notify')), 'It did ask');
  });

  test('ignores malformed requests, other channels and its own id', async () => {
    const leader = instance('leader', 2_000);
    leader.election.start();
    await wait(50);
    const session = leader.sessions[0];
    for (const payload of ['not json', '{}', '{"instanceId":5,"startedAt":9999}', '{"instanceId":"x","startedAt":"soon"}', '{"instanceId":"leader","startedAt":9999}']) {
      session.emit('notification', { channel: CHANNEL, payload });
    }
    session.emit('notification', { channel: 'other_channel', payload: '{"instanceId":"x","startedAt":9999}' });
    await wait(30);
    assert.strictEqual(leader.election.isLeader, true);
  });

  test('after stepping down, leaves the lock to the newer instance for a grace period', async () => {
    const old = instance('old', 1_000);
    old.election.start();
    await wait(50);
    // A newer instance asks, then goes away before it takes the lock
    const newer = instance('new', 2_000, { handoffPollMs: 1_000, retryMs: 1_000 });
    newer.election.start();
    await wait(30);
    await newer.election.stop();
    assert.strictEqual(old.election.isLeader, false);
    assert.strictEqual(db.lockOwner, null);

    await wait(100); // Within the 200 ms grace period
    assert.strictEqual(old.election.isLeader, false, 'It must not grab the lock back right away');
    await wait(200); // After it, the old instance leads again
    assert.strictEqual(old.election.isLeader, true);
  });

  test('closes its connection, which releases the lock, if it cannot release the lock', async () => {
    const old = instance('old', 1_000);
    old.election.start();
    await wait(50);
    old.sessions[0].failUnlock = true;
    const newer = instance('new', 2_000);
    newer.election.start();
    await wait(100);
    assert.strictEqual(newer.election.isLeader, true);
    assert.ok(!db.sessions.has(old.sessions[0]), 'The old session was closed');
  });

  test('without a handoff channel, a standby only waits', async () => {
    const leader = instance('leader', 1_000, { handoffChannel: undefined });
    leader.election.start();
    await wait(50);
    const newer = instance('new', 2_000, { handoffChannel: undefined });
    newer.election.start();
    await wait(100);
    assert.strictEqual(leader.election.isLeader, true);
    assert.ok(!newer.sessions[0].queries.some((q) => q.includes('pg_notify') || q.startsWith('LISTEN')));
  });

  test('waits for beforeRelease, holding the lock, before the newer instance can lead', async () => {
    let finishWork: () => void = () => {};
    const old = instance('old', 1_000, {
      beforeRelease: () => {
        events.push(`old draining (lock held: ${db.lockOwner !== null})`);
        return new Promise<void>((resolve) => {
          finishWork = () => {
            events.push('old drained');
            resolve();
          };
        });
      },
    });
    old.election.start();
    await wait(50);
    const newer = instance('new', 2_000);
    newer.election.start();
    await wait(100);
    // Still draining: the lock stays with the old instance, and nobody leads
    assert.strictEqual(newer.election.isLeader, false);
    assert.strictEqual(old.election.isLeader, false);
    assert.strictEqual(db.lockOwner, old.sessions[0]);

    finishWork();
    await wait(150);
    assert.strictEqual(newer.election.isLeader, true);
    assert.deepStrictEqual(events, [
      'old acquired', 'old lost (lock held: true)', 'old draining (lock held: true)', 'old drained', 'new acquired',
    ]);
  });

  test('closes its connection, releasing the lock, if beforeRelease fails', async () => {
    const old = instance('old', 1_000, { beforeRelease: async () => { throw new Error('drain failed'); } });
    old.election.start();
    await wait(50);
    const newer = instance('new', 2_000);
    newer.election.start();
    await wait(100);
    assert.strictEqual(newer.election.isLeader, true);
    assert.ok(!db.sessions.has(old.sessions[0]));
  });

  test('does not lead if stopped while it was setting up as leader', async () => {
    db.listenDelayMs = 40;
    const leader = instance('leader', 1_000);
    leader.election.start();
    await wait(10); // It holds the lock and is waiting on LISTEN
    await leader.election.stop();
    await wait(60);
    assert.strictEqual(leader.election.isLeader, false);
    assert.deepStrictEqual(events, [], 'onAcquire must not run for a stopped election');
    assert.strictEqual(db.lockOwner, null, 'Ending the session released the lock');
  });

  test('ignores requests with out-of-range times or oversized ids, without failing', async () => {
    const leader = instance('leader', 2_000);
    leader.election.start();
    await wait(50);
    const session = leader.sessions[0];
    for (const request of [
      { instanceId: 'x', startedAt: 1e20 }, // Newer, but not a valid Date
      { instanceId: 'x', startedAt: -1e20 },
      { instanceId: 'x'.repeat(201), startedAt: 9_999 },
      { instanceId: '', startedAt: 9_999 },
    ]) {
      session.emit('notification', { channel: CHANNEL, payload: JSON.stringify(request) });
    }
    await wait(30);
    assert.strictEqual(leader.election.isLeader, true);
    assert.strictEqual(db.lockOwner, session);
    assert.deepStrictEqual(events, ['leader acquired']);
  });

  test('rejects a channel name that is not a plain identifier', () => {
    assert.throws(() => instance('x', 1, { handoffChannel: 'bad"; DROP TABLE x; --' }), /Invalid handoff channel/);
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

  test('a newer instance takes over from a running leader through Postgres LISTEN/NOTIFY', async () => {
    const lockKey = `nytlabeler:test:${Date.now()}:${Math.random()}`;
    const handoffChannel = `nytlabeler_test_handoff_${process.pid}`;
    const make = (instanceId: string, startedAt: number) =>
      new LeaderElection({
        lockKey,
        handoffChannel,
        instanceId,
        startedAt,
        createClient: () => new pg.Client({ connectionString: testDatabaseUrl }),
        retryMs: 50,
        handoffPollMs: 10,
        yieldGraceMs: 300,
        onAcquire: () => {},
        onLose: () => {},
      });
    const old = make('old', Date.now() - 60_000);
    const newer = make('new', Date.now());
    try {
      old.start();
      await wait(200);
      assert.strictEqual(old.isLeader, true);

      newer.start();
      await wait(400);
      assert.strictEqual(newer.isLeader, true);
      assert.strictEqual(old.isLeader, false);

      // Past the grace period the old instance competes again, but stays on standby
      await wait(500);
      assert.strictEqual(newer.isLeader, true);
      assert.strictEqual(old.isLeader, false);
    } finally {
      await Promise.all([old.stop(), newer.stop()]);
    }
  });
});
