import crypto from 'node:crypto';

/** The cookie that holds an admin session (signed, so it needs no server-side storage). */
export const SESSION_COOKIE = 'nytlabeler_admin';
/** How long a sign-in lasts. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Fixed, so every instance derives the same signing key from the same password. */
const SCRYPT_SALT = 'nytlabeler admin password v1';
/** 32 bytes to check the password against, then 32 that go into the session signing key. */
const DERIVED_LENGTH = 64;
/** scrypt's defaults (N = 2^14, r = 8): tens of milliseconds and 16 MB per check. */
const SCRYPT_OPTIONS: crypto.ScryptOptions = { N: 16_384, r: 8, p: 1 };
/** Longer passwords are refused rather than hashed. */
const MAX_PASSWORD_LENGTH = 1024;

export interface AdminAuth {
  /** Whether an admin password is set; without one, nobody can sign in. */
  readonly configured: boolean;
  /** Whether a submitted password is the admin password. */
  checkPassword(password: unknown): Promise<boolean>;
  /** A new session token, valid for SESSION_TTL_MS. */
  createSession(now?: number): string;
  /** Whether a session token is genuine and unexpired. */
  isValidSession(token: string | undefined, now?: number): boolean;
}

/**
 * Admin sign-in with a single shared password (the ADMIN_PASSWORD environment variable).
 *
 * A session is "<expiry>.<signature>": an HMAC of the expiry. The signing key combines a
 * random secret that all instances share (sessionSecret) with the password, so:
 * - knowing or guessing the password isn't enough to make a session (every guess has to go
 *   through the rate-limited sign-in);
 * - any instance can check a session without shared session storage;
 * - changing the password signs everyone out.
 *
 * The password check uses scrypt, a deliberately slow password hash.
 */
export function createAdminAuth(password: string | undefined, sessionSecret?: string): AdminAuth {
  const configured = typeof password === 'string' && password.length > 0;
  if (configured && (typeof sessionSecret !== 'string' || sessionSecret.length < 32)) {
    throw new Error('A session secret of at least 32 characters is required');
  }
  const derived = configured ? crypto.scryptSync(password, SCRYPT_SALT, DERIVED_LENGTH, SCRYPT_OPTIONS) : null;
  const verifier = derived?.subarray(0, 32) ?? null;
  const signingKey = derived ? crypto.createHmac('sha256', sessionSecret!).update(derived.subarray(32)).digest() : null;

  const sign = (expiresAt: number) =>
    crypto.createHmac('sha256', signingKey!).update(String(expiresAt)).digest('base64url');

  return {
    configured,

    async checkPassword(submitted) {
      if (!verifier || typeof submitted !== 'string' || submitted.length === 0 || submitted.length > MAX_PASSWORD_LENGTH) {
        return false;
      }
      // Asynchronous, so hashing doesn't hold up the firehose; fixed-length values compared in
      // constant time, so the time taken reveals nothing about the password
      const candidate = await scrypt(submitted);
      return crypto.timingSafeEqual(candidate.subarray(0, 32), verifier);
    },

    createSession(now = Date.now()) {
      if (!signingKey) throw new Error('No admin password is set');
      const expiresAt = now + SESSION_TTL_MS;
      return `${expiresAt}.${sign(expiresAt)}`;
    },

    isValidSession(token, now = Date.now()) {
      if (!signingKey || typeof token !== 'string') return false;
      const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return false;
      const expiresAt = Number(match[1]);
      // Expired, or further out than any session this server issues
      if (expiresAt <= now || expiresAt > now + SESSION_TTL_MS) return false;
      const expected = Buffer.from(sign(expiresAt));
      const actual = Buffer.from(match[2]);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    },
  };
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** A new random session secret (see createAdminAuth). */
export function createSessionSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function scrypt(password: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, SCRYPT_SALT, DERIVED_LENGTH, SCRYPT_OPTIONS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
