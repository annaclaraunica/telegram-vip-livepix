const db = require('../lib/db');

async function listActivePlans() {
  const result = await db.query(
    'SELECT code, title, price_cents, duration_days FROM config_plans WHERE active = TRUE ORDER BY duration_days ASC'
  );
  return result.rows;
}

async function getPlanByCode(code) {
  const result = await db.query(
    'SELECT code, title, price_cents, duration_days FROM config_plans WHERE code = $1 AND active = TRUE LIMIT 1',
    [code]
  );
  return result.rows[0] || null;
}

async function getActiveVipAccess(telegramUserId) {
  const result = await db.query(
    `SELECT *
     FROM vip_access
     WHERE telegram_user_id = $1 AND is_active = TRUE
     ORDER BY expires_at DESC
     LIMIT 1`,
    [telegramUserId]
  );
  return result.rows[0] || null;
}

async function extendVipAccess({ orderId, telegramUserId, telegramUsername, planCode, durationDays }) {
  return db.withTransaction(async (client) => {
    const existingByOrder = await client.query('SELECT * FROM vip_access WHERE order_id = $1 LIMIT 1', [orderId]);
    if (existingByOrder.rowCount > 0) {
      return existingByOrder.rows[0];
    }

    const current = await client.query(
      `SELECT expires_at
       FROM vip_access
       WHERE telegram_user_id = $1 AND is_active = TRUE
       ORDER BY expires_at DESC
       LIMIT 1
       FOR UPDATE`,
      [telegramUserId]
    );

    const now = new Date();
    const currentExpiry = current.rows[0] ? new Date(current.rows[0].expires_at) : null;
    const baseDate = currentExpiry && currentExpiry > now ? currentExpiry : now;
    const expiresAt = new Date(baseDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

    await client.query('UPDATE vip_access SET is_active = FALSE WHERE telegram_user_id = $1 AND is_active = TRUE', [
      telegramUserId
    ]);

    const inserted = await client.query(
      `INSERT INTO vip_access (telegram_user_id, telegram_username, plan_code, starts_at, expires_at, is_active, order_id)
       VALUES ($1, $2, $3, NOW(), $4, TRUE, $5)
       RETURNING *`,
      [telegramUserId, telegramUsername || null, planCode, expiresAt, orderId]
    );

    return inserted.rows[0];
  });
}

async function expireVipAccesses() {
  const result = await db.query(
    `UPDATE vip_access
     SET is_active = FALSE
     WHERE is_active = TRUE AND expires_at <= NOW()
     RETURNING telegram_user_id`
  );

  return result.rows;
}

module.exports = {
  listActivePlans,
  getPlanByCode,
  getActiveVipAccess,
  extendVipAccess,
  expireVipAccesses
};
