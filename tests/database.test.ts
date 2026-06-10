import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeNytUrl, slugify } from '../src/database.js';

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
});
