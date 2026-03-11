const { Pool } = require('pg');
const env = require('../config/env');
const logger = require('./logger');

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  logger.error({ err }, 'Erro inesperado no pool Postgres');
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

async function healthcheck() {
  const result = await pool.query('SELECT NOW() AS now');
  return result.rows[0];
}

module.exports = {
  pool,
  query,
  getClient,
  withTransaction,
  healthcheck
};