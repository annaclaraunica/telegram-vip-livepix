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
  return db.withTransaction(async (client) => {
    const result = await client.query(
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
      ON CONFLICT (provider, provider_event_id)
      DO UPDATE
      SET telegram_user_id = COALESCE(orders.telegram_user_id, EXCLUDED.telegram_user_id),
          telegram_username = COALESCE(orders.telegram_username, EXCLUDED.telegram_username),
          buyer_name = COALESCE(orders.buyer_name, EXCLUDED.buyer_name),
          buyer_email = COALESCE(orders.buyer_email, EXCLUDED.buyer_email),
          buyer_phone = COALESCE(orders.buyer_phone, EXCLUDED.buyer_phone),
          target_type = COALESCE(orders.target_type, EXCLUDED.target_type),
          target_code = COALESCE(orders.target_code, EXCLUDED.target_code),
          product_id = COALESCE(orders.product_id, EXCLUDED.product_id),
          amount_cents = CASE
            WHEN orders.amount_cents IS NULL OR orders.amount_cents = 0 THEN EXCLUDED.amount_cents
            ELSE orders.amount_cents
          END,
          raw_payload = COALESCE(orders.raw_payload, EXCLUDED.raw_payload)
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
  });
}

module.exports = {
  createPendingOrder
};
