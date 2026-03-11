const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const env = require('../config/env');
const logger = require('./logger');

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  max: env.dbPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Erro inesperado no pool Postgres');
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  const schemaPath = path.resolve(process.cwd(), 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);

  const extraStatements = [
    "ALTER TABLE pending_grants ALTER COLUMN email DROP NOT NULL",
    "ALTER TABLE pending_grants ALTER COLUMN email SET DEFAULT ''",
    'ALTER TABLE pending_grants ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE',
    'ALTER TABLE pending_grants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ',
    'ALTER TABLE vip_access ADD COLUMN IF NOT EXISTS order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL',
    'ALTER TABLE drive_access ADD COLUMN IF NOT EXISTS order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL',
    "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending'",
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_grants_order ON pending_grants(order_id) WHERE order_id IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_purchases_order ON purchases(order_id) WHERE order_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(provider_event_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
    'CREATE INDEX IF NOT EXISTS idx_drive_access_active_exp ON drive_access(is_active, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_content_links_active ON content_links(token, used_count, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_vip_access_active_exp ON vip_access(is_active, expires_at)'
  ];

  for (const statement of extraStatements) {
    await pool.query(statement);
  }
}

async function healthcheck() {
  const result = await pool.query('SELECT NOW() AS now');
  return result.rows[0];
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  getClient,
  withTransaction,
  migrate,
  healthcheck,
  close
};
