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

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function normalizeWebhookSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const url = new URL(raw);
    return url.searchParams.get('secret') || raw;
  } catch (error) {
    return raw;
  }
}

function normalizeUrl(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return fallback;
  }

  if (raw.startsWith('https:https://')) {
    return raw.replace('https:https://', 'https://');
  }

  if (raw.startsWith('http:http://')) {
    return raw.replace('http:http://', 'http://');
  }

  return raw;
}

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || process.env.PUBLIC_URL || `http://localhost:${port}`;
const webhookSecret = normalizeWebhookSecret(process.env.WEBHOOK_SECRET);
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || webhookSecret;

function requiredInProduction(name, value) {
  if (process.env.NODE_ENV === 'production' && !value) {
    throw new Error(`Variavel obrigatoria em producao ausente: ${name}`);
  }
  return value;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  appBaseUrl,
  appRole: process.env.APP_ROLE || 'web',
  runJobsInWeb: String(process.env.RUN_JOBS_IN_WEB || 'false').toLowerCase() === 'true',
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 10),
  redisUrl: process.env.REDIS_URL || '',
  redisQueuePrefix: process.env.REDIS_QUEUE_PREFIX || 'telegram-vip-livepix',
  trustProxy: process.env.TRUST_PROXY || '1',
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 120),
  webhookRateLimitMax: Number(process.env.WEBHOOK_RATE_LIMIT_MAX || 300),
  webhookSecret: requiredInProduction('WEBHOOK_SECRET', webhookSecret),
  telegramWebhookSecret: requiredInProduction('TELEGRAM_WEBHOOK_SECRET', telegramWebhookSecret),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  telegramVipChatId: firstDefined(process.env.TELEGRAM_VIP_CHAT_ID, process.env.VIP_CHAT_ID),
  vipInviteTtlMinutes: Number(process.env.VIP_INVITE_TTL_MINUTES || 15),
  adminUser: process.env.ADMIN_USER || '',
  adminPass: process.env.ADMIN_PASS || '',
  livepixClientId: process.env.LIVEPIX_CLIENT_ID || '',
  livepixClientSecret: process.env.LIVEPIX_CLIENT_SECRET || '',
  supportWhatsappUrl: firstDefined(process.env.SUPPORT_WHATSAPP_URL, process.env.SUPPORT_WA, '5522988046948'),
  instagramUrl: normalizeUrl(process.env.INSTAGRAM_URL, 'https://instagram.com'),
  freeGroupUrl: normalizeUrl(process.env.FREE_GROUP_URL, 'https://t.me'),
  googleServiceAccountJson: optionalJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, null),
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  telegramSendTimeoutMs: Number(process.env.TELEGRAM_SEND_TIMEOUT_MS || 20000),
  jobSendDelayMs: Number(process.env.JOB_SEND_DELAY_MS || 900),
  livepixHttpTimeoutMs: Number(process.env.LIVEPIX_HTTP_TIMEOUT_MS || 20000),
  maxPreviewMb: Number(process.env.MAX_PREVIEW_MB || 45),
  menuMediaMode: process.env.MENU_MEDIA_MODE || 'auto',
  remarketingEnabled: String(process.env.REMARKETING_ENABLED || 'true').toLowerCase() !== 'false',
  remarketingStep1DelayMinutes: Number(process.env.REMARKETING_STEP1_DELAY_MINUTES || 15),
  remarketingStep2DelayMinutes: Number(process.env.REMARKETING_STEP2_DELAY_MINUTES || 240),
  remarketingStep3DelayMinutes: Number(process.env.REMARKETING_STEP3_DELAY_MINUTES || 1440),
  aiRemarketingEnabled: String(process.env.AI_REMARKETING_ENABLED || 'true').toLowerCase() !== 'false',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  aiRemarketingTone: process.env.AI_REMARKETING_TONE || 'humanizado, sedutor e sugestivo, sem conteudo explicito',
  remarketingVideoFileId: process.env.REMARKETING_VIDEO_FILE_ID || '',
  remarketingVideoCaption: process.env.REMARKETING_VIDEO_CAPTION || '',
  remarketingVoiceStep1FileId: process.env.REMARKETING_VOICE_STEP1_FILE_ID || '',
  remarketingVoiceStep2FileId: process.env.REMARKETING_VOICE_STEP2_FILE_ID || '',
  remarketingVoiceStep3FileId: process.env.REMARKETING_VOICE_STEP3_FILE_ID || ''
};
