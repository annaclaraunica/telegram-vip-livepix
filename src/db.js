
const Database = require("better-sqlite3")
const db = new Database("app.db")

db.exec(`

CREATE TABLE IF NOT EXISTS users (
telegram_user_id TEXT PRIMARY KEY,
first_seen_at INTEGER,
last_seen_at INTEGER,
marketing_opt_out INTEGER DEFAULT 0,
last_marketing_at INTEGER
);

CREATE TABLE IF NOT EXISTS products (
id INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT,
description TEXT,
price_cents INTEGER,
preview_video_url TEXT,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchases (
id INTEGER PRIMARY KEY AUTOINCREMENT,
telegram_user_id TEXT,
product_id INTEGER,
paid INTEGER DEFAULT 0,
created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_emails (
telegram_user_id TEXT PRIMARY KEY,
email TEXT
);

`)

module.exports=db
