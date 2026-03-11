const db = require('../lib/db');

function normalizeProductInput(input = {}) {
  return {
    title: String(input.title || '').trim(),
    description: String(input.description || '').trim(),
    price_cents: Number(input.price_cents || 0),
    drive_file_id: String(input.drive_file_id || '').trim(),
    preview_drive_file_id: String(input.preview_drive_file_id || '').trim(),
    preview_mime: String(input.preview_mime || 'video').trim().toLowerCase(),
    active: input.active !== false
  };
}

async function listActiveProducts(limit = 20) {
  const result = await db.query('SELECT * FROM products WHERE active = TRUE ORDER BY id DESC LIMIT $1', [limit]);
  return result.rows;
}

async function getProductById(productId) {
  const result = await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [productId]);
  return result.rows[0] || null;
}

async function listCarouselProducts(limit = 20) {
  const result = await db.query(
    'SELECT * FROM products WHERE active = TRUE ORDER BY id DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

async function createProduct(input) {
  const product = normalizeProductInput(input);
  const result = await db.query(
    `INSERT INTO products (
      title,
      description,
      price_cents,
      drive_file_id,
      preview_drive_file_id,
      preview_mime,
      active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      product.title,
      product.description,
      product.price_cents,
      product.drive_file_id,
      product.preview_drive_file_id || null,
      product.preview_mime || 'video',
      product.active
    ]
  );
  return result.rows[0];
}

async function deactivateProduct(productId) {
  const result = await db.query(
    `UPDATE products
     SET active = FALSE
     WHERE id = $1
     RETURNING *`,
    [productId]
  );
  return result.rows[0] || null;
}

async function updateProduct(productId, input) {
  const product = normalizeProductInput(input);
  const result = await db.query(
    `UPDATE products
     SET title = $2,
         description = $3,
         price_cents = $4,
         drive_file_id = $5,
         preview_drive_file_id = $6,
         preview_mime = $7,
         active = $8
     WHERE id = $1
     RETURNING *`,
    [
      productId,
      product.title,
      product.description,
      product.price_cents,
      product.drive_file_id,
      product.preview_drive_file_id || null,
      product.preview_mime || 'video',
      product.active
    ]
  );
  return result.rows[0] || null;
}

module.exports = {
  listActiveProducts,
  getProductById,
  listCarouselProducts,
  createProduct,
  deactivateProduct,
  updateProduct,
  normalizeProductInput
};
