import db from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationTable() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      run_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function getRunMigrations() {
  const rows = await db.prepare('SELECT name FROM _migrations ORDER BY id').all();
  return new Set(rows.map((r) => r.name));
}

async function runMigrations() {
  await ensureMigrationTable();

  const runSet = await getRunMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (runSet.has(file)) {
      console.log(`[migrate] SKIP ${file} — already run`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`[migrate] RUN  ${file}`);

    // Use a client from the pool for transactional migration
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] DONE ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAIL ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

export default runMigrations;
