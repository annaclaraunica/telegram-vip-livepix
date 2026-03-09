require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");
const basicAuth = require("basic-auth");
const path = require("path");
const { nanoid } = require("nanoid");

const db = require("./db");
const { getLivePixToken, createPayment } = require("./livepix");
const {
  grantFileToEmail,
  revokePermission,
  listFolderFiles,
  driveDirectUrl,
  driveViewUrl,
} = require("./drive");
const {
  mainMenu,
  vipPlansMenu,
  avulsoKeyboard,
  supportMenu,
} = require("./menus");
const { AsyncQueue } = require("./queue");

const app = express();
app.use(express.json({ limit: "2mb" }));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
const VIP_CHAT_ID = Number(process.env.VIP_CHAT_ID || "-1002216871314");
const SUPPORT_WA = (process.env.SUPPORT_WA || process.env.SUPPORT_WHATSAPP || "5522988046948").replace(/[^0-9]/g, "");
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || "https://www.instagram.com/the.annaofc/";
const FREE_GROUP_URL = process.env.FREE_GROUP_URL || "https://t.me/+dlUFej0xfmZhZWE5";
const MENU_MEDIA_MODE = String(process.env.MENU_MEDIA_MODE || "auto").toLowerCase();
const TELEGRAM_SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_SEND_TIMEOUT_MS || 20000);
const JOB_SEND_DELAY_MS = Number(process.env.JOB_SEND_DELAY_MS || 900);
const INVITE_TTL_MINUTES = 15;

const sendQueue = new AsyncQueue({ delayMs: JOB_SEND_DELAY_MS });
const jobLocks = new Set();

const hookCold = [
  "👀 Tem conteúdo que faz muita gente voltar depois do primeiro preview.",
  "🔥 Esse destaque está chamando atenção hoje.",
  "💎 Quem libera esse acesso geralmente volta para pegar mais.",
];

const hookWarm = [
  "👀 Você já demonstrou interesse nesse tipo de conteúdo.",
  "🔥 Esse preview costuma converter muito quando a pessoa volta.",
  "⚡ Você ficou perto de liberar esse acesso.",
];

const hookHot = [
  "🚨 Você já voltou nesse preview. Esse costuma ser o passo final antes da compra.",
  "💎 Esse é um dos conteúdos que mais convertem em retorno.",
  "⚡ Se você já olhou mais de uma vez, provavelmente esse é o certo para você.",
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runExclusive(name, fn) {
  if (jobLocks.has(name)) return Promise.resolve(false);
  jobLocks.add(name);
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      log(`[${name}]`, error.message);
      return false;
    })
    .finally(() => jobLocks.delete(name));
}

function requireAdmin(req, res, next) {
  const u = basicAuth(req);
  if (!(u && u.name === process.env.ADMIN_USER && u.pass === process.env.ADMIN_PASS)) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Auth required");
  }
  next();
}

function trackEvent(userId, event, productId = null, meta = null) {
  db.prepare("INSERT INTO user_events (telegram_user_id,event,product_id,meta) VALUES (?,?,?,?)")
    .run(String(userId), String(event), productId ? Number(productId) : null, meta ? JSON.stringify(meta) : null);
}

function touchUser(userId) {
  const uid = String(userId);
  const now = Date.now();
  const row = db.prepare("SELECT * FROM users WHERE telegram_user_id=?").get(uid);
  if (!row) {
    db.prepare("INSERT INTO users (telegram_user_id,first_seen_at,last_seen_at,marketing_opt_out,last_marketing_at,score) VALUES (?,?,?,?,?,?)")
      .run(uid, now, now, 0, null, 0);
    trackEvent(uid, "start");
    return true;
  }
  db.prepare("UPDATE users SET last_seen_at=? WHERE telegram_user_id=?").run(now, uid);
  return false;
}

function addScore(userId, points) {
  db.prepare("UPDATE users SET score=COALESCE(score,0)+? WHERE telegram_user_id=?")
    .run(Number(points), String(userId));
}

const getPlans = () => db.prepare("SELECT * FROM config_plans ORDER BY days ASC").all();
const getPlan = (code) => db.prepare("SELECT * FROM config_plans WHERE code=?").get(code);
const getVip = (userId) => db.prepare("SELECT * FROM vip_access WHERE telegram_user_id=?").get(String(userId));
const isVipActive = (userId) => {
  const row = getVip(userId);
  return row && Number(row.expires_at) > Date.now();
};

function setVipExpiry(userId, expiresAtMs) {
  db.prepare("INSERT INTO vip_access (telegram_user_id,expires_at,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET expires_at=excluded.expires_at,updated_at=datetime('now')")
    .run(String(userId), Number(expiresAtMs));
}

