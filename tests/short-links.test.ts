import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { isShortLink, extractShortLinks, resolveShortLink, configureShortLinks } from '../src/short-links.js';
import { isNytUrl } from '../src/jetstream.js';

const ARTICLE = 'https://www.nytimes.com/2026/10/21/opinion/trump-ilhan-omar-emma-goldman.html?smid=bsky-nytimes&smtyp=cur';

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = console.warn = console.error = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

/** A fake fetch: each URL maps to a redirect target, a status, an error, or a slow response. */
function fakeFetch(routes: Record<string, string | number | Error | (() => Promise<Response>)>) {
  const requests: { url: string; method: string; redirect?: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, method: String(init.method), redirect: init.redirect });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request to ${url}`);
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route();
    if (typeof route === 'number') return new Response(null, { status: route });
    return new Response(null, { status: 301, headers: { location: route } });
  };
  return { fetch, requests };
}

describe('isShortLink', () => {
  test('accepts nyti.ms and trib.al links', () => {
    for (const url of ['https://nyti.ms/3VZJtSp', 'http://nyti.ms/abc', 'https://www.nyti.ms/abc', 'https://trib.al/gUvJkPN', 'HTTPS://NYTI.MS/abc']) {
      assert.strictEqual(isShortLink(url), true, url);
    }
  });

  test('rejects other hosts, lookalikes and other protocols', () => {
    for (const url of [
      'https://nyti.ms.evil.com/abc', 'https://evil.com/nyti.ms/abc', 'https://evilnyti.ms/abc', 'https://www.nytimes.com/x',
      'ftp://nyti.ms/abc', 'javascript:alert(1)', 'not a url',
    ]) {
      assert.strictEqual(isShortLink(url), false, url);
    }
  });
});

describe('extractShortLinks', () => {
  test('finds short links in the link card, link facets and text, once each', () => {
    const record = {
      text: 'Read https://nyti.ms/inText and https://nyti.ms/3VZJtSp',
      embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://nyti.ms/3VZJtSp' } },
      facets: [
        { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://trib.al/gUvJkPN' }] },
        { features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:x' }] },
      ],
    };
    assert.deepStrictEqual(extractShortLinks(record).sort(), ['https://nyti.ms/3VZJtSp', 'https://nyti.ms/inText', 'https://trib.al/gUvJkPN']);
  });

  test('leaves punctuation after a short link in the text out of the link', () => {
    for (const text of ['Read (https://nyti.ms/3VZJtSp)', 'Read https://nyti.ms/3VZJtSp.', 'Read https://nyti.ms/3VZJtSp, then this', '"https://nyti.ms/3VZJtSp"!']) {
      assert.deepStrictEqual(extractShortLinks({ text }), ['https://nyti.ms/3VZJtSp'], text);
    }
    // Link cards and facets carry the full URL, which is kept as it is
    const uri = 'https://trib.al/gUvJkPN?utm_source=x';
    assert.deepStrictEqual(extractShortLinks({ embed: { $type: 'app.bsky.embed.external', external: { uri } } }), [uri]);
  });

  test('ignores posts without short links, and malformed records', () => {
    assert.deepStrictEqual(extractShortLinks({ text: 'https://www.nytimes.com/x https://bit.ly/y' }), []);
    for (const record of [null, undefined, {}, { facets: 'x' }, { facets: [null, { features: 'x' }] }, { embed: { $type: 'app.bsky.embed.external', external: { uri: 5 } } }]) {
      assert.deepStrictEqual(extractShortLinks(record), []);
    }
  });
});

describe('resolveShortLink', () => {
  beforeEach(() => configureShortLinks({ fetch: fakeFetch({}).fetch }));

  test('follows nyti.ms through trib.al to the article, without fetching the article', async () => {
    const { fetch, requests } = fakeFetch({ 'https://nyti.ms/3VZJtSp': 'https://trib.al/gUvJkPN', 'https://trib.al/gUvJkPN': ARTICLE });
    configureShortLinks({ fetch });
    assert.strictEqual(await resolveShortLink('https://nyti.ms/3VZJtSp', isNytUrl), ARTICLE);
    assert.deepStrictEqual(requests.map((r) => r.url), ['https://nyti.ms/3VZJtSp', 'https://trib.al/gUvJkPN']);
    assert.ok(requests.every((r) => r.method === 'HEAD' && r.redirect === 'manual'));
  });

  test('upgrades http short links to https, and resolves relative redirects', async () => {
    const { fetch, requests } = fakeFetch({ 'https://nyti.ms/abc': '/def', 'https://nyti.ms/def': ARTICLE });
    configureShortLinks({ fetch });
    assert.strictEqual(await resolveShortLink('http://nyti.ms/abc', isNytUrl), ARTICLE);
    assert.deepStrictEqual(requests.map((r) => r.url), ['https://nyti.ms/abc', 'https://nyti.ms/def']);
  });

  test('never follows a redirect to a host that is not a short link', async () => {
    const { fetch, requests } = fakeFetch({ 'https://trib.al/other': 'https://example.com/story', 'https://trib.al/internal': 'http://169.254.169.254/latest' });
    configureShortLinks({ fetch });
    assert.strictEqual(await resolveShortLink('https://trib.al/other', isNytUrl), null);
    assert.strictEqual(await resolveShortLink('https://trib.al/internal', isNytUrl), null);
    assert.deepStrictEqual(requests.map((r) => r.url), ['https://trib.al/other', 'https://trib.al/internal']);
  });

  test('gives up after a few hops', async () => {
    const { fetch, requests } = fakeFetch({ 'https://nyti.ms/a': 'https://nyti.ms/b', 'https://nyti.ms/b': 'https://nyti.ms/a' });
    configureShortLinks({ fetch });
    assert.strictEqual(await resolveShortLink('https://nyti.ms/a', isNytUrl), null);
    assert.strictEqual(requests.length, 4);
  });

  test('returns null for a link that does not redirect, or a failed request', async () => {
    configureShortLinks({ fetch: fakeFetch({ 'https://nyti.ms/gone': 404, 'https://nyti.ms/ok': 200, 'https://nyti.ms/down': new Error('ECONNRESET') }).fetch });
    for (const url of ['https://nyti.ms/gone', 'https://nyti.ms/ok', 'https://nyti.ms/down']) {
      assert.strictEqual(await resolveShortLink(url, isNytUrl), null, url);
    }
  });

  test('falls back to GET when HEAD is not allowed', async () => {
    let calls = 0;
    const requests: string[] = [];
    configureShortLinks({
      fetch: async (url, init) => {
        requests.push(`${init.method} ${url}`);
        calls++;
        if (init.method === 'HEAD') return new Response(null, { status: 405 });
        return new Response('moved', { status: 302, headers: { location: ARTICLE } });
      },
    });
    assert.strictEqual(await resolveShortLink('https://nyti.ms/x', isNytUrl), ARTICLE);
    assert.deepStrictEqual(requests, ['HEAD https://nyti.ms/x', 'GET https://nyti.ms/x']);
    assert.strictEqual(calls, 2);
  });

  test('remembers results, and resolves a link shared at the same moment once', async () => {
    const { fetch, requests } = fakeFetch({ 'https://nyti.ms/x': ARTICLE, 'https://nyti.ms/bad': 404 });
    configureShortLinks({ fetch });
    const results = await Promise.all([1, 2, 3].map(() => resolveShortLink('https://nyti.ms/x', isNytUrl)));
    assert.deepStrictEqual(results, [ARTICLE, ARTICLE, ARTICLE]);
    assert.strictEqual(await resolveShortLink('https://nyti.ms/x', isNytUrl), ARTICLE);
    // Failures are remembered too, for a while
    assert.strictEqual(await resolveShortLink('https://nyti.ms/bad', isNytUrl), null);
    assert.strictEqual(await resolveShortLink('https://nyti.ms/bad', isNytUrl), null);
    assert.deepStrictEqual(requests.map((r) => r.url), ['https://nyti.ms/x', 'https://nyti.ms/bad']);
  });

  test('skips links rather than queueing them when too many are being resolved', async () => {
    const release: (() => void)[] = [];
    configureShortLinks({
      fetch: () => new Promise<Response>((resolve) => release.push(() => resolve(new Response(null, { status: 301, headers: { location: ARTICLE } })))),
    });
    const pending = Array.from({ length: 20 }, (_, i) => resolveShortLink(`https://nyti.ms/p${i}`, isNytUrl));
    assert.strictEqual(await resolveShortLink('https://nyti.ms/one-too-many', isNytUrl), null);
    for (const done of release) done();
    assert.ok((await Promise.all(pending)).every((r) => r === ARTICLE));
  });

  test('does not request anything for a URL that is not a short link', async () => {
    const { fetch, requests } = fakeFetch({});
    configureShortLinks({ fetch });
    assert.strictEqual(await resolveShortLink('https://example.com/x', isNytUrl), null);
    assert.strictEqual(requests.length, 0);
  });
});
