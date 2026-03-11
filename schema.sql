CREATE TABLE IF NOT EXISTS config_plans (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  preview_drive_file_id TEXT,
  preview_mime TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  provider_payment_id TEXT,
  telegram_user_id BIGINT,
  telegram_username TEXT,
  buyer_name TEXT,
  buyer_email TEXT,
  buyer_phone TEXT,
  target_type TEXT NOT NULL,
  target_code TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL DEFAULT 'pending',
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_provider_payment
ON orders(provider, provider_payment_id)
WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_provider_reference
ON orders(provider, provider_event_id)
WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vip_access (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  telegram_username TEXT,
  plan_code TEXT NOT NULL,
  order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vip_access_user
ON vip_access(telegram_user_id);

CREATE TABLE IF NOT EXISTS user_emails (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drive_access (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  email TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
  permission_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pending_grants (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  email TEXT DEFAULT '',
  order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_links (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  telegram_user_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, event_id)
);

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT,
  payment_id TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_user_events (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  telegram_username TEXT,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_code TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remarketing_campaigns (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  telegram_username TEXT,
  target_type TEXT NOT NULL,
  target_code TEXT,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remarketing_messages (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES remarketing_campaigns(id) ON DELETE CASCADE,
  sequence_step INTEGER NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  message_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, sequence_step)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings_audit_logs (
  id SERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  previous_value JSONB,
  next_value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_locks (
  job_name TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_purchases_order
ON purchases(order_id)
WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_audit_provider_event
ON payment_audit_logs(provider, event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_audit_order
ON payment_audit_logs(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_user_events_user_created
ON bot_user_events(telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_remarketing_campaigns_status
ON remarketing_campaigns(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_remarketing_messages_due
ON remarketing_messages(status, due_at ASC);

CREATE INDEX IF NOT EXISTS idx_app_settings_audit_key_created
ON app_settings_audit_logs(setting_key, created_at DESC);

INSERT INTO config_plans (code, title, price_cents, duration_days, active)
VALUES
  ('week', 'VIP 7 dias', 1090, 7, TRUE),
  ('month', 'VIP 30 dias', 2990, 30, TRUE),
  ('months3', 'VIP 90 dias', 8990, 90, TRUE)
ON CONFLICT (code) DO NOTHING;