const getUserEmail = (userId) => db.prepare("SELECT email FROM user_emails WHERE telegram_user_id=?").get(String(userId))?.email || null;

function setUserEmail(userId, email) {
  db.prepare("INSERT INTO user_emails (telegram_user_id,email,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET email=excluded.email,updated_at=datetime('now')")
    .run(String(userId), email);
}

const getOrderByReference = (reference) => db.prepare("SELECT * FROM orders WHERE reference=?").get(reference);

function markOrderPaid(reference, paymentId) {
  db.prepare("UPDATE orders SET status='paid', payment_id=? WHERE reference=?").run(paymentId || null, reference);
}

const getAvulsoIndex = (userId) => db.prepare("SELECT avulso_index FROM ui_state WHERE telegram_user_id=?").get(String(userId))?.avulso_index ?? 0;

function setAvulsoIndex(userId, idx) {
  db.prepare("INSERT INTO ui_state (telegram_user_id,avulso_index) VALUES (?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET avulso_index=excluded.avulso_index").run(String(userId), Number(idx));
}

const getProducts = () => db.prepare("SELECT * FROM products WHERE is_active=1 ORDER BY sort_order DESC, id DESC").all();
const getProductById = (id) => db.prepare("SELECT * FROM products WHERE id=?").get(Number(id));
const getTopProducts = (limit = 5) => db.prepare("SELECT p.*, COUNT(o.id) AS paid_count FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.kind='product' AND o.status='paid' WHERE p.is_active=1 GROUP BY p.id ORDER BY paid_count DESC, p.sort_order DESC, p.id DESC LIMIT ?").all(limit);
const getRecentPaidCount = (productId, hours = 24) => Number(db.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_id=? AND kind='product' AND status='paid' AND datetime(created_at)>=datetime('now',?)").get(Number(productId), `-${hours} hours`).c || 0);
const getRecentViewsCount = (productId, hours = 24) => Number(db.prepare("SELECT COUNT(*) AS c FROM user_events WHERE event='view_preview' AND product_id=? AND datetime(created_at)>=datetime('now',?)").get(Number(productId), `-${hours} hours`).c || 0);

function getUserBehavior(userId) {
  const rows = db.prepare("SELECT event,product_id FROM user_events WHERE telegram_user_id=? ORDER BY id DESC LIMIT 25").all(String(userId));
  const previews = rows.filter((r) => r.event === "view_preview").length;
  const buys = rows.filter((r) => r.event === "buy_click").length;
  const lastViewed = rows.find((r) => r.event === "view_preview")?.product_id || null;

  let segment = "cold";
  if (previews >= 3 || buys >= 1) segment = "hot";
  else if (previews >= 1) segment = "warm";

  return { previews, buys, lastViewed, segment };
}

function behaviorHook(behavior) {
  if (behavior.segment === "hot") return hookHot[Math.floor(Math.random() * hookHot.length)];
  if (behavior.segment === "warm") return hookWarm[Math.floor(Math.random() * hookWarm.length)];
  return hookCold[Math.floor(Math.random() * hookCold.length)];
}

function socialProof(product) {
  const sales = getRecentPaidCount(product.id, 24);
  const views = getRecentViewsCount(product.id, 24);
  if (sales >= 5) return `🔥 ${sales} compras nas últimas 24h`;
  if (sales >= 1) return "👀 Compra recente detectada";
  if (views >= 3) return `⚡ ${views} visualizações recentes nesse preview`;
  return "💎 Conteúdo exclusivo disponível agora";
}

const getMenuMedia = (key) => db.prepare("SELECT * FROM menu_media WHERE menu_key=?").get(String(key)) || null;
const mediaUrl = (id) => (id ? driveDirectUrl(id) : null);
const mediaKind = (m) => (m === "gif" ? "gif" : "video");
const productPreviewUrl = (p) => mediaUrl(p.preview_drive_file_id);
const productPreviewKind = (p) => mediaKind(p.preview_mime);

async function queueTelegram(task) {
  return sendQueue.push(() => withTimeout(task(), TELEGRAM_SEND_TIMEOUT_MS, "telegram_send"));
}

async function safeReply(ctx, text, extra = {}) {
  try {
    return await queueTelegram(() => ctx.reply(text, extra));
  } catch (error) {
    log("safeReply error:", error.message);
    return null;
  }
}

async function safeTelegramSendMessage(chatId, text, extra = {}) {
  try {
    return await queueTelegram(() => bot.telegram.sendMessage(chatId, text, extra));
  } catch (error) {
    log("safeTelegramSendMessage error:", error.message);
    return null;
  }
}

async function safeSendMenuWithMedia(ctx, key, fallback, markup) {
  const row = getMenuMedia(key);
  const url = mediaUrl(row?.preview_drive_file_id);
  const kind = mediaKind(row?.preview_mime);
  const caption = row?.caption || fallback;

  if (!url || MENU_MEDIA_MODE === "off") {
    return safeReply(ctx, caption, markup);
  }

  try {
    if (kind === "gif") {
      return await queueTelegram(() => ctx.replyWithAnimation(url, { caption, ...markup }));
    }
    return await queueTelegram(() => ctx.replyWithVideo(url, { caption, ...markup }));
  } catch (error) {
    log("menu media fallback:", error.message);
    return safeReply(ctx, caption, markup);
  }
}

async function createSingleUseInviteLink() {
  const exp = Math.floor((Date.now() + INVITE_TTL_MINUTES * 60000) / 1000);
  const link = await withTimeout(
    bot.telegram.createChatInviteLink(VIP_CHAT_ID, {
      expire_date: exp,
      member_limit: 1,
      creates_join_request: false,
    }),
    TELEGRAM_SEND_TIMEOUT_MS,
    "create_invite"
  );
  return link.invite_link;
}

async function kickFromChannel(userId) {
  await withTimeout(bot.telegram.banChatMember(VIP_CHAT_ID, userId), TELEGRAM_SEND_TIMEOUT_MS, "ban_member");
  await withTimeout(bot.telegram.unbanChatMember(VIP_CHAT_ID, userId), TELEGRAM_SEND_TIMEOUT_MS, "unban_member");
}

function createContentToken({ telegramUserId, productId, driveFileId, expiresAtMs }) {
  const token = nanoid(24);
  db.prepare("INSERT INTO content_links (token,telegram_user_id,product_id,drive_file_id,expires_at,used_count) VALUES (?,?,?,?,?,0)")
    .run(token, String(telegramUserId), Number(productId), driveFileId, Number(expiresAtMs));
  return token;
}

async function showProduct(ctx, idx) {
  const items = getProducts();
  if (!items.length) {
    if (ctx.updateType === "callback_query") return ctx.editMessageText("Sem conteúdos cadastrados no momento.");
    return safeReply(ctx, "Sem conteúdos cadastrados no momento.");
  }

  const total = items.length;
  const safe = ((idx % total) + total) % total;
  const p = items[safe];

  setAvulsoIndex(ctx.from.id, safe);
  trackEvent(ctx.from.id, "view_preview", p.id);
  addScore(ctx.from.id, 2);

  const header = p.tagline ? `*${p.tagline}*\n` : "";
  const caption = `${socialProof(p)}\n\n${header}🎬 *${p.title}*\n\n${p.description}\n\n💰 R$ ${(p.price_cents / 100).toFixed(2).replace(".", ",")}\n\n_Se esse preview chamou sua atenção, esse é o próximo passo._`;
  const keyboard = avulsoKeyboard({ idx: safe, total, productId: p.id, freeGroupUrl: FREE_GROUP_URL });
  const url = productPreviewUrl(p);
  const kind = productPreviewKind(p);

  if (url && MENU_MEDIA_MODE !== "off") {
    try {
      if (ctx.updateType === "callback_query") {
        try {
          await withTimeout(
            ctx.editMessageMedia(
              {
                type: kind === "gif" ? "animation" : "video",
                media: url,
                caption,
                parse_mode: "Markdown",
              },
              keyboard
            ),
            TELEGRAM_SEND_TIMEOUT_MS,
            "edit_message_media"
          );
          return;
        } catch (error) {
          log("editMessageMedia fallback:", error.message);
        }
      }

      if (kind === "gif") {
        return await queueTelegram(() => ctx.replyWithAnimation(url, { caption, parse_mode: "Markdown", ...keyboard }));
      }
      return await queueTelegram(() => ctx.replyWithVideo(url, { caption, parse_mode: "Markdown", ...keyboard }));
    } catch (error) {
      log("showProduct media fallback:", error.message);
    }
  }

  if (ctx.updateType === "callback_query") return ctx.editMessageText(caption, { parse_mode: "Markdown", ...keyboard });
  return safeReply(ctx, caption, { parse_mode: "Markdown", ...keyboard });
}

async function processPendingGrantsForUser(ctx, email) {
  const pendings = db.prepare("SELECT * FROM pending_grants WHERE telegram_user_id=?").all(String(ctx.from.id));
  for (const pg of pendings) {
    try {
      const { permissionId } = await grantFileToEmail({
        driveFileId: pg.drive_file_id,
        email,
        expirationTime: new Date(pg.expires_at).toISOString(),
      });

      db.prepare("INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)")
        .run(String(ctx.from.id), email, pg.drive_file_id, permissionId, pg.expires_at);

      const token = createContentToken({
        telegramUserId: ctx.from.id,
        productId: pg.product_id,
        driveFileId: pg.drive_file_id,
        expiresAtMs: pg.expires_at,
      });

      db.prepare("INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)").run(String(ctx.from.id), pg.product_id);
      db.prepare("DELETE FROM pending_grants WHERE id=?").run(pg.id);

      trackEvent(ctx.from.id, "content_unlocked", pg.product_id);
      addScore(ctx.from.id, 10);

      await safeReply(ctx, `🎁 *Acesso liberado!*\n\n🔗 Link individual (1 uso):\n${PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`, { parse_mode: "Markdown" });
    } catch (e) {
      log("pending grant error:", e.message);
      await safeReply(ctx, "⚠️ Tive um erro ao liberar seu conteúdo.");
    }
  }
}

async function sendMarketingMessage(userId, product, extraText) {
  const url = productPreviewUrl(product);
  const kind = productPreviewKind(product);
  const line = product.tagline ? `*${product.tagline}*\n` : "";
  const caption = `${extraText}\n\n${socialProof(product)}\n\n${line}🎬 *${product.title}*\n💰 R$ ${(product.price_cents / 100).toFixed(2).replace(".", ",")}\n\n_Se você já parou nesse preview, esse é o conteúdo que vale liberar._`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "💳 Comprar agora", callback_data: `BUY_PRODUCT_${product.id}` }],
      [{ text: "🆓 Grupo FREE", url: FREE_GROUP_URL }],
      [{ text: "📸 Instagram", url: INSTAGRAM_URL }],
      [{ text: "🚫 Parar mensagens", callback_data: "MARKETING_STOP" }],
    ],
  };

  if (url && MENU_MEDIA_MODE !== "off") {
    try {
      if (kind === "gif") {
        return await queueTelegram(() => bot.telegram.sendAnimation(userId, url, { caption, parse_mode: "Markdown", reply_markup }));
      }
      return await queueTelegram(() => bot.telegram.sendVideo(userId, url, { caption, parse_mode: "Markdown", reply_markup }));
    } catch (error) {
      log("marketing media fallback:", error.message);
    }
  }

  return safeTelegramSendMessage(userId, caption, { parse_mode: "Markdown", reply_markup });
}

