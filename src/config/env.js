const dotenv = require('dotenv');

dotenv.config();

function required(name, value) {
  if (!value) {
    throw new Error(`Variavel obrigatoria ausente: ${name}`);
  }
  return value;
}

function optionalJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    process.emitWarning('GOOGLE_SERVICE_ACCOUNT_JSON invalido; integracao do Drive sera desabilitada');
    return fallback;
  }
}

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || process.env.PUBLIC_URL || `http://localhost:${port}`;

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  appBaseUrl,
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 10),
  redisUrl: process.env.REDIS_URL || '',
  redisQueuePrefix: process.env.REDIS_QUEUE_PREFIX || 'telegram-vip-livepix',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  telegramVipChatId: process.env.TELEGRAM_VIP_CHAT_ID || '',
  vipInviteTtlMinutes: Number(process.env.VIP_INVITE_TTL_MINUTES || 15),
  adminUser: process.env.ADMIN_USER || '',
  adminPass: process.env.ADMIN_PASS || '',
  livepixClientId: process.env.LIVEPIX_CLIENT_ID || '',
  livepixClientSecret: process.env.LIVEPIX_CLIENT_SECRET || '',
  supportWhatsappUrl: process.env.SUPPORT_WHATSAPP_URL || '5522988046948',
  instagramUrl: process.env.INSTAGRAM_URL || 'https://instagram.com',
  freeGroupUrl: process.env.FREE_GROUP_URL || 'https://t.me',
  googleServiceAccountJson: optionalJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, null),
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || ''
};
