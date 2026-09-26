import { metricsPool, POST_ARTICLES_TABLE } from './post-articles.js';

/** The periods the Reports page covers, newest first. */
export const REPORT_WINDOWS = [
  { key: '1h', label: 'Last Hour', interval: '1 hour' },
  { key: '8h', label: 'Last 8 Hours', interval: '8 hours' },
  { key: '24h', label: 'Last 24 Hours', interval: '24 hours' },
  { key: '7d', label: 'Last 7 Days', interval: '7 days' },
] as const;

/** Articles listed per period. */
export const REPORT_LIMIT = 10;

/** How long a report is reused before the database is queried again. */
export const REPORT_CACHE_MS = 30_000;

export interface PopularArticle {
  id: number;
  title: string | null;
  url: string;
  authors: string[];
  shares: number;
}

export interface PopularArticlesReport {
  generatedAt: string;
  windows: { key: string; label: string; articles: PopularArticle[] }[];
}

/**
 * The articles shared in the most posts in one period, most shared first (ties: most
 * recently shared first). Each post counts once per article it links.
 */
async function popularArticles(interval: string, limit: number): Promise<PopularArticle[]> {
  const { rows } = await metricsPool.query(
    `SELECT a.id, a.title, a.url, s.shares,
            COALESCE((SELECT array_agg(au.name ORDER BY au.name)
                      FROM "_ArticleToAuthor" j JOIN "Author" au ON au.id = j."B"
                      WHERE j."A" = a.id), '{}') AS authors
     FROM (SELECT article_id, COUNT(*)::int AS shares, MAX(created_at) AS last_shared
           FROM ${POST_ARTICLES_TABLE}
           WHERE created_at > now() - $1::interval
           GROUP BY article_id) s
     JOIN "Article" a ON a.id = s.article_id
     ORDER BY s.shares DESC, s.last_shared DESC, a.id
     LIMIT $2`,
    [interval, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    authors: row.authors,
    shares: row.shares,
  }));
}

let cached: { report: PopularArticlesReport; at: number } | null = null;
let inFlight: Promise<PopularArticlesReport> | null = null;

/**
 * The most shared articles for each report period. The dashboard is public, so a report is
 * reused for REPORT_CACHE_MS and concurrent requests share one set of queries.
 */
export async function fetchPopularArticlesReport(now = Date.now()): Promise<PopularArticlesReport> {
  if (cached && now - cached.at < REPORT_CACHE_MS) return cached.report;
  if (!inFlight) {
    inFlight = (async () => {
      const windows = [];
      // One at a time: the metrics pool has a single connection
      for (const window of REPORT_WINDOWS) {
        windows.push({ key: window.key, label: window.label, articles: await popularArticles(window.interval, REPORT_LIMIT) });
      }
      const report = { generatedAt: new Date(now).toISOString(), windows };
      cached = { report, at: now };
      return report;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Clears the cached report. Useful for tests. */
export function resetReportCache(): void {
  cached = null;
  inFlight = null;
}
