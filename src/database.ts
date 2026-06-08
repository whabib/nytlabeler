import pg from 'pg';
import { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from './config.js';

const { Pool } = pg;

// Connection Pool
// Note: In Cloud Run, if using Cloud SQL connection, DB_HOST can be the unix socket path like '/cloudsql/project:region:instance'
export const pool = new Pool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
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
 * Authors who have articles in the 'opinion' section and have authored > 1 article in total.
 */
export async function getActiveAuthors(): Promise<{ id: number; name: string; total_articles: number }[]> {
  const sql = `
    SELECT auth.id, auth.name, COUNT(j."A") AS total_articles
    FROM "Author" auth
    JOIN "_ArticleToAuthor" j ON auth.id = j."B"
    JOIN "Article" a ON j."A" = a.id
    WHERE auth.id IN (
      SELECT DISTINCT j2."B"
      FROM "_ArticleToAuthor" j2
      JOIN "Article" a2 ON j2."A" = a2.id
      WHERE a2.section = 'opinion'
    )
    GROUP BY auth.id, auth.name
    HAVING COUNT(j."A") > 1
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
    
    return {
      sections: sectionRes.rows.map(r => r.section),
      subsections: subRes.rows.map(r => r.subsection)
    };
  } catch (error) {
    console.error('Database error fetching categories:', error);
    return { sections: [], subsections: [] };
  }
}
