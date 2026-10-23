import crypto from 'node:crypto';

/** The cookie that holds an admin session (signed, so it needs no server-side storage). */
export const SESSION_COOKIE = 'nytlabeler_admin';
/** How long a sign-in lasts. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AdminAuth {
  /** Whether an admin password is set; without one, nobody can sign in. */
  readonly configured: boolean;
  /** Whether a submitted password is the admin password. */
  checkPassword(password: unknown): boolean;
  /** A new session token, valid for SESSION_TTL_MS. */
  createSession(now?: number): string;
  /** Whether a session token is genuine and unexpired. */
  isValidSession(token: string | undefined, now?: number): boolean;
}

/**
 * Admin sign-in with a single shared password (the ADMIN_PASSWORD environment variable).
 *
 * A session is "<expiry>.<signature>": an HMAC of the expiry, keyed from the password. Any
 * instance can check it without shared storage, and changing the password signs everyone out.
 */
export function createAdminAuth(password: string | undefined): AdminAuth {
  const configured = typeof password === 'string' && password.length > 0;
  const passwordDigest = configured ? sha256(password) : null;
  const signingKey = configured
    ? crypto.createHmac('sha256', password).update('nytlabeler admin session v1').digest()
    : null;

  const sign = (expiresAt: number) =>
    crypto.createHmac('sha256', signingKey!).update(String(expiresAt)).digest('base64url');

  return {
    configured,

    checkPassword(submitted) {
      if (!passwordDigest || typeof submitted !== 'string' || submitted.length === 0) return false;
      // Compare fixed-length digests, so the time taken reveals nothing about the password
      return crypto.timingSafeEqual(sha256(submitted), passwordDigest);
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

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}
