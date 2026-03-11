const express = require('express');
const { basicAuth } = require('../lib/auth');
const db = require('../lib/db');
const { asyncHandler } = require('../lib/async-handler');
const vip = require('../services/vip');
const products = require('../services/products');
const appSettings = require('../services/app-settings');
const remarketing = require('../services/remarketing');
const notifications = require('../services/notifications');
const grants = require('../services/grants');
const { JOBS, getQueueStatus } = require('../lib/queue');
const { runJobNow } = require('../jobs');
const env = require('../config/env');

function toCsv(rows, headers) {
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    headers.map((item) => escape(item.label)).join(','),
    ...rows.map((row) => headers.map((item) => escape(item.value(row))).join(','))
  ].join('\n');
}

function brtDayRange() {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  return {
    start: `${today}T00:00:00-03:00`,
    end: `${today}T23:59:59.999-03:00`
  };
}

function buildIncidents({ queue, pendingGrantCount, webhookFailures24h, latestWebhookFailureAt, driveConfigured }) {
  const incidents = [];

  if (!queue.ready) {
    incidents.push({
      key: 'job_stopped',
      severity: 'danger',
      title: 'Scheduler indisponivel',
      detail: 'Fila de jobs nao esta pronta.'
    });
  }

  if (queue.mode !== 'redis') {
    incidents.push({
      key: 'redis_offline',
      severity: 'warn',
      title: 'Redis offline ou desabilitado',
      detail: 'Jobs estao em fallback local.'
    });
  }

  if (pendingGrantCount > 0) {
    incidents.push({
      key: 'drive_pending',
      severity: pendingGrantCount > 10 ? 'danger' : 'warn',
      title: 'Grants pendentes',
      detail: `${pendingGrantCount} grants aguardando processamento.`
    });
  }

  if (!driveConfigured) {
    incidents.push({
      key: 'drive_disabled',
      severity: 'warn',
      title: 'Drive nao configurado',
      detail: 'Liberacao automatica de arquivos pode falhar.'
    });
  }

  if (webhookFailures24h > 0) {
    incidents.push({
      key: 'webhook_failing',
      severity: webhookFailures24h > 5 ? 'danger' : 'warn',
      title: 'Falhas recentes de webhook',
      detail: `${webhookFailures24h} falhas nas ultimas 24h${latestWebhookFailureAt ? `, ultima em ${latestWebhookFailureAt}` : ''}.`
    });
  }

  return incidents;
}

