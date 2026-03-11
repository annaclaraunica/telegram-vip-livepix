const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const env = require('./config/env');
const { basicAuth } = require('./lib/auth');
const healthRoutes = require('./routes/health');
const webhookRoutes = require('./routes/webhooks');
const contentRoutes = require('./routes/content');
const adminRoutes = require('./routes/admin');
const { notFoundHandler } = require('./middleware/not-found');
const { errorHandler } = require('./middleware/error-handler');

function createApp({ botService }) {
  const app = express();
  app.set('trust proxy', env.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const headerId = req.headers['x-request-id'];
        if (headerId) {
          return String(headerId);
        }

        return res.getHeader('x-request-id') || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      },
      customSuccessMessage(req, res) {
        return `${req.method} ${req.url} completed with ${res.statusCode}`;
      },
      customErrorMessage(req, res, err) {
        return `${req.method} ${req.url} failed with ${res.statusCode}: ${err.message}`;
      }
    })
  );
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  const defaultLimiter = rateLimit({
    windowMs: env.rateLimitWindowMs,
    max: env.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false
  });
  const webhookLimiter = rateLimit({
    windowMs: env.rateLimitWindowMs,
    max: env.webhookRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false
  });

  app.use(defaultLimiter);

  app.use(healthRoutes);
  app.use('/webhook', webhookLimiter);
  app.use(webhookRoutes({ botService }));
  app.use(contentRoutes);
  app.use(adminRoutes({ botService }));

  if (botService.enabled) {
    app.use(botService.webhookPath, botService.verifyWebhookRequest, botService.webhookMiddleware());
  }

  app.get('/admin', basicAuth, (req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'admin', 'index.html'));
  });

  app.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'telegram-vip-livepix-pro',
      uptime_seconds: Math.floor(process.uptime()),
      telegram_enabled: botService.enabled,
      app_base_url: env.appBaseUrl
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp
};
