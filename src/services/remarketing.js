const db = require('../lib/db');
const env = require('../config/env');
const logger = require('../lib/logger');
const { generateRemarketingCopy } = require('./ai-remarketing');
const appSettings = require('./app-settings');

function getSequenceConfig(settings) {
  return [
    { step: 1, delayMinutes: Number(settings.remarketing_step1_delay_minutes || env.remarketingStep1DelayMinutes), messageType: 'video' },
    { step: 2, delayMinutes: Number(settings.remarketing_step2_delay_minutes || env.remarketingStep2DelayMinutes), messageType: 'social-proof' },
    { step: 3, delayMinutes: Number(settings.remarketing_step3_delay_minutes || env.remarketingStep3DelayMinutes), messageType: 'desire' }
  ];
}

function extractPaymentUrl(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return '';
  }

  const payment = rawPayload.payment || rawPayload;
  return payment.redirectUrl || payment.checkoutUrl || payment.paymentUrl || '';
}

async function buildBehaviorProfile({ telegramUserId, orderId }) {
  const result = await db.query(
    `SELECT event_type
     FROM bot_user_events
     WHERE telegram_user_id = $1
       AND ($2::int IS NULL OR order_id = $2 OR order_id IS NULL)
     ORDER BY created_at DESC
     LIMIT 12`,
    [telegramUserId, orderId || null]
  );

  const recentEvents = result.rows.map((row) => row.event_type);
  let intentScore = 35;
  if (recentEvents.includes('checkout_started')) intentScore += 35;
  if (recentEvents.includes('view_vip_menu') || recentEvents.includes('view_product_menu')) intentScore += 15;
  if (recentEvents.includes('menu_support')) intentScore += 10;

  return {
    recentEvents,
    intentScore: Math.min(intentScore, 100)
  };
}

function getVoiceFileId(sequenceStep, settings) {
  if (sequenceStep === 1) return settings.remarketing_voice_step1_file_id || env.remarketingVoiceStep1FileId;
  if (sequenceStep === 2) return settings.remarketing_voice_step2_file_id || env.remarketingVoiceStep2FileId;
  if (sequenceStep === 3) return settings.remarketing_voice_step3_file_id || env.remarketingVoiceStep3FileId;
  return '';
}

function getAudioLibraryFileId(sequenceStep, conversionSettings, campaignId) {
  const libraries = {
    1: conversionSettings.audio_library_step1 || [],
    2: conversionSettings.audio_library_step2 || [],
    3: conversionSettings.audio_library_step3 || []
  };
  const list = libraries[sequenceStep] || [];
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  return list[campaignId % list.length] || '';
}

function getSocialProof(conversionSettings, campaignId, messageType) {
  if (messageType !== 'social-proof') {
    return '';
  }
  const proofs = conversionSettings.social_proofs || [];
  if (!Array.isArray(proofs) || proofs.length === 0) {
    return '';
  }
  return proofs[campaignId % proofs.length] || '';
}

function getAbHook(conversionSettings, campaignId) {
  if (!conversionSettings.ab_test_enabled) {
    return { hook: '', variantLabel: '' };
  }
  const isVariantA = campaignId % 2 === 0;
  return {
    hook: isVariantA ? String(conversionSettings.ab_variant_a_hook || '').trim() : String(conversionSettings.ab_variant_b_hook || '').trim(),
    variantLabel: isVariantA ? 'A' : 'B'
  };
}

