import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { LabelerServer, signLabel } from 'labeler';
import { migrateLegacyLabels } from '../src/migrate-labels.js';

// Runs only against a disposable database. Never point this at the shared nytdata database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const DID = 'did:plc:ragtjsm2j2vknq6zbnujgah7';
const KEY = new Uint8Array(32).fill(7);
const KEY_HEX = Buffer.from(KEY).toString('hex');

describe('migrateLegacyLabels (Postgres)', { skip: !testDatabaseUrl && 'TEST_DATABASE_URL is not set' }, () => {
  let pool: pg.Pool;
  const schema = `nyt_migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const legacyTable = `"${schema}"."_Labels"`;
  const servers: LabelerServer[] = [];

  // Same shape as the production "_Labels" table
  async function createLegacyTable() {
    await pool.query(`
      CREATE TABLE ${legacyTable} (
        environment VARCHAR(50) NOT NULL,
        id INT NOT NULL,
        src VARCHAR(255) NOT NULL,
        uri VARCHAR(511) NOT NULL,
        cid VARCHAR(255),
        val VARCHAR(255) NOT NULL,
        neg BOOLEAN DEFAULT FALSE,
        cts TIMESTAMP NOT NULL,
        exp TIMESTAMP,
        sig BYTEA,
        PRIMARY KEY (environment, id)
      )`);
  }

  async function insertLegacy(environment: string, id: number, val: string, cts: string, signedVal = val) {
    const { sig } = signLabel({ src: DID, uri: `at://did:plc:x/app.bsky.feed.post/${id}`, val: signedVal, neg: false, cts: cts as any }, KEY);
    await pool.query(
      `INSERT INTO ${legacyTable} (environment, id, src, uri, val, neg, cts, sig) VALUES ($1, $2, $3, $4, $5, false, $6, $7)`,
      [environment, id, DID, `at://did:plc:x/app.bsky.feed.post/${id}`, val, cts, Buffer.from(sig)],
    );
  }

  async function newServer(table: string) {
    const server = new LabelerServer({ did: DID, signingKey: KEY_HEX, postgres: { pool, table } });
    servers.push(server);
    await server.ready();
    return server;
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await createLegacyTable();
    await insertLegacy('development', 14, 'us', '2026-06-13T02:55:09.289Z');
    await insertLegacy('development', 15, 'politics', '2026-06-13T02:55:09.351Z');
    await insertLegacy('development', 39, 'world', '2026-06-13T02:59:25.723Z');
    await insertLegacy('development', 40, 'dummy-sequence-pad', '2026-08-26T21:06:00.000Z');
    await insertLegacy('production', 14, 'opinion', '2026-07-01T00:00:00.000Z');
  });

  after(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(resolve));
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  test('copies this environment’s labels with their ids, exact timestamps and signatures', async () => {
    const table = `${schema}.labels_development`;
    const server = await newServer(table);

    const result = await migrateLegacyLabels(pool, { targetTable: table, legacyTable, environment: 'development', signingKey: KEY });
    assert.deepStrictEqual(result, { migrated: 4, checkedSignatures: 4 });

    const rows = (await pool.query(`SELECT id, val, cts, sig FROM ${table} ORDER BY id`)).rows;
    assert.deepStrictEqual(rows.map((row) => row.id), ['14', '15', '39', '40']);
    assert.deepStrictEqual(rows.map((row) => row.cts), [
      '2026-06-13T02:55:09.289Z',
      '2026-06-13T02:55:09.351Z',
      '2026-06-13T02:59:25.723Z',
      '2026-08-26T21:06:00.000Z',
    ]);

    // The labeler serves migrated labels with their original signatures
    const served = await server.store.query({ uriPatterns: [], sources: [], cursor: 0, limit: 10 });
    const legacySigs = (await pool.query(
      `SELECT sig FROM ${legacyTable} WHERE environment = 'development' ORDER BY id`,
    )).rows.map((row) => Buffer.from(row.sig).toString('hex'));
    assert.deepStrictEqual(served.map((label) => Buffer.from(label.sig).toString('hex')), legacySigs);

    // New labels continue after the highest migrated id
    const next = await server.createLabel({ uri: 'did:plc:after', val: 'next' });
    assert.strictEqual(next.id, 41);

    // A second startup finds the table populated and does nothing
    const again = await migrateLegacyLabels(pool, { targetTable: table, legacyTable, environment: 'development', signingKey: KEY });
    assert.strictEqual(again.skipped, 'target-not-empty');
    assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 5);
  });

  test('rolls back the whole copy if a signature does not match', async () => {
    const table = `${schema}.labels_tampered`;
    await newServer(table);
    // A row whose stored value differs from what was signed
    await insertLegacy('tampered', 1, 'good', '2026-06-13T00:00:00.000Z');
    await insertLegacy('tampered', 2, 'changed', '2026-06-13T00:00:01.000Z', 'original');

    await assert.rejects(
      migrateLegacyLabels(pool, { targetTable: table, legacyTable, environment: 'tampered', signingKey: KEY }),
      /does not match its signature/,
    );
    assert.strictEqual((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  });

  test('skips when there is no legacy table', async () => {
    const table = `${schema}.labels_fresh`;
    await newServer(table);
    const result = await migrateLegacyLabels(pool, {
      targetTable: table,
      legacyTable: `"${schema}"."_Missing"`,
      environment: 'development',
      signingKey: KEY,
    });
    assert.strictEqual(result.skipped, 'no-legacy-table');
  });
});
