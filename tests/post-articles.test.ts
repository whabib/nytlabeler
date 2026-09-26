import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { pool } from '../src/database.js';
import { POST_ARTICLES_TABLE, preparePostArticlesTable, recordPostArticles } from '../src/post-articles.js';

const originalQuery = pool.query;
const originalConnect = pool.connect;

test('uses one post-articles table per environment, beside the label table', () => {
  assert.match(POST_ARTICLES_TABLE, /^labeler\.post_articles_[a-z0-9_]+$/);
});

// Runs only against a disposable database. Never point this at the shared nytdata database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe('Post articles (Postgres)', { skip: !testDatabaseUrl && 'TEST_DATABASE_URL is not set' }, () => {
  let testPool: pg.Pool;

  before(async () => {
    testPool = new pg.Pool({ connectionString: testDatabaseUrl });
    await testPool.query(`DROP TABLE IF EXISTS ${POST_ARTICLES_TABLE}`);
    // Route the app's pool to the disposable database
    pool.query = testPool.query.bind(testPool) as any;
    pool.connect = testPool.connect.bind(testPool) as any;
  });

  after(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await testPool.query(`DROP TABLE IF EXISTS ${POST_ARTICLES_TABLE}`);
    await testPool.end();
    await pool.end();
  });

  test('creates the table safely when several instances start at once', async () => {
    await Promise.all(Array.from({ length: 6 }, () => preparePostArticlesTable()));
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
});
