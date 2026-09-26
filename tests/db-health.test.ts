import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { pool } from '../src/database.js';
import { stats } from '../src/labeler.js';
import { checkDatabase, refreshDatabaseStatus, resetDatabaseStatus } from '../src/db-health.js';

const originalQuery = pool.query;
const originalLog = console.log;
const originalError = console.error;

describe('Database status check', () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    resetDatabaseStatus();
    logs = [];
    errors = [];
    console.log = (...args: any[]) => { logs.push(String(args[0])); };
    console.error = (...args: any[]) => { errors.push(String(args[0])); };
  });

  after(async () => {
    pool.query = originalQuery;
    console.log = originalLog;
    console.error = originalError;
    resetDatabaseStatus();
    await pool.end();
  });

  test('reports a working database as connected, with the query round trip', async () => {
    const queries: string[] = [];
    pool.query = (async (sql: string) => {
      queries.push(sql);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { rows: [{ '?column?': 1 }] };
    }) as any;

    await refreshDatabaseStatus();
    assert.deepStrictEqual(queries, ['SELECT 1']);
    assert.strictEqual(stats.database?.connected, true);
    assert.ok(stats.database!.latencyMs! >= 10, `latency ${stats.database!.latencyMs}`);
    assert.ok(!Number.isNaN(Date.parse(stats.database!.checkedAt)));
  });

  test('reports a failing database as unreachable, without error details', async () => {
    pool.query = (async () => { throw new Error('connect ECONNREFUSED 10.73.128.3:5432'); }) as any;
    await refreshDatabaseStatus();
    assert.deepStrictEqual(Object.keys(stats.database!).sort(), ['checkedAt', 'connected', 'latencyMs']);
    assert.strictEqual(stats.database!.connected, false);
    assert.strictEqual(stats.database!.latencyMs, null);
    assert.ok(!JSON.stringify(stats.database).includes('10.73.128.3'), 'The public status must not leak the address');
  });

  test('counts a query that gets no answer in time as unreachable', async () => {
    pool.query = (() => new Promise(() => {})) as any; // e.g. a stalled connection or an exhausted pool
    const startedAt = Date.now();
    const status = await checkDatabase(50);
    assert.strictEqual(status.connected, false);
    assert.ok(Date.now() - startedAt < 1000);
    assert.match(errors[0], /Database check failed/);
  });

  test('logs an outage once, and its recovery once', async () => {
    pool.query = (async () => { throw new Error('down'); }) as any;
    await checkDatabase();
    await checkDatabase();
    await checkDatabase();
    assert.strictEqual(errors.length, 1);

    pool.query = (async () => ({ rows: [] })) as any;
    await checkDatabase();
    await checkDatabase();
    assert.deepStrictEqual(logs, ['✅ Database is reachable again.']);
  });
});
