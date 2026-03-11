const express = require('express');
const db = require('../lib/db');
const { getQueueStatus } = require('../lib/queue');
const env = require('../config/env');
const { asyncHandler } = require('../lib/async-handler');

const router = express.Router();

router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const dbInfo = await db.healthcheck();
    const queue = getQueueStatus();

    res.json({
      ok: true,
      db: 'ok',
      queue,
      integrations: {
        telegram_enabled: Boolean(env.telegramBotToken),
        redis_configured: Boolean(env.redisUrl),
        drive_configured: Boolean(env.googleServiceAccountJson),
        livepix_configured: Boolean(env.livepixClientId && env.livepixClientSecret)
      },
      time: dbInfo.now,
      uptime_seconds: Math.floor(process.uptime())
    });
  })
);

router.get(
  '/readyz',
  asyncHandler(async (req, res) => {
    const dbInfo = await db.healthcheck();
    const queue = getQueueStatus();
    const ready = Boolean(dbInfo && queue.ready);

    return res.status(ready ? 200 : 503).json({
      ok: ready,
      db: 'ok',
      queue
    });
  })
);

module.exports = router;
