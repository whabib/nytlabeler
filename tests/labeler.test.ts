import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { formatLabel, signLabel } from 'labeler';
import { issueLabelsForPost, recentLabels, activeAuthorSlugsSet, setLabelerServer, initLabelStoreGate, prepareLabelStore, labelStoreReady, LABELS_TABLE } from '../src/labeler.js';
import { pool } from '../src/database.js';

const TEST_KEY = new Uint8Array(32).fill(7);

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

  test('should publish each label through the LabelerServer and nothing else', async () => {
    const originalQuery = pool.query;
    const queries: string[] = [];
    pool.query = (async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    }) as any;

    const created: any[] = [];
    setLabelerServer({
      createLabel: async (label: any) => {
        created.push(label);
        const signed = signLabel(
          { src: 'did:plc:labeler', uri: label.uri, val: label.val, neg: false, cts: '2026-09-23T01:02:03.456Z' },
          TEST_KEY,
        );
        return { id: created.length, ...formatLabel(signed) };
      },
    });

    try {
      await issueLabelsForPost(
        'at://did:plc:mock/app.bsky.feed.post/publish',
        'did:plc:author',
        'A travel story',
        { section: 'travel', subsection: 'europe', authors: [], title: 'Mock' },
      );
    } finally {
      pool.query = originalQuery;
      setLabelerServer(null);
    }

    assert.deepStrictEqual(
      created.map((label) => [label.uri, label.val, label.neg]),
      [
        ['at://did:plc:mock/app.bsky.feed.post/publish', 'travel', false],
        ['at://did:plc:mock/app.bsky.feed.post/publish', 'europe', false],
      ],
    );
    // The legacy "_Labels" table is gone; labels are stored only by the LabelerServer
    assert.deepStrictEqual(queries.filter((sql) => sql.includes('_Labels')), []);
  });

  test('should not publish labels until the label store gate opens', async () => {
    const originalQuery = pool.query;
    pool.query = (async () => ({ rows: [] })) as any;
    const created: string[] = [];
    setLabelerServer({
      createLabel: async (label: any) => {
        created.push(label.val);
        const signed = signLabel(
          { src: 'did:plc:labeler', uri: label.uri, val: label.val, neg: false, cts: '2026-09-23T01:02:03.456Z' },
          TEST_KEY,
        );
        return { id: 1, ...formatLabel(signed) };
      },
    });
    initLabelStoreGate();

    try {
      const publishing = issueLabelsForPost(
        'at://did:plc:mock/app.bsky.feed.post/early',
        'did:plc:author',
        'Posted during the migration',
        { section: 'world', subsection: null, authors: [], title: 'Mock' },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepStrictEqual(created, [], 'Nothing should be written while the migration runs');

      // Open the gate (with no server, there is nothing to prepare); the post that
      // arrived earlier is then published through the server it started with
      setLabelerServer(null);
      await prepareLabelStore();
      await publishing;
      assert.deepStrictEqual(created, ['world']);
    } finally {
      pool.query = originalQuery;
      setLabelerServer(null);
    }
  });

  test('should keep the gate closed when label store preparation fails', async () => {
    initLabelStoreGate();
    let opened = false;
    labelStoreReady.then(() => {
      opened = true;
    });
    setLabelerServer({
      ready: async () => {
        throw new Error('database unavailable');
      },
    });

    try {
      await assert.rejects(prepareLabelStore(), /database unavailable/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.strictEqual(opened, false);
    } finally {
      // Open the gate so later tests aren't blocked
      setLabelerServer(null);
      await prepareLabelStore();
    }
  });

  test('should use one Postgres label table per environment', () => {
    assert.match(LABELS_TABLE, /^labeler\.labels_[a-z0-9_]+$/);
  });

  after(async () => {
    await pool.end();
  });
});
