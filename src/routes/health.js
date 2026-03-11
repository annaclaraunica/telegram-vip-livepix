const express = require('express');
const db = require('../lib/db');

const router = express.Router();

router.get('/health', async (req, res) => {
  try {
    const dbInfo = await db.healthcheck();
    res.json({
      ok: true,
      db: 'ok',
      time: dbInfo.now,
      uptime_seconds: Math.floor(process.uptime())
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      db: 'error',
      error: error.message
    });
  }
});

module.exports = router;
