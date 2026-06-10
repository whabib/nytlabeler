import WebSocket from 'ws';

// Polyfill global WebSocket for @skyware/jetstream in Node.js environments
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WebSocket as any;
}

import { validateConfig } from './config.js';
import { loadActiveAuthors } from './labeler.js';
import { startFirehoseListener } from './jetstream.js';
import { startWebServer } from './server.js';

async function bootstrap() {
  console.log('🏁 Starting NY Times Bluesky Labeler Service...');
  
  // 1. Validate environment configuration
  validateConfig();

  // 2. Load and cache active authors from PostgreSQL database
  await loadActiveAuthors();

  // 3. Connect to Jetstream and start processing firehose posts
  startFirehoseListener();

  // 4. Boot up the control panel web dashboard
  startWebServer();
}

bootstrap().catch((error) => {
  console.error('❌ Critical bootstrap error, process exiting:', error);
  process.exit(1);
});
