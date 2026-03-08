
const Database = require("better-sqlite3");
const db = new Database("app.db");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_user_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  marketing_opt_out INTEGER NOT NULL DEFAULT 0,
  last_marketing_at INTEGER,
  score INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  product_id INTEGER,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vip_access (
  telegram_user_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan_code TEXT,
  product_id INTEGER,
  amount_cents INTEGER NOT NULL,
  reference TEXT UNIQUE,
  payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS config_plans (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  days INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  drive_file_id TEXT,
  preview_video_url TEXT,
  preview_gif_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_emails (
  telegram_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS drive_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pending_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  order_reference TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS content_links (
  token TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS ui_state (
  telegram_user_id TEXT PRIMARY KEY,
  avulso_index INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_media (
  menu_key TEXT PRIMARY KEY,
  preview_video_url TEXT,
  preview_gif_url TEXT,
  caption TEXT
);
`);
const c = db.prepare("SELECT COUNT(*) AS c FROM config_plans").get().c;
if (!c) {
  db.prepare("INSERT INTO config_plans (code,label,days,amount_cents) VALUES ('week','1 Semana',7,590),('month','1 Mês',30,1090),('months3','3 Meses',90,2990)").run();
}
const m = db.prepare("SELECT COUNT(*) AS c FROM menu_media").get().c;
if (!m) {
  db.prepare("INSERT INTO menu_media (menu_key,preview_video_url,preview_gif_url,caption) VALUES ('home',NULL,NULL,'🔥 Bem-vinda ao VIP da Anna'),('vip',NULL,NULL,'🔐 Planos VIP'),('avulso',NULL,NULL,'🎬 Conteúdos disponíveis'),('free',NULL,NULL,'🆓 Grupo free')").run();
}
module.exports = db;
