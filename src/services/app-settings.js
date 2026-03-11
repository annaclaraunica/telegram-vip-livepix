const db = require('../lib/db');
const env = require('../config/env');

function getDefaultRemarketingSettings() {
  return {
    remarketing_enabled: env.remarketingEnabled,
    ai_remarketing_enabled: env.aiRemarketingEnabled,
    ai_remarketing_tone: env.aiRemarketingTone,
    remarketing_step1_delay_minutes: env.remarketingStep1DelayMinutes,
    remarketing_step2_delay_minutes: env.remarketingStep2DelayMinutes,
    remarketing_step3_delay_minutes: env.remarketingStep3DelayMinutes,
    remarketing_video_file_id: env.remarketingVideoFileId,
    remarketing_video_caption: env.remarketingVideoCaption,
    remarketing_voice_step1_file_id: env.remarketingVoiceStep1FileId,
    remarketing_voice_step2_file_id: env.remarketingVoiceStep2FileId,
    remarketing_voice_step3_file_id: env.remarketingVoiceStep3FileId
  };
}

function getDefaultNotificationSettings() {
  return {
    sale_confirmed_enabled: false,
    telegram_enabled: false,
    telegram_chat_id: '',
    webhook_enabled: false,
    webhook_url: '',
    webhook_secret: '',
    whatsapp_enabled: false,
    whatsapp_number: '',
    whatsapp_webhook_url: '',
    whatsapp_auth_token: ''
  };
}

function getDefaultMenuMediaSettings() {
  return {
    home: { preview_drive_file_id: '', preview_mime: 'video', caption: '' },
    vip: { preview_drive_file_id: '', preview_mime: 'video', caption: '' },
    free: { preview_drive_file_id: '', preview_mime: 'video', caption: '' }
  };
}

function getDefaultConversionSettings() {
  return {
    social_proofs: [],
    audio_library_step1: [],
    audio_library_step2: [],
    audio_library_step3: [],
    ab_test_enabled: false,
    ab_variant_a_hook: '',
    ab_variant_b_hook: ''
  };
}

function normalizeLines(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function saveSetting(key, value, options = {}) {
  const actor = String(options.actor || 'system').trim() || 'system';
  const previous = await db.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [key]);
  const previousValue = previous.rowCount > 0 ? previous.rows[0].value : null;

  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );

    await client.query(
      `INSERT INTO app_settings_audit_logs (
        setting_key,
        actor,
        previous_value,
        next_value
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [key, actor, previousValue ? JSON.stringify(previousValue) : null, JSON.stringify(value)]
    );
  });
}

async function getSetting(key, fallback) {
  const result = await db.query('SELECT value FROM app_settings WHERE key = $1 LIMIT 1', [key]);
  if (result.rowCount === 0) {
    return fallback;
  }

  const value = result.rows[0].value;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...fallback, ...value }
    : fallback;
}

async function getRemarketingSettings() {
  return getSetting('remarketing', getDefaultRemarketingSettings());
}

async function saveRemarketingSettings(settings, options = {}) {
  const normalized = {
    remarketing_enabled: settings.remarketing_enabled !== false,
    ai_remarketing_enabled: settings.ai_remarketing_enabled !== false,
    ai_remarketing_tone: String(settings.ai_remarketing_tone || '').trim() || env.aiRemarketingTone,
    remarketing_step1_delay_minutes: Number(settings.remarketing_step1_delay_minutes || env.remarketingStep1DelayMinutes),
    remarketing_step2_delay_minutes: Number(settings.remarketing_step2_delay_minutes || env.remarketingStep2DelayMinutes),
    remarketing_step3_delay_minutes: Number(settings.remarketing_step3_delay_minutes || env.remarketingStep3DelayMinutes),
    remarketing_video_file_id: String(settings.remarketing_video_file_id || '').trim(),
    remarketing_video_caption: String(settings.remarketing_video_caption || '').trim(),
    remarketing_voice_step1_file_id: String(settings.remarketing_voice_step1_file_id || '').trim(),
    remarketing_voice_step2_file_id: String(settings.remarketing_voice_step2_file_id || '').trim(),
    remarketing_voice_step3_file_id: String(settings.remarketing_voice_step3_file_id || '').trim()
  };

  await saveSetting('remarketing', normalized, options);

  return normalized;
}

async function getNotificationSettings() {
  return getSetting('notifications', getDefaultNotificationSettings());
}

async function saveNotificationSettings(settings, options = {}) {
  const normalized = {
    sale_confirmed_enabled: settings.sale_confirmed_enabled === true,
    telegram_enabled: settings.telegram_enabled === true,
    telegram_chat_id: String(settings.telegram_chat_id || '').trim(),
    webhook_enabled: settings.webhook_enabled === true,
    webhook_url: String(settings.webhook_url || '').trim(),
    webhook_secret: String(settings.webhook_secret || '').trim(),
    whatsapp_enabled: settings.whatsapp_enabled === true,
    whatsapp_number: String(settings.whatsapp_number || '').replace(/[^0-9]/g, ''),
    whatsapp_webhook_url: String(settings.whatsapp_webhook_url || '').trim(),
    whatsapp_auth_token: String(settings.whatsapp_auth_token || '').trim()
  };

  await saveSetting('notifications', normalized, options);
  return normalized;
}

async function getMenuMediaSettings() {
  return getSetting('menu_media', getDefaultMenuMediaSettings());
}

async function saveMenuMediaSettings(settings, options = {}) {
  const defaults = getDefaultMenuMediaSettings();
  const normalized = {
    home: {
      preview_drive_file_id: String(settings.home?.preview_drive_file_id || '').trim(),
      preview_mime: String(settings.home?.preview_mime || 'video').trim().toLowerCase(),
      caption: String(settings.home?.caption || '').trim()
    },
    vip: {
      preview_drive_file_id: String(settings.vip?.preview_drive_file_id || '').trim(),
      preview_mime: String(settings.vip?.preview_mime || 'video').trim().toLowerCase(),
      caption: String(settings.vip?.caption || '').trim()
    },
    free: {
      preview_drive_file_id: String(settings.free?.preview_drive_file_id || '').trim(),
      preview_mime: String(settings.free?.preview_mime || 'video').trim().toLowerCase(),
      caption: String(settings.free?.caption || '').trim()
    }
  };

  await saveSetting('menu_media', { ...defaults, ...normalized }, options);
  return normalized;
}

async function getConversionSettings() {
  return getSetting('conversion_assets', getDefaultConversionSettings());
}

async function saveConversionSettings(settings, options = {}) {
  const normalized = {
    social_proofs: normalizeLines(settings.social_proofs),
    audio_library_step1: normalizeLines(settings.audio_library_step1),
    audio_library_step2: normalizeLines(settings.audio_library_step2),
    audio_library_step3: normalizeLines(settings.audio_library_step3),
    ab_test_enabled: settings.ab_test_enabled === true,
    ab_variant_a_hook: String(settings.ab_variant_a_hook || '').trim(),
    ab_variant_b_hook: String(settings.ab_variant_b_hook || '').trim()
  };

  await saveSetting('conversion_assets', normalized, options);
  return normalized;
}

async function listAuditLogs(limit = 50) {
  const result = await db.query(
    `SELECT id, setting_key, actor, previous_value, next_value, created_at
     FROM app_settings_audit_logs
     ORDER BY id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

module.exports = {
  getRemarketingSettings,
  saveRemarketingSettings,
  getNotificationSettings,
  saveNotificationSettings,
  getMenuMediaSettings,
  saveMenuMediaSettings,
  getConversionSettings,
  saveConversionSettings,
  listAuditLogs
};
