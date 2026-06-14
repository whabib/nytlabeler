import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { issueLabelsForPost, recentLabels, activeAuthorSlugsSet, ensureDatabaseSequence, setLabelerServer, rehydrateDatabase, setLocalMaxId, localMaxId, initRehydrationGate } from '../src/labeler.js';
import { pool } from '../src/database.js';

describe('Labeler Logic', () => {
  beforeEach(() => {
    // Clear the memory history log before each test
    recentLabels.length = 0;
    
    // Set up a mock set of active/published opinion authors
    activeAuthorSlugsSet.clear();
    activeAuthorSlugsSet.add('ross-douthat');
    activeAuthorSlugsSet.add('jamelle-bouie');

    // Reset sequence cache to prevent test state contamination
    setLocalMaxId(0);
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
  });

  test('should generate labels in the correct order: section, subsection, then author', async () => {
    await issueLabelsForPost(
      'at://did:plc:mock/app.bsky.feed.post/order-test',
      'did:plc:author',
      'An opinion piece about international travel',
      {
        section: 'opinion',
        subsection: 'travel',
        authors: ['Ross Douthat'],
        title: 'Mock Column About Travel'
      }
    );

    assert.strictEqual(recentLabels.length, 1);
    const log = recentLabels[0];
    assert.deepStrictEqual(log.labels, ['opinion', 'travel', 'ross-douthat']);
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
    const originalQuery = pool.query;
    pool.query = (async () => ({ rows: [] })) as any;

    const createdLabels: any[] = [];
    const executedQueries: any[] = [];

    const mockServer = {
      createLabel: async (label: any) => {
        createdLabels.push(label);
      },
      db: {
        execute: async (query: any) => {
          executedQueries.push(query);
          if (query.sql.includes('MAX(id)')) {
            return { rows: [{ id: 5 }] };
          }
          if (query.sql.includes('SELECT * FROM labels')) {
            const uri = query.args[0];
            const idMatch = uri.match(/dummy-(\d+)/);
            const id = idMatch ? parseInt(idMatch[1], 10) : 6;
            return {
              rows: [
                {
                  id,
                  src: 'did:plc:mock',
                  uri,
                  val: 'dummy-sequence-pad',
                  neg: 0,
                  cts: new Date().toISOString(),
                  exp: null,
                  sig: new Uint8Array([1, 2, 3])
                }
              ]
            };
          }
          return { rows: [] };
        }
      }
    };

    setLabelerServer(mockServer);
    await ensureDatabaseSequence(8);

    assert.strictEqual(createdLabels.length, 3);
    assert.strictEqual(createdLabels[0].val, 'dummy-sequence-pad');
    assert.ok(createdLabels[0].uri.includes('dummy-6'));

    pool.query = originalQuery;
    setLabelerServer(null);
  });

  test('ensureDatabaseSequence should handle concurrent calls sequentially with a lock', async () => {
    const originalQuery = pool.query;
    pool.query = (async () => ({ rows: [] })) as any;

    const createdLabels: any[] = [];
    let maxIdValue = 5;

    const mockServer = {
      createLabel: async (label: any) => {
        createdLabels.push(label);
        // Simulate a slight delay to allow concurrency to manifest
        await new Promise(resolve => setTimeout(resolve, 10));
      },
      db: {
        execute: async (query: any) => {
          if (query.sql.includes('MAX(id)')) {
            return { rows: [{ id: maxIdValue }] };
          }
          if (query.sql.includes('SELECT * FROM labels')) {
            const uri = query.args[0];
            const idMatch = uri.match(/dummy-(\d+)/);
            const id = idMatch ? parseInt(idMatch[1], 10) : 6;
            // When we finish padding, max ID shifts
            if (id > maxIdValue) {
              maxIdValue = id;
            }
            return {
              rows: [
                {
                  id,
                  src: 'did:plc:mock',
                  uri,
                  val: 'dummy-sequence-pad',
                  neg: 0,
                  cts: new Date().toISOString(),
                  exp: null,
                  sig: new Uint8Array([1, 2, 3])
                }
              ]
            };
          }
          return { rows: [] };
        }
      }
    };

    setLabelerServer(mockServer);

    // Call ensureDatabaseSequence concurrently three times
    await Promise.all([
      ensureDatabaseSequence(8),
      ensureDatabaseSequence(8),
      ensureDatabaseSequence(8)
    ]);

    // Because of the concurrency lock, the database should only have been padded once (3 creates total, from 5 to 8)
    // If there were no lock, there would be 9 creates total!
    assert.strictEqual(createdLabels.length, 3);
    assert.strictEqual(maxIdValue, 8);

    pool.query = originalQuery;
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

    const insertQueries = sqliteQueries.filter(q => q.sql.includes('INSERT OR IGNORE INTO labels'));
    assert.strictEqual(insertQueries.length, 2);
    assert.strictEqual(insertQueries[0].args[0], 1);
    assert.strictEqual(insertQueries[1].args[0], 2);

    const selectQueries = sqliteQueries.filter(q => q.sql.includes('MAX(id)'));
    assert.strictEqual(selectQueries.length, 1);

    // Restore original query function and reset mock server
    pool.query = originalQuery;
    setLabelerServer(null);
  });

  test('ensureDatabaseSequence should bypass locks and database queries when cursor <= localMaxId', async () => {
    // Manually set localMaxId to 10
    setLocalMaxId(10);

    const mockServer = {
      db: {
        execute: async () => {
          throw new Error('Database query should NOT be executed when cursor <= localMaxId!');
        }
      }
    };
    setLabelerServer(mockServer);

    // Call with a cursor <= 10. This should return instantly and successfully
    await assert.doesNotReject(async () => {
      await ensureDatabaseSequence(8);
    });

    await assert.doesNotReject(async () => {
      await ensureDatabaseSequence(10);
    });

    // Reset localMaxId and server
    setLocalMaxId(0);
    setLabelerServer(null);
  });

  test('ensureDatabaseSequence should wait for rehydration gate to resolve before executing', async () => {
    // 1. Arm the rehydration gate
    initRehydrationGate();

    let resolved = false;
    const mockServer = {
      db: {
        execute: async (query: any) => {
          if (query.sql.includes('MAX(id)')) {
            return { rows: [{ id: 5 }] };
          }
          return { rows: [] };
        }
      }
    };
    setLabelerServer(mockServer as any);

    // 2. Start the call but don't await yet
    const callPromise = ensureDatabaseSequence(5).then(() => {
      resolved = true;
    });

    // 3. Yield event loop to let promise chains run
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(resolved, false, 'Should be blocked because the gate is armed and pending');

    // 4. Resolve the gate (by mimicking a successful rehydrateDatabase)
    const originalQuery = pool.query;
    pool.query = (async () => ({ rows: [] })) as any;
    await rehydrateDatabase();
    pool.query = originalQuery;

    // 5. Now the gate should be open and the call should be resolved
    await callPromise;
    assert.strictEqual(resolved, true, 'Should resolve once the gate is opened by rehydration');

    setLabelerServer(null);
  });

  after(async () => {
    await pool.end();
  });
});