async function marketingJob() {
  const users = db.prepare("SELECT * FROM users WHERE marketing_opt_out=0").all();
  const products = getProducts();
  if (!products.length) return;

  for (const u of users) {
    if (db.prepare("SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1").get(u.telegram_user_id)) continue;
    const can = !u.last_marketing_at || (Date.now() - Number(u.last_marketing_at)) > 24 * 60 * 60 * 1000;
    if (!can) continue;

    const behavior = getUserBehavior(u.telegram_user_id);
    const preferred = behavior.lastViewed ? getProductById(behavior.lastViewed) : null;
    const product = preferred || getTopProducts(1)[0] || products[0];

    try {
      await sendMarketingMessage(u.telegram_user_id, product, behaviorHook(behavior));
      db.prepare("UPDATE users SET last_marketing_at=? WHERE telegram_user_id=?").run(Date.now(), u.telegram_user_id);
      trackEvent(u.telegram_user_id, "remarketing_sent", product.id);
    } catch (e) {
      log("marketing error:", e.message);
    }
  }
}

async function removeExpiredUsersJob() {
  const rows = db.prepare("SELECT telegram_user_id,expires_at FROM vip_access").all();
  for (const r of rows) {
    if (Number(r.expires_at) <= Date.now()) {
      try {
        await kickFromChannel(Number(r.telegram_user_id));
      } catch (e) {
        log("kick error:", e.message);
      }
    }
  }
}