async function trackUserEvent({ telegramUserId, telegramUsername, eventType, targetType, targetCode, productId, orderId, metadata }) {
  if (!telegramUserId) {
    return null;
  }

  await db.query(
    `INSERT INTO bot_user_events (
      telegram_user_id,
      telegram_username,
      event_type,
      target_type,
      target_code,
      product_id,
      order_id,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      telegramUserId,
      telegramUsername || null,
      eventType,
      targetType || null,
      targetCode || null,
      productId || null,
      orderId || null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );

  logger.info(
    {
      telegramUserId,
      eventType,
      targetType: targetType || null,
      targetCode: targetCode || null,
      productId: productId || null,
      orderId: orderId || null
    },
    'Evento de comportamento registrado'
  );

  return true;
}

async function scheduleCheckoutRemarketing({ orderId, telegramUserId, telegramUsername, targetType, targetCode, productId }) {
  const settings = await appSettings.getRemarketingSettings();
  if (!settings.remarketing_enabled || !orderId || !telegramUserId) {
    return null;
  }

  return db.withTransaction(async (client) => {
    const campaignResult = await client.query(
      `INSERT INTO remarketing_campaigns (
        order_id,
        telegram_user_id,
        telegram_username,
        target_type,
        target_code,
        product_id,
        status,
        last_event_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
      ON CONFLICT (order_id)
      DO UPDATE
      SET telegram_username = COALESCE(EXCLUDED.telegram_username, remarketing_campaigns.telegram_username),
          target_type = EXCLUDED.target_type,
          target_code = EXCLUDED.target_code,
          product_id = EXCLUDED.product_id,
          status = 'active',
          last_event_at = NOW(),
          updated_at = NOW()
      RETURNING *`,
      [orderId, telegramUserId, telegramUsername || null, targetType, targetCode || null, productId || null]
    );

    const campaign = campaignResult.rows[0];
    for (const item of getSequenceConfig(settings)) {
      await client.query(
        `INSERT INTO remarketing_messages (
          campaign_id,
          sequence_step,
          due_at,
          message_type,
          payload
        )
        VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4, $5)
        ON CONFLICT (campaign_id, sequence_step) DO NOTHING`,
        [
          campaign.id,
          item.step,
          item.delayMinutes,
          item.messageType,
          JSON.stringify({
            target_type: targetType,
            target_code: targetCode || null,
            product_id: productId || null
          })
        ]
      );
    }

    logger.info(
      {
        orderId,
        telegramUserId,
        targetType,
        targetCode: targetCode || null,
        productId: productId || null,
        campaignId: campaign.id
      },
      'Campanha de remarketing agendada'
    );

    return campaign;
  });
}

async function markOrderConverted(orderId) {
  if (!orderId) {
    return { updatedCampaigns: 0, cancelledMessages: 0 };
  }

  const campaignResult = await db.query(
    `UPDATE remarketing_campaigns
     SET status = 'converted',
         converted_at = NOW(),
         updated_at = NOW()
     WHERE order_id = $1 AND status = 'active'
     RETURNING id`,
    [orderId]
  );

  const ids = campaignResult.rows.map((row) => row.id);
  if (ids.length === 0) {
    return { updatedCampaigns: 0, cancelledMessages: 0 };
  }

  const cancelResult = await db.query(
    `UPDATE remarketing_messages
     SET status = 'cancelled',
         updated_at = NOW()
     WHERE campaign_id = ANY($1::int[]) AND status = 'pending'`,
    [ids]
  );

  logger.info(
    {
      orderId,
      updatedCampaigns: campaignResult.rowCount,
      cancelledMessages: cancelResult.rowCount
    },
    'Campanha de remarketing encerrada por conversao'
  );

  return {
    updatedCampaigns: campaignResult.rowCount,
    cancelledMessages: cancelResult.rowCount
  };
}

async function buildCopy({ order, campaign, sequenceStep, messageType }) {
  const [settings, conversionSettings] = await Promise.all([
    appSettings.getRemarketingSettings(),
    appSettings.getConversionSettings()
  ]);
  const checkoutUrl = extractPaymentUrl(order.raw_payload);
  const profile = await buildBehaviorProfile({
    telegramUserId: campaign.telegram_user_id,
    orderId: campaign.order_id
  });
  const campaignId = Number(campaign.id || campaign.campaign_id || 0);
  const socialProof = getSocialProof(conversionSettings, campaignId, messageType);
  const ab = getAbHook(conversionSettings, campaignId);
  const generated = await generateRemarketingCopy({
    profile,
    campaign,
    sequenceStep,
    messageType,
    checkoutUrl,
    socialProof,
    abHook: ab.hook,
    variantLabel: ab.variantLabel
  });
  const voiceFileId = getVoiceFileId(sequenceStep, settings) || getAudioLibraryFileId(sequenceStep, conversionSettings, campaignId);

  return {
    text: generated.text,
    reasoning: [generated.reasoning, socialProof ? 'social-proof-library' : '', ab.variantLabel ? `variant-${ab.variantLabel}` : '']
      .filter(Boolean)
      .join(','),
    mediaType: voiceFileId ? 'voice' : (settings.remarketing_video_file_id || env.remarketingVideoFileId) && messageType === 'video' ? 'video' : 'text',
    voiceFileId
  };
}

async function markMessageStatus(messageId, status) {
  await db.query(
    `UPDATE remarketing_messages
     SET status = $2,
         sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [messageId, status]
  );
}

