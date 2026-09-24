import { pool } from './database.js';
import { LABELS_TABLE } from './labeler.js';

/** Label activity across all instances, read from the shared Postgres label table. */
export interface LabelActivity {
  /** All labels ever issued. */
  total: number;
  /** Labels issued in the last hour. */
  lastHour: number;
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
const LAST_HOUR_SCAN_LIMIT = 5000;

/**
 * Reads label activity from the database. Every instance sees the same numbers, including
 * a standby instance that isn't processing the firehose itself.
 */
export async function fetchLabelActivity(now = new Date()): Promise<LabelActivity> {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  // cts values are ISO-8601 UTC strings, so they compare correctly as text
  const result = await pool.query(
    `SELECT
      (SELECT COUNT(*) FROM ${LABELS_TABLE})::int AS total,
      (SELECT cts FROM ${LABELS_TABLE} ORDER BY id DESC LIMIT 1) AS last_cts,
      (SELECT COUNT(*) FROM (
        SELECT cts FROM ${LABELS_TABLE} ORDER BY id DESC LIMIT ${LAST_HOUR_SCAN_LIMIT}
      ) recent WHERE cts >= $1)::int AS last_hour`,
    [hourAgo],
  );
  const row = result.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    lastHour: Number(row.last_hour ?? 0),
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
  return [...posts.values()].reverse();
}
