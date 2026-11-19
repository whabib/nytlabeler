import type { Client } from '@atproto/lex-client';
import { fileURLToPath } from 'url';
import { withBlueskySession, type BlueskyLogin } from './bluesky.js';
import { DID, BSKY_IDENTIFIER, BSKY_PASSWORD, DRY_RUN } from './config.js';
import { popularArticles, REPORT_WINDOWS } from './reports.js';

/** How many stories a post lists. */
export const TOP_STORIES_COUNT = 3;

/** Bluesky's limit on a post's text, in graphemes (what people see as characters). */
export const POST_MAX_GRAPHEMES = 300;

export interface TopStory {
  url: string;
  /** The headline, shown as the link's text; without one, the shortened URL is shown. */
  title?: string | null;
  shares: number;
}

export interface TopStoriesPost {
  text: string;
  facets: {
    index: { byteStart: number; byteEnd: number };
    features: { $type: 'app.bsky.richtext.facet#link'; uri: string }[];
  }[];
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (text: string) => [...segmenter.segment(text)].map((s) => s.segment);
const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8');

/** The periods a post can cover (the Reports page's): 1h, 8h, 24h or 7d. */
export type TopStoriesWindow = (typeof REPORT_WINDOWS)[number];

export function findWindow(key: string): TopStoriesWindow | undefined {
  return REPORT_WINDOWS.find((w) => w.key === key);
}

function header(count: number, period: string): string {
  return count === 1 ? `Top Shared NYT Story ${period}:` : `Top ${count} Shared NYT Stories ${period}:`;
}

function sharesText(shares: number): string {
  return `, ${shares} ${shares === 1 ? 'share' : 'shares'}`;
}

/**
 * How a link is shown in the post, like the Bluesky app shows links: without the scheme,
 * "www.", query or fragment, and cut short with "…" past `max` graphemes. The full URL is
 * kept in the link facet, so the shortened text still opens the story.
 */
export function displayUrl(url: string, max: number): string {
  return shorten(url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, ''), max);
}

/** Cuts text short with "…" past `max` graphemes. */
function shorten(text: string, max: number): string {
  const chars = graphemes(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(max - 1, 0)).join('')}…`;
}

/** A story's link text: its headline on one line, or the shortened URL when it has none. */
function linkText(story: TopStory): string {
  const title = story.title?.replace(/\s+/g, ' ').trim();
  return title || displayUrl(story.url, Infinity);
}

/**
 * Shares `budget` graphemes among texts of the given lengths: short ones keep their full
 * length, and the rest is split evenly among the long ones.
 */
function allot(lengths: number[], budget: number): number[] {
  const allotted = new Array<number>(lengths.length);
  let remaining = budget;
  const order = lengths.map((length, i) => ({ length, i })).sort((a, b) => a.length - b.length);
  order.forEach(({ length, i }, n) => {
    allotted[i] = Math.min(length, Math.floor(remaining / (order.length - n)));
    remaining -= allotted[i];
  });
  return allotted;
}

/**
 * The post for one period (`period` is its label, like "Last Hour"): a heading, then one line
 * per story with its headline and share count. Each headline is a link to the story (a link
 * facet, by byte offsets into the UTF-8 text); a story without one shows its shortened URL.
 * Headlines are cut short as needed to keep the text within Bluesky's 300-grapheme limit.
 * Returns null when nothing was shared, since there's nothing to post.
 */
export function buildTopStoriesPost(stories: TopStory[], period = 'Last Hour'): TopStoriesPost | null {
  const listed = stories.slice(0, TOP_STORIES_COUNT);
  if (listed.length === 0) return null;

  const heading = header(listed.length, period);
  // Everything but the link texts: the heading, and each line's line break and share count
  const fixed = graphemes(heading).length + listed.reduce((sum, s) => sum + 1 + graphemes(sharesText(s.shares)).length, 0);
  const texts = listed.map(linkText);
  const lengths = allot(texts.map((t) => graphemes(t).length), POST_MAX_GRAPHEMES - fixed);

  let text = heading;
  const facets: TopStoriesPost['facets'] = [];
  for (const [i, story] of listed.entries()) {
    text += '\n';
    const shown = shorten(texts[i], lengths[i]);
    const byteStart = utf8Length(text);
    text += shown;
    facets.push({
      index: { byteStart, byteEnd: utf8Length(text) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: story.url }],
    });
    text += sharesText(story.shares);
  }
  return { text, facets };
}

/** Logs in, creates the post on the account, logs out, and returns the new post's URI. */
export async function postTopStories(
  post: TopStoriesPost,
  options: BlueskyLogin & { repo: string; now?: Date },
): Promise<string> {
  return withBlueskySession(options, async (client) => {
    const record = {
      $type: 'app.bsky.feed.post',
      text: post.text,
      facets: post.facets,
      langs: ['en'],
      createdAt: (options.now ?? new Date()).toISOString(),
    };
    const response = await client.createRecord(record as Parameters<Client['createRecord']>[0], undefined, {
      repo: options.repo as `did:${string}:${string}`,
    });
    return response.body.uri;
  });
}

async function run(windowKey: string) {
  const window = findWindow(windowKey);
  if (!window) {
    throw new Error(`Unknown period "${windowKey}"; use one of ${REPORT_WINDOWS.map((w) => w.key).join(', ')}`);
  }
  console.log('📰 Posting the most shared NYT stories (%s)...', window.label);
  // Not validateConfig(): posting needs the app password, not the labeling signing key

  const stories = await popularArticles(window.interval, TOP_STORIES_COUNT);
  const post = buildTopStoriesPost(stories, window.label);
  if (!post) {
    console.log('ℹ️ No NYT stories were shared (%s); nothing to post.', window.label);
    return;
  }
  console.log('📝 Post text:\n%s', post.text);

  if (DRY_RUN || !BSKY_IDENTIFIER || !BSKY_PASSWORD || !DID) {
    console.log('⚠️ [DRY RUN] Not posted. Set DRY_RUN=false and the Bluesky credentials to post.');
    return;
  }

  const uri = await postTopStories(post, {
    service: 'https://bsky.social',
    identifier: BSKY_IDENTIFIER,
    password: BSKY_PASSWORD,
    repo: DID,
  });
  console.log('🎉 Posted %s', uri);
}

// Run only when executed directly (the Cloud Run job), not when imported by tests. The one
// argument is the period: 1h (the default), 8h, 24h or 7d.
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('top-stories.ts') ||
  process.argv[1].endsWith('top-stories.js')
);

if (isMain) {
  run(process.argv[2] ?? '1h').then(
    () => process.exit(0),
    (error) => {
      console.error('❌ Failed to post the top stories:', error);
      process.exit(1);
    },
  );
}
