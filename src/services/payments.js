const db = require('../lib/db');
const logger = require('../lib/logger');
const grants = require('./grants');
const products = require('./products');
const vip = require('./vip');
const remarketing = require('./remarketing');
const notifications = require('./notifications');

function normalizePayload(payload) {
  const resource = payload && typeof payload === 'object' ? payload.resource || payload.data || payload : {};
  const metadata = resource.metadata || payload.metadata || {};
  const customer = resource.customer || payload.customer || {};

  return {
    eventId: String(payload.id || payload.eventId || resource.eventId || resource.id || ''),
    paymentId: String(resource.id || payload.paymentId || ''),
    reference: String(resource.reference || metadata.reference || ''),
    status: String(resource.status || payload.status || '').toLowerCase(),
    amountCents: Number(resource.amount || metadata.amount_cents || 0),
    telegramUserId: metadata.telegram_user_id ? Number(metadata.telegram_user_id) : null,
    telegramUsername: metadata.telegram_username || null,
    targetType: metadata.target_type || null,
    targetCode: metadata.target_code || metadata.plan_code || null,
    productId: metadata.product_id ? Number(metadata.product_id) : null,
    buyerName: customer.name || metadata.buyer_name || null,
    buyerEmail: customer.email || metadata.buyer_email || null,
    buyerPhone: customer.phone || metadata.buyer_phone || null,
    rawPayload: payload
  };
}

function isPaidStatus(status) {
  return ['approved', 'completed', 'paid', 'confirmed'].includes(status);
}

async function writeAuditLog(executor, entry) {
  const queryable = typeof executor.query === 'function' ? executor : db;
  await queryable.query(
    `INSERT INTO payment_audit_logs (
      provider,
      event_id,
      payment_id,
      order_id,
      stage,
      status,
      message,
      payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.provider,
      entry.eventId || null,
      entry.paymentId || null,
      entry.orderId || null,
      entry.stage,
      entry.status,
      entry.message || null,
      entry.payload ? JSON.stringify(entry.payload) : null
    ]
  );
}

async function claimWebhook(client, provider, eventId) {
  const inserted = await client.query(
    `INSERT INTO processed_webhooks (provider, event_id, status)
     VALUES ($1, $2, 'processing')
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [provider, eventId]
  );

  if (inserted.rowCount > 0) {
    await writeAuditLog(client, {
      provider,
      eventId,
      stage: 'webhook_claim',
      status: 'processing',
      message: 'Webhook claimed for processing'
    });
    return { claimed: true };
  }

  const current = await client.query(
    'SELECT * FROM processed_webhooks WHERE provider = $1 AND event_id = $2 FOR UPDATE',
    [provider, eventId]
  );

  if (current.rowCount === 0) {
    return { claimed: false, status: 'missing' };
  }

  if (current.rows[0].status === 'failed') {
    await client.query(
      'UPDATE processed_webhooks SET status = $3 WHERE provider = $1 AND event_id = $2',
      [provider, eventId, 'processing']
    );
    await writeAuditLog(client, {
      provider,
      eventId,
      stage: 'webhook_reclaim',
      status: 'processing',
      message: 'Failed webhook reclaimed'
    });
    return { claimed: true };
  }

  await writeAuditLog(client, {
    provider,
    eventId,
    stage: 'webhook_duplicate',
    status: current.rows[0].status,
    message: 'Webhook already processed or in progress'
  });
  return { claimed: false, status: current.rows[0].status };
}

async function markWebhook(provider, eventId, status) {
  await db.query('UPDATE processed_webhooks SET status = $3 WHERE provider = $1 AND event_id = $2', [
    provider,
    eventId,
    status
  ]);
}

async function loadOrderForWebhook(client, payment) {
  if (payment.paymentId) {
    const byPayment = await client.query(
      'SELECT * FROM orders WHERE provider = $1 AND provider_payment_id = $2 LIMIT 1 FOR UPDATE',
      ['livepix', payment.paymentId]
    );
    if (byPayment.rowCount > 0) {
      return byPayment.rows[0];
    }
  }

  if (payment.reference) {
    const byReference = await client.query(
      'SELECT * FROM orders WHERE provider = $1 AND provider_event_id = $2 LIMIT 1 FOR UPDATE',
      ['livepix', payment.reference]
    );
    if (byReference.rowCount > 0) {
      return byReference.rows[0];
    }
  }

  return null;
}

