const db = require('../lib/db');
const env = require('../config/env');
const { generateToken } = require('../lib/crypto');

function buildContentUrl(token) {
  return new URL(`/c/${token}`, env.appBaseUrl).toString();
}

function buildDriveUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

async function createContentLink({ telegramUserId, productId, driveFileId, expiresAt }) {
  const token = generateToken(18);
  const result = await db.query(
    `INSERT INTO content_links (token, telegram_user_id, product_id, drive_file_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING token, expires_at`,
    [token, telegramUserId, productId, driveFileId, expiresAt]
  );

  return {
    token: result.rows[0].token,
    expiresAt: result.rows[0].expires_at,
    url: buildContentUrl(result.rows[0].token)
  };
}

async function consumeContentLink(token) {
  const updated = await db.query(
    `UPDATE content_links
     SET used_count = used_count + 1, used_at = NOW()
     WHERE token = $1 AND used_count = 0 AND expires_at > NOW()
     RETURNING drive_file_id`,
    [token]
  );

  if (updated.rowCount > 0) {
    return {
      status: 'ok',
      url: buildDriveUrl(updated.rows[0].drive_file_id)
    };
  }

  const current = await db.query('SELECT used_count, expires_at FROM content_links WHERE token = $1', [token]);
  if (current.rowCount === 0) {
    return { status: 'missing' };
  }

  if (Number(current.rows[0].used_count) > 0) {
    return { status: 'used' };
  }

  return { status: 'expired' };
}

async function cleanupExpiredContentLinks() {
  const result = await db.query('DELETE FROM content_links WHERE expires_at <= NOW()');
  return result.rowCount;
}

module.exports = {
  buildContentUrl,
  createContentLink,
  consumeContentLink,
  cleanupExpiredContentLinks
};
