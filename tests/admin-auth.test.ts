import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createAdminAuth, createSessionSecret, readCookie, SESSION_TTL_MS } from '../src/admin-auth.js';

const SECRET = createSessionSecret();

describe('createAdminAuth', () => {
  const auth = createAdminAuth('correct horse battery staple', SECRET);
  const now = 1_800_000_000_000;

  test('accepts only the exact password', async () => {
    assert.strictEqual(auth.configured, true);
    assert.strictEqual(await auth.checkPassword('correct horse battery staple'), true);
    for (const wrong of [
      'correct horse battery stapl', 'Correct horse battery staple', 'correct horse battery staple ', '', 'x'.repeat(5000),
      null, undefined, 42, ['correct horse battery staple'],
    ]) {
      assert.strictEqual(await auth.checkPassword(wrong), false, String(wrong).slice(0, 40));
    }
  });

  test('issues sessions that are valid until they expire', () => {
    const token = auth.createSession(now);
    assert.strictEqual(auth.isValidSession(token, now), true);
    assert.strictEqual(auth.isValidSession(token, now + SESSION_TTL_MS - 1), true);
    assert.strictEqual(auth.isValidSession(token, now + SESSION_TTL_MS), false);
  });

  test('rejects tampered, forged and malformed sessions', () => {
    const token = auth.createSession(now);
    const [expiresAt, signature] = token.split('.');
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    for (const bad of [
      `${expiresAt}.${flipped}`, // Altered signature
      `${Number(expiresAt) + 1000}.${signature}`, // Extended expiry
      `${now + 10 * SESSION_TTL_MS}.${signature}`, // Far-future expiry
      createAdminAuth('another password', SECRET).createSession(now), // Signed with another password
      '', 'not-a-token', `${expiresAt}.`, `.${signature}`, `${expiresAt}.${signature}.extra`, undefined,
    ]) {
      assert.strictEqual(auth.isValidSession(bad, now), false, String(bad));
    }
  });

  test('knowing the password is not enough to make a session: the shared secret is needed too', () => {
    const guessed = createAdminAuth('correct horse battery staple', createSessionSecret()).createSession(now);
    assert.strictEqual(auth.isValidSession(guessed, now), false);
    // The same password and secret, as on another instance, make sessions that are accepted
    const otherInstance = createAdminAuth('correct horse battery staple', SECRET);
    assert.strictEqual(auth.isValidSession(otherInstance.createSession(now), now), true);
  });

  test('requires a session secret when a password is set', () => {
    assert.throws(() => createAdminAuth('a password'), /session secret/);
    assert.throws(() => createAdminAuth('a password', 'too short'), /session secret/);
    assert.match(createSessionSecret(), /^[0-9a-f]{64}$/);
    assert.notStrictEqual(createSessionSecret(), createSessionSecret());
  });

  test('without a password, nobody can sign in', async () => {
    for (const password of [undefined, '']) {
      const locked = createAdminAuth(password);
      assert.strictEqual(locked.configured, false);
      assert.strictEqual(await locked.checkPassword(''), false);
      assert.strictEqual(await locked.checkPassword('anything'), false);
      assert.strictEqual(locked.isValidSession(auth.createSession(now), now), false);
      assert.throws(() => locked.createSession(now));
    }
  });
});

describe('readCookie', () => {
  test('finds a cookie among others', () => {
    assert.strictEqual(readCookie('a=1; nytlabeler_admin=tok.en; b=2', 'nytlabeler_admin'), 'tok.en');
    assert.strictEqual(readCookie('nytlabeler_admin=x', 'nytlabeler_admin'), 'x');
  });

  test('returns undefined when it is absent', () => {
    assert.strictEqual(readCookie(undefined, 'nytlabeler_admin'), undefined);
    assert.strictEqual(readCookie('', 'nytlabeler_admin'), undefined);
    assert.strictEqual(readCookie('other=1; nytlabeler_admin_x=2; junk', 'nytlabeler_admin'), undefined);
  });
});
