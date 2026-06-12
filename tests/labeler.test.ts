import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { issueLabelsForPost, recentLabels, activeAuthorSlugsSet } from '../src/labeler.js';
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

  after(async () => {
    await pool.end();
  });
});
