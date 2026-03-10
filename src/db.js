const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.resolve(process.cwd(), "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("temp_store = MEMORY");
db.pragma("cache_size = -20000");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS config_plans (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  days INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vip_access (
  telegram_user_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_emails (
  telegram_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT,
  kind TEXT NOT NULL,
  plan_code TEXT,
  product_id INTEGER,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reference TEXT UNIQUE,
  payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  drive_file_id TEXT,
  preview_drive_file_id TEXT,
  preview_mime TEXT DEFAULT 'video',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drive_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  permission_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  order_reference TEXT UNIQUE,
  product_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS content_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  telegram_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id TEXT PRIMARY KEY,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  marketing_opt_out INTEGER DEFAULT 0,
  last_marketing_at INTEGER,
  score INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  product_id INTEGER,
  meta TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ui_state (
  telegram_user_id TEXT PRIMARY KEY,
  avulso_index INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_media (
  menu_key TEXT PRIMARY KEY,
  preview_drive_file_id TEXT,
  preview_mime TEXT DEFAULT 'video',
  caption TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status_kind_created ON orders(status, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(reference);
CREATE INDEX IF NOT EXISTS idx_orders_product_status ON orders(product_id, status);
CREATE INDEX IF NOT EXISTS idx_products_active_id ON products(is_active, id DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_user_product ON purchases(telegram_user_id, product_id);
CREATE INDEX IF NOT EXISTS idx_drive_access_exp ON drive_access(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_grants_user ON pending_grants(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_content_links_token ON content_links(token);
CREATE INDEX IF NOT EXISTS idx_content_links_exp ON content_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_events_user_event ON user_events(telegram_user_id, event, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_events_product_event_created ON user_events(product_id, event, created_at);
`);

const productColumns = db.prepare("PRAGMA table_info(products)").all();
const hasSortOrder = productColumns.some((col) => col.name === "sort_order");
if (!hasSortOrder) {
  db.exec("ALTER TABLE products ADD COLUMN sort_order INTEGER DEFAULT 0");
}

const hasPlans = db.prepare("SELECT COUNT(*) AS total FROM config_plans").get().total;
if (!hasPlans) {
  const ins = db.prepare("INSERT INTO config_plans (code, label, days, amount_cents) VALUES (?, ?, ?, ?)");
  ins.run("week", "VIP 7 dias", 7, 1090);
  ins.run("month", "VIP 30 dias", 30, 2990);
  ins.run("months3", "VIP 90 dias", 90, 8990);
}

module.exports = db;
