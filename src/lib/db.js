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
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS preview_drive_file_id TEXT',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS preview_mime TEXT',
    "ALTER TABLE pending_grants ALTER COLUMN email DROP NOT NULL",
    "ALTER TABLE pending_grants ALTER COLUMN email SET DEFAULT ''",
    'ALTER TABLE pending_grants ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE',
    'ALTER TABLE pending_grants ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ',
    'ALTER TABLE vip_access ADD COLUMN IF NOT EXISTS order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL',
    'ALTER TABLE drive_access ADD COLUMN IF NOT EXISTS order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL',
    "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending'",
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_grants_order ON pending_grants(order_id) WHERE order_id IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_purchases_order ON purchases(order_id) WHERE order_id IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_provider_reference ON orders(provider, provider_event_id) WHERE provider_event_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(provider_event_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
    'CREATE INDEX IF NOT EXISTS idx_drive_access_active_exp ON drive_access(is_active, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_content_links_active ON content_links(token, used_count, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_vip_access_active_exp ON vip_access(is_active, expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_payment_audit_provider_event ON payment_audit_logs(provider, event_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_payment_audit_order ON payment_audit_logs(order_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_bot_user_events_user_created ON bot_user_events(telegram_user_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_remarketing_campaigns_status ON remarketing_campaigns(status, updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_remarketing_messages_due ON remarketing_messages(status, due_at ASC)',
    'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    'CREATE TABLE IF NOT EXISTS app_settings_audit_logs (id SERIAL PRIMARY KEY, setting_key TEXT NOT NULL, actor TEXT NOT NULL, previous_value JSONB, next_value JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    'CREATE INDEX IF NOT EXISTS idx_app_settings_audit_key_created ON app_settings_audit_logs(setting_key, created_at DESC)'
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