async function persistWebhookOrder(client, payment) {
  const existing = await loadOrderForWebhook(client, payment);
  if (existing) {
    const nextStatus = existing.status === 'fulfilled' ? 'fulfilled' : 'processing';
    const updated = await client.query(
      `UPDATE orders
       SET provider_payment_id = COALESCE(provider_payment_id, $2),
           telegram_user_id = COALESCE(telegram_user_id, $3),
           telegram_username = COALESCE(telegram_username, $4),
           buyer_name = COALESCE(buyer_name, $5),
           buyer_email = COALESCE(buyer_email, $6),
           buyer_phone = COALESCE(buyer_phone, $7),
           raw_payload = $8,
           status = $9
       WHERE id = $1
       RETURNING *`,
      [
        existing.id,
        payment.paymentId || null,
        payment.telegramUserId,
        payment.telegramUsername,
        payment.buyerName,
        payment.buyerEmail,
        payment.buyerPhone,
        JSON.stringify(payment.rawPayload),
        nextStatus
      ]
    );
    await writeAuditLog(client, {
      provider: 'livepix',
      eventId: payment.eventId,
      paymentId: payment.paymentId,
      orderId: updated.rows[0].id,
      stage: 'order_upsert',
      status: updated.rows[0].status,
      message: 'Existing order updated from webhook'
    });
    return updated.rows[0];
  }

  const inserted = await client.query(
    `INSERT INTO orders (
      provider,
      provider_event_id,
      provider_payment_id,
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
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'processing', $13)
    RETURNING *`,
    [
      'livepix',
      payment.reference || payment.eventId,
      payment.paymentId || null,
      payment.telegramUserId,
      payment.telegramUsername,
      payment.buyerName,
      payment.buyerEmail,
      payment.buyerPhone,
      payment.targetType || 'unknown',
      payment.targetCode,
      payment.productId,
      payment.amountCents,
      JSON.stringify(payment.rawPayload)
    ]
  );

  await writeAuditLog(client, {
    provider: 'livepix',
    eventId: payment.eventId,
    paymentId: payment.paymentId,
    orderId: inserted.rows[0].id,
    stage: 'order_create',
    status: inserted.rows[0].status,
    message: 'Order created from webhook'
  });
  return inserted.rows[0];
}

async function fulfillPaidOrder(order, { botService }) {
  if (order.status === 'fulfilled') {
    return { order, action: 'already-fulfilled' };
  }

  if (order.target_type === 'vip') {
    const plan = await vip.getPlanByCode(order.target_code);
    if (!plan) {
      logger.warn({ orderId: order.id, targetCode: order.target_code }, 'Plano VIP nao encontrado');
      await db.query("UPDATE orders SET status = 'failed' WHERE id = $1", [order.id]);
      return { order, action: 'missing-plan' };
    }

    const access = await vip.extendVipAccess({
      orderId: order.id,
      telegramUserId: order.telegram_user_id,
      telegramUsername: order.telegram_username,
      planCode: plan.code,
      durationDays: plan.duration_days
    });

    await db.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [order.id]);
    await writeAuditLog(db, {
      provider: 'livepix',
      paymentId: order.provider_payment_id,
      orderId: order.id,
      stage: 'vip_fulfillment',
      status: 'fulfilled',
      message: 'VIP access granted'
    });

    if (botService.enabled && order.telegram_user_id) {
      const inviteLink = await botService.createVipInviteLink().catch((error) => {
        logger.warn({ err: error, orderId: order.id }, 'Falha ao criar link VIP');
        return null;
      });

      const lines = [
        'Pagamento confirmado.',
        `VIP liberado ate ${new Date(access.expires_at).toLocaleString('pt-BR')}.`
      ];
      if (inviteLink) {
        lines.push(`Link de entrada: ${inviteLink}`);
      }
      await botService.safeSendMessage(order.telegram_user_id, lines.join('\n'));
    }

    return { order, action: 'vip-fulfilled', access };
  }

  if (order.target_type === 'product') {
    const product = order.product_id ? await products.getProductById(order.product_id) : null;
    if (!product || !product.drive_file_id) {
      logger.warn({ orderId: order.id, productId: order.product_id }, 'Produto sem drive_file_id');
      await db.query("UPDATE orders SET status = 'failed' WHERE id = $1", [order.id]);
      return { order, action: 'missing-product' };
    }

    const enrichedOrder = {
      ...order,
      drive_file_id: product.drive_file_id
    };

    const email = order.buyer_email || (await grants.getUserEmail(order.telegram_user_id));
    if (!email) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await grants.queuePendingGrant({
        orderId: order.id,
        telegramUserId: order.telegram_user_id,
        email: '',
        productId: product.id,
        driveFileId: product.drive_file_id,
        expiresAt
      });

      if (botService.enabled && order.telegram_user_id) {
        await botService.safeSendMessage(
          order.telegram_user_id,
          'Pagamento confirmado. Envie seu email com /email seuemail@exemplo.com para liberar o conteudo.'
        );
      }

      await writeAuditLog(db, {
        provider: 'livepix',
        paymentId: order.provider_payment_id,
        orderId: order.id,
        stage: 'product_fulfillment',
        status: 'awaiting_email',
        message: 'Payment confirmed but awaiting buyer email'
      });

      return { order, action: 'awaiting-email' };
    }

    let link;
    try {
      link = await grants.fulfillProductOrder({
        order: enrichedOrder,
        email
      });
    } catch (error) {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await grants.queuePendingGrant({
        orderId: order.id,
        telegramUserId: order.telegram_user_id,
        email,
        productId: product.id,
        driveFileId: product.drive_file_id,
        expiresAt
      });

      logger.warn({ err: error, orderId: order.id }, 'Grant do Drive falhou; pedido mantido pendente');
      if (botService.enabled && order.telegram_user_id) {
        await botService.safeSendMessage(
          order.telegram_user_id,
          'Pagamento confirmado. O acesso ficou pendente e sera reenviado quando a integracao do Drive responder.'
        );
      }

      await writeAuditLog(db, {
        provider: 'livepix',
        paymentId: order.provider_payment_id,
        orderId: order.id,
        stage: 'product_fulfillment',
        status: 'pending_drive_grant',
        message: 'Drive grant pending after payment confirmation'
      });

      return { order, action: 'pending-drive-grant' };
    }

    if (botService.enabled && order.telegram_user_id) {
      await botService.safeSendMessage(order.telegram_user_id, `Conteudo liberado: ${link.url}`);
    }

    await writeAuditLog(db, {
      provider: 'livepix',
      paymentId: order.provider_payment_id,
      orderId: order.id,
      stage: 'product_fulfillment',
      status: 'fulfilled',
      message: 'Product access granted'
    });

    return { order, action: 'product-fulfilled', link };
  }

  await db.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [order.id]);
  await writeAuditLog(db, {
    provider: 'livepix',
    paymentId: order.provider_payment_id,
    orderId: order.id,
    stage: 'generic_fulfillment',
    status: 'fulfilled',
    message: 'Generic payment fulfillment completed'
  });
  return { order, action: 'generic-fulfilled' };
}

