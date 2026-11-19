import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';

const { buildTopStoriesPost, displayUrl, findWindow, postTopStories, POST_MAX_GRAPHEMES } = await import('../src/top-stories.js');

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = console.warn = console.error = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

const DID = 'did:plc:diitczh77g62vvea5fjbbz6b';
const graphemeCount = (text: string) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;

/** The text a facet covers, read by its UTF-8 byte offsets like a Bluesky client does. */
function facetText(text: string, facet: { index: { byteStart: number; byteEnd: number } }) {
  return Buffer.from(text, 'utf8').subarray(facet.index.byteStart, facet.index.byteEnd).toString('utf8');
}

describe('buildTopStoriesPost', () => {
  test('lists each story on its own line, its headline linking to it, with its share count', () => {
    const stories = [
      { url: 'https://www.nytimes.com/2026/11/18/us/politics/senate-vote.html', title: 'Senate Passes  the\nSpending Bill', shares: 12 },
      { url: 'https://www.nytimes.com/2026/11/18/opinion/trump-tariffs.html', title: 'The Tariffs Aren’t Working', shares: 7 },
      { url: 'https://www.nytimes.com/2026/11/17/world/europe/ukraine.html', title: 'Ukraine’s Winter Offensive', shares: 1 },
    ];
    const post = buildTopStoriesPost(stories)!;
    assert.strictEqual(post.text, [
      'Top 3 Shared NYT Stories Last Hour:',
      'Senate Passes the Spending Bill, 12 shares',
      'The Tariffs Aren’t Working, 7 shares',
      'Ukraine’s Winter Offensive, 1 share',
    ].join('\n'));
    assert.deepStrictEqual(post.facets.map((f) => f.features[0].uri), stories.map((s) => s.url));
    // Byte offsets: the curly apostrophes take 3 bytes each
    assert.deepStrictEqual(post.facets.map((f) => facetText(post.text, f)), [
      'Senate Passes the Spending Bill',
      'The Tariffs Aren’t Working',
      'Ukraine’s Winter Offensive',
    ]);
    assert.ok(post.facets.every((f) => f.features[0].$type === 'app.bsky.richtext.facet#link'));
  });

  test('shows the shortened URL for a story without a headline', () => {
    const stories = [
      { url: 'https://www.nytimes.com/2026/11/18/us/politics/senate-vote.html?smid=bsky', title: null, shares: 3 },
      { url: 'https://www.nytimes.com/2026/11/18/us/other.html', title: '   ', shares: 2 },
    ];
    const post = buildTopStoriesPost(stories)!;
    assert.deepStrictEqual(post.facets.map((f) => facetText(post.text, f)), [
      'nytimes.com/2026/11/18/us/politics/senate-vote.html',
      'nytimes.com/2026/11/18/us/other.html',
    ]);
    assert.strictEqual(post.facets[0].features[0].uri, stories[0].url);
  });

  test('cuts long headlines short to fit 300 characters, leaving short ones whole', () => {
    const long = (n: number) => `${'A Very Long Headline About the News of the Day, '.repeat(4)}Part ${n}`;
    const stories = [
      { url: 'https://www.nytimes.com/1.html', title: long(1), shares: 30 },
      { url: 'https://www.nytimes.com/2.html', title: 'Short One', shares: 20 },
      { url: 'https://www.nytimes.com/3.html', title: long(3), shares: 10 },
    ];
    const post = buildTopStoriesPost(stories)!;
    assert.ok(graphemeCount(post.text) <= POST_MAX_GRAPHEMES, `${graphemeCount(post.text)} graphemes`);
    const shown = post.facets.map((f) => facetText(post.text, f));
    assert.strictEqual(shown[1], 'Short One');
    assert.ok(shown[0].endsWith('…') && shown[2].endsWith('…'), shown.join(' | '));
    // The space the short headline doesn't use goes to the long ones
    assert.ok(graphemeCount(post.text) >= POST_MAX_GRAPHEMES - 2, `${graphemeCount(post.text)} graphemes`);
  });

  test('without headlines, shortens long links to fit 300 characters, keeping the full URLs in the links', () => {
    const slug = 'a-very-long-headline-slug-that-goes-on-and-on-about-the-news-of-the-day';
    const stories = [1, 2, 3].map((n) => ({ url: `https://www.nytimes.com/2026/11/18/us/politics/${slug}-${n}.html?smid=bsky`, shares: 1000 + n }));
    const post = buildTopStoriesPost(stories)!;
    assert.ok(graphemeCount(post.text) <= POST_MAX_GRAPHEMES, `${graphemeCount(post.text)} graphemes`);
    for (const [i, facet] of post.facets.entries()) {
      const shown = facetText(post.text, facet);
      assert.ok(shown.startsWith('nytimes.com/2026/11/18/us/politics/a-very-long'), shown);
      assert.ok(shown.endsWith('…'), shown);
      assert.strictEqual(facet.features[0].uri, stories[i].url);
    }
    assert.match(post.text, /…, 1003 shares$/);
  });

  test('without headlines, shortens only the long links, giving them the room short ones leave', () => {
    const slug = 'a-very-long-headline-slug-that-goes-on-and-on-about-the-news-of-the-day-and-then-some';
    const stories = [
      { url: `https://www.nytimes.com/2026/11/18/us/politics/${slug}-1.html`, shares: 30 },
      { url: 'https://www.nytimes.com/2026/11/18/us/short.html', shares: 20 },
      { url: `https://www.nytimes.com/2026/11/18/us/politics/${slug}-3.html`, shares: 10 },
    ];
    const post = buildTopStoriesPost(stories)!;
    const shown = post.facets.map((f) => facetText(post.text, f));
    assert.strictEqual(shown[1], 'nytimes.com/2026/11/18/us/short.html');
    assert.ok(shown[0].endsWith('…') && shown[2].endsWith('…'), shown.join(' | '));
    assert.ok(graphemeCount(post.text) <= POST_MAX_GRAPHEMES);
    assert.ok(graphemeCount(post.text) >= POST_MAX_GRAPHEMES - 2, `${graphemeCount(post.text)} graphemes`);

    // When everything fits, nothing is shortened
    const fits = buildTopStoriesPost([stories[1], { url: 'https://www.nytimes.com/2026/11/18/us/politics/a-medium-length-slug-here.html', shares: 5 }])!;
    assert.ok(!fits.text.includes('…'), fits.text);
  });

  test('lists only the top three, and says how many it lists when there are fewer', () => {
    const story = (n: number) => ({ url: `https://www.nytimes.com/2026/11/18/us/story-${n}.html`, shares: 10 - n });
    assert.strictEqual(buildTopStoriesPost([1, 2, 3, 4].map(story))!.facets.length, 3);
    assert.match(buildTopStoriesPost([1, 2].map(story))!.text, /^Top 2 Shared NYT Stories Last Hour:\n/);
    assert.match(buildTopStoriesPost([story(1)])!.text, /^Top Shared NYT Story Last Hour:\nnytimes\.com\/2026\/11\/18\/us\/story-1\.html, 9 shares$/);
  });

  test("names the period in the heading, using the Reports page's periods", () => {
    const stories = [1, 2, 3].map((n) => ({ url: `https://www.nytimes.com/2026/11/18/us/story-${n}.html`, shares: 5 }));
    const headings = ['1h', '8h', '24h', '7d'].map((key) => buildTopStoriesPost(stories, findWindow(key)!.label)!.text.split('\n')[0]);
    assert.deepStrictEqual(headings, [
      'Top 3 Shared NYT Stories Last Hour:',
      'Top 3 Shared NYT Stories Last 8 Hours:',
      'Top 3 Shared NYT Stories Last 24 Hours:',
      'Top 3 Shared NYT Stories Last 7 Days:',
    ]);
    assert.strictEqual(findWindow('2h'), undefined);
  });

  test('posts nothing when nothing was shared', () => {
    assert.strictEqual(buildTopStoriesPost([]), null);
  });

  test('counts bytes for the link positions, and characters for the limit, in non-ASCII text', () => {
    const url = 'https://www.nytimes.com/2026/11/18/espa%C3%B1ol/caf%C3%A9-ñandú-🗽.html';
    const post = buildTopStoriesPost([{ url, shares: 2 }])!;
    assert.strictEqual(facetText(post.text, post.facets[0]), 'nytimes.com/2026/11/18/espa%C3%B1ol/caf%C3%A9-ñandú-🗽.html');
    assert.strictEqual(displayUrl(url, 20), 'nytimes.com/2026/11…');
    assert.strictEqual(graphemeCount(displayUrl('https://www.nytimes.com/🗽🗽🗽🗽', 14)), 14);
  });
});

