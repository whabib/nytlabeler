import { Client } from '@atproto/lex-client';
import { PasswordSession } from '@atproto/lex-password-session';

export interface BlueskyLogin {
  service: string;
  identifier: string;
  password: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Logs in with an app password, runs `work` with a client for the session, then logs out.
 * A failed logout is only logged, so it never fails the work.
 */
export async function withBlueskySession<T>(login: BlueskyLogin, work: (client: Client) => Promise<T>): Promise<T> {
  console.log(`🔐 Logging into Bluesky as ${login.identifier}...`);
  const session = await PasswordSession.login({
    service: login.service,
    identifier: login.identifier,
    password: login.password,
    fetch: login.fetch,
  });
  try {
    console.log('🔑 Login successful!');
    return await work(new Client(session));
  } finally {
    // Don't leave a session behind on every run
    await session.logout().catch((err: unknown) => console.warn('⚠️ Logging out of Bluesky failed:', err));
  }
}
