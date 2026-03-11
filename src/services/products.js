const db = require('../lib/db');

async function listActiveProducts(limit = 20) {
  const result = await db.query('SELECT * FROM products WHERE active = TRUE ORDER BY id DESC LIMIT $1', [limit]);
  return result.rows;
}

async function getProductById(productId) {
  const result = await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [productId]);
  return result.rows[0] || null;
}

module.exports = {
  listActiveProducts,
  getProductById
};
