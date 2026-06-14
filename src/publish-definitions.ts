import { BskyAgent } from '@atproto/api';
import { fileURLToPath } from 'url';
import { getDistinctCategories, getActiveAuthors, slugify } from './database.js';
import { DID, BSKY_IDENTIFIER, BSKY_PASSWORD, DRY_RUN, validateConfig } from './config.js';
import { formatDisplayName } from './utils.js';

async function publishDefinitions() {
  console.log('📰 Generating and publishing label definitions for NY Times Bluesky Labeler...');

  validateConfig();

  // 1. Fetch distinct sections and subsections
  console.log('🔍 Fetching sections and subsections from postgres...');
  const { sections, subsections } = await getDistinctCategories();
  console.log(`✅ Loaded ${sections.length} sections and ${subsections.length} subsections.`);

  // 2. Fetch opinion authors matching our strict criteria
  console.log('🔍 Fetching opinion authors with > 1 total articles...');
  const authors = await getActiveAuthors();
  console.log(`✅ Loaded ${authors.length} matching authors:`, authors.map(a => a.name));

  // 3. Assemble definitions array
  const definitions: any[] = [];
  const registeredValues = new Set<string>();

  // Add Section labels
  for (const section of sections) {
    const slug = slugify(section);
    if (!slug || registeredValues.has(slug)) continue;
    registeredValues.add(slug);

    // Format display name beautifully
    const formattedName = formatDisplayName(section);

    definitions.push({
      identifier: slug,
      severity: 'inform',
      blurs: 'none',
      defaultSetting: 'warn',
      locales: [
        {
          lang: 'en',
          name: `${formattedName} Section`,
          description: `Articles in the ${formattedName} section of The New York Times`,
        },
      ],
    });
  }

  // Add Subsection labels
  for (const sub of subsections) {
    const slug = slugify(sub);
    if (!slug || registeredValues.has(slug)) continue;
    registeredValues.add(slug);

    const formattedName = formatDisplayName(sub);

    definitions.push({
      identifier: slug,
      severity: 'inform',
      blurs: 'none',
      defaultSetting: 'warn',
      locales: [
        {
          lang: 'en',
          name: `${formattedName} Subsection`,
          description: `Articles in the ${formattedName} subsection of The New York Times`,
        },
      ],
    });
  }

  // Add Author labels (using exact display names in locales!)
  for (const auth of authors) {
    const slug = slugify(auth.name);
    if (!slug || registeredValues.has(slug)) continue;
    registeredValues.add(slug);

    definitions.push({
      identifier: slug,
      severity: 'inform',
      blurs: 'none',
      defaultSetting: 'warn',
      locales: [
        {
          lang: 'en',
          name: auth.name, // EXACT database proper name
          description: `Articles authored by ${auth.name} for The New York Times`,
        },
      ],
    });
  }

  const labelValues = Array.from(registeredValues);

  console.log(`🏷️ Compiled ${definitions.length} total label definitions.`);

  // 4. Assemble service record structure
  const serviceRecord = {
    $type: 'app.bsky.labeler.service',
    policies: {
      labelValues: labelValues,
      labelValueDefinitions: definitions,
    },
    subjectTypes: ['record'],
    subjectCollections: ['app.bsky.feed.post'],
    createdAt: new Date().toISOString(),
  };

  if (DRY_RUN || !BSKY_IDENTIFIER || !BSKY_PASSWORD || !DID) {
    console.log('\n--- [DRY RUN] Compiled app.bsky.labeler.service Record ---');
    console.log(JSON.stringify(serviceRecord, null, 2));
    console.log('------------------------------------------------------------\n');
    console.log('⚠️ Record was NOT published. To publish to the live Bluesky network:');
    console.log('1. Ensure DRY_RUN=false in your .env file.');
    console.log('2. Ensure BSKY_DID, BSKY_SIGNING_KEY, BSKY_IDENTIFIER, and BSKY_PASSWORD are set correctly.');
    process.exit(0);
  }

  // 5. Connect and Login to Bluesky
  console.log(`🔐 Logging into Bluesky as ${BSKY_IDENTIFIER}...`);
  const agent = new BskyAgent({ service: 'https://bsky.social' });

  try {
    await agent.login({
      identifier: BSKY_IDENTIFIER,
      password: BSKY_PASSWORD,
    });
    console.log('🔑 Login successful! Submitting service record...');

    // 6. Publish/Put service record
    await agent.api.com.atproto.repo.putRecord({
      repo: DID,
      collection: 'app.bsky.labeler.service',
      rkey: 'self',
      record: serviceRecord,
    });

    console.log('🎉 SUCCESS! Your labeler service record has been published/updated on the ATProto network!');
    console.log(`🔗 Service DID: ${DID}`);
    console.log(`🌐 Users can now search for and subscribe to your labeler in Bluesky client apps!`);
  } catch (error) {
    console.error('❌ Failed to publish service record to Bluesky:', error);
    process.exit(1);
  }
}

// Execute script only when run directly as a CLI
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('publish-definitions.ts') ||
  process.argv[1].endsWith('publish-definitions.js')
);

if (isMain) {
  publishDefinitions().then(() => {
    process.exit(0);
  });
}
