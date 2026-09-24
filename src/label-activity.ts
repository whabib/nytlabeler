import { pool } from './database.js';
import { LABELS_TABLE } from './labeler.js';

/** Label activity across all instances, read from the shared Postgres label table. */
export interface LabelActivity {
  /** All labels ever issued. */
  total: number;
  /** Labels issued in the last hour (a lower bound when lastHourCapped is true). */
  lastHour: number;
  /** True when the last-hour count hit its scan limit, so the real number may be higher. */
  lastHourCapped: boolean;
  /** When the most recent label was issued (ISO timestamp), or null if there are none. */
  lastLabelAt: string | null;
}

/** The most recent labels on one post, as stored (no post text or article title). */
export interface StoredPostLabels {
  uri: string;
  labels: string[];
  timestamp: string;
}

// The last-hour count only scans the newest labels (about a day's worth at current volume),
// so it stays cheap however large the table grows.
export const LAST_HOUR_SCAN_LIMIT = 5000;

// The all-time total is counted once, then kept up to date by counting only labels newer
// than the last id seen. That stays exact because labels are never deleted, and ids become
// visible strictly in order: the labeler library's PostgresLabelStore.insert takes a
// per-table advisory lock (pg_advisory_xact_lock) before the INSERT draws its id and holds
// it until COMMIT, so no insert can draw an id until the previous one has committed, across
// all instances. (This is the labels-table lock, not the firehose leadership lock.)
let countedTotal = 0;
let countedThroughId = 0;
let refreshInFlight: Promise<LabelActivity> | null = null;

/**
 * Forgets the running total, so the next refresh counts the whole table. Useful for testing.
 */
export function resetLabelActivityCount() {
  countedTotal = 0;
  countedThroughId = 0;
  refreshInFlight = null;
}

/**
 * Reads label activity from the database. Every instance sees the same numbers, including
 * a standby instance that isn't processing the firehose itself.
 */
export function fetchLabelActivity(now = new Date()): Promise<LabelActivity> {
  // Overlapping refreshes share one query, so new labels are never counted twice
  refreshInFlight ??= queryLabelActivity(now).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function queryLabelActivity(now: Date): Promise<LabelActivity> {
  const newLabels = await pool.query(
    `SELECT COUNT(*)::int AS n, MAX(id) AS max_id FROM ${LABELS_TABLE} WHERE id > $1`,
    [countedThroughId],
  );
  const { n, max_id: maxId } = newLabels.rows[0] ?? {};
  if (maxId != null) {
    countedTotal += Number(n ?? 0);
    countedThroughId = Number(maxId);
  }

  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  // cts values are ISO-8601 UTC strings, so they compare correctly as text
  const recent = await pool.query(
    `SELECT
      (SELECT cts FROM ${LABELS_TABLE} ORDER BY id DESC LIMIT 1) AS last_cts,
      (SELECT COUNT(*) FROM (
        SELECT cts FROM ${LABELS_TABLE} ORDER BY id DESC LIMIT ${LAST_HOUR_SCAN_LIMIT}
      ) newest WHERE cts >= $1)::int AS last_hour`,
    [hourAgo],
  );
  const row = recent.rows[0] ?? {};
  const lastHour = Number(row.last_hour ?? 0);
  return {
    total: countedTotal,
    lastHour,
    lastHourCapped: lastHour >= LAST_HOUR_SCAN_LIMIT,
    lastLabelAt: row.last_cts ?? null,
  };
}

/**
 * Reads the most recent labels from the database, grouped by post, newest first.
 */
export async function fetchRecentPostLabels(maxLabels = 200): Promise<StoredPostLabels[]> {
  const result = await pool.query(
    `SELECT uri, val, cts FROM ${LABELS_TABLE} ORDER BY id DESC LIMIT $1`,
    [maxLabels],
  );
  const posts = new Map<string, StoredPostLabels>();
  // Rows are newest first; restore issue order within each post
  for (const row of [...result.rows].reverse()) {
    const post = posts.get(row.uri);
    if (post) {
      if (!post.labels.includes(row.val)) post.labels.push(row.val);
      post.timestamp = row.cts;
    } else {
      posts.set(row.uri, { uri: row.uri, labels: [row.val], timestamp: row.cts });
    }
  }
  // Newest post first, by the time of its latest label
  return [...posts.values()].sort((x, y) => y.timestamp.localeCompare(x.timestamp));
}
