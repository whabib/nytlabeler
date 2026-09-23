import WebSocket from 'ws';

// Polyfill global WebSocket in Node.js environments that lack it
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WebSocket as any;
}

import { validateConfig } from './config.js';
import { loadActiveAuthors, prepareLabelStore, initLabelStoreGate } from './labeler.js';
import { initFirehose } from './jetstream.js';
import { startWebServer } from './server.js';
import { loadSetting } from './database.js';

async function bootstrap() {
  console.log('🏁 Starting NY Times Bluesky Labeler Service...');
  
  // 1. Validate environment configuration
  validateConfig();

  // 1.5. Hold labeler requests until the label table is ready, before the web server starts
  initLabelStoreGate();

  // 2. Start the web server immediately to bind port 4100/4101 and avoid Cloud Run startup timeouts/probe failures
  startWebServer();

  // 3. Load and cache active authors from PostgreSQL database
  await loadActiveAuthors();

  // 4. Wait for the Postgres label table to be ready, then let labeler requests through
  await prepareLabelStore();

  // 5. Compete for firehose leadership; the leader connects to Jetstream if the firehose is enabled
  const firehoseEnabledSetting = await loadSetting('firehose_enabled', 'true');
  initFirehose(firehoseEnabledSetting === 'true');
  if (firehoseEnabledSetting !== 'true') {
    console.log('🔌 Jetstream firehose is persistently toggled OFF; waiting for it to be enabled.');
  }

  console.log('✅ NY Times Bluesky Labeler Service fully bootstrapped and active!');
}

bootstrap().catch((error) => {
  console.error('❌ Critical bootstrap error, process exiting:', error);
  process.exit(1);
});
