import { metricsPool, POST_ARTICLES_TABLE } from './post-articles.js';
import { LABEL_AUTHOR_IDS_SQL } from './database.js';

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

// Reports are reused for REPORT_CACHE_MS, since the dashboard is public, and concurrent
// requests for the same report share one set of queries. Failures aren't cached.
const MAX_CACHED_REPORTS = 200;
const cache = new Map<string, { value: unknown; at: number }>();
const inFlight = new Map<string, Promise<unknown>>();

function cachedReport<T>(key: string, now: number, build: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < REPORT_CACHE_MS) return Promise.resolve(hit.value as T);
  let pending = inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = build()
      .then((value) => {
        cache.delete(key);
        // Many authors can be looked up, so the oldest reports make room
        if (cache.size >= MAX_CACHED_REPORTS) cache.delete(cache.keys().next().value!);
        cache.set(key, { value, at: now });
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** The most shared articles for each report period. */
export function fetchPopularArticlesReport(now = Date.now()): Promise<PopularArticlesReport> {
  return cachedReport('popular-articles', now, async () => {
    const windows = [];
    // One at a time: the metrics pool has a single connection
    for (const window of REPORT_WINDOWS) {
      windows.push({ key: window.key, label: window.label, articles: await popularArticles(window.interval, REPORT_LIMIT) });
    }
    return { generatedAt: new Date(now).toISOString(), windows };
  });
}

/**
 * Which articles the author reports cover: those shared since recording began, or every
 * article nytdata has (with 0 shares for those shared before recording began, or never).
 */
export type AuthorScope = 'shared' | 'all';
export const AUTHOR_SCOPES: readonly AuthorScope[] = ['shared', 'all'];

export interface AuthorShares {
  id: number;
  name: string;
  /** This author's articles in the scope: shared ones, or all of them. */
  articles: number;
  /** Posts that shared any of those articles. An article with two authors counts for both. */
  shares: number;
}

export interface AuthorsReport {
  generatedAt: string;
  scope: AuthorScope;
  authors: AuthorShares[];
}

/**
 * Authors who get their own label, with their article and share counts, most shared first
 * (then most articles). With the "shared" scope, only those with a shared article are listed
 * and only those articles count; with "all", every label author is listed with all of their
 * articles.
 */
export function fetchAuthorsReport(scope: AuthorScope = 'shared', now = Date.now()): Promise<AuthorsReport> {
  return cachedReport(`authors:${scope}`, now, async () => {
    // Each (article, author) pair appears once in _ArticleToAuthor, so COUNT(*) counts articles
    const { rows } = await metricsPool.query(
      `SELECT au.id, au.name, COUNT(*)::int AS articles, COALESCE(SUM(s.shares), 0)::int AS shares
       FROM "_ArticleToAuthor" j
       JOIN "Author" au ON au.id = j."B"
       LEFT JOIN (SELECT article_id, COUNT(*) AS shares FROM ${POST_ARTICLES_TABLE} GROUP BY article_id) s
         ON s.article_id = j."A"
       WHERE j."B" IN (${LABEL_AUTHOR_IDS_SQL})
         AND ($1::boolean OR s.article_id IS NOT NULL)
       GROUP BY au.id, au.name
       ORDER BY shares DESC, articles DESC, au.name, au.id`,
      [scope === 'all'],
    );
    return {
      generatedAt: new Date(now).toISOString(),
      scope,
      authors: rows.map((row) => ({ id: row.id, name: row.name, articles: row.articles, shares: row.shares })),
    };
  });
}

export interface AuthorArticle {
  id: number;
  title: string | null;
  url: string;
  /** When nytdata first recorded the article from the Top Stories feed (it has no published date). */
  dateAdded: string;
  shares: number;
}

export interface AuthorReport {
  generatedAt: string;
  scope: AuthorScope;
  author: { id: number; name: string };
  articles: AuthorArticle[];
}

/**
 * An author's articles in the scope, most shared first (then newest); null for an unknown
 * author.
 */
export function fetchAuthorReport(authorId: number, scope: AuthorScope = 'shared', now = Date.now()): Promise<AuthorReport | null> {
  return cachedReport(`author:${authorId}:${scope}`, now, async () => {
    const author = await metricsPool.query('SELECT id, name FROM "Author" WHERE id = $1', [authorId]);
    if (author.rows.length === 0) return null;
    const { rows } = await metricsPool.query(
      // date_created is a TIMESTAMP without time zone holding UTC; mark it as UTC so it
      // doesn't depend on this process's time zone
      `SELECT a.id, a.title, a.url, a.date_created AT TIME ZONE 'UTC' AS date_created, COUNT(pa.id)::int AS shares
       FROM "_ArticleToAuthor" j
       JOIN "Article" a ON a.id = j."A"
       LEFT JOIN ${POST_ARTICLES_TABLE} pa ON pa.article_id = a.id
       WHERE j."B" = $1
       GROUP BY a.id
       HAVING $2::boolean OR COUNT(pa.id) > 0
       ORDER BY shares DESC, a.date_created DESC, a.id`,
      [authorId, scope === 'all'],
    );
    return {
      generatedAt: new Date(now).toISOString(),
      scope,
      author: { id: author.rows[0].id, name: author.rows[0].name },
      articles: rows.map((row) => ({
        id: row.id,
        title: row.title,
        url: row.url,
        dateAdded: new Date(row.date_created).toISOString(),
        shares: row.shares,
      })),
    };
  });
}

/** Clears cached reports. Useful for tests. */
export function resetReportCache(): void {
  cache.clear();
  inFlight.clear();
}
