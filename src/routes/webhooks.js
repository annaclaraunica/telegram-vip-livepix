const express = require('express');
const env = require('../config/env');
const logger = require('../lib/logger');
const payments = require('../services/payments');

module.exports = function createWebhookRoutes({ botService }) {
  const router = express.Router();

  router.post('/webhook/livepix', async (req, res) => {
    if (env.webhookSecret && req.query.secret !== env.webhookSecret) {
      return res.status(401).json({ ok: false });
    }

    try {
      const result = await payments.processLivePixWebhook(req.body, { botService });
      return res.json({ ok: true, result });
    } catch (error) {
      logger.error({ err: error, payload: req.body }, 'Falha no webhook LivePix');
      return res.status(500).json({ ok: false });
    }
  });

  return router;
};
