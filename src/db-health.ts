import { pool } from './database.js';
import { stats } from './labeler.js';

/** How often the dashboard's database status is checked. */
export const DB_CHECK_INTERVAL_MS = 30_000;

/** A check that gets no answer within this long counts as a failure. */
export const DB_CHECK_TIMEOUT_MS = 5_000;

export interface DatabaseStatus {
  connected: boolean;
  /** Round trip of the check query, when it succeeded. */
  latencyMs: number | null;
  checkedAt: string;
}

// Only changes are logged, so an outage produces one error line rather than one per check
let wasConnected: boolean | null = null;

/**
 * Runs a trivial query on the shared pool (the one label writes and article lookups use).
 * The dashboard is public, so the result carries no error details; those go to the log.
 */
export async function checkDatabase(timeoutMs = DB_CHECK_TIMEOUT_MS): Promise<DatabaseStatus> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (wasConnected === false) console.log('✅ Database is reachable again.');
    wasConnected = true;
    return { connected: true, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (wasConnected !== false) console.error('❌ Database check failed:', error);
    wasConnected = false;
    return { connected: false, latencyMs: null, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks the database and publishes the result in the dashboard stats. */
export async function refreshDatabaseStatus(): Promise<void> {
  stats.database = await checkDatabase();
}

/** Clears the logged state. Useful for tests. */
export function resetDatabaseStatus(): void {
  wasConnected = null;
  stats.database = null;
}
