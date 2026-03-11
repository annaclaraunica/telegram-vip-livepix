const db = require('../lib/db');
const logger = require('../lib/logger');
const { grantFileToEmail, revokePermission } = require('../drive');
const contentLinks = require('./content-links');

async function storeUserEmail(telegramUserId, email) {
  await db.query(
    `INSERT INTO user_emails (telegram_user_id, email, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()`,
    [telegramUserId, email]
  );
}

async function getUserEmail(telegramUserId) {
  const result = await db.query('SELECT email FROM user_emails WHERE telegram_user_id = $1 LIMIT 1', [telegramUserId]);
  return result.rows[0] ? result.rows[0].email : null;
}

async function queuePendingGrant({ orderId, telegramUserId, email, productId, driveFileId, expiresAt }) {
  await db.query(
    `INSERT INTO pending_grants (telegram_user_id, email, product_id, drive_file_id, order_id, expires_at, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
     ON CONFLICT (order_id)
     DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()`,
    [telegramUserId, email || '', productId, driveFileId, orderId, expiresAt]
  );
}

async function fulfillProductOrder({ order, email }) {
  const existing = await db.query('SELECT * FROM purchases WHERE order_id = $1 LIMIT 1', [order.id]);
  if (existing.rowCount > 0) {
    return contentLinks.createContentLink({
      telegramUserId: order.telegram_user_id,
      productId: order.product_id,
      driveFileId: order.drive_file_id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const grant = await grantFileToEmail({
    driveFileId: order.drive_file_id,
    email,
    expirationTime: expiresAt.toISOString()
  });

  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO drive_access (telegram_user_id, email, drive_file_id, permission_id, expires_at, is_active, order_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (order_id)
       DO NOTHING`,
      [order.telegram_user_id, email, order.drive_file_id, grant.permissionId, expiresAt, order.id]
    );

    await client.query(
      `INSERT INTO purchases (telegram_user_id, product_id, order_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT DO NOTHING`,
      [order.telegram_user_id, order.product_id, order.id]
    );

    await client.query('DELETE FROM pending_grants WHERE order_id = $1', [order.id]);
    await client.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [order.id]);
  });

  return contentLinks.createContentLink({
    telegramUserId: order.telegram_user_id,
    productId: order.product_id,
    driveFileId: order.drive_file_id,
    expiresAt
  });
}

async function processPendingGrantsForUser(telegramUserId, email) {
  const rows = await db.query(
    `SELECT *
     FROM pending_grants
     WHERE telegram_user_id = $1 AND status = 'pending'
     ORDER BY id ASC`,
    [telegramUserId]
  );

  const results = [];
  for (const row of rows.rows) {
    try {
      const link = await fulfillProductOrder({
        order: {
          id: row.order_id,
          telegram_user_id: row.telegram_user_id,
          product_id: row.product_id,
          drive_file_id: row.drive_file_id
        },
        email
      });
      results.push(link);
    } catch (error) {
      logger.warn({ err: error, pendingGrantId: row.id }, 'Falha ao processar grant pendente');
      await db.query(
        `UPDATE pending_grants
         SET attempts = attempts + 1, last_error = $2, updated_at = NOW()
         WHERE id = $1`,
        [row.id, error.message]
      );
    }
  }

  return results;
}

async function revokeExpiredDriveAccesses() {
  const rows = await db.query(
    'SELECT * FROM drive_access WHERE is_active = TRUE AND expires_at <= NOW() ORDER BY id ASC LIMIT 100'
  );

  let revokedCount = 0;
  let revokeFailures = 0;

  for (const row of rows.rows) {
    try {
      await revokePermission({ driveFileId: row.drive_file_id, permissionId: row.permission_id });
    } catch (error) {
      revokeFailures += 1;
      logger.warn({ err: error, driveAccessId: row.id }, 'Falha ao revogar permissao Drive');
    }

    await db.query('UPDATE drive_access SET is_active = FALSE WHERE id = $1', [row.id]);
    revokedCount += 1;
  }

  return {
    scannedCount: rows.rowCount,
    revokedCount,
    revokeFailures
  };
}

async function listPendingGrants(limit = 100) {
  const result = await db.query(
    `SELECT *
     FROM pending_grants
     WHERE status = 'pending'
     ORDER BY updated_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

async function reprocessPendingGrant(pendingGrantId) {
  const result = await db.query(
    `SELECT *
     FROM pending_grants
     WHERE id = $1
     LIMIT 1`,
    [pendingGrantId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  const email = String(row.email || '').trim();
  if (!email) {
    return {
      ok: false,
      reason: 'missing_email',
      pendingGrant: row
    };
  }

  try {
    const link = await fulfillProductOrder({
      order: {
        id: row.order_id,
        telegram_user_id: row.telegram_user_id,
        product_id: row.product_id,
        drive_file_id: row.drive_file_id
      },
      email
    });

    await db.query(
      `UPDATE pending_grants
       SET status = 'processed',
           updated_at = NOW(),
           last_error = NULL
       WHERE id = $1`,
      [pendingGrantId]
    );

    return {
      ok: true,
      link
    };
  } catch (error) {
    logger.warn({ err: error, pendingGrantId }, 'Falha ao reprocessar grant pendente manualmente');
    await db.query(
      `UPDATE pending_grants
       SET attempts = attempts + 1,
           last_error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [pendingGrantId, error.message]
    );

    return {
      ok: false,
      reason: 'grant_failed',
      error: error.message
    };
  }
}

module.exports = {
  storeUserEmail,
  getUserEmail,
  queuePendingGrant,
  fulfillProductOrder,
  processPendingGrantsForUser,
  revokeExpiredDriveAccesses,
  listPendingGrants,
  reprocessPendingGrant
};