async function rescheduleMessage(messageId, retryMinutes) {
  await db.query(
    `UPDATE remarketing_messages
     SET due_at = NOW() + ($2 * INTERVAL '1 minute'),
         updated_at = NOW()
     WHERE id = $1`,
    [messageId, retryMinutes]
  );
}

async function processDueMessages({ botService }) {
  const settings = await appSettings.getRemarketingSettings();
  if (!settings.remarketing_enabled || !botService.enabled) {
    return { processed: 0, skipped: true, reason: 'remarketing_disabled_or_bot_disabled' };
  }

  const result = await db.query(
    `SELECT
       rm.id,
       rm.sequence_step,
       rm.message_type,
       rc.id AS campaign_id,
       rc.order_id,
       rc.telegram_user_id,
       rc.telegram_username,
       rc.target_type,
       rc.target_code,
       rc.product_id,
       o.status AS order_status,
       o.raw_payload
     FROM remarketing_messages rm
     INNER JOIN remarketing_campaigns rc ON rc.id = rm.campaign_id
     INNER JOIN orders o ON o.id = rc.order_id
     WHERE rm.status = 'pending'
       AND rc.status = 'active'
       AND rm.due_at <= NOW()
       AND o.status = 'pending'
     ORDER BY rm.due_at ASC
     LIMIT 20`
  );

  let sent = 0;
  let failed = 0;

  for (const row of result.rows) {
    const copy = await buildCopy({
      order: row,
      campaign: row,
      sequenceStep: row.sequence_step,
      messageType: row.message_type
    });

    try {
      let delivered = false;
      if (copy.mediaType === 'voice' && copy.voiceFileId) {
        delivered = await botService.safeSendVoice(row.telegram_user_id, copy.voiceFileId, {
          caption: copy.text
        });
      } else if (copy.mediaType === 'video' && (settings.remarketing_video_file_id || env.remarketingVideoFileId)) {
        delivered = await botService.safeSendVideo(
          row.telegram_user_id,
          settings.remarketing_video_file_id || env.remarketingVideoFileId,
          {
            caption: settings.remarketing_video_caption || env.remarketingVideoCaption || copy.text
          }
        );
      } else {
        delivered = await botService.safeSendMessage(row.telegram_user_id, copy.text);
      }

      if (!delivered) {
        await rescheduleMessage(row.id, 30);
        failed += 1;
        logger.warn(
          {
            messageId: row.id,
            campaignId: row.campaign_id,
            orderId: row.order_id,
            telegramUserId: row.telegram_user_id,
            sequenceStep: row.sequence_step
          },
          'Envio de remarketing nao confirmado; mensagem reagendada'
        );
        continue;
      }

      await markMessageStatus(row.id, 'sent');
      sent += 1;
      logger.info(
        {
          messageId: row.id,
          campaignId: row.campaign_id,
          orderId: row.order_id,
          telegramUserId: row.telegram_user_id,
          sequenceStep: row.sequence_step,
          messageType: row.message_type,
          reasoning: copy.reasoning
        },
        'Mensagem de remarketing enviada'
      );
    } catch (error) {
      failed += 1;
      logger.error(
        {
          err: error,
          messageId: row.id,
          campaignId: row.campaign_id,
          orderId: row.order_id,
          telegramUserId: row.telegram_user_id,
          sequenceStep: row.sequence_step
        },
        'Falha ao enviar remarketing'
      );
    }
  }

  return {
    processed: result.rowCount,
    sent,
    failed
  };
}

