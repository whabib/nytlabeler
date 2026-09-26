import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { pool } from '../src/database.js';
import {
  POST_ARTICLES_TABLE,
  METRICS_POOL_OPTIONS,
  MAX_PENDING_WRITES,
  metricsPool,
  preparePostArticlesTable,
  recordPostArticles,
} from '../src/post-articles.js';

const originalMetricsQuery = metricsPool.query;
const originalMetricsConnect = metricsPool.connect;

test('uses one post-articles table per environment, beside the label table', () => {
  assert.match(POST_ARTICLES_TABLE, /^labeler\.post_articles_[a-z0-9_]+$/);
});

test('keeps metrics writes off the shared pool, on one connection with a statement timeout', () => {
  assert.notStrictEqual(metricsPool, pool);
  assert.strictEqual(METRICS_POOL_OPTIONS.max, 1);
  assert.ok(METRICS_POOL_OPTIONS.statement_timeout > 0);
});

test('drops writes beyond the pending limit instead of queueing them', async () => {
  const originalWarn = console.warn;
  const warnings: any[][] = [];
  console.warn = (...args: any[]) => { warnings.push(args); };
  let started = 0;
  let locked = true;
  const hung: (() => void)[] = [];
  // While locked, writes don't finish until released, like inserts waiting on a locked table
  metricsPool.query = (() => {
    started++;
    return locked ? new Promise<void>((resolve) => hung.push(resolve)) : Promise.resolve({ rows: [] });
  }) as any;

  try {
    const writes = Array.from({ length: MAX_PENDING_WRITES + 25 }, (_, i) =>
      recordPostArticles(`at://did:plc:a/app.bsky.feed.post/${i}`, 'did:plc:a', [i]));
    assert.strictEqual(started, MAX_PENDING_WRITES);
    assert.strictEqual(warnings.length, 25);
    assert.match(String(warnings[0][0]), /Dropping articles/);

    // Once the waiting writes finish, new ones go through again
    locked = false;
    for (const release of hung) release();
    await Promise.all(writes);
    await recordPostArticles('at://did:plc:a/app.bsky.feed.post/later', 'did:plc:a', [1]);
    assert.strictEqual(started, MAX_PENDING_WRITES + 1);
  } finally {
    metricsPool.query = originalMetricsQuery;
    console.warn = originalWarn;
  }
});

// Runs only against a disposable database. Never point this at the shared nytdata database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe('Post articles (Postgres)', { skip: !testDatabaseUrl && 'TEST_DATABASE_URL is not set' }, () => {
  let testPool: pg.Pool;
  let testMetricsPool: pg.Pool;

  before(async () => {
    testPool = new pg.Pool({ connectionString: testDatabaseUrl });
    // The metrics pool's own settings, with a short timeout to keep the tests quick
    testMetricsPool = new pg.Pool({ connectionString: testDatabaseUrl, ...METRICS_POOL_OPTIONS, statement_timeout: 300 });
    await testPool.query(`DROP TABLE IF EXISTS ${POST_ARTICLES_TABLE}`);
    // Route the metrics pool to the disposable database
    metricsPool.query = testMetricsPool.query.bind(testMetricsPool) as any;
    metricsPool.connect = testMetricsPool.connect.bind(testMetricsPool) as any;
  });

  after(async () => {
    metricsPool.query = originalMetricsQuery;
    metricsPool.connect = originalMetricsConnect;
    await testPool.query(`DROP TABLE IF EXISTS ${POST_ARTICLES_TABLE}`);
    await testPool.end();
    await testMetricsPool.end();
    await metricsPool.end();
    await pool.end();
  });

  test('creates the table safely when several instances start at once', async () => {
    // A pool per instance (one pool has a single connection, which would run them one at a time)
    const instances = Array.from({ length: 6 }, () => new pg.Pool({ connectionString: testDatabaseUrl, ...METRICS_POOL_OPTIONS }));
    try {
      let next = 0;
      metricsPool.connect = (() => instances[next++ % instances.length].connect()) as any;
      await Promise.all(instances.map(() => preparePostArticlesTable()));
    } finally {
      metricsPool.connect = testMetricsPool.connect.bind(testMetricsPool) as any;
      await Promise.all(instances.map((instancePool) => instancePool.end()));
    }
    await preparePostArticlesTable(); // And again on a later startup

    const { rows } = await testPool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      POST_ARTICLES_TABLE.split('.'),
    );
    assert.deepStrictEqual(rows.map((row) => [row.column_name, row.data_type]), [
      ['id', 'bigint'],
      ['uri', 'text'],
      ['author_did', 'text'],
      ['article_id', 'integer'],
      ['created_at', 'timestamp with time zone'],
    ]);
  });

  test('records one row per post and article, ignoring repeats', async () => {
    await recordPostArticles('at://did:plc:a/app.bsky.feed.post/1', 'did:plc:a', [11, 12, 11]);
    await recordPostArticles('at://did:plc:a/app.bsky.feed.post/1', 'did:plc:a', [12]); // Already recorded
    await recordPostArticles('at://did:plc:b/app.bsky.feed.post/2', 'did:plc:b', [11]);
    await recordPostArticles('at://did:plc:b/app.bsky.feed.post/3', 'did:plc:b', []);

    const { rows } = await testPool.query(
      `SELECT uri, author_did, article_id, created_at FROM ${POST_ARTICLES_TABLE} ORDER BY id`,
    );
    assert.deepStrictEqual(rows.map((row) => [row.uri, row.author_did, row.article_id]), [
      ['at://did:plc:a/app.bsky.feed.post/1', 'did:plc:a', 11],
      ['at://did:plc:a/app.bsky.feed.post/1', 'did:plc:a', 12],
      ['at://did:plc:b/app.bsky.feed.post/2', 'did:plc:b', 11],
    ]);
    for (const row of rows) assert.ok(row.created_at instanceof Date);

    // How often each article was shared
    const shares = await testPool.query(
      `SELECT article_id, COUNT(*)::int AS posts FROM ${POST_ARTICLES_TABLE} GROUP BY article_id ORDER BY article_id`,
    );
    assert.deepStrictEqual(shares.rows, [{ article_id: 11, posts: 2 }, { article_id: 12, posts: 1 }]);
  });

  test('gives up on a write to a locked table after the statement timeout', async () => {
    const originalError = console.error;
    const errors: any[][] = [];
    console.error = (...args: any[]) => { errors.push(args); };
    const locker = await testPool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`LOCK TABLE ${POST_ARTICLES_TABLE} IN ACCESS EXCLUSIVE MODE`);

      const startedAt = Date.now();
      await recordPostArticles('at://did:plc:c/app.bsky.feed.post/4', 'did:plc:c', [13]);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 3000, `The write should time out, but it waited ${elapsed}ms`);
      assert.strictEqual(errors.length, 1);
      assert.match(String(errors[0][2]?.message), /statement timeout/);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      console.error = originalError;
    }

    // The metrics connection is usable again once the lock is gone
    await recordPostArticles('at://did:plc:c/app.bsky.feed.post/4', 'did:plc:c', [13]);
    const { rows } = await testPool.query(`SELECT COUNT(*)::int AS n FROM ${POST_ARTICLES_TABLE} WHERE article_id = 13`);
    assert.strictEqual(rows[0].n, 1);
  });
});
