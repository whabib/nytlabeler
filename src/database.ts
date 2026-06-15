import pg from 'pg';
import { DATABASE_URL, ENV } from './config.js';

const { Pool } = pg;

// Connection Pool
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

export interface ArticleMatch {
  id: number;
  url: string;
  section: string;
  subsection: string | null;
  title: string | null;
  authors: string[];
}

/**
 * Normalizes/sanitizes a URL to match the format stored in the database.
 * E.g., strips off tracking parameters (smid, referringSource, etc.)
 */
export function normalizeNytUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    // Force https and www
    url.protocol = 'https:';
    if (!url.hostname.startsWith('www.')) {
      url.hostname = 'www.' + url.hostname;
    }
    // Remove query params which are usually tracking
    url.search = '';
    url.hash = '';
    return url.toString().trim();
  } catch {
    return urlStr.trim();
  }
}

/**
 * Looks up an article in the PostgreSQL DB by its normalized URL, joining its Author(s).
 */
export async function lookupArticle(url: string): Promise<ArticleMatch | null> {
  const normalized = normalizeNytUrl(url);
  const sql = `
    SELECT 
      a.id, 
      a.url, 
      a.section, 
      a.subsection, 
      a.title,
      auth.name AS author_name
    FROM "Article" a
    LEFT JOIN "_ArticleToAuthor" j ON a.id = j."A"
    LEFT JOIN "Author" auth ON j."B" = auth.id
    WHERE a.url = $1
  `;
  
  try {
    const res = await pool.query(sql, [normalized]);
    if (res.rows.length === 0) {
      return null;
    }
    
    // Group authors if there are multiple rows due to the join
    const firstRow = res.rows[0];
    const authors: string[] = res.rows
      .map((row) => row.author_name)
      .filter((name): name is string => typeof name === 'string' && name.trim() !== '');

    return {
      id: firstRow.id,
      url: firstRow.url,
      section: firstRow.section,
      subsection: firstRow.subsection || null,
      title: firstRow.title || null,
      authors: Array.from(new Set(authors)), // Deduplicate
    };
  } catch (error) {
    console.error(`Database error during URL lookup [${normalized}]:`, error);
    return null;
  }
}

/**
 * Gets the restricted list of published authors:
 * Authors who have written >= 2 articles in the 'opinion' section,
 * OR >= 2 articles in the 'us' section and 'politics' subsection (case-insensitive).
 */
export async function getActiveAuthors(): Promise<{ id: number; name: string; total_articles: number }[]> {
  const sql = `
    SELECT auth.id, auth.name, COUNT(j."A") AS total_articles
    FROM "Author" auth
    JOIN "_ArticleToAuthor" j ON auth.id = j."B"
    JOIN "Article" a ON j."A" = a.id
    WHERE auth.id IN (
      SELECT j2."B"
      FROM "_ArticleToAuthor" j2
      JOIN "Article" a2 ON j2."A" = a2.id
      GROUP BY j2."B"
      HAVING SUM(CASE WHEN a2.section = 'opinion' THEN 1 ELSE 0 END) >= 2
          OR SUM(CASE WHEN LOWER(a2.section) = 'us' AND LOWER(a2.subsection) = 'politics' THEN 1 ELSE 0 END) >= 2
    )
    GROUP BY auth.id, auth.name
    ORDER BY total_articles DESC, auth.name ASC;
  `;
  
  try {
    const res = await pool.query(sql);
    return res.rows.map((row) => ({
      id: parseInt(row.id, 10),
      name: row.name,
      total_articles: parseInt(row.total_articles, 10),
    }));
  } catch (error) {
    console.error('Database error fetching active authors:', error);
    return [];
  }
}


/**
 * Helper to slugify names/labels for ATProto compliance.
 * ATProto expects lower-case kebab-case (a-z, 0-9, -).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD') // Normalize accents
    .replace(/[\u0300-\u036f]/g, '') // Strip accents
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphen
    .replace(/^-+|-+$/g, ''); // Trim leading/trailing hyphens
}

/**
 * Fetches distinct sections and subsections to establish the possible categories.
 */
export async function getDistinctCategories(): Promise<{ sections: string[]; subsections: string[] }> {
  try {
    const sectionRes = await pool.query('SELECT DISTINCT section FROM "Article" WHERE section IS NOT NULL AND section != \'\' ORDER BY section ASC;');
    const subRes = await pool.query('SELECT DISTINCT subsection FROM "Article" WHERE subsection IS NOT NULL AND subsection != \'\' ORDER BY subsection ASC;');
    
    const formatCategory = (name: string) => name.toLowerCase() === 'us' ? 'US' : name;

    const sections = Array.from(new Set(sectionRes.rows.map(r => formatCategory(r.section))));
    const subsections = Array.from(new Set(subRes.rows.map(r => r.subsection ? formatCategory(r.subsection) : ''))).filter(s => s !== '');

    return {
      sections,
      subsections
    };
  } catch (error) {
    console.error('Database error fetching categories:', error);
    return { sections: [], subsections: [] };
  }
}