async function processLivePixWebhook(payload, { botService }) {
  const payment = normalizePayload(payload);
  if (!payment.eventId) {
    return {
      outcome: 'ignored',
      httpStatus: 200,
      status: 'ignored',
      reason: 'missing-event-id'
    };
  }

  const provider = 'livepix';
  const claim = await db.withTransaction(async (client) => {
    const claimed = await claimWebhook(client, provider, payment.eventId);
    if (!claimed.claimed) {
      return {
        outcome: 'duplicate',
        httpStatus: 200,
        status: 'duplicate',
        reason: claimed.status
      };
    }

    if (!isPaidStatus(payment.status)) {
      await writeAuditLog(client, {
        provider,
        eventId: payment.eventId,
        paymentId: payment.paymentId,
        stage: 'webhook_ignore',
        status: 'ignored',
        message: `Webhook ignored due to status ${payment.status || 'unknown'}`,
        payload: payment.rawPayload
      });
      return { ignored: true, reason: `status:${payment.status || 'unknown'}` };
    }

    const order = await persistWebhookOrder(client, payment);
    if (order.status === 'fulfilled') {
      return {
        outcome: 'duplicate',
        httpStatus: 200,
        status: 'duplicate',
        order,
        reason: 'already-fulfilled'
      };
    }

    return { outcome: 'processing', order };
  });

  if (claim.outcome === 'duplicate' || claim.ignored) {
    if (claim.ignored) {
      await markWebhook(provider, payment.eventId, 'ignored');
      return {
        outcome: 'ignored',
        httpStatus: 200,
        status: 'ignored',
        reason: claim.reason
      };
    }
    return claim;
  }

  try {
    await remarketing.markOrderConverted(claim.order.id);
    const result = await fulfillPaidOrder(claim.order, { botService });
    await markWebhook(provider, payment.eventId, 'processed');
    if (result.action !== 'already-fulfilled') {
      notifications.notifySaleConfirmed({
        order: result.order || claim.order,
        action: result.action,
        botService
      }).catch((error) => {
        logger.warn({ err: error, orderId: claim.order.id }, 'Falha ao disparar notificacao de venda');
      });
    }
    await writeAuditLog(db, {
      provider,
      eventId: payment.eventId,
      paymentId: payment.paymentId,
      orderId: claim.order.id,
      stage: 'webhook_complete',
      status: 'processed',
      message: `Webhook processed with action ${result.action}`
    });
    return {
      outcome: 'processed',
      httpStatus: 200,
      status: 'processed',
      orderId: claim.order.id,
      action: result.action,
      result
    };
  } catch (error) {
    await markWebhook(provider, payment.eventId, 'failed');
    await writeAuditLog(db, {
      provider,
      eventId: payment.eventId,
      paymentId: payment.paymentId,
      orderId: claim.order && claim.order.id,
      stage: 'webhook_complete',
      status: 'failed',
      message: error.message
    });
    throw error;
  }
}

module.exports = {
  processLivePixWebhook
};