async function revokeExpiredDriveAccessJob() {
  const rows = db.prepare("SELECT * FROM drive_access WHERE expires_at <= ?").all(Date.now());
  for (const r of rows) {
    try {
      await revokePermission({ driveFileId: r.drive_file_id, permissionId: r.permission_id });
    } catch (e) {
      log("revoke error:", e.message);
    }
    db.prepare("DELETE FROM drive_access WHERE id=?").run(r.id);
  }
  db.prepare("DELETE FROM content_links WHERE expires_at <= ?").run(Date.now());
}

bot.start(async (ctx) => {
  const isNew = touchUser(ctx.from.id);
  if (isNew && process.env.COVER_FILE_ID) {
    try {
      await queueTelegram(() => ctx.replyWithPhoto(process.env.COVER_FILE_ID, {
        caption: "🔥 *Bem-vinda ao VIP*\n\nConteúdos exclusivos, previews e acesso rápido.\n\n👇 Escolha uma opção no menu.",
        parse_mode: "Markdown",
      }));
    } catch (error) {
      log("cover photo error:", error.message);
    }
  }
  await safeSendMenuWithMedia(ctx, "home", "Menu principal", mainMenu(INSTAGRAM_URL, FREE_GROUP_URL));
});

bot.command("email", async (ctx) => {
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  if (parts.length < 2) return safeReply(ctx, "📧 Envie assim: /email seuemail@exemplo.com");
  const email = parts[1].trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return safeReply(ctx, "❌ Email inválido.");
  setUserEmail(ctx.from.id, email);
  trackEvent(ctx.from.id, "email_set");
  await safeReply(ctx, `✅ Email cadastrado: ${email}`);
  await processPendingGrantsForUser(ctx, email);
});

