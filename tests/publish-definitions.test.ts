import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
const { publishServiceRecord } = await import('../src/publish-definitions.js');

const originalConsole = { log: console.log, warn: console.warn, error: console.error };
before(() => {
  console.log = console.warn = console.error = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

const DID = 'did:plc:diitczh77g62vvea5fjbbz6b';

/** A JWT-shaped token; the session only reads its claims, the server checks the signature. */
function fakeJwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256K', typ: 'at+jwt' })}.${encode(claims)}.c2ln`;
}

const record = {
  $type: 'app.bsky.labeler.service' as const,
  policies: { labelValues: ['us'], labelValueDefinitions: [] },
  subjectTypes: ['record'],
  subjectCollections: ['app.bsky.feed.post'],
  createdAt: '2026-10-27T03:00:00.000Z',
};

/** A fake bsky.social: records each request, and answers like the real XRPC endpoints. */
function fakeBluesky(options: { failPut?: boolean; failLogin?: boolean } = {}) {
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
        if (options.failLogin) return json(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' });
        return json(200, {
          did: DID,
          handle: 'nyt-labeler-dev.bsky.social',
          accessJwt: fakeJwt({ sub: DID, scope: 'com.atproto.appPass', iat: now, exp: now + 7200 }),
          refreshJwt: fakeJwt({ sub: DID, scope: 'com.atproto.refresh', iat: now, exp: now + 86400 }),
          active: true,
        });
      case '/xrpc/com.atproto.repo.putRecord':
        if (options.failPut) return json(400, { error: 'InvalidRequest', message: 'Record is invalid' });
        return json(200, { uri: `at://${DID}/app.bsky.labeler.service/self`, cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm' });
      case '/xrpc/com.atproto.server.deleteSession':
        return new Response(null, { status: 200 });
      default:
        return json(404, { error: 'MethodNotImplemented' });
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

describe('publishServiceRecord', () => {
  test('logs in with the app password, puts the service record, then logs out', async () => {
    const bluesky = fakeBluesky();
    await publishServiceRecord(record, {
      service: 'https://bsky.social',
      identifier: 'nyt-labeler-dev.bsky.social',
      password: 'app-password',
      repo: DID,
      fetch: bluesky.fetch,
    });

    const paths = bluesky.requests.map((r) => `${r.method} ${r.path}`);
    assert.deepStrictEqual(paths, [
      'POST /xrpc/com.atproto.server.createSession',
      'POST /xrpc/com.atproto.repo.putRecord',
      'POST /xrpc/com.atproto.server.deleteSession',
    ]);
    assert.deepStrictEqual(bluesky.requests[0].body, { identifier: 'nyt-labeler-dev.bsky.social', password: 'app-password' });

    const put = bluesky.requests[1];
    assert.match(put.auth ?? '', /^Bearer /, 'The record is written with the session');
    assert.strictEqual(put.body.repo, DID);
    assert.strictEqual(put.body.collection, 'app.bsky.labeler.service');
    assert.strictEqual(put.body.rkey, 'self');
    assert.deepStrictEqual(put.body.record, record);
  });

  test('fails, without writing anything, when the login is refused', async () => {
    const bluesky = fakeBluesky({ failLogin: true });
    await assert.rejects(publishServiceRecord(record, {
      service: 'https://bsky.social', identifier: 'x', password: 'wrong', repo: DID, fetch: bluesky.fetch,
    }));
    assert.deepStrictEqual(bluesky.requests.map((r) => r.path), ['/xrpc/com.atproto.server.createSession']);
  });

  test('fails when the record is rejected, and still logs out', async () => {
    const bluesky = fakeBluesky({ failPut: true });
    await assert.rejects(publishServiceRecord(record, {
      service: 'https://bsky.social', identifier: 'x', password: 'app-password', repo: DID, fetch: bluesky.fetch,
    }));
    assert.deepStrictEqual(bluesky.requests.map((r) => r.path), [
      '/xrpc/com.atproto.server.createSession',
      '/xrpc/com.atproto.repo.putRecord',
      '/xrpc/com.atproto.server.deleteSession',
    ]);
  });
});
