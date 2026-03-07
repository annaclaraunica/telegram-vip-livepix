
const Database = require("better-sqlite3");
const db = new Database("app.db");
db.exec(`
CREATE TABLE IF NOT EXISTS users (telegram_user_id TEXT PRIMARY KEY, first_seen_at INTEGER, last_seen_at INTEGER, marketing_opt_out INTEGER DEFAULT 0, last_marketing_at INTEGER);
CREATE TABLE IF NOT EXISTS vip_access (telegram_user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_user_id TEXT, kind TEXT, plan_code TEXT, product_id INTEGER, amount_cents INTEGER, reference TEXT UNIQUE, payment_id TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS config_plans (code TEXT PRIMARY KEY, label TEXT, days INTEGER, amount_cents INTEGER);
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, price_cents INTEGER, drive_file_id TEXT, preview_video_url TEXT, preview_gif_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_user_id TEXT, product_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS user_emails (telegram_user_id TEXT PRIMARY KEY, email TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS drive_access (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_user_id TEXT, email TEXT, drive_file_id TEXT, permission_id TEXT, expires_at INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pending_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_user_id TEXT, order_reference TEXT UNIQUE, product_id INTEGER, drive_file_id TEXT, expires_at INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS content_links (token TEXT PRIMARY KEY, telegram_user_id TEXT, product_id INTEGER, drive_file_id TEXT, expires_at INTEGER, used_count INTEGER DEFAULT 0, used_at INTEGER);
CREATE TABLE IF NOT EXISTS ui_state (telegram_user_id TEXT PRIMARY KEY, avulso_index INTEGER DEFAULT 0);
`);
const c = db.prepare("SELECT COUNT(*) c FROM config_plans").get().c;
if (!c) {
  db.prepare("INSERT INTO config_plans (code,label,days,amount_cents) VALUES ('week','1 Semana',7,590),('month','1 Mês',30,1090),('months3','3 Meses',90,2990)").run();
}
module.exports = db;
