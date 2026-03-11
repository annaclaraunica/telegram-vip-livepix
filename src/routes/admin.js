const express = require('express');
const { basicAuth } = require('../lib/auth');
const db = require('../lib/db');

const router = express.Router();

router.get('/admin/api/stats', basicAuth, async (req, res) => {
  const [orders, vip, products] = await Promise.all([
    db.query("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM orders WHERE status IN ('paid', 'fulfilled')"),
    db.query("SELECT COUNT(*)::INTEGER AS total FROM vip_access WHERE is_active = TRUE"),
    db.query('SELECT COUNT(*)::INTEGER AS total FROM products WHERE active = TRUE')
  ]);

  res.json({
    ok: true,
    revenue_cents: Number(orders.rows[0].cents || 0),
    active_vips: vip.rows[0].total,
    active_products: products.rows[0].total
  });
});

router.get('/admin/api/orders', basicAuth, async (req, res) => {
  const result = await db.query('SELECT * FROM orders ORDER BY id DESC LIMIT 200');
  res.json(result.rows);
});

router.get('/admin/api/vips', basicAuth, async (req, res) => {
  const result = await db.query('SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200');
  res.json(result.rows);
});

router.get('/admin/api/products', basicAuth, async (req, res) => {
  const result = await db.query('SELECT * FROM products ORDER BY id DESC LIMIT 200');
  res.json(result.rows);
});

module.exports = router;