bot.command("parar", async (ctx) => {
  db.prepare("UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?").run(String(ctx.from.id));
  await safeReply(ctx, "✅ Não vou mais enviar mensagens automáticas.");
});

bot.command("voltar", async (ctx) => {
  db.prepare("UPDATE users SET marketing_opt_out=0 WHERE telegram_user_id=?").run(String(ctx.from.id));
  await safeReply(ctx, "✅ Reativei as mensagens automáticas.");
});

bot.action("MENU_HOME", async (ctx) => {
  await ctx.answerCbQuery();
  await safeSendMenuWithMedia(ctx, "home", "Menu principal", mainMenu(INSTAGRAM_URL, FREE_GROUP_URL));
});

bot.action("MENU_VIP", async (ctx) => {
  await ctx.answerCbQuery();
  const plans = getPlans();
  if (isVipActive(ctx.from.id)) {
    const row = getVip(ctx.from.id);
    return safeReply(ctx, `✅ VIP ativo até: ${new Date(Number(row.expires_at)).toLocaleString("pt-BR")}\n\nQuer renovar?`, vipPlansMenu(plans));
  }
  await safeSendMenuWithMedia(ctx, "vip", "🔐 Planos VIP", vipPlansMenu(plans));
});

bot.action("MENU_AVULSO", async (ctx) => {
  await ctx.answerCbQuery();
  await showProduct(ctx, getAvulsoIndex(ctx.from.id));
});

bot.action(/^AV_NEXT_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showProduct(ctx, Number(ctx.match[1]) + 1);
});

bot.action(/^AV_PREV_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showProduct(ctx, Number(ctx.match[1]) - 1);
});

bot.action("AV_NOOP", async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action("MENU_TOP", async (ctx) => {
  await ctx.answerCbQuery();
  const tops = getTopProducts(5);
  if (!tops.length) return safeReply(ctx, "Ainda não há vendas suficientes para mostrar ranking.");
  const text = tops.map((p, i) => `${i + 1}. ${p.title}${p.paid_count ? ` — ${p.paid_count} vendas` : ""}`).join("\n");
  await safeReply(ctx, `🔥 *Mais vendidos*\n\n${text}`, { parse_mode: "Markdown" });
});

bot.action("AV_MY", async (ctx) => {
  await ctx.answerCbQuery();
  const rows = db.prepare("SELECT p.id,p.title FROM purchases pu JOIN products p ON p.id=pu.product_id WHERE pu.telegram_user_id=? ORDER BY pu.id DESC LIMIT 20").all(String(ctx.from.id));
  if (!rows.length) return safeReply(ctx, "🧾 Você ainda não comprou conteúdos.");
  const kb = rows.map((r) => [{ text: `🔁 Reenviar: ${r.title}`, callback_data: `REDELIVER_${r.id}` }]);
  kb.push([{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }]);
  await safeReply(ctx, "🧾 *Minhas compras*\n\nEscolha um item para gerar um novo link:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: kb },
  });
});

