const express = require('express');
const path = require('path');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const env = require('./config/env');
const healthRoutes = require('./routes/health');
const webhookRoutes = require('./routes/webhooks');
const contentRoutes = require('./routes/content');
const adminRoutes = require('./routes/admin');

function createApp({ botService }) {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(healthRoutes);
  app.use(webhookRoutes({ botService }));
  app.use(contentRoutes);
  app.use(adminRoutes);

  if (botService.enabled) {
    app.use(botService.webhookPath, botService.webhookMiddleware());
  }

  app.get('/admin', (req, res) => {
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

  return app;
}

module.exports = {
  createApp
};
