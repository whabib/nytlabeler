import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { issueLabelsForPost, recentLabels, activeAuthorSlugsSet, ensureDatabaseSequence, setLabelerServer, rehydrateDatabase } from '../src/labeler.js';
import { pool } from '../src/database.js';

describe('Labeler Logic', () => {
  beforeEach(() => {
    // Clear the memory history log before each test
    recentLabels.length = 0;
    
    // Set up a mock set of active/published opinion authors
    activeAuthorSlugsSet.clear();
    activeAuthorSlugsSet.add('ross-douthat');
    activeAuthorSlugsSet.add('jamelle-bouie');
  });

  test('should generate section and subsection labels correctly (without prefixes)', async () => {
    await issueLabelsForPost(
      'at://did:plc:mock/app.bsky.feed.post/123',
      'did:plc:author',
      'Check out this travel guide!',
      {
        section: 'travel',
        subsection: 'review',
        authors: [],
        title: 'Mock Lisbon Restaurants'
      }
    );

    assert.strictEqual(recentLabels.length, 1);
    const log = recentLabels[0];
    assert.deepStrictEqual(log.labels, ['travel', 'review']);
    assert.strictEqual(log.title, 'Mock Lisbon Restaurants');
    assert.strictEqual(log.authorDid, 'did:plc:author');
  });

  test('should only include authors who are active opinion writers with >1 article', async () => {
    await issueLabelsForPost(
      'at://did:plc:mock/app.bsky.feed.post/456',
      'did:plc:author',
      'Opinion column on politics',
      {
        section: 'opinion',
        subsection: null,
        authors: ['Ross Douthat', 'Unpublished Author'],
        title: 'Mock Column'
      }
    );

    assert.strictEqual(recentLabels.length, 1);
    const log = recentLabels[0];
    // 'ross-douthat' is active, but 'unpublished-author' is ignored!
    assert.deepStrictEqual(log.labels, ['opinion', 'ross-douthat']);
  });

  test('should emit no labels when category/subsection is empty and no authors match criteria', async () => {
    await issueLabelsForPost(
      'at://did:plc:mock/app.bsky.feed.post/789',
      'did:plc:author',
      'Another generic social post',
      {
        section: '',
        subsection: '',
        authors: ['Unpublished Author'],
        title: 'Mock Generic Post'
      }
    );

    assert.strictEqual(recentLabels.length, 0);
  });

  test('ensureDatabaseSequence should pad database when cursor is greater than max ID', async () => {
    const executedQueries: any[] = [];
    const mockServer = {
      db: {
        execute: async (query: any) => {
          executedQueries.push(query);
          if (query.sql.includes('MAX(id)')) {
            return { rows: [{ id: 5 }] };
          }
          return { rows: [] };
        }
      }
    };
    setLabelerServer(mockServer);
    await ensureDatabaseSequence(8);
    const insertQueries = executedQueries.filter(q => q.sql.includes('INSERT'));
    assert.strictEqual(insertQueries.length, 3);
    assert.strictEqual(insertQueries[0].args[0], 6);
    setLabelerServer(null);
  });

  test('rehydrateDatabase should query Postgres and populate SQLite database', async () => {
    const originalQuery = pool.query;
    const sqliteQueries: any[] = [];

    // Mock pool.query to simulate fetching labels from Postgres
    pool.query = (async (sqlStr: string, args?: any[]) => {
      if (sqlStr.includes('SELECT id, src')) {
        return {
          rows: [
            {
              id: 1,
              src: 'did:plc:mock',
              uri: 'at://did:plc:mock/post/1',
              cid: null,
              val: 'opinion',
              neg: false,
              cts: '2026-06-13T00:00:00.000Z',
              exp: null,
              sig: new Uint8Array([1, 2, 3])
            },
            {
              id: 2,
              src: 'did:plc:mock',
              uri: 'at://did:plc:mock/post/2',
              cid: null,
              val: 'travel',
              neg: false,
              cts: '2026-06-13T00:01:00.000Z',
              exp: null,
              sig: new Uint8Array([4, 5, 6])
            }
          ]
        };
      }
      return { rows: [] };
    }) as any;

    const mockServer = {
      db: {
        execute: async (query: any) => {
          sqliteQueries.push(query);
          return { rows: [] };
        }
      }
    };
    setLabelerServer(mockServer);

    await rehydrateDatabase();

    assert.strictEqual(sqliteQueries.length, 2);
    assert.ok(sqliteQueries[0].sql.includes('INSERT OR IGNORE INTO labels'));
    assert.strictEqual(sqliteQueries[0].args[0], 1);
    assert.strictEqual(sqliteQueries[1].args[0], 2);

    // Restore original query function and reset mock server
    pool.query = originalQuery;
    setLabelerServer(null);
  });

  after(async () => {
    await pool.end();
  });
});
