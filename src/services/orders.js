const db = require('../lib/db');

async function createPendingOrder({
  provider,
  providerReference,
  telegramUserId,
  telegramUsername,
  buyerEmail,
  buyerName,
  buyerPhone,
  targetType,
  targetCode,
  productId,
  amountCents,
  rawPayload
}) {
  const result = await db.query(
    `INSERT INTO orders (
      provider,
      provider_event_id,
      telegram_user_id,
      telegram_username,
      buyer_name,
      buyer_email,
      buyer_phone,
      target_type,
      target_code,
      product_id,
      amount_cents,
      status,
      raw_payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
    RETURNING *`,
    [
      provider,
      providerReference,
      telegramUserId || null,
      telegramUsername || null,
      buyerName || null,
      buyerEmail || null,
      buyerPhone || null,
      targetType,
      targetCode || null,
      productId || null,
      amountCents,
      rawPayload ? JSON.stringify(rawPayload) : null
    ]
  );

  return result.rows[0];
}

module.exports = {
  createPendingOrder
};
