import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'tiktok',
  user: process.env.DB_USER || 'tiktok',
  password: process.env.DB_PASSWORD || 'tiktok',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err);
});

/**
 * Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...`
 */
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Create a db-like wrapper scoped to a single client connection.
 * Used by transaction() so all queries in a transaction share one connection.
 */
function makeClientDb(client) {
  return {
    prepare(sql) {
      const converted = convertPlaceholders(sql);
      return {
        async get(...params) {
          const result = await client.query(converted, params);
          return result.rows[0];
        },
        async all(...params) {
          const result = await client.query(converted, params);
          return result.rows;
        },
        async run(...params) {
          await client.query(converted, params);
        },
      };
    },
  };
}

/**
 * Async DB wrapper providing a better-sqlite3-compatible interface.
 * - .prepare(sql) → { get(), all(), run() }  (all async)
 * - .exec(sql)  → runs raw SQL
 * - .query(sql, params) → raw pg query result
 * - .transaction(fn) → runs fn(tdb) inside BEGIN/COMMIT on a single client
 */
const db = {
  pool,

  prepare(sql) {
    const converted = convertPlaceholders(sql);
    return {
      async get(...params) {
        const result = await pool.query(converted, params);
        return result.rows[0];
      },
      async all(...params) {
        const result = await pool.query(converted, params);
        return result.rows;
      },
      async run(...params) {
        await pool.query(converted, params);
      },
    };
  },

  async exec(sql) {
    await pool.query(convertPlaceholders(sql));
  },

  async query(sql, params = []) {
    return pool.query(convertPlaceholders(sql), params);
  },

  // Run a callback inside a transaction. All queries inside fn must use the
  // transaction-scoped `tdb` parameter (not the outer `db`) to go through the
  // same client connection.
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(makeClientDb(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // PG doesn't have PRAGMA — return empty array so migration checks skip cleanly
  pragma() {
    return { all: async () => [] };
  },

  async close() {
    await pool.end();
  },
};

export default db;
