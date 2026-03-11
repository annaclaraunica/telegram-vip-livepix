const logger = require('../lib/logger');
const appSettings = require('./app-settings');

function formatPrice(cents) {
  return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
}

function buildSaleMessage({ order, action }) {
  const target = order.target_type === 'vip'
    ? `VIP ${order.target_code || ''}`.trim()
    : `Produto ${order.product_id || ''}`.trim();

  return [
    'Nova venda confirmada',
    `Pedido: #${order.id}`,
    `Tipo: ${target}`,
    `Valor: ${formatPrice(order.amount_cents)}`,
    `Usuario Telegram: ${order.telegram_user_id || '-'}`,
    `Username: ${order.telegram_username || '-'}`,
    `Status: ${order.status}`,
    `Acao: ${action}`
  ].join('\n');
}

async function sendTelegramNotification(settings, message, { botService }) {
  if (!settings.telegram_enabled || !settings.telegram_chat_id || !botService || !botService.enabled) {
    return { channel: 'telegram', sent: false, reason: 'disabled_or_unavailable' };
  }

  const sent = await botService.safeSendMessage(settings.telegram_chat_id, message);
  return { channel: 'telegram', sent };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function sendWebhookNotification(settings, payload) {
  if (!settings.webhook_enabled || !settings.webhook_url) {
    return { channel: 'webhook', sent: false, reason: 'disabled_or_missing_url' };
  }

  const headers = settings.webhook_secret
    ? { 'x-notification-secret': settings.webhook_secret }
    : {};

  await postJson(settings.webhook_url, payload, headers);
  return { channel: 'webhook', sent: true };
}

async function sendWhatsAppWebhookNotification(settings, payload, message) {
  if (!settings.whatsapp_enabled || !settings.whatsapp_number || !settings.whatsapp_webhook_url) {
    return { channel: 'whatsapp_webhook', sent: false, reason: 'disabled_or_missing_config' };
  }

  const headers = settings.whatsapp_auth_token
    ? { Authorization: `Bearer ${settings.whatsapp_auth_token}` }
    : {};

  await postJson(
    settings.whatsapp_webhook_url,
    {
      event: payload.event,
      number: settings.whatsapp_number,
      message,
      payload
    },
    headers
  );

  return { channel: 'whatsapp_webhook', sent: true };
}

async function notifySaleConfirmed({ order, action, botService }) {
  const settings = await appSettings.getNotificationSettings();
  if (!settings.sale_confirmed_enabled) {
    return { enabled: false, attempts: [] };
  }

  const message = buildSaleMessage({ order, action });
  const payload = {
    event: 'sale_confirmed',
    order: {
      id: order.id,
      target_type: order.target_type,
      target_code: order.target_code,
      product_id: order.product_id,
      amount_cents: order.amount_cents,
      status: order.status,
      telegram_user_id: order.telegram_user_id,
      telegram_username: order.telegram_username,
      provider: order.provider,
      provider_payment_id: order.provider_payment_id,
      created_at: order.created_at
    },
    action,
    message
  };

  const attempts = [];

  for (const task of [
    () => sendTelegramNotification(settings, message, { botService }),
    () => sendWebhookNotification(settings, payload),
    () => sendWhatsAppWebhookNotification(settings, payload, message)
  ]) {
    try {
      attempts.push(await task());
    } catch (error) {
      logger.warn({ err: error }, 'Falha ao enviar notificacao de venda');
      attempts.push({ sent: false, error: error.message });
    }
  }

  logger.info({ orderId: order.id, action, attempts }, 'Notificacoes de venda processadas');
  return { enabled: true, attempts };
}

async function sendTestNotification({ botService }) {
  const fakeOrder = {
    id: 0,
    target_type: 'test',
    target_code: 'manual',
    product_id: null,
    amount_cents: 1990,
    status: 'fulfilled',
    telegram_user_id: null,
    telegram_username: 'admin_test',
    provider: 'manual',
    provider_payment_id: null,
    created_at: new Date().toISOString()
  };

  return notifySaleConfirmed({
    order: fakeOrder,
    action: 'test-notification',
    botService
  });
}

module.exports = {
  notifySaleConfirmed,
  sendTestNotification
};
