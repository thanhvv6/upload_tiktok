# Docker + PostgreSQL Migration Design

**Date:** 2026-08-06
**Status:** approved
**Branch:** feat/docker-postgres

## Goal

Containerize the app with Docker for cross-platform (Mac/Windows) execution and migrate from SQLite (better-sqlite3) to PostgreSQL.

## Current State

| Component | Current |
|---|---|
| DB driver | better-sqlite3 (synchronous API) |
| DB file | data/tiktok.db |
| DB calls in server.js | ~112 (prepare/get/all/run/exec/pragma) |
| DB calls in stores | ~15 (group-store.js, profile-store.js) |
| Migrations | 15 manual ALTER TABLE blocks + db.json import |
| Server | Express, port 3010, singleton DB connection |
| System deps | Node.js, Chromium (Playwright), ffmpeg, Python |
| Tests | Node test runner, SQLite :memory: |

## Key Design Decisions

### 1. Approach: DB Adapter + Incremental Migration

Create `backend/db.js` as a single shared PG connection pool. Convert store files first, then server.js route by route. All migration logic consolidated into one SQL file.

### 2. Scope: Mechanical conversion only

No business logic changes. No refactoring of route structure. Same endpoints, same request/response shapes. Only DB access layer changes.

## Target Architecture

```
upload_tiktok/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── backend/
│   ├── db.js                    # [NEW] PG connection pool
│   ├── migrate.js               # [NEW] Migration runner
│   ├── migrations/
│   │   └── 001_init.sql         # [NEW] Consolidated schema
│   ├── group-store.js           # [MODIFIED] async queries
│   ├── profile-store.js         # [MODIFIED] async queries
│   ├── server.js                # [MODIFIED] async route handlers
│   └── tests/
│       ├── group-store.test.js  # [MODIFIED] PG test
│       └── profile-store.test.js
├── profiles/                    # [UNCHANGED]
├── uploads/                     # [UNCHANGED]
└── extensions/                  # [UNCHANGED]
```

## Database Module: `backend/db.js`

```js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tiktok',
  user: process.env.DB_USER || 'tiktok',
  password: process.env.DB_PASSWORD || 'tiktok',
});

// Connection test on startup
const result = await pool.query('SELECT 1');
console.log('[DB] PostgreSQL connected');

export { pool };
```

## Migration: `backend/migrate.js`

Runs on server startup. Reads and executes `001_init.sql`. All 15 old ALTER TABLE blocks in server.js are removed.

```js
import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

export async function runMigrations() {
  const sql = fs.readFileSync(
    path.join(import.meta.dirname, 'migrations', '001_init.sql'),
    'utf-8'
  );
  await pool.query(sql);
  console.log('[DB] Migrations complete');
}
```

## Schema: `backend/migrations/001_init.sql`

Consolidates the initial CREATE TABLE + all 15 migrations into one file:

```sql
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'idle',
    video_folder TEXT,
    proxy TEXT,
    is_scheduled INTEGER DEFAULT 0,
    last_run TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    group_id TEXT,
    set_music INTEGER DEFAULT 0,
    auto_increment_schedule INTEGER DEFAULT 0,
    upload_count INTEGER DEFAULT 1,
    channel_ids TEXT,
    needs_render INTEGER DEFAULT 1,
    render_concat_video INTEGER DEFAULT 0,
    remove_title INTEGER DEFAULT 1,
    render_video_long INTEGER DEFAULT 0,
    need_content_check INTEGER DEFAULT 1,
    avatar_image TEXT,
    music_search TEXT,
    cookies TEXT,
    schedule_interval INTEGER DEFAULT 5
);

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS profile_schedules (
    id SERIAL PRIMARY KEY,
    profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
    time TEXT
);
```

## SQL Dialect Mapping

