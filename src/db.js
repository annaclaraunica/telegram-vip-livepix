const Database = require("better-sqlite3")
const path = require("path")

const db = new Database(path.join(process.cwd(), "app.db"))
db.pragma("journal_mode = WAL")
db.pragma("synchronous = NORMAL")

db.exec(`
CREATE TABLE IF NOT EXISTS config_plans (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  days INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vip_access (
  telegram_user_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL,
  drive_file_id TEXT,
  preview_drive_file_id TEXT,
  preview_mime TEXT DEFAULT 'video',
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_emails (
  telegram_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drive_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  permission_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS content_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_count INTEGER DEFAULT 0,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT,
  kind TEXT NOT NULL,
  plan_code TEXT,
  product_id INTEGER,
  amount_cents INTEGER NOT NULL,
  reference TEXT UNIQUE,
  payment_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  order_reference TEXT UNIQUE,
  product_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
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
`)

// lightweight migrations
const cols = db.prepare("PRAGMA table_info(products)").all().map((r) => r.name)

if (!cols.includes("tagline")) {
  db.exec("ALTER TABLE products ADD COLUMN tagline TEXT DEFAULT ''")
}

if (!cols.includes("sort_order")) {
  db.exec("ALTER TABLE products ADD COLUMN sort_order INTEGER DEFAULT 0")
}

const count = db.prepare("SELECT COUNT(*) AS total FROM config_plans").get().total

if (!count) {
  const ins = db.prepare("INSERT INTO config_plans (code,label,days,amount_cents,active) VALUES (?,?,?,?,1)")
  ins.run("week", "VIP 7 dias", 7, 1090)
  ins.run("month", "VIP 30 dias", 30, 2990)
  ins.run("months3", "VIP 90 dias", 90, 8990)
}

module.exports = db
