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

// Choose ATProto credentials based on environment
export const DID = IS_DEV 
  ? (process.env.DEV_DID || '') 
  : (process.env.PROD_DID || '');

export const SIGNING_KEY = IS_DEV 
  ? (process.env.DEV_SIGNING_KEY || '') 
  : (process.env.PROD_SIGNING_KEY || '');

export const BSKY_IDENTIFIER = IS_DEV 
  ? (process.env.DEV_BSKY_IDENTIFIER || 'nyt-labeler-dev@bsky.social') 
  : (process.env.PROD_BSKY_IDENTIFIER || 'nyt-labeler@bsky.social');

export const BSKY_PASSWORD = IS_DEV 
  ? (process.env.DEV_BSKY_PASSWORD || '') 
  : (process.env.PROD_BSKY_PASSWORD || '');

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
  if (!DID) missing.push(IS_DEV ? 'DEV_DID' : 'PROD_DID');
  if (!SIGNING_KEY) missing.push(IS_DEV ? 'DEV_SIGNING_KEY' : 'PROD_SIGNING_KEY');
  if (!BSKY_IDENTIFIER) missing.push(IS_DEV ? 'DEV_BSKY_IDENTIFIER' : 'PROD_BSKY_IDENTIFIER');
  if (!BSKY_PASSWORD) missing.push(IS_DEV ? 'DEV_BSKY_PASSWORD' : 'PROD_BSKY_PASSWORD');

  if (missing.length > 0) {
    console.warn(`⚠️ Warning: Missing ATProto credentials in .env: [${missing.join(', ')}]. Falling back to DRY_RUN mode.`);
    process.env.DRY_RUN = 'true';
  }
}