/** A JWT-shaped token; the session only reads its claims, the server checks the signature. */
function fakeJwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256K', typ: 'at+jwt' })}.${encode(claims)}.c2ln`;
}

/** A fake bsky.social: records each request, and answers like the real XRPC endpoints. */
function fakeBluesky(options: { failCreate?: boolean } = {}) {
  const requests: { method: string; path: string; body?: any; auth?: string | null }[] = [];
  const now = Math.floor(Date.now() / 1000);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'POST' ? await request.text() : '';
    requests.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : undefined, auth: request.headers.get('authorization') });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    switch (url.pathname) {
      case '/xrpc/com.atproto.server.createSession':
        return json(200, {
          did: DID,
          handle: 'nyt-labeler-dev.bsky.social',
          accessJwt: fakeJwt({ sub: DID, scope: 'com.atproto.appPass', iat: now, exp: now + 7200 }),
          refreshJwt: fakeJwt({ sub: DID, scope: 'com.atproto.refresh', iat: now, exp: now + 86400 }),
          active: true,
        });
      case '/xrpc/com.atproto.repo.createRecord':
        if (options.failCreate) return json(400, { error: 'InvalidRequest', message: 'Record is invalid' });
        return json(200, { uri: `at://${DID}/app.bsky.feed.post/3n2abc`, cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm' });
      case '/xrpc/com.atproto.server.deleteSession':
        return new Response(null, { status: 200 });
      default:
        return json(404, { error: 'MethodNotImplemented' });
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

describe('postTopStories', () => {
  const post = buildTopStoriesPost([{ url: 'https://www.nytimes.com/2026/11/18/us/story.html', shares: 4 }])!;
  const login = { service: 'https://bsky.social', identifier: 'nyt-labeler-dev.bsky.social', password: 'app-password', repo: DID };

  test('logs in, creates the post on the account, then logs out', async () => {
    const bluesky = fakeBluesky();
    const now = new Date('2026-11-18T15:00:00.000Z');
    const uri = await postTopStories(post, { ...login, fetch: bluesky.fetch, now });
    assert.strictEqual(uri, `at://${DID}/app.bsky.feed.post/3n2abc`);
    assert.deepStrictEqual(bluesky.requests.map((r) => `${r.method} ${r.path}`), [
      'POST /xrpc/com.atproto.server.createSession',
      'POST /xrpc/com.atproto.repo.createRecord',
      'POST /xrpc/com.atproto.server.deleteSession',
    ]);
    const create = bluesky.requests[1];
    assert.match(create.auth ?? '', /^Bearer /);
    assert.strictEqual(create.body.repo, DID);
    assert.strictEqual(create.body.collection, 'app.bsky.feed.post');
    assert.deepStrictEqual(create.body.record, {
      $type: 'app.bsky.feed.post',
      text: post.text,
      facets: post.facets,
      langs: ['en'],
      createdAt: '2026-11-18T15:00:00.000Z',
    });
  });

  test('fails when the post is rejected, and still logs out', async () => {
    const bluesky = fakeBluesky({ failCreate: true });
    await assert.rejects(postTopStories(post, { ...login, fetch: bluesky.fetch }));
    assert.deepStrictEqual(bluesky.requests.map((r) => r.path), [
      '/xrpc/com.atproto.server.createSession',
      '/xrpc/com.atproto.repo.createRecord',
      '/xrpc/com.atproto.server.deleteSession',
    ]);
  });
});
