const express = require('express');
const env = require('../config/env');
const logger = require('../lib/logger');
const payments = require('../services/payments');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function createWebhookRoutes({ botService }) {
  const router = express.Router();

  router.post(
    '/webhook/livepix',
    asyncHandler(async (req, res) => {
      if (!env.webhookSecret) {
        logger.error('WEBHOOK_SECRET ausente; recusando webhook LivePix');
        return res.status(503).json({ ok: false });
      }

      if (req.query.secret !== env.webhookSecret) {
        return res.status(401).json({ ok: false });
      }

      const result = await payments.processLivePixWebhook(req.body, { botService });
      req.log.info(
        {
          provider: 'livepix',
          eventId: req.body && (req.body.id || req.body.eventId || req.body.resource?.id),
          outcome: result.outcome,
          orderId: result.orderId || result.result?.order?.id || null
        },
        'Webhook LivePix processado'
      );
      return res.status(result.httpStatus || 200).json({
        ok: result.outcome !== 'error',
        provider: 'livepix',
        outcome: result.outcome,
        status: result.status,
        orderId: result.orderId || result.result?.order?.id || null,
        action: result.action || result.result?.action || null,
        reason: result.reason || null
      });
    })
  );

  return router;
};