bot.action(/^REDELIVER_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const product = getProductById(Number(ctx.match[1]));
  if (!product) return safeReply(ctx, "❌ Conteúdo não encontrado.");
  if (!product.drive_file_id) return safeReply(ctx, "⚠️ Esse item não tem Drive ID cadastrado.");

  const token = createContentToken({
    telegramUserId: ctx.from.id,
    productId: product.id,
    driveFileId: product.drive_file_id,
    expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  await safeReply(ctx, `🔗 Novo link (1 uso):\n${PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`);
});

bot.action(/^VIP_BUY_(week|month|months3)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const plan = getPlan(ctx.match[1]);
  if (!plan) return safeReply(ctx, "Plano inválido.");

  try {
    const token = await getLivePixToken({
      clientId: process.env.LIVEPIX_CLIENT_ID,
      clientSecret: process.env.LIVEPIX_CLIENT_SECRET,
    });
    const payment = await createPayment({
      token,
      amountCents: plan.amount_cents,
      redirectUrl: `${PUBLIC_URL || "https://example.com"}/admin`,
    });

    db.prepare("INSERT INTO orders (telegram_user_id,kind,plan_code,amount_cents,reference,status) VALUES (?, 'vip', ?, ?, ?, 'pending')")
      .run(String(ctx.from.id), plan.code, plan.amount_cents, payment.reference);

    await safeReply(ctx, `💳 *Pagamento gerado!*\n\nPlano: *${plan.label}*\nValor: R$ ${(plan.amount_cents / 100).toFixed(2).replace(".", ",")}\n\n👉 Pague por aqui:\n${payment.redirectUrl}`, { parse_mode: "Markdown" });
  } catch (error) {
    log("vip payment error:", error.message);
    await safeReply(ctx, "❌ Erro ao gerar pagamento.");
  }
});

bot.action(/^BUY_PRODUCT_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const product = getProductById(Number(ctx.match[1]));
  if (!product) return safeReply(ctx, "❌ Conteúdo não encontrado.");

  try {
    const token = await getLivePixToken({
      clientId: process.env.LIVEPIX_CLIENT_ID,
      clientSecret: process.env.LIVEPIX_CLIENT_SECRET,
    });
    const payment = await createPayment({
      token,
      amountCents: product.price_cents,
      redirectUrl: `${PUBLIC_URL || "https://example.com"}/admin`,
    });

    db.prepare("INSERT INTO orders (telegram_user_id,kind,product_id,amount_cents,reference,status) VALUES (?, 'product', ?, ?, ?, 'pending')")
      .run(String(ctx.from.id), product.id, product.price_cents, payment.reference);

    trackEvent(ctx.from.id, "buy_click", product.id);
    addScore(ctx.from.id, 5);

    await safeReply(ctx, `💳 *Pagamento gerado!*\n\nConteúdo: *${product.title}*\nValor: R$ ${(product.price_cents / 100).toFixed(2).replace(".", ",")}\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Após confirmar, eu vou pedir seu email para liberar o acesso.`, { parse_mode: "Markdown" });
  } catch (error) {
    log("product payment error:", error.message);
    await safeReply(ctx, "❌ Erro ao gerar pagamento.");
  }
});

bot.action("MENU_SUPORTE", async (ctx) => {
  await ctx.answerCbQuery();
  await safeReply(ctx, "🆘 *Suporte VIP*\n\nFale comigo no WhatsApp:", {
    parse_mode: "Markdown",
    ...supportMenu(SUPPORT_WA),
  });
});

bot.action("MARKETING_STOP", async (ctx) => {
  await ctx.answerCbQuery();
  db.prepare("UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?").run(String(ctx.from.id));
  await safeReply(ctx, "✅ Tudo certo. Não vou mais enviar mensagens automáticas.");
});

async function processPaidOrder(order, reference) {
  if (order.kind === "vip") {
    const plan = getPlan(order.plan_code);
    if (!plan) return;
    setVipExpiry(order.telegram_user_id, Date.now() + Number(plan.days) * 24 * 60 * 60 * 1000);
    const invite = await createSingleUseInviteLink();
    await safeTelegramSendMessage(order.telegram_user_id, `✅ Pagamento confirmado!\n\nVIP liberado por *${plan.days} dias*.\n\n⏳ Link (1 uso / expira em ${INVITE_TTL_MINUTES} min):\n${invite}`, { parse_mode: "Markdown" });
    return;
  }

  if (order.kind === "product") {
    const product = getProductById(Number(order.product_id));
    if (!product || !product.drive_file_id) {
      await safeTelegramSendMessage(order.telegram_user_id, "⚠️ Pagamento confirmado, mas este item está sem Drive ID cadastrado. Fale no suporte.");
      return;
    }

    const email = getUserEmail(order.telegram_user_id);
    const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;

    if (!email) {
      db.prepare("INSERT INTO pending_grants (telegram_user_id,order_reference,product_id,drive_file_id,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(order_reference) DO NOTHING")
        .run(String(order.telegram_user_id), reference, Number(product.id), product.drive_file_id, expires);

      await safeTelegramSendMessage(order.telegram_user_id, "✅ Pagamento confirmado!\n\n📧 Agora envie seu email do Google para liberar o conteúdo por 30 dias.\n\nExemplo:\n/email seuemail@exemplo.com");
      return;
    }

    const perm = await grantFileToEmail({
      driveFileId: product.drive_file_id,
      email,
      expirationTime: new Date(expires).toISOString(),
    });

    db.prepare("INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)")
      .run(String(order.telegram_user_id), email, product.drive_file_id, perm.permissionId, expires);

    const token = createContentToken({
      telegramUserId: order.telegram_user_id,
      productId: product.id,
      driveFileId: product.drive_file_id,
      expiresAtMs: expires,
    });

    db.prepare("INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)").run(String(order.telegram_user_id), product.id);
    await safeTelegramSendMessage(order.telegram_user_id, `✅ Pagamento confirmado!\n\n📁 Conteúdo liberado para: *${email}*\n⏳ Validade: *30 dias*\n\n🔗 Link individual (1 uso):\n${PUBLIC_URL}/c/${token}`, { parse_mode: "Markdown" });
  }
}

