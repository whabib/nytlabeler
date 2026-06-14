import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { normalizeNytUrl, slugify, saveSetting, loadSetting, getDistinctCategories, pool } from '../src/database.js';
import { formatDisplayName } from '../src/publish-definitions.js';

describe('Database Helpers', () => {
  describe('normalizeNytUrl', () => {
    test('should normalize http to https and prepend www. if missing', () => {
      const url1 = 'http://nytimes.com/2026/06/03/travel/lisbon.html';
      const url2 = 'https://nytimes.com/2026/06/03/travel/lisbon.html';
      
      assert.strictEqual(normalizeNytUrl(url1), 'https://www.nytimes.com/2026/06/03/travel/lisbon.html');
      assert.strictEqual(normalizeNytUrl(url2), 'https://www.nytimes.com/2026/06/03/travel/lisbon.html');
    });

    test('should strip off query parameters and hash components', () => {
      const url = 'https://www.nytimes.com/2026/06/03/travel/lisbon.html?smid=nytcore-ios-share&referringSource=articleShare#comments';
      
      assert.strictEqual(normalizeNytUrl(url), 'https://www.nytimes.com/2026/06/03/travel/lisbon.html');
    });

    test('should trim whitespace around the url', () => {
      const url = '  https://www.nytimes.com/2026/06/03/travel/lisbon.html  ';
      assert.strictEqual(normalizeNytUrl(url), 'https://www.nytimes.com/2026/06/03/travel/lisbon.html');
    });

    test('should return original trimmed string if URL parsing fails', () => {
      const invalidUrl = 'not-a-valid-url';
      assert.strictEqual(normalizeNytUrl(invalidUrl), 'not-a-valid-url');
    });
  });

  describe('slugify', () => {
    test('should convert text to lowercase and replace non-alphanumeric with hyphens', () => {
      assert.strictEqual(slugify('Ross Douthat'), 'ross-douthat');
      assert.strictEqual(slugify('Science & Technology'), 'science-technology');
    });

    test('should normalize accent characters and diacritics', () => {
      assert.strictEqual(slugify('François-René'), 'francois-rene');
    });

    test('should trim leading and trailing hyphens', () => {
      assert.strictEqual(slugify('--Some Section Name--'), 'some-section-name');
    });
  });

  describe('Settings Persistence (Environment-Aware)', () => {
    test('should save and load settings with the correct environment scoping', async (t) => {
      const mockDb = new Map<string, string>(); // key format: "env:key" -> value

      // Mock pool.query
      const queryMock = t.mock.method(pool, 'query', async (sql: string, params?: any[]) => {
        const sqlNormalized = sql.trim().replace(/\s+/g, ' ');

        // 1. Handle SELECT value FROM "_Settings" WHERE environment = $1 AND key = $2
        if (sqlNormalized.includes('SELECT value FROM "_Settings"')) {
          const env = params?.[0];
          const key = params?.[1];
          const mockKey = `${env}:${key}`;
          const value = mockDb.get(mockKey);
          if (value === undefined) {
            return { rows: [] };
          }
          return { rows: [{ value }] };
        }

        // 2. Handle INSERT INTO "_Settings" (environment, key, value) ... ON CONFLICT
        if (sqlNormalized.includes('INSERT INTO "_Settings"')) {
          const env = params?.[0];
          const key = params?.[1];
          const value = params?.[2];
          const mockKey = `${env}:${key}`;
          mockDb.set(mockKey, value);
          return { rows: [] };
        }

        // Fallback for other database operations (table check, create table etc.)
        if (sqlNormalized.includes('SELECT column_name') && sqlNormalized.includes('_Settings')) {
          // Mock information schema check - return environment column as existing
          return { rows: [{ column_name: 'environment' }] };
        }

        return { rows: [] };
      });

      // Assert environment separation:
      // First, save 'firehose_enabled' = 'false'
      await saveSetting('firehose_enabled', 'false');

      // Check that it was saved under the current ENV
      const loadedValue = await loadSetting('firehose_enabled', 'true');
      assert.strictEqual(loadedValue, 'false');

      // Now verify that if we query for a different environment (by simulating mock data for 'production'),
      // they don't leak or conflict with each other.
      mockDb.set('production:firehose_enabled', 'true');
      mockDb.set('development:firehose_enabled', 'false');

      const insertCalls = queryMock.mock.calls.filter(c => c.arguments[0].includes('INSERT'));
      assert.ok(insertCalls.length >= 1, 'Should have made at least one INSERT query');
      const firstInsertArgs = insertCalls[0].arguments[1];
      assert.strictEqual(firstInsertArgs[1], 'firehose_enabled');
      assert.strictEqual(firstInsertArgs[2], 'false');

      const selectCalls = queryMock.mock.calls.filter(c => c.arguments[0].includes('SELECT value'));
      assert.ok(selectCalls.length >= 1, 'Should have made at least one SELECT query');
      const firstSelectArgs = selectCalls[0].arguments[1];
      assert.strictEqual(firstSelectArgs[0], firstInsertArgs[0], 'Should query the exact same environment it saved to');
      assert.strictEqual(firstSelectArgs[1], 'firehose_enabled');
    });

    test('should fall back to default value if setting is not found', async (t) => {
      // Mock pool.query to return empty result
      t.mock.method(pool, 'query', async () => {
        return { rows: [] };
      });

      const loaded = await loadSetting('non_existent_key', 'default_val');
      assert.strictEqual(loaded, 'default_val');
    });

    test('should auto-create or migrate table if querying fails', async (t) => {
      let createdTable = false;
      let checkedColumns = false;

      t.mock.method(pool, 'query', async (sql: string) => {
        const sqlNormalized = sql.trim().replace(/\s+/g, ' ');
        if (sqlNormalized.includes('SELECT value FROM "_Settings"')) {
          throw new Error('Relation "_Settings" does not exist');
        }
        if (sqlNormalized.includes('CREATE TABLE IF NOT EXISTS "_Settings"')) {
          createdTable = true;
          return { rows: [] };
        }
        if (sqlNormalized.includes('SELECT column_name') && sqlNormalized.includes('_Settings')) {
          checkedColumns = true;
          return { rows: [] }; // Mock that 'environment' column is missing to trigger drop/recreate
        }
        if (sqlNormalized.includes('DROP TABLE IF EXISTS "_Settings"')) {
          return { rows: [] };
        }
        if (sqlNormalized.includes('CREATE TABLE "_Settings"')) {
          createdTable = true;
          return { rows: [] };
        }
        return { rows: [] };
      });

      const loaded = await loadSetting('firehose_enabled', 'true');
      assert.strictEqual(loaded, 'true');
      assert.ok(createdTable, 'Should have attempted to create settings table');
      assert.ok(checkedColumns, 'Should have checked column schemas for environment column existence');
    });
  });

  describe('getDistinctCategories', () => {
    test('should format "us" as "US" and deduplicate results', async (t) => {
      // Mock pool.query to simulate rows with varying casings of 'us'
      t.mock.method(pool, 'query', async (sql: string) => {
        const sqlNormalized = sql.trim().replace(/\s+/g, ' ');
        if (sqlNormalized.includes('SELECT DISTINCT section')) {
          return {
            rows: [
              { section: 'travel' },
              { section: 'us' },
              { section: 'US' },
              { section: 'Us' }
            ]
          };
        }
        if (sqlNormalized.includes('SELECT DISTINCT subsection')) {
          return {
            rows: [
              { subsection: 'politics' },
              { subsection: 'us' },
              { subsection: null }
            ]
          };
        }
        return { rows: [] };
      });

      const categories = await getDistinctCategories();
      
      // 'travel' remains, while 'us', 'US', 'Us' are mapped to 'US' and deduplicated
      assert.deepStrictEqual(categories.sections, ['travel', 'US']);
      
      // 'politics' remains, 'us' becomes 'US', and null/empty is filtered out
      assert.deepStrictEqual(categories.subsections, ['politics', 'US']);
    });
  });

  describe('formatDisplayName', () => {
    test('should format "us" as "US" case-insensitively', () => {
      assert.strictEqual(formatDisplayName('us'), 'US');
      assert.strictEqual(formatDisplayName('Us'), 'US');
      assert.strictEqual(formatDisplayName('US'), 'US');
    });

    test('should capitalize first letter of other categories', () => {
      assert.strictEqual(formatDisplayName('politics'), 'Politics');
      assert.strictEqual(formatDisplayName('travel'), 'Travel');
      assert.strictEqual(formatDisplayName('opinion'), 'Opinion');
    });
  });

  after(async () => {
    await pool.end();
  });
});
