import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { LabelerServer } from 'labeler';
import { pool } from '../src/database.js';
import { LABELS_TABLE } from '../src/labeler.js';
import { fetchLabelActivity, fetchRecentPostLabels, resetLabelActivityCount, LAST_HOUR_SCAN_LIMIT } from '../src/label-activity.js';

const originalQuery = pool.query;

describe('Label activity (mocked database)', () => {
  // Serves the two activity queries: new labels since an id, and the recent-window query
  function mockDatabase(newLabels: (sinceId: number) => { n: number; max_id: number | null }, recent: { last_cts: string | null; last_hour: number }) {
    const sinceIds: number[] = [];
    pool.query = (async (sql: string, params: any[]) => {
      if (sql.includes('MAX(id) AS max_id')) {
        sinceIds.push(params[0]);
        return { rows: [newLabels(params[0])] };
      }
      return { rows: [recent] };
    }) as any;
    return sinceIds;
  }

  beforeEach(() => {
    resetLabelActivityCount();
  });

  after(() => {
    pool.query = originalQuery;
    resetLabelActivityCount();
  });

  test('counts the whole table once, then only labels newer than the last id seen', async () => {
    let tableMax = 528950;
    const sinceIds = mockDatabase(
      (sinceId) => (sinceId === 0 ? { n: 528909, max_id: tableMax } : { n: tableMax - sinceId, max_id: tableMax }),
      { last_cts: '2026-09-24T01:14:21.000Z', last_hour: 214 },
    );

    const first = await fetchLabelActivity(new Date('2026-09-24T02:00:00.000Z'));
    assert.deepStrictEqual(first, { total: 528909, lastHour: 214, lastHourCapped: false, lastLabelAt: '2026-09-24T01:14:21.000Z' });

    tableMax += 3; // Three new labels
    const second = await fetchLabelActivity();
    assert.strictEqual(second.total, 528912);
    assert.deepStrictEqual(sinceIds, [0, 528950], 'The second refresh only counts labels after id 528950');
  });

  test('passes the one-hour cutoff to the recent-window query', async () => {
    const params: any[] = [];
    pool.query = (async (sql: string, p: any[]) => {
      if (sql.includes('last_hour')) params.push(p);
      return { rows: [sql.includes('max_id') ? { n: 0, max_id: null } : { last_cts: null, last_hour: 0 }] };
    }) as any;
    await fetchLabelActivity(new Date('2026-09-24T02:00:00.000Z'));
    assert.deepStrictEqual(params, [['2026-09-24T01:00:00.000Z']]);
  });

  test('counts each label once when refreshes overlap', async () => {
    let calls = 0;
    pool.query = (async (sql: string) => {
      if (sql.includes('max_id')) {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { rows: [{ n: 10, max_id: 10 }] };
      }
      return { rows: [{ last_cts: null, last_hour: 0 }] };
    }) as any;
    const [a, b] = await Promise.all([fetchLabelActivity(), fetchLabelActivity()]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(a.total, 10);
    assert.strictEqual(b.total, 10);
  });

  test('handles an empty label table', async () => {
    mockDatabase(() => ({ n: 0, max_id: null }), { last_cts: null, last_hour: 0 });
    assert.deepStrictEqual(await fetchLabelActivity(), { total: 0, lastHour: 0, lastHourCapped: false, lastLabelAt: null });
  });

  test('flags the last-hour count as a lower bound at its scan limit', async () => {
    mockDatabase(() => ({ n: 9000, max_id: 9000 }), { last_cts: '2026-09-24T01:59:00.000Z', last_hour: LAST_HOUR_SCAN_LIMIT });
    const activity = await fetchLabelActivity();
    assert.strictEqual(activity.lastHour, LAST_HOUR_SCAN_LIMIT);
    assert.strictEqual(activity.lastHourCapped, true);
  });

  test('groups recent labels by post, newest post first, labels in issue order', async () => {
    // The query returns labels newest first; post "a" got another label later on
    pool.query = (async () => ({
      rows: [
        { uri: 'at://a', val: 'late', cts: '2026-09-24T01:00:05.000Z' },
        { uri: 'at://b', val: 'world', cts: '2026-09-24T01:00:03.000Z' },
        { uri: 'at://a', val: 'politics', cts: '2026-09-24T01:00:02.000Z' },
        { uri: 'at://a', val: 'us', cts: '2026-09-24T01:00:01.000Z' },
      ],
    })) as any;

    assert.deepStrictEqual(await fetchRecentPostLabels(), [
      { uri: 'at://a', labels: ['us', 'politics', 'late'], timestamp: '2026-09-24T01:00:05.000Z' },
      { uri: 'at://b', labels: ['world'], timestamp: '2026-09-24T01:00:03.000Z' },
    ]);
  });
});

// Runs only against a disposable database. Never point this at the shared nytdata database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe('Label activity (Postgres)', { skip: !testDatabaseUrl && 'TEST_DATABASE_URL is not set' }, () => {
  let testPool: pg.Pool;
  const schema = `nyt_activity_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = `"${schema}".labels`;

  before(async () => {
    testPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await testPool.query(`CREATE SCHEMA "${schema}"`);
    // Same shape as the labeler library's table
    await testPool.query(`CREATE TABLE ${table} (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      src TEXT NOT NULL, uri TEXT NOT NULL, cid TEXT, val TEXT NOT NULL,
      neg BOOLEAN NOT NULL DEFAULT FALSE, cts TEXT NOT NULL, exp TEXT, sig BYTEA)`);
    const rows = [
      ['at://old', 'us', '2026-09-24T00:30:00.000Z'],
      ['at://a', 'us', '2026-09-24T01:10:00.000Z'],
      ['at://a', 'politics', '2026-09-24T01:10:00.010Z'],
      ['at://b', 'world', '2026-09-24T01:50:00.000Z'],
    ];
    for (const [uri, val, cts] of rows) {
      await testPool.query(`INSERT INTO ${table} (src, uri, val, cts) VALUES ('did:plc:x', $1, $2, $3)`, [uri, val, cts]);
    }
    // Run the real SQL against the test table instead of the app's
    pool.query = ((sql: string, params: any[]) => testPool.query(sql.replaceAll(LABELS_TABLE, table), params)) as any;
  });

  after(async () => {
    pool.query = originalQuery;
    resetLabelActivityCount();
    await testPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await testPool.end();
  });

  test('counts all labels and those from the last hour, then keeps the total current', async () => {
    resetLabelActivityCount();
    const activity = await fetchLabelActivity(new Date('2026-09-24T02:00:00.000Z'));
    assert.deepStrictEqual(activity, { total: 4, lastHour: 3, lastHourCapped: false, lastLabelAt: '2026-09-24T01:50:00.000Z' });

    // Two more labels arrive; the next refresh only counts those
    for (const [uri, val, cts] of [['at://c', 'arts', '2026-09-24T01:55:00.000Z'], ['at://c', 'music', '2026-09-24T01:55:00.010Z']]) {
      await testPool.query(`INSERT INTO ${table} (src, uri, val, cts) VALUES ('did:plc:x', $1, $2, $3)`, [uri, val, cts]);
    }
    const next = await fetchLabelActivity(new Date('2026-09-24T02:00:00.000Z'));
    assert.deepStrictEqual(next, { total: 6, lastHour: 5, lastHourCapped: false, lastLabelAt: '2026-09-24T01:55:00.010Z' });
  });

  test('returns recent labels grouped by post', async () => {
    const posts = await fetchRecentPostLabels(5);
    assert.deepStrictEqual(posts, [
      { uri: 'at://c', labels: ['arts', 'music'], timestamp: '2026-09-24T01:55:00.010Z' },
      { uri: 'at://b', labels: ['world'], timestamp: '2026-09-24T01:50:00.000Z' },
      { uri: 'at://a', labels: ['us', 'politics'], timestamp: '2026-09-24T01:10:00.010Z' },
    ]);
  });

  test('keeps the running total exact while several servers insert concurrently', async () => {
    resetLabelActivityCount();
    await fetchLabelActivity(); // Start the running count

    // Two servers sharing the table, each with several concurrent writers, like overlapping
    // instances whose firehose handlers label posts in parallel
    const key = Buffer.from(new Uint8Array(32).fill(7)).toString('hex');
    const servers = [0, 1].map(() => new LabelerServer({
      did: 'did:plc:ragtjsm2j2vknq6zbnujgah7',
      signingKey: key,
      postgres: { pool: testPool, table: `${schema}.labels` },
    }));
    let writing = true;
    const writers = servers.flatMap((server, s) => [0, 1, 2].map(async (w) => {
      for (let i = 0; i < 40; i++) {
        await server.createLabel({ uri: `did:plc:concurrent${s}${w}${i}`, val: 'concurrent' });
      }
    }));
    // Refresh the running total continuously while the writes land
    const poller = (async () => {
      while (writing) {
        await fetchLabelActivity();
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all(writers);
    writing = false;
    await poller;

    const running = (await fetchLabelActivity()).total;
    const actual = (await testPool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
    assert.strictEqual(actual, 6 + 240);
    assert.strictEqual(running, actual, 'The incremental count must not skip any label');
    for (const server of servers) await new Promise<void>((resolve) => server.close(resolve));
  });
});
