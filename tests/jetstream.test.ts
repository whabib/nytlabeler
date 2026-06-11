import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isNytUrl, extractNytUrls } from '../src/jetstream.js';

describe('Jetstream & Link Parser Integration', () => {
  describe('isNytUrl Validation', () => {
    test('should return true for standard https and http www links', () => {
      assert.strictEqual(isNytUrl('https://www.nytimes.com/2026/06/11/opinion/col.html'), true);
      assert.strictEqual(isNytUrl('http://www.nytimes.com/article'), true);
    });

    test('should return true for naked nytimes.com links (no www)', () => {
      assert.strictEqual(isNytUrl('https://nytimes.com/section/abc'), true);
      assert.strictEqual(isNytUrl('http://nytimes.com/'), true);
    });

    test('should return true for valid nytimes.com subdomains', () => {
      assert.strictEqual(isNytUrl('https://mobile.nytimes.com/opinion'), true);
      assert.strictEqual(isNytUrl('http://help.nytimes.com/articles'), true);
    });

    test('should be case-insensitive for host and protocol', () => {
      assert.strictEqual(isNytUrl('HTTPS://WWW.NYTIMES.COM/xyz'), true);
      assert.strictEqual(isNytUrl('Https://Mobile.NyTimes.Com/abc'), true);
    });

    test('should return false for false positives and spoof attempts', () => {
      assert.strictEqual(isNytUrl('https://notnytimes.com/article'), false);
      assert.strictEqual(isNytUrl('https://nytimes.com.spoof.com/article'), false);
      assert.strictEqual(isNytUrl('https://google.com/search?q=nytimes'), false);
      assert.strictEqual(isNytUrl('ftp://nytimes.com/article'), false); // invalid protocol
    });

    test('should return false for malformed or completely invalid URL strings', () => {
      assert.strictEqual(isNytUrl('not-a-url'), false);
      assert.strictEqual(isNytUrl(''), false);
    });
  });

  describe('extractNytUrls Extractor', () => {
    test('should extract url from external embeds (link cards)', () => {
      const mockRecord = {
        embed: {
          $type: 'app.bsky.embed.external',
          external: {
            uri: 'https://www.nytimes.com/2026/06/11/world/europe/ukraine.html',
            title: 'Mock Article',
          },
        },
      };

      const extracted = extractNytUrls(mockRecord);
      assert.deepStrictEqual(extracted, ['https://www.nytimes.com/2026/06/11/world/europe/ukraine.html']);
    });

    test('should ignore non-NYT urls from external embeds', () => {
      const mockRecord = {
        embed: {
          $type: 'app.bsky.embed.external',
          external: {
            uri: 'https://www.washingtonpost.com/article',
            title: 'Mock Article',
          },
        },
      };

      const extracted = extractNytUrls(mockRecord);
      assert.deepStrictEqual(extracted, []);
    });

    test('should extract urls from facets (rich-text links)', () => {
      const mockRecord = {
        facets: [
          {
            features: [
              {
                $type: 'app.bsky.richtext.facet#link',
                uri: 'https://mobile.nytimes.com/2026/col.html',
              },
            ],
          },
          {
            features: [
              {
                $type: 'app.bsky.richtext.facet#mention',
                did: 'did:plc:123',
              },
              {
                $type: 'app.bsky.richtext.facet#link',
                uri: 'https://nytimes.com/another',
              },
            ],
          },
        ],
      };

      const extracted = extractNytUrls(mockRecord);
      assert.deepStrictEqual(extracted.sort(), [
        'https://mobile.nytimes.com/2026/col.html',
        'https://nytimes.com/another',
      ].sort());
    });

    test('should extract urls from plain post text (fallback regex matching)', () => {
      const mockRecord = {
        text: 'Did you read this? http://nytimes.com/opinion/column and https://www.nytimes.com/news/123.html ?',
      };

      const extracted = extractNytUrls(mockRecord);
      assert.deepStrictEqual(extracted.sort(), [
        'http://nytimes.com/opinion/column',
        'https://www.nytimes.com/news/123.html',
      ].sort());
    });

    test('should deduplicate multiple matching URLs in same post', () => {
      const mockRecord = {
        text: 'Check this link: https://www.nytimes.com/2026/opinion.html and here is the same card.',
        embed: {
          $type: 'app.bsky.embed.external',
          external: {
            uri: 'https://www.nytimes.com/2026/opinion.html',
            title: 'Same Link',
          },
        },
        facets: [
          {
            features: [
              {
                $type: 'app.bsky.richtext.facet#link',
                uri: 'https://www.nytimes.com/2026/opinion.html',
              },
            ],
          },
        ],
      };

      const extracted = extractNytUrls(mockRecord);
      assert.strictEqual(extracted.length, 1);
      assert.strictEqual(extracted[0], 'https://www.nytimes.com/2026/opinion.html');
    });

    test('should return empty array for records with no content or invalid records', () => {
      assert.deepStrictEqual(extractNytUrls(null), []);
      assert.deepStrictEqual(extractNytUrls({}), []);
      assert.deepStrictEqual(extractNytUrls({ text: 'just a normal social post without any link' }), []);
    });
  });
});
