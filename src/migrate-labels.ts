import { signLabel } from 'labeler';
import type pg from 'pg';

/** Format of the ISO timestamps labels were signed with, e.g. 2026-06-13T02:55:09.289Z. */
const ISO_MS_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export interface MigrateLegacyLabelsOptions {
  /** Schema-qualified table the LabelerServer stores labels in (it must already exist). */
  targetTable: string;
  /** Legacy double-write table, keyed by (environment, id). */
  legacyTable?: string;
  /** Only rows for this environment are copied. */
  environment: string;
  /** The labeler's private key, used to re-sign a sample of rows and compare signatures. */
  signingKey: Uint8Array;
  /** How many random rows to re-sign and compare. */
  sampleSize?: number;
}

export interface MigrateLegacyLabelsResult {
  /** Why nothing was copied, if nothing was. */
  skipped?: 'target-not-empty' | 'no-legacy-table';
  migrated: number;
  checkedSignatures: number;
}

/**
 * One-time copy of the legacy "_Labels" rows into the LabelerServer's Postgres table,
 * keeping their ids so subscribers' cursors stay valid.
 *
 * Runs only while the target table is empty, in a single transaction under an advisory
 * lock, so concurrent startups can't copy twice. Legacy timestamps are TIMESTAMP columns
 * holding UTC wall-clock times; they're turned back into the exact ISO strings the labels
 * were signed with. A random sample is re-signed (signing is deterministic) and compared
 * with the stored signature; any mismatch rolls the whole copy back.
 */
export async function migrateLegacyLabels(
  pool: pg.Pool,
  { targetTable, legacyTable = '"_Labels"', environment, signingKey, sampleSize = 200 }: MigrateLegacyLabelsOptions,
): Promise<MigrateLegacyLabelsResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`nytlabeler:migrate:${targetTable}`]);

    const existing = await client.query(`SELECT EXISTS (SELECT 1 FROM ${targetTable}) AS has_rows`);
    if (existing.rows[0].has_rows) {
      await client.query('COMMIT');
      return { skipped: 'target-not-empty', migrated: 0, checkedSignatures: 0 };
    }

    const legacy = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [legacyTable]);
    if (!legacy.rows[0].present) {
      await client.query('COMMIT');
      return { skipped: 'no-legacy-table', migrated: 0, checkedSignatures: 0 };
    }

    const inserted = await client.query(
      `INSERT INTO ${targetTable} (id, src, uri, cid, val, neg, cts, exp, sig)
      SELECT id, src, uri, cid, val, COALESCE(neg, FALSE),
        to_char(cts, '${ISO_MS_FORMAT}'),
        CASE WHEN exp IS NULL THEN NULL ELSE to_char(exp, '${ISO_MS_FORMAT}') END,
        sig
      FROM ${legacyTable}
      WHERE environment = $1
      ORDER BY id`,
      [environment],
    );
    const migrated = inserted.rowCount ?? 0;

    if (migrated > 0) {
      // New labels continue after the highest migrated id
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT MAX(id) FROM ${targetTable}))`,
        [targetTable],
      );
    }

    const sample = await client.query(
      `SELECT id, src, uri, cid, val, neg, cts, exp, sig FROM ${targetTable} ORDER BY random() LIMIT $1`,
      [sampleSize],
    );
    for (const row of sample.rows) {
      const expected = signLabel(
        {
          src: row.src,
          uri: row.uri,
          val: row.val,
          neg: row.neg,
          cts: row.cts,
          ...(row.cid ? { cid: row.cid } : {}),
          ...(row.exp ? { exp: row.exp } : {}),
        },
        signingKey,
      ).sig;
      if (!row.sig || !Buffer.from(expected).equals(row.sig)) {
        throw new Error(
          `Migrated label ${row.id} does not match its signature; rolled back the label migration`,
        );
      }
    }

    await client.query('COMMIT');
    return { migrated, checkedSignatures: sample.rows.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Parse a labeler private key the way the labeler library does: 32 bytes, as hex or base64url.
 */
export function parseSigningKey(key: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return new Uint8Array(Buffer.from(key, 'hex'));
  }
  if (/^[A-Za-z0-9_-]{43}=?$/.test(key)) {
    const bytes = Buffer.from(key, 'base64url');
    if (bytes.byteLength === 32) return new Uint8Array(bytes);
  }
  throw new Error('Invalid signing key. Must be hex or base64url, and 32 bytes long.');
}
