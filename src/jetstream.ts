import { Jetstream } from '@skyware/jetstream';
import { FIREHOSE_URL, WANTED_COLLECTION } from './config.js';
import { lookupArticle } from './database.js';
import { issueLabelsForPost, stats } from './labeler.js';

export let jetstream: Jetstream | null = null;

// Regex to detect standard NY Times links in text
const NYT_REGEX = /https?:\/\/(?:www\.)?nytimes\.com\/[^\s"']+/gi;

/**
 * Extracts all NY Times URLs from a Bluesky post record.
 */
function extractNytUrls(record: any): string[] {
  const urls = new Set<string>();

  // 1. Check external embed (link cards)
  if (record.embed && record.embed.$type === 'app.bsky.embed.external' && record.embed.external?.uri) {
    const uri = record.embed.external.uri;
    if (uri.toLowerCase().startsWith('https://www.nytimes.com') || uri.toLowerCase().startsWith('https://nytimes.com')) {
      urls.add(uri);
    }
  }

  // 2. Check facets (richtext links)
  if (record.facets && Array.isArray(record.facets)) {
    for (const facet of record.facets) {
      if (facet.features && Array.isArray(facet.features)) {
        for (const feature of facet.features) {
          if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
            const uri = feature.uri;
            if (uri.toLowerCase().startsWith('https://www.nytimes.com') || uri.toLowerCase().startsWith('https://nytimes.com')) {
              urls.add(uri);
            }
          }
        }
      }
    }
  }

  // 3. Fallback to regex text search
  if (record.text && typeof record.text === 'string') {
    let match;
    // Reset regex state since it has global flag
    NYT_REGEX.lastIndex = 0;
    while ((match = NYT_REGEX.exec(record.text)) !== null) {
      urls.add(match[0]);
    }
  }

  return Array.from(urls);
}

/**
 * Starts the Jetstream listener subscribing to the live Bluesky firehose.
 */
export function startFirehoseListener() {
  console.log(`📡 Connecting to Jetstream firehose at: ${FIREHOSE_URL}`);
  
  jetstream = new Jetstream({
    wantedCollections: [WANTED_COLLECTION],
  });

  // Handle new post events
  jetstream.onCreate(WANTED_COLLECTION, async (event) => {
    stats.postsProcessed++;
    
    const record = event.commit.record as any;
    if (!record) return;

    const nytUrls = extractNytUrls(record);
    if (nytUrls.length === 0) return;

    stats.nytLinksDetected++;
    const postUri = `at://${event.did}/${WANTED_COLLECTION}/${event.commit.rkey}`;
    const authorDid = event.did;
    const postText = record.text || '';

    console.log(`🔍 [NYT LINK] Detected NY Times URL(s) in post ${postUri}: ${nytUrls.join(', ')}`);

    for (const url of nytUrls) {
      try {
        const article = await lookupArticle(url);
        if (article) {
          console.log(`🎯 [DB MATCH] Found article in nytdata: "${article.title}" [Section: ${article.section}, Subsection: ${article.subsection || 'None'}, Authors: ${article.authors.join(', ')}]`);
          
          await issueLabelsForPost(postUri, authorDid, postText, {
            section: article.section,
            subsection: article.subsection,
            authors: article.authors,
            title: article.title,
          });
        } else {
          console.log(`🫙 [NO DB MATCH] URL not found in database: ${url}`);
        }
      } catch (err) {
        console.error(`❌ Error processing link ${url} for post ${postUri}:`, err);
      }
    }
  });

  jetstream.on('error', (error) => {
    console.error('❌ Jetstream client error:', error);
  });

  jetstream.on('close', () => {
    console.log('🔌 Jetstream connection closed. Reconnecting...');
  });

  try {
    jetstream.start();
    console.log('✅ Jetstream listener successfully started!');
  } catch (error) {
    console.error('❌ Failed to start Jetstream client:', error);
  }
}
