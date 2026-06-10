import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const ENV = process.env.ENV || 'development';
export const IS_DEV = ENV === 'development';

export const PORT = parseInt(process.env.PORT || '4100', 10);
export const DRY_RUN = process.env.DRY_RUN === 'true';

// ATProto credentials (unified)
export const DID = process.env.BSKY_DID || '';
export const SIGNING_KEY = process.env.BSKY_SIGNING_KEY || '';
export const BSKY_IDENTIFIER = process.env.BSKY_IDENTIFIER || '';
export const BSKY_PASSWORD = process.env.BSKY_PASSWORD || '';

export const SERVICE_URL = IS_DEV
  ? 'https://nyt-labeler-dev.warren.nyc'
  : 'https://nyt-labeler.warren.nyc';

// Database config
export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
export const DB_USER = process.env.DB_USER || 'nytdata';
export const DB_PASSWORD = process.env.DB_PASSWORD || '';
export const DB_NAME = process.env.DB_NAME || 'nytdata';

// Jetstream Config
export const FIREHOSE_URL = process.env.FIREHOSE_URL || 'wss://jetstream.atproto.tools/subscribe';
export const WANTED_COLLECTION = process.env.WANTED_COLLECTION || 'app.bsky.feed.post';

// Validation helper
export function validateConfig() {
  if (DRY_RUN) {
    console.log('⚠️ Running in DRY_RUN mode. Labels will be matched but not published to the live ATProto network.');
    return;
  }
  
  const missing = [];
  if (!DID) missing.push('BSKY_DID');
  if (!SIGNING_KEY) missing.push('BSKY_SIGNING_KEY');
  if (!BSKY_IDENTIFIER) missing.push('BSKY_IDENTIFIER');
  if (!BSKY_PASSWORD) missing.push('BSKY_PASSWORD');

  if (missing.length > 0) {
    console.warn(`⚠️ Warning: Missing ATProto credentials in .env: [${missing.join(', ')}]. Falling back to DRY_RUN mode.`);
    process.env.DRY_RUN = 'true';
  }
}