app.post("/webhook/livepix", async (req, res) => {
  try {
    if (process.env.WEBHOOK_SECRET && req.query.secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }

    const payload = req.body;
    if (payload?.resource?.type !== "payment") return res.json({ ok: true });

    const paymentId = payload.resource.id;
    const reference = payload.resource.reference;
    const order = getOrderByReference(reference);
    if (!order || order.status === "paid") return res.json({ ok: true });

    markOrderPaid(reference, paymentId);
    res.json({ ok: true });
    processPaidOrder(order, reference).catch((error) => log("post-webhook processing error:", error.message));
  } catch (error) {
    log("webhook error:", error.message);
    res.status(500).json({ ok: false });
  }
});

app.get("/c/:token", (req, res) => {
  const row = db.prepare("SELECT * FROM content_links WHERE token=?").get(req.params.token);
  if (!row) return res.status(404).send("Link inválido.");
  if (Number(row.used_count) >= 1) return res.status(410).send("Link já utilizado.");
  if (Number(row.expires_at) <= Date.now()) return res.status(410).send("Acesso expirado.");

  const ok = db.transaction(() => {
    const cur = db.prepare("SELECT used_count FROM content_links WHERE token=?").get(req.params.token);
    if (!cur || Number(cur.used_count) >= 1) return false;
    db.prepare("UPDATE content_links SET used_count=1, used_at=? WHERE token=?").run(Date.now(), req.params.token);
    return true;
  })();

  if (!ok) return res.status(410).send("Link já utilizado.");
  return res.redirect(302, driveViewUrl(row.drive_file_id));
});

app.get("/admin", requireAdmin, (req, res) => res.sendFile(path.resolve("admin", "index.html")));
app.get("/admin/api/stats", requireAdmin, (req, res) => {
  const total = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid'").get().cents;
  const vip = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='vip'").get().cents;
  const product = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='product'").get().cents;
  const users = db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
  const activeProducts = db.prepare("SELECT COUNT(*) AS total FROM products WHERE is_active=1").get().total;
  res.json({ total, vip, product, users, activeProducts });
});

app.get("/admin/api/plans", requireAdmin, (req, res) => res.json(getPlans()));
app.post("/admin/api/plans", requireAdmin, (req, res) => {
  const { plans } = req.body;
  const stmt = db.prepare("UPDATE config_plans SET label=?, days=?, amount_cents=?, active=? WHERE code=?");
  db.transaction(() => {
    for (const p of plans) stmt.run(String(p.label), Number(p.days), Number(p.amount_cents), Number(p.active ?? 1), String(p.code));
  })();
  res.json({ ok: true });
});

app.get("/admin/api/products", requireAdmin, (req, res) => res.json(db.prepare("SELECT * FROM products ORDER BY sort_order DESC, id DESC").all()));
app.post("/admin/api/products", requireAdmin, (req, res) => {
  const { title, tagline="", description="", price_cents, drive_file_id, preview_drive_file_id, preview_mime, sort_order=0 } = req.body;
  if (!title || !price_cents) return res.status(400).send("missing fields");
  db.prepare("INSERT INTO products (title,tagline,description,price_cents,drive_file_id,preview_drive_file_id,preview_mime,sort_order) VALUES (?,?,?,?,?,?,?,?)")
    .run(String(title), String(tagline), String(description), Number(price_cents), String(drive_file_id || "") || null, String(preview_drive_file_id || "") || null, String(preview_mime || "video"), Number(sort_order));
  res.json({ ok: true });
});

app.put("/admin/api/products/:id", requireAdmin, (req, res) => {
  const { title, tagline="", description="", price_cents, drive_file_id, preview_drive_file_id, preview_mime, is_active=1, sort_order=0 } = req.body;
  db.prepare("UPDATE products SET title=?, tagline=?, description=?, price_cents=?, drive_file_id=?, preview_drive_file_id=?, preview_mime=?, is_active=?, sort_order=? WHERE id=?")
    .run(String(title), String(tagline), String(description), Number(price_cents), String(drive_file_id || "") || null, String(preview_drive_file_id || "") || null, String(preview_mime || "video"), Number(is_active), Number(sort_order), Number(req.params.id));
  res.json({ ok: true });
});