| SQLite | PostgreSQL |
|---|---|
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value` |
| `db.pragma(...)` | Remove (PRAGMA table_info) or replace with `information_schema.columns` |
| `PRAGMA journal_mode = WAL` | Remove (PG default) |
| `PRAGMA busy_timeout = 10000` | Remove (PG uses connection pooling) |
| `AUTOINCREMENT` | `SERIAL` |
| `error.code === 'SQLITE_CONSTRAINT_UNIQUE'` | `error.code === '23505'` |
| `?` placeholders | `$1`, `$2`, ... |
| `CURRENT_TIMESTAMP` | `NOW()` |
| `INTEGER DEFAULT 0` for bools | Keep INTEGER (compatibility), or BOOLEAN |

## API Pattern Conversion

```js
// BEFORE (SQLite sync)
function getGroupById(db, id) {
  return db.prepare('SELECT id, name, created_at FROM groups WHERE id = ?').get(id);
}
const groups = db.prepare('SELECT * FROM groups').all();
db.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').run(id, name);

// AFTER (PostgreSQL async)
async function getGroupById(id) {
  const result = await pool.query('SELECT id, name, created_at FROM groups WHERE id = $1', [id]);
  return result.rows[0];
}
const { rows: groups } = await pool.query('SELECT * FROM groups');
await pool.query('INSERT INTO groups (id, name) VALUES ($1, $2)', [id, name]);
```

Note: `db` is no longer passed as a parameter — store functions import `pool` directly.

## Docker

### Dockerfile

```dockerfile
FROM node:22-bookworm

# System deps: Chromium + ffmpeg + Python
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ffmpeg \
  python3 \
  python3-pip \
  fonts-noto-cjk \
  fonts-liberation \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libdbus-1-3 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
  && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm install
COPY . .

CMD ["node", "backend/server.js"]
```

### docker-compose.yml

```yaml
services:
  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: tiktok
      POSTGRES_USER: tiktok
      POSTGRES_PASSWORD: tiktok
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tiktok"]
      interval: 5s
      retries: 5

  app:
    build: .
    ports:
      - "3010:3010"
    volumes:
      - ./profiles:/app/profiles
      - ./uploads:/app/uploads
      - ./data:/app/data
      - browser_data:/app/browser_data
    environment:
      DB_HOST: db
      DB_PORT: 5432
      DB_NAME: tiktok
      DB_USER: tiktok
      DB_PASSWORD: tiktok
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
  browser_data:
```

## Local GUI Mode

For local development with browser GUI on Mac/Windows:

- **Mac**: Mount XQuartz socket: `- /tmp/.X11-unix:/tmp/.X11-unix` + `DISPLAY=host.docker.internal:0`
- **Windows**: Use VNC container sidecar (e.g., `scottleigh/vnc`) or `DISPLAY=host.docker.internal:0` with VcXsrv

Controlled via `DISPLAY_MODE` env var:
- `DISPLAY_MODE=headless` → `--headless=new` (server default)
- `DISPLAY_MODE=gui` → headed browser (local dev)

## Environment Variables (`.env.example`)

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=tiktok
DB_USER=tiktok
DB_PASSWORD=tiktok
DISPLAY_MODE=headless
PORT=3010
```

## Package Changes

```diff
- "better-sqlite3": "^12.9.0"
+ "pg": "^8.13.0"
```

`lowdb` kept but deprecated — old migration logic reads `db.json` once and renames it.

## Test Changes

- Replace `new Database(':memory:')` → `pool.query()` against a real PostgreSQL
- Use `CREATE TABLE ... TEMP` for isolated test schema, or a dedicated test database
- Tests remain async with `node:test`

## Implementation Order

| Step | Description | Files |
|---|---|---|
| 1 | Create branch `feat/docker-postgres` | git |
| 2 | Create `db.js` + `migrate.js` + `001_init.sql` | backend/ |
| 3 | Convert `group-store.js` → async, import `pool` | backend/group-store.js |
| 4 | Convert `profile-store.js` → async, import `pool` | backend/profile-store.js |
| 5 | Convert server.js: replace `import Database from 'better-sqlite3'` with `import { pool } from './db.js'`, convert all ~112 DB calls to async | backend/server.js |
| 6 | Remove all old migrations in server.js, replace with `await runMigrations()` | backend/server.js |
| 7 | Apply SQL dialect conversions (INSERT OR IGNORE → ON CONFLICT, etc.) | server.js, group-store.js, profile-store.js |
| 8 | Create `Dockerfile`, `docker-compose.yml`, `.env.example` | root |
| 9 | Convert tests → async PG | backend/tests/ |
| 10 | Update `package.json` | backend/package.json |
| 11 | Validate: `docker compose up`, test all endpoints | manual |
