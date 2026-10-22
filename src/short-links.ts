/**
 * Resolves the short links NYT accounts post (nyti.ms, which redirects through trib.al) to
 * the nytimes.com article they point to.
 *
 * Only short-link hosts are ever requested: each redirect's target is checked before it's
 * followed, and resolution stops as soon as it reaches the destination (the article page
 * itself is never fetched). Requests are HEAD, with a short timeout and a hop limit, and
 * results are cached, so a link shared many times is resolved once.
 */

/** Hosts whose redirects are followed. trib.al is a shortener many publishers use. */
const SHORT_LINK_HOSTS = new Set(['nyti.ms', 'www.nyti.ms', 'trib.al']);

/** Short links written into post text (link cards and facets carry full URLs). */
const SHORT_LINK_REGEX = /https?:\/\/(?:www\.)?(?:nyti\.ms|trib\.al)\/[^\s"']+/gi;

const MAX_HOPS = 4;
const REQUEST_TIMEOUT_MS = 3_000;
/** At most this many resolutions at once; past it, a link is skipped rather than queued. */
const MAX_IN_FLIGHT = 20;
const CACHE_LIMIT = 5_000;
/** Short links don't change, so a resolved one is kept a day; a failure is retried sooner. */
const RESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 5 * 60 * 1000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

let fetchImpl: Fetch = (url, init) => fetch(url, init);
const cache = new Map<string, { destination: string | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<string | null>>();

/** Whether a URL is on one of the short-link hosts this module follows. */
export function isShortLink(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return (url.protocol === 'http:' || url.protocol === 'https:') && SHORT_LINK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Extracts short links from a post's link card, link facets and text. */
export function extractShortLinks(record: any): string[] {
  const urls = new Set<string>();
  if (!record) return [];

  const embedUri = record.embed?.$type === 'app.bsky.embed.external' ? record.embed.external?.uri : undefined;
  if (typeof embedUri === 'string' && isShortLink(embedUri)) urls.add(embedUri);

  if (Array.isArray(record.facets)) {
    for (const facet of record.facets) {
      if (!Array.isArray(facet?.features)) continue;
      for (const feature of facet.features) {
        if (feature?.$type === 'app.bsky.richtext.facet#link' && typeof feature.uri === 'string' && isShortLink(feature.uri)) {
          urls.add(feature.uri);
        }
      }
    }
  }

  if (typeof record.text === 'string') {
    for (const match of record.text.matchAll(SHORT_LINK_REGEX)) {
      if (isShortLink(match[0])) urls.add(match[0]);
    }
  }

  return [...urls];
}

/**
 * Follows a short link's redirects until one points at a destination (as judged by
 * isDestination), and returns that URL; null if it leads anywhere else, fails or times out.
 */
export async function resolveShortLink(url: string, isDestination: (url: string) => boolean): Promise<string | null> {
  if (!isShortLink(url)) return null;
  const key = toHttps(url);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.destination;
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (inFlight.size >= MAX_IN_FLIGHT) {
    console.warn('⚠️ [SHORT LINK] Too many short links being resolved; skipping %s', url);
    return null;
  }

  const resolution = follow(key, isDestination)
    .catch(() => null)
    .then((destination) => {
      remember(key, destination);
      return destination;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, resolution);
  return resolution;
}

async function follow(url: string, isDestination: (url: string) => boolean): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const location = await redirectTarget(current);
    if (!location) return null;
    const next = new URL(location, current).toString();
    if (isDestination(next)) return next;
    // Only short-link hosts are ever requested
    if (!isShortLink(next)) return null;
    current = toHttps(next);
  }
  return null;
}

/** The Location of a redirect response, or null if the response isn't a redirect. */
async function redirectTarget(url: string): Promise<string | null> {
  let response = await request(url, 'HEAD');
  // Some servers don't answer HEAD; GET without reading the body works the same
  if (response.status === 405 || response.status === 501) response = await request(url, 'GET');
  await response.body?.cancel().catch(() => {});
  if (response.status < 300 || response.status >= 400) return null;
  return response.headers.get('location');
}

function request(url: string, method: 'HEAD' | 'GET'): Promise<Response> {
  return fetchImpl(url, { method, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Short-link hosts all serve HTTPS; never send the request in the clear. */
function toHttps(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = 'https:';
  return parsed.toString();
}

function remember(key: string, destination: string | null): void {
  cache.delete(key);
  cache.set(key, { destination, expiresAt: Date.now() + (destination ? RESOLVED_TTL_MS : FAILED_TTL_MS) });
  // Maps iterate in insertion order, so this drops the oldest
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Replaces fetch and clears the cache. Useful for unit testing. */
export function configureShortLinks(options: { fetch: Fetch }): void {
  fetchImpl = options.fetch;
  cache.clear();
  inFlight.clear();
}