async function getCampaignMetrics() {
  const [campaigns, messages] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::INTEGER AS total_campaigns,
         COUNT(*) FILTER (WHERE status = 'active')::INTEGER AS active_campaigns,
         COUNT(*) FILTER (WHERE status = 'converted')::INTEGER AS converted_campaigns
       FROM remarketing_campaigns`
    ),
    db.query(
      `SELECT
         COUNT(*)::INTEGER AS total_messages,
         COUNT(*) FILTER (WHERE status = 'pending')::INTEGER AS pending_messages,
         COUNT(*) FILTER (WHERE status = 'sent')::INTEGER AS sent_messages,
         COUNT(*) FILTER (WHERE status = 'cancelled')::INTEGER AS cancelled_messages
       FROM remarketing_messages`
    )
  ]);

  return {
    total_campaigns: campaigns.rows[0].total_campaigns || 0,
    active_campaigns: campaigns.rows[0].active_campaigns || 0,
    converted_campaigns: campaigns.rows[0].converted_campaigns || 0,
    total_messages: messages.rows[0].total_messages || 0,
    pending_messages: messages.rows[0].pending_messages || 0,
    sent_messages: messages.rows[0].sent_messages || 0,
    cancelled_messages: messages.rows[0].cancelled_messages || 0
  };
}

async function listRecentCampaigns(limit = 50) {
  const result = await db.query(
    `SELECT
       rc.id,
       rc.order_id,
       rc.telegram_user_id,
       rc.telegram_username,
       rc.target_type,
       rc.target_code,
       rc.product_id,
       rc.status,
       rc.created_at,
       rc.converted_at,
       COUNT(rm.id)::INTEGER AS message_count,
       COUNT(rm.id) FILTER (WHERE rm.status = 'sent')::INTEGER AS sent_count,
       COUNT(rm.id) FILTER (WHERE rm.status = 'pending')::INTEGER AS pending_count
     FROM remarketing_campaigns rc
     LEFT JOIN remarketing_messages rm ON rm.campaign_id = rc.id
     GROUP BY rc.id
     ORDER BY rc.id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

async function getCampaignForManualAction(campaignId) {
  const result = await db.query(
    `SELECT
       rc.id,
       rc.order_id,
       rc.telegram_user_id,
       rc.telegram_username,
       rc.target_type,
       rc.target_code,
       rc.product_id,
       rc.status,
       COALESCE(rm.sequence_step, 1) AS sequence_step,
       COALESCE(rm.message_type, 'text') AS message_type,
       o.raw_payload
     FROM remarketing_campaigns rc
     LEFT JOIN LATERAL (
       SELECT sequence_step, message_type
       FROM remarketing_messages
       WHERE campaign_id = rc.id
       ORDER BY sequence_step DESC
       LIMIT 1
     ) rm ON TRUE
     INNER JOIN orders o ON o.id = rc.order_id
     WHERE rc.id = $1
     LIMIT 1`,
    [campaignId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}

async function sendCampaignCopy(campaign, copy, { botService }) {
  if (copy.mediaType === 'voice' && copy.voiceFileId) {
    return botService.safeSendVoice(campaign.telegram_user_id, copy.voiceFileId, { caption: copy.text });
  }

  if (copy.mediaType === 'video') {
    const settings = await appSettings.getRemarketingSettings();
    return botService.safeSendVideo(
      campaign.telegram_user_id,
      settings.remarketing_video_file_id || env.remarketingVideoFileId,
      { caption: settings.remarketing_video_caption || env.remarketingVideoCaption || copy.text }
    );
  }

  return botService.safeSendMessage(campaign.telegram_user_id, copy.text);
}

async function previewCampaignCopy(campaignId) {
  const campaign = await getCampaignForManualAction(campaignId);
  if (!campaign) {
    return null;
  }

  const copy = await buildCopy({
    order: campaign,
    campaign,
    sequenceStep: Number(campaign.sequence_step || 1),
    messageType: campaign.message_type || 'text'
  });

  return {
    campaign,
    copy
  };
}

async function resendCampaignNow(campaignId, { botService, text }) {
  const campaign = await getCampaignForManualAction(campaignId);
  if (!campaign) {
    return null;
  }

  const copy = text && String(text).trim()
    ? {
        text: String(text).trim(),
        reasoning: 'manual-override',
        mediaType: 'text',
        voiceFileId: ''
      }
    : await buildCopy({
        order: campaign,
        campaign,
        sequenceStep: Number(campaign.sequence_step || 1),
        messageType: campaign.message_type || 'text'
      });

  const delivered = await sendCampaignCopy(campaign, copy, { botService });

  return {
    delivered,
    campaignId,
    reasoning: copy.reasoning
  };
}

module.exports = {
  trackUserEvent,
  scheduleCheckoutRemarketing,
  markOrderConverted,
  processDueMessages,
  getCampaignMetrics,
  listRecentCampaigns,
  previewCampaignCopy,
  resendCampaignNow
};