function createAdminRoutes({ botService }) {
  const router = express.Router();

  router.get(
    '/admin/api/stats',
    basicAuth,
    asyncHandler(async (req, res) => {
      const [revenue, vipRevenue, productRevenue, vipCount, productCount] = await Promise.all([
        db.query("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status IN ('paid', 'fulfilled')"),
        db.query(
          "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status IN ('paid', 'fulfilled') AND target_type = 'vip'"
        ),
        db.query(
          "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status IN ('paid', 'fulfilled') AND target_type = 'product'"
        ),
        db.query("SELECT COUNT(*)::INTEGER AS total FROM vip_access WHERE is_active = TRUE"),
        db.query('SELECT COUNT(*)::INTEGER AS total FROM products WHERE active = TRUE')
      ]);

      res.json({
        ok: true,
        total: Number(revenue.rows[0].cents || 0),
        vip: Number(vipRevenue.rows[0].cents || 0),
        product: Number(productRevenue.rows[0].cents || 0),
        revenue_cents: Number(revenue.rows[0].cents || 0),
        active_vips: vipCount.rows[0].total,
        active_products: productCount.rows[0].total
      });
    })
  );

  router.get(
    '/admin/api/overview',
    basicAuth,
    asyncHandler(async (req, res) => {
      const { start, end } = brtDayRange();
      const queue = getQueueStatus();

      const [
        salesToday,
        activeVips,
        remarketingMetrics,
        webhookFailures,
        pendingGrants,
        conversions,
        campaigns,
        recentErrors
      ] = await Promise.all([
        db.query(
          `SELECT
             COUNT(*)::INTEGER AS orders_count,
             COALESCE(SUM(amount_cents), 0)::BIGINT AS revenue_cents
           FROM orders
           WHERE status = 'fulfilled'
             AND created_at >= $1
             AND created_at <= $2`,
          [start, end]
        ),
        db.query("SELECT COUNT(*)::INTEGER AS total FROM vip_access WHERE is_active = TRUE"),
        remarketing.getCampaignMetrics(),
        db.query(
          `SELECT
             COUNT(*)::INTEGER AS total,
             MAX(created_at) AS latest_at
           FROM payment_audit_logs
           WHERE status = 'failed'
             AND created_at >= NOW() - INTERVAL '24 hours'`
        ),
        db.query("SELECT COUNT(*)::INTEGER AS total FROM pending_grants WHERE status = 'pending'"),
        db.query(
          `SELECT
             id,
             target_type,
             target_code,
             product_id,
             amount_cents,
             telegram_user_id,
             telegram_username,
             created_at
           FROM orders
           WHERE status = 'fulfilled'
           ORDER BY id DESC
           LIMIT 8`
        ),
        remarketing.listRecentCampaigns(8),
        db.query(
          `SELECT
             provider,
             stage,
             status,
             message,
             order_id,
             created_at
           FROM payment_audit_logs
           WHERE status IN ('failed', 'pending_drive_grant', 'awaiting_email')
              OR stage IN ('webhook_complete', 'product_fulfillment')
           ORDER BY created_at DESC
           LIMIT 12`
        )
      ]);

      const latestWebhookFailureAt = webhookFailures.rows[0].latest_at
        ? new Date(webhookFailures.rows[0].latest_at).toLocaleString('pt-BR')
        : null;

      const metrics = {
        sales_today_count: Number(salesToday.rows[0].orders_count || 0),
        sales_today_revenue_cents: Number(salesToday.rows[0].revenue_cents || 0),
        active_vips: Number(activeVips.rows[0].total || 0),
        active_campaigns: Number(remarketingMetrics.active_campaigns || 0),
        webhook_failures_24h: Number(webhookFailures.rows[0].total || 0),
        pending_grants: Number(pendingGrants.rows[0].total || 0)
      };

      const incidents = buildIncidents({
        queue,
        pendingGrantCount: metrics.pending_grants,
        webhookFailures24h: metrics.webhook_failures_24h,
        latestWebhookFailureAt,
        driveConfigured: Boolean(env.googleServiceAccountJson)
      });

      res.json({
        ok: true,
        metrics,
        incidents,
        queue,
        health: {
          redis_mode: queue.mode,
          queue_ready: queue.ready,
          registered_jobs: queue.registeredJobs || []
        },
        logs: {
          recent_errors: recentErrors.rows,
          recent_conversions: conversions.rows,
          recent_campaigns: campaigns
        }
      });
    })
  );

  router.get(
    '/admin/api/orders',
    basicAuth,
    asyncHandler(async (req, res) => {
      const result = await db.query(
        `SELECT
           id,
           telegram_user_id,
           target_type AS kind,
           COALESCE(target_code, product_id::text, provider_event_id, provider_payment_id) AS product_ref,
           amount_cents,
           status,
           provider_event_id,
           provider_payment_id,
           target_type,
           target_code,
           product_id,
           created_at
         FROM orders
         ORDER BY id DESC
         LIMIT 200`
      );
      res.json(result.rows);
    })
  );

  router.get(
    '/admin/api/logs',
    basicAuth,
    asyncHandler(async (req, res) => {
      const [errors, conversions, campaigns, audit] = await Promise.all([
        db.query(
          `SELECT provider, stage, status, message, order_id, created_at
           FROM payment_audit_logs
           WHERE status IN ('failed', 'ignored')
           ORDER BY created_at DESC
           LIMIT 30`
        ),
        db.query(
          `SELECT id, target_type, target_code, product_id, amount_cents, telegram_username, created_at
           FROM orders
           WHERE status = 'fulfilled'
           ORDER BY id DESC
           LIMIT 30`
        ),
        remarketing.listRecentCampaigns(30),
        appSettings.listAuditLogs(30)
      ]);

      res.json({
        ok: true,
        errors: errors.rows,
        conversions: conversions.rows,
        campaigns,
        audit
      });
    })
  );

  router.get(
    '/admin/api/plans',
    basicAuth,
    asyncHandler(async (req, res) => {
      const plans = await vip.listPlans();
      res.json(plans);
    })
  );

  router.put(
    '/admin/api/plans',
    basicAuth,
    asyncHandler(async (req, res) => {
      const plans = Array.isArray(req.body?.plans) ? req.body.plans : [];
      const sanitized = plans.map((plan) => ({
        code: String(plan.code || '').trim(),
        title: String(plan.title || '').trim(),
        price_cents: Number(plan.price_cents || 0),
        duration_days: Number(plan.duration_days || 0),
        active: plan.active !== false
      }));

      if (sanitized.length === 0) {
        return res.status(400).json({ error: 'Nenhum plano enviado.' });
      }

      for (const plan of sanitized) {
        if (!plan.code || !plan.title || plan.price_cents <= 0 || plan.duration_days <= 0) {
          return res.status(400).json({ error: 'Plano invalido.' });
        }
      }

      const updated = await vip.updatePlans(sanitized);
      res.json({ ok: true, plans: updated });
    })
  );

  router.get(
    '/admin/api/remarketing-settings',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.getRemarketingSettings();
      res.json(settings);
    })
  );

  router.get(
    '/admin/api/conversion-settings',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.getConversionSettings();
      res.json(settings);
    })
  );

  router.get(
    '/admin/api/remarketing-metrics',
    basicAuth,
    asyncHandler(async (req, res) => {
      const [metrics, campaigns] = await Promise.all([
        remarketing.getCampaignMetrics(),
        remarketing.listRecentCampaigns(50)
      ]);
      res.json({ metrics, campaigns });
    })
  );

  router.put(
    '/admin/api/remarketing-settings',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.saveRemarketingSettings(req.body || {}, { actor: req.adminUser });
      res.json({ ok: true, settings });
    })
  );

  router.put(
    '/admin/api/conversion-settings',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.saveConversionSettings(req.body || {}, { actor: req.adminUser });
      res.json({ ok: true, settings });
    })
  );

  router.get(
    '/admin/api/notification-settings',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.getNotificationSettings();
      res.json(settings);
    })
  );

  router.put(
    '/admin/api/notification-settings',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.saveNotificationSettings(req.body || {}, { actor: req.adminUser });
      res.json({ ok: true, settings });
    })
  );

  router.get(
    '/admin/api/menu-media',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.getMenuMediaSettings();
      res.json(settings);
    })
  );

  router.put(
    '/admin/api/menu-media',
    basicAuth,
    asyncHandler(async (req, res) => {
      const settings = await appSettings.saveMenuMediaSettings(req.body || {}, { actor: req.adminUser });
      res.json({ ok: true, settings });
    })
  );

  router.get(
    '/admin/api/settings-audit',
    basicAuth,
    asyncHandler(async (req, res) => {
      const rows = await appSettings.listAuditLogs(100);
      res.json(rows);
    })
  );

  router.post(
    '/admin/api/notification-settings/test',
    basicAuth,
    asyncHandler(async (req, res) => {
      const result = await notifications.sendTestNotification({ botService });
      res.json({ ok: true, result });
    })
  );

  router.get(
    '/admin/api/vips',
    basicAuth,
    asyncHandler(async (req, res) => {
      const result = await db.query('SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200');
      res.json(result.rows);
    })
  );

  router.get(
    '/admin/api/pending-grants',
    basicAuth,
    asyncHandler(async (req, res) => {
      const rows = await grants.listPendingGrants(100);
      res.json(rows);
    })
  );

  router.get(
    '/admin/api/export/orders.csv',
    basicAuth,
    asyncHandler(async (req, res) => {
      const result = await db.query(
        `SELECT id, provider, provider_event_id, provider_payment_id, telegram_user_id, telegram_username, target_type, target_code, product_id, amount_cents, status, created_at
         FROM orders
         ORDER BY id DESC
         LIMIT 1000`
      );

      const csv = toCsv(result.rows, [
        { label: 'id', value: (row) => row.id },
        { label: 'provider', value: (row) => row.provider },
        { label: 'provider_event_id', value: (row) => row.provider_event_id },
        { label: 'provider_payment_id', value: (row) => row.provider_payment_id },
        { label: 'telegram_user_id', value: (row) => row.telegram_user_id },
        { label: 'telegram_username', value: (row) => row.telegram_username },
        { label: 'target_type', value: (row) => row.target_type },
        { label: 'target_code', value: (row) => row.target_code },
        { label: 'product_id', value: (row) => row.product_id },
        { label: 'amount_cents', value: (row) => row.amount_cents },
        { label: 'status', value: (row) => row.status },
        { label: 'created_at', value: (row) => row.created_at }
      ]);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=\"orders.csv\"');
      res.send(csv);
    })
  );

  router.get(
    '/admin/api/export/campaigns.csv',
    basicAuth,
    asyncHandler(async (req, res) => {
      const rows = await remarketing.listRecentCampaigns(1000);
      const csv = toCsv(rows, [
        { label: 'id', value: (row) => row.id },
        { label: 'order_id', value: (row) => row.order_id },
        { label: 'telegram_user_id', value: (row) => row.telegram_user_id },
        { label: 'telegram_username', value: (row) => row.telegram_username },
        { label: 'target_type', value: (row) => row.target_type },
        { label: 'target_code', value: (row) => row.target_code },
        { label: 'product_id', value: (row) => row.product_id },
        { label: 'status', value: (row) => row.status },
        { label: 'message_count', value: (row) => row.message_count },
        { label: 'sent_count', value: (row) => row.sent_count },
        { label: 'pending_count', value: (row) => row.pending_count },
        { label: 'created_at', value: (row) => row.created_at }
      ]);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=\"campaigns.csv\"');
      res.send(csv);
    })
  );

  router.get(
    '/admin/api/products',
    basicAuth,
    asyncHandler(async (req, res) => {
      const result = await db.query('SELECT * FROM products ORDER BY id DESC LIMIT 200');
      res.json(result.rows);
    })
  );

  router.post(
    '/admin/api/products',
    basicAuth,
    asyncHandler(async (req, res) => {
      const payload = products.normalizeProductInput(req.body || {});
      if (!payload.title || payload.price_cents <= 0 || !payload.drive_file_id) {
        return res.status(400).json({ error: 'title, price_cents e drive_file_id sao obrigatorios.' });
      }

      if (!['photo', 'image', 'video', 'gif'].includes(payload.preview_mime)) {
        return res.status(400).json({ error: 'preview_mime invalido.' });
      }

      const product = await products.createProduct(payload);
      res.status(201).json({ ok: true, product });
    })
  );

  router.delete(
    '/admin/api/products/:id',
    basicAuth,
    asyncHandler(async (req, res) => {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const product = await products.deactivateProduct(productId);
      if (!product) {
        return res.status(404).json({ error: 'Produto nao encontrado.' });
      }

      res.json({ ok: true, product });
    })
  );

  router.put(
    '/admin/api/products/:id',
    basicAuth,
    asyncHandler(async (req, res) => {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const payload = products.normalizeProductInput(req.body || {});
      if (!payload.title || payload.price_cents <= 0 || !payload.drive_file_id) {
        return res.status(400).json({ error: 'title, price_cents e drive_file_id sao obrigatorios.' });
      }

      if (!['photo', 'image', 'video', 'gif'].includes(payload.preview_mime)) {
        return res.status(400).json({ error: 'preview_mime invalido.' });
      }

      const product = await products.updateProduct(productId, payload);
      if (!product) {
        return res.status(404).json({ error: 'Produto nao encontrado.' });
      }

      res.json({ ok: true, product });
    })
  );

  router.post(
    '/admin/api/actions/remarketing-preview/:campaignId',
    basicAuth,
    asyncHandler(async (req, res) => {
      const campaignId = Number(req.params.campaignId);
      if (!Number.isInteger(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const preview = await remarketing.previewCampaignCopy(campaignId);
      if (!preview) {
        return res.status(404).json({ error: 'Campanha nao encontrada.' });
      }

      res.json({ ok: true, preview });
    })
  );

  router.post(
    '/admin/api/actions/reprocess-grant/:id',
    basicAuth,
    asyncHandler(async (req, res) => {
      const pendingGrantId = Number(req.params.id);
      if (!Number.isInteger(pendingGrantId) || pendingGrantId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const result = await grants.reprocessPendingGrant(pendingGrantId);
      if (!result) {
        return res.status(404).json({ error: 'Grant pendente nao encontrado.' });
      }

      res.json({ ok: result.ok, result });
    })
  );

  router.post(
    '/admin/api/actions/remarketing-send/:campaignId',
    basicAuth,
    asyncHandler(async (req, res) => {
      if (!botService || !botService.enabled) {
        return res.status(503).json({ error: 'Bot Telegram indisponivel.' });
      }

      const campaignId = Number(req.params.campaignId);
      if (!Number.isInteger(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const text = String(req.body?.text || '').trim();
      const result = await remarketing.resendCampaignNow(campaignId, { botService, text });
      if (!result) {
        return res.status(404).json({ error: 'Campanha nao encontrada.' });
      }

      res.json({ ok: true, result });
    })
  );

  router.post(
    '/admin/api/actions/run-job/:jobName',
    basicAuth,
    asyncHandler(async (req, res) => {
      const jobName = String(req.params.jobName || '').trim();
      if (!Object.values(JOBS).includes(jobName)) {
        return res.status(400).json({ error: 'job invalido.' });
      }

      const result = await runJobNow(jobName, { botService });
      res.json({ ok: true, result });
    })
  );

  router.post(
    '/admin/api/actions/resend-remarketing/:campaignId',
    basicAuth,
    asyncHandler(async (req, res) => {
      if (!botService || !botService.enabled) {
        return res.status(503).json({ error: 'Bot Telegram indisponivel.' });
      }

      const campaignId = Number(req.params.campaignId);
      if (!Number.isInteger(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const result = await remarketing.resendCampaignNow(campaignId, { botService });
      if (!result) {
        return res.status(404).json({ error: 'Campanha nao encontrada.' });
      }

      res.json({ ok: true, result });
    })
  );

  router.post(
    '/admin/api/actions/resend-vip/:accessId',
    basicAuth,
    asyncHandler(async (req, res) => {
      if (!botService || !botService.enabled) {
        return res.status(503).json({ error: 'Bot Telegram indisponivel.' });
      }

      const accessId = Number(req.params.accessId);
      if (!Number.isInteger(accessId) || accessId <= 0) {
        return res.status(400).json({ error: 'id invalido.' });
      }

      const result = await db.query('SELECT * FROM vip_access WHERE id = $1 LIMIT 1', [accessId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'VIP nao encontrado.' });
      }

      const access = result.rows[0];
      const inviteLink = await botService.createVipInviteLink();
      if (!inviteLink) {
        return res.status(400).json({ error: 'Nao foi possivel gerar convite VIP.' });
      }

      await botService.safeSendMessage(
        access.telegram_user_id,
        `Seu link VIP foi reenviado.\nValido ate ${new Date(access.expires_at).toLocaleString('pt-BR')}.\n${inviteLink}`
      );

      res.json({ ok: true, inviteLink });
    })
  );

  router.get(
    '/admin/api/telegram-file/:fileId',
    basicAuth,
    asyncHandler(async (req, res) => {
      if (!botService || !botService.enabled || !botService.bot) {
        return res.status(503).json({ error: 'Bot Telegram indisponivel.' });
      }

      const fileId = String(req.params.fileId || '').trim();
      if (!fileId) {
        return res.status(400).json({ error: 'file_id obrigatorio.' });
      }

      const fileUrl = await botService.bot.telegram.getFileLink(fileId);
      res.redirect(fileUrl.toString());
    })
  );

  router.post(
    '/admin/api/test-product-preview',
    basicAuth,
    asyncHandler(async (req, res) => {
      if (!botService || !botService.enabled || !botService.bot) {
        return res.status(503).json({ error: 'Bot Telegram indisponivel.' });
      }

      const chatId = String(req.body?.chat_id || '').trim();
      const previewFileId = String(req.body?.preview_drive_file_id || '').trim();
      const previewMime = String(req.body?.preview_mime || 'video').trim().toLowerCase();
      const title = String(req.body?.title || '').trim();
      const description = String(req.body?.description || '').trim();
      const priceCents = Number(req.body?.price_cents || 0);

      if (!chatId) {
        return res.status(400).json({ error: 'chat_id obrigatorio.' });
      }

      if (!previewFileId) {
        return res.status(400).json({ error: 'preview_drive_file_id obrigatorio.' });
      }

      const caption = [title, description, priceCents > 0 ? `R$ ${(priceCents / 100).toFixed(2).replace('.', ',')}` : '']
        .filter(Boolean)
        .join('\n');

      if (previewMime === 'photo' || previewMime === 'image') {
        await botService.bot.telegram.sendPhoto(chatId, previewFileId, { caption });
      } else if (previewMime === 'gif') {
        await botService.bot.telegram.sendAnimation(chatId, previewFileId, { caption });
      } else {
        await botService.bot.telegram.sendVideo(chatId, previewFileId, { caption });
      }

      res.json({ ok: true });
    })
  );

  router.post(
    '/admin/api/test-menu-preview',
    basicAuth,
    asyncHandler(async (req, res) => {
      if (!botService || !botService.enabled || !botService.bot) {
        return res.status(503).json({ error: 'Bot Telegram indisponivel.' });
      }

      const chatId = String(req.body?.chat_id || '').trim();
      const previewFileId = String(req.body?.preview_drive_file_id || '').trim();
      const previewMime = String(req.body?.preview_mime || 'video').trim().toLowerCase();
      const caption = String(req.body?.caption || '').trim();

      if (!chatId) {
        return res.status(400).json({ error: 'chat_id obrigatorio.' });
      }

      if (!previewFileId) {
        return res.status(400).json({ error: 'preview_drive_file_id obrigatorio.' });
      }

      if (previewMime === 'photo' || previewMime === 'image') {
        await botService.bot.telegram.sendPhoto(chatId, previewFileId, { caption });
      } else if (previewMime === 'gif') {
        await botService.bot.telegram.sendAnimation(chatId, previewFileId, { caption });
      } else {
        await botService.bot.telegram.sendVideo(chatId, previewFileId, { caption });
      }

      res.json({ ok: true });
    })
  );

  return router;
}

module.exports = createAdminRoutes;