app.delete("/admin/api/products/:id", requireAdmin, (req, res) => {
  db.prepare("UPDATE products SET is_active=0 WHERE id=?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.post("/admin/api/menu-media", requireAdmin, (req, res) => {
  const { menu_key, caption, preview_drive_file_id, preview_mime } = req.body;
  db.prepare("INSERT INTO menu_media (menu_key,preview_drive_file_id,preview_mime,caption) VALUES (?,?,?,?) ON CONFLICT(menu_key) DO UPDATE SET preview_drive_file_id=excluded.preview_drive_file_id, preview_mime=excluded.preview_mime, caption=excluded.caption")
    .run(String(menu_key), String(preview_drive_file_id || "") || null, String(preview_mime || "video"), caption || null);
  res.json({ ok: true });
});

app.get("/admin/api/menu-media", requireAdmin, (req, res) => res.json(db.prepare("SELECT * FROM menu_media ORDER BY menu_key").all()));

app.post("/admin/api/import-drive-folder", requireAdmin, async (req, res) => {
  try {
    const folderId = String(req.body.folder_id || "").trim();
    const desc = String(req.body.description || "").trim() || "Conteúdo exclusivo.";
    const price = Number(req.body.price_cents || 0);
    if (!folderId) return res.status(400).send("folder_id vazio");

    const files = await listFolderFiles({ folderId });
    const only = files.filter((f) => !String(f.mimeType || "").includes("folder"));

    const normalize = (name) => String(name || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_\- ]preview$/i, "")
      .replace(/\(preview\)$/i, "")
      .trim()
      .toLowerCase();

    const previews = new Map()
    for (const f of only) {
      if (/(^|[_\- ])preview($|[_\- ])/i.test(f.name) || /[_\- ]preview\./i.test(f.name) || /\(preview\)/i.test(f.name)) {
        previews.set(normalize(f.name), f)
      }
    }

    const exists = db.prepare("SELECT id FROM products WHERE drive_file_id=? LIMIT 1");
    const ins = db.prepare("INSERT INTO products (title,tagline,description,price_cents,drive_file_id,preview_drive_file_id,preview_mime,sort_order) VALUES (?,?,?,?,?,?,?,?)");
    let created = 0

    db.transaction(() => {
      for (const f of only) {
        if (/(^|[_\- ])preview($|[_\- ])/i.test(f.name) || /[_\- ]preview\./i.test(f.name) || /\(preview\)/i.test(f.name)) continue
        if (exists.get(String(f.id))) continue
        const key = normalize(f.name)
        const preview = previews.get(key) || null
        const mime = preview && /gif/i.test(preview.mimeType || "") ? "gif" : "video"
        ins.run(String(f.name || "Conteúdo"), "", desc, price, String(f.id), preview ? String(preview.id) : null, mime, 0)
        created++
      }
    })()

    res.json({ ok: true, created, total: only.length })
  } catch (error) {
    log("import-drive-folder error:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/admin/api/orders", requireAdmin, (req, res) => res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all()));
app.get("/admin/api/vips", requireAdmin, (req, res) => res.json(db.prepare("SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200").all()));
app.get("/admin/api/users", requireAdmin, (req, res) => res.json(db.prepare("SELECT * FROM users ORDER BY last_seen_at DESC LIMIT 200").all()));

app.get("/", (req, res) => res.send("OK"));
app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get("/readyz", (req, res) => res.json({ ok: true }));

app.use(bot.webhookCallback("/telegram"));

setInterval(() => runExclusive("marketingJob", marketingJob), 6 * 60 * 60 * 1000);
setInterval(() => runExclusive("removeExpiredUsersJob", removeExpiredUsersJob), 30 * 60 * 60 * 1000);
setInterval(() => runExclusive("revokeExpiredDriveAccessJob", revokeExpiredDriveAccessJob), 60 * 60 * 60 * 1000);

process.on("unhandledRejection", (error) => log("unhandledRejection:", error?.message || error));
process.on("uncaughtException", (error) => log("uncaughtException:", error?.message || error));

async function main() {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, async () => {
    log(`HTTP on :${port}`);
    if (PUBLIC_URL) {
      try {
        await bot.telegram.setWebhook(`${PUBLIC_URL}/telegram`);
        log("Telegram webhook configured");
      } catch (error) {
        log("setWebhook error:", error.message);
      }
    }
    log("BOT ONLINE");
  });
}

main().catch((error) => {
  log("startup error:", error.message);
  process.exit(1);
});