/**
 * Saves a system setting to the database (environment-aware).
 */
export async function saveSetting(key: string, value: string): Promise<void> {
  const sql = `
    INSERT INTO "_Settings" (environment, key, value)
    VALUES ($1, $2, $3)
    ON CONFLICT (environment, key) DO UPDATE SET value = EXCLUDED.value;
  `;
  try {
    await pool.query(sql, [ENV, key, value]);
  } catch (err) {
    console.error(`Error saving setting ${key} for environment ${ENV}:`, err);
  }
}

/**
 * Loads a system setting from the database (environment-aware).
 */
export async function loadSetting(key: string, defaultValue: string): Promise<string> {
  const sql = `SELECT value FROM "_Settings" WHERE environment = $1 AND key = $2;`;
  try {
    const res = await pool.query(sql, [ENV, key]);
    if (res.rows.length === 0) {
      return defaultValue;
    }
    return res.rows[0].value;
  } catch (err) {
    // If the table doesn't exist yet, or is using the old single-key schema,
    // we attempt to recreate or migrate it safely.
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "_Settings" (
          environment VARCHAR(50) NOT NULL,
          key VARCHAR(255) NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (environment, key)
        );
      `);

      // Verify if the 'environment' column actually exists in the table.
      const colCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = '_Settings' AND column_name = 'environment';
      `);

      if (colCheck.rows.length === 0) {
        console.log('🔄 Migrating old "_Settings" table to be environment-aware...');
        // Drop the old table to avoid schema conflicts, then recreate with the compound primary key
        await pool.query('DROP TABLE IF EXISTS "_Settings";');
        await pool.query(`
          CREATE TABLE "_Settings" (
            environment VARCHAR(50) NOT NULL,
            key VARCHAR(255) NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (environment, key)
          );
        `);
      }
    } catch (migErr) {
      console.error('Failed to auto-create/migrate _Settings table:', migErr);
    }
    return defaultValue;
  }
}

export interface LabelRecord {
  id: number;
  src: string;
  uri: string;
  cid: string | null;
  val: string;
  neg: boolean;
  cts: string;
  exp: string | null;
  sig: Buffer | null;
}

/**
 * Synchronizes an issued label record to the environment-aware PostgreSQL table.
 */
export async function syncLabelToPostgres(label: LabelRecord): Promise<void> {
  const sql = `
    INSERT INTO "_Labels" (environment, id, src, uri, cid, val, neg, cts, exp, sig)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (environment, id) DO UPDATE SET
      src = EXCLUDED.src,
      uri = EXCLUDED.uri,
      cid = EXCLUDED.cid,
      val = EXCLUDED.val,
      neg = EXCLUDED.neg,
      cts = EXCLUDED.cts,
      exp = EXCLUDED.exp,
      sig = EXCLUDED.sig;
  `;
  try {
    await pool.query(sql, [
      ENV,
      label.id,
      label.src,
      label.uri,
      label.cid,
      label.val,
      label.neg,
      label.cts,
      label.exp,
      label.sig,
    ]);
  } catch (err) {
    console.error(`❌ Failed to sync label ${label.id} to PostgreSQL:`, err);
  }
}

/**
 * Loads all historical labels for the current environment from PostgreSQL.
 * Auto-creates the environment-aware "_Labels" table if it does not exist yet.
 */
export async function fetchLabelsFromPostgres(): Promise<LabelRecord[]> {
  const sql = `
    SELECT id, src, uri, cid, val, neg, cts, exp, sig 
    FROM "_Labels" 
    WHERE environment = $1 
    ORDER BY id ASC;
  `;
  try {
    const res = await pool.query(sql, [ENV]);
    return res.rows.map((row) => ({
      id: parseInt(row.id, 10),
      src: row.src,
      uri: row.uri,
      cid: row.cid || null,
      val: row.val,
      neg: !!row.neg,
      cts: row.cts instanceof Date ? row.cts.toISOString() : String(row.cts),
      exp: row.exp ? (row.exp instanceof Date ? row.exp.toISOString() : String(row.exp)) : null,
      sig: row.sig || null,
    }));
  } catch (err) {
    try {
      console.log('🔄 Creating "_Labels" PostgreSQL table (environment-aware)...');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "_Labels" (
          environment VARCHAR(50) NOT NULL,
          id INT NOT NULL,
          src VARCHAR(255) NOT NULL,
          uri VARCHAR(511) NOT NULL,
          cid VARCHAR(255),
          val VARCHAR(255) NOT NULL,
          neg BOOLEAN DEFAULT FALSE,
          cts TIMESTAMP NOT NULL,
          exp TIMESTAMP,
          sig BYTEA,
          PRIMARY KEY (environment, id)
        );
      `);
    } catch (createErr) {
      console.error('❌ Failed to auto-create _Labels table:', createErr);
    }
    return [];
  }
}

