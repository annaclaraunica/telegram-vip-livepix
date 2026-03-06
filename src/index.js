require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");
const basicAuth = require("basic-auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const db = require("./db");
const { nanoid } = require("nanoid");
const { getLivePixToken, createPayment } = require("./livepix");
const { grantFileToEmail, revokePermission, listFolderFiles } = require("./drive");
const { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu } = require("./menus");

const app = express();
app.use(express.json());

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

function requireAdmin(req, res, next) {
  const user = basicAuth(req);
  const ok = user && user.name === process.env.ADMIN_USER && user.pass === process.env.ADMIN_PASS;
  if (!ok) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Auth required");
  }
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const VIP_CHAT_ID = Number(process.env.VIP_CHAT_ID || "-1002216871314");
const INVITE_TTL_MINUTES = 15;
const SUPPORT_WA = (process.env.SUPPORT_WA || "5522988046948").replace(/[^0-9]/g, "");
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || "https://www.instagram.com/the.annaofc/";

function getPlans() { return db.prepare(`SELECT * FROM config_plans ORDER BY days ASC`).all(); }
function getPlan(code) { return db.prepare(`SELECT * FROM config_plans WHERE code=?`).get(code); }
function setVipExpiry(userId, expiresAtMs) {
  db.prepare(`
    INSERT INTO vip_access (telegram_user_id, expires_at, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(telegram_user_id) DO UPDATE SET expires_at=excluded.expires_at, updated_at=datetime('now')
  `).run(String(userId), expiresAtMs);
}
function getVip(userId) { return db.prepare(`SELECT * FROM vip_access WHERE telegram_user_id=?`).get(String(userId)); }
function isVipActive(userId) { const r = getVip(userId); return r && r.expires_at > Date.now(); }
function getUserEmail(userId) { return db.prepare(`SELECT email FROM user_emails WHERE telegram_user_id=?`).get(String(userId))?.email || null; }
function setUserEmail(userId, email) {
  db.prepare(`
    INSERT INTO user_emails (telegram_user_id, email, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(telegram_user_id) DO UPDATE SET email=excluded.email, updated_at=datetime('now')
  `).run(String(userId), email);
}
function getOrderByReference(reference) { return db.prepare(`SELECT * FROM orders WHERE reference=?`).get(reference); }
function markOrderPaid(reference, paymentId) { db.prepare(`UPDATE orders SET status='paid', payment_id=? WHERE reference=?`).run(paymentId||null, reference); }
function getAvulsoIndex(userId) { return db.prepare(`SELECT avulso_index FROM ui_state WHERE telegram_user_id=?`).get(String(userId))?.avulso_index ?? 0; }
function setAvulsoIndex(userId, idx) {
  db.prepare(`
    INSERT INTO ui_state (telegram_user_id, avulso_index, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(telegram_user_id) DO UPDATE SET avulso_index=excluded.avulso_index, updated_at=datetime('now')
  `).run(String(userId), Number(idx));
}

function canUpsell(userId) {
  const row = db.prepare(`SELECT last_upsell_at FROM upsell_log WHERE telegram_user_id=?`).get(String(userId));
  if (!row) return true;
  return (Date.now() - Number(row.last_upsell_at)) > 24*60*60*1000;
}
function markUpsell(userId) {
  db.prepare(`
    INSERT INTO upsell_log (telegram_user_id, last_upsell_at)
    VALUES (?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET last_upsell_at=excluded.last_upsell_at
  `).run(String(userId), Date.now());
}
async function sendUpsellIfAllowed(ctx) {
  if (!canUpsell(ctx.from.id)) return;
  markUpsell(ctx.from.id);
  const plans = getPlans();
  const best = plans[plans.length-1] || plans[0];
  await ctx.reply(`💎 *Dica:* no VIP você tem acesso a muito mais conteúdo.\n\nQuer ver os planos?`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: `🔐 Ver VIP (${best.label})`, callback_data: "MENU_VIP" }]] }
  });
}

async function createSingleUseInviteLink() {
  const expireDateSeconds = Math.floor((Date.now() + INVITE_TTL_MINUTES*60_000)/1000);
  const link = await bot.telegram.createChatInviteLink(VIP_CHAT_ID, {
    expire_date: expireDateSeconds,
    member_limit: 1,
    creates_join_request: false
  });
  return link.invite_link;
}
async function kickFromChannel(userId) {
  await bot.telegram.banChatMember(VIP_CHAT_ID, userId);
  await bot.telegram.unbanChatMember(VIP_CHAT_ID, userId);
}

function createContentToken({ telegramUserId, productId, driveFileId, expiresAtMs }) {
  const token = nanoid(24);
  db.prepare(`INSERT INTO content_links (token, telegram_user_id, product_id, drive_file_id, expires_at, used_count) VALUES (?, ?, ?, ?, ?, 0)`)
    .run(token, String(telegramUserId), Number(productId), driveFileId, expiresAtMs);
  return token;
}

function listProducts(){ return db.prepare(`SELECT * FROM products ORDER BY id DESC`).all(); }
function absolutePreviewUrl(p){
  const rel = p.preview_video_url || p.preview_gif_url || null;
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${rel}` : rel;
}
async function renderAvulso(ctx, idx){
  const items = listProducts();
  if (!items.length) {
    return (ctx.updateType==="callback_query")
      ? ctx.editMessageText("📦 Nenhum conteúdo disponível.")
      : ctx.reply("📦 Nenhum conteúdo disponível.");
  }
  const total = items.length;
  const safeIdx = ((idx%total)+total)%total;
  const p = items[safeIdx];
  setAvulsoIndex(ctx.from.id, safeIdx);

  const email = getUserEmail(ctx.from.id);
  const hasEmail = !!email;

  const caption =
    `🎬 *${p.title}*\n\n${p.description}\n\n` +
    `💰 R$ ${(p.price_cents/100).toFixed(2).replace(".", ",")}\n` +
    `📧 Email: ${hasEmail ? email : "não cadastrado (/email)"}\n\n` +
    `Após o pagamento, o Drive é liberado apenas para o email cadastrado por 30 dias.`;

  const keyboard = avulsoKeyboard({ idx: safeIdx, total, productId: p.id, hasEmail });
  const url = absolutePreviewUrl(p);

  if (url){
    const isVideo = !!p.preview_video_url;
    const media = { type: isVideo ? "video" : "animation", media: url, caption, parse_mode:"Markdown" };
    if (ctx.updateType==="callback_query"){
      try { await ctx.editMessageMedia(media, keyboard); return; } catch {}
    }
    return isVideo
      ? ctx.replyWithVideo(url,{caption,parse_mode:"Markdown",...keyboard})
      : ctx.replyWithAnimation(url,{caption,parse_mode:"Markdown",...keyboard});
  }

  const text = caption + "\n\n(Prévia não cadastrada.)";
  return (ctx.updateType==="callback_query")
    ? ctx.editMessageText(text,{parse_mode:"Markdown",...keyboard})
    : ctx.reply(text,{parse_mode:"Markdown",...keyboard});
}

bot.start(async (ctx) => {
  const vip = isVipActive(ctx.from.id);
  await ctx.reply(
    vip ? "✅ VIP ativo. Use o menu abaixo:" : "🔥 Bem-vindo(a) ao VIP 🔥\n\nEscolha uma opção:",
    mainMenu(INSTAGRAM_URL)
  );
});

bot.command("email", async (ctx) => {
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  if (parts.length < 2) {
    const current = getUserEmail(ctx.from.id);
    return ctx.reply(current
      ? `📧 Seu email atual: ${current}\n\nPara alterar: /email seuemail@exemplo.com`
      : "📧 Cadastre seu email:\nEx: /email seuemail@exemplo.com"
    );
  }
  const email = parts[1].trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ctx.reply("❌ Email inválido.");
  setUserEmail(ctx.from.id, email);
  return ctx.reply(`✅ Email cadastrado: ${email}`);
});

bot.action("MENU_HOME", async (ctx)=>{ await ctx.answerCbQuery(); await ctx.editMessageText("Escolha uma opção:", mainMenu(INSTAGRAM_URL)); });

bot.action("MENU_VIP", async (ctx) => {
  await ctx.answerCbQuery();
  const plans = getPlans();
  if (isVipActive(ctx.from.id)) {
    const row = getVip(ctx.from.id);
    return ctx.editMessageText(`✅ VIP ativo até: ${new Date(row.expires_at).toLocaleString("pt-BR")}\n\nQuer renovar?`, vipPlansMenu(plans));
  }
  await ctx.editMessageText("🕵️ Pagamento 100% anônimo\n\n🔥 Escolha o plano:", vipPlansMenu(plans));
});

bot.action(/^VIP_BUY_(week|month|months3)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const planCode = ctx.match[1];
  const plan = getPlan(planCode);
  if (!plan) return ctx.reply("Plano inválido.");
  try {
    const token = await getLivePixToken({ clientId: process.env.LIVEPIX_CLIENT_ID, clientSecret: process.env.LIVEPIX_CLIENT_SECRET });
    const payment = await createPayment({ token, amountCents: plan.amount_cents, redirectUrl: "https://example.com/obrigado" });
    db.prepare(`INSERT INTO orders (telegram_user_id, kind, plan_code, amount_cents, reference, status) VALUES (?, 'vip', ?, ?, ?, 'pending')`)
      .run(String(ctx.from.id), planCode, plan.amount_cents, payment.reference);

    await ctx.editMessageText(
      `💳 *Pagamento gerado!*\n\nPlano: *${plan.label}* (R$ ${(plan.amount_cents/100).toFixed(2).replace(".", ",")})\nRef: \`${payment.reference}\`\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Assim que confirmar, eu libero automaticamente.`,
      { parse_mode: "Markdown" }
    );
  } catch (e) { console.error(e); await ctx.reply("❌ Erro ao gerar pagamento."); }
});

bot.action("MENU_AVULSO", async (ctx)=>{
  await ctx.answerCbQuery();
  await renderAvulso(ctx, getAvulsoIndex(ctx.from.id));
  await sendUpsellIfAllowed(ctx);
});
bot.action(/^AV_NEXT_(\d+)$/, async (ctx)=>{ await ctx.answerCbQuery(); await renderAvulso(ctx, Number(ctx.match[1])+1); });
bot.action(/^AV_PREV_(\d+)$/, async (ctx)=>{ await ctx.answerCbQuery(); await renderAvulso(ctx, Number(ctx.match[1])-1); });
bot.action("AV_NOOP", async (ctx)=>{ await ctx.answerCbQuery(); });
bot.action("EMAIL_HELP", async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply("📧 Cadastre seu email: /email seuemail@exemplo.com"); });

bot.action("AV_MY", async (ctx)=>{
  await ctx.answerCbQuery();
  const rows = db.prepare(`SELECT p.id, p.title FROM purchases pu JOIN products p ON p.id=pu.product_id WHERE pu.telegram_user_id=? ORDER BY pu.id DESC LIMIT 20`).all(String(ctx.from.id));
  if (!rows.length) return ctx.reply("🧾 Você ainda não comprou conteúdos.");
  const keyboard = rows.map(r=>[{ text:`🔁 Reenviar: ${r.title}`, callback_data:`REDELIVER_${r.id}` }]);
  keyboard.push([{ text:"⬅️ Voltar", callback_data:"MENU_HOME" }]);
  await ctx.reply("🧾 *Minhas compras*\n\nEscolha um item para gerar um novo link:", { parse_mode:"Markdown", reply_markup:{ inline_keyboard: keyboard }});
});

bot.action(/^REDELIVER_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(productId);
  if (!product) return ctx.reply("❌ Conteúdo não encontrado.");
  const email = getUserEmail(ctx.from.id);
  if (!email) return ctx.reply("📧 Cadastre seu email: /email seuemail@exemplo.com");
  const expiresAtMs = Date.now() + 30*24*60*60*1000;
  const token = createContentToken({ telegramUserId: ctx.from.id, productId, driveFileId: product.drive_file_id, expiresAtMs });
  await ctx.reply(`🔗 Novo link (1 uso):\n${process.env.PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`);
});

bot.action(/^BUY_PRODUCT_(\d+)$/, async (ctx)=>{
  await ctx.answerCbQuery();
  const productId = Number(ctx.match[1]);
  const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(productId);
  if (!product) return ctx.reply("❌ Conteúdo não encontrado.");
  const email = getUserEmail(ctx.from.id);
  if (!email) return ctx.reply("📧 Antes de comprar, cadastre seu email: /email seuemail@exemplo.com");
  try {
    const token = await getLivePixToken({ clientId: process.env.LIVEPIX_CLIENT_ID, clientSecret: process.env.LIVEPIX_CLIENT_SECRET });
    const payment = await createPayment({ token, amountCents: product.price_cents, redirectUrl: "https://example.com/obrigado" });
    db.prepare(`INSERT INTO orders (telegram_user_id, kind, product_id, amount_cents, reference, status) VALUES (?, 'product', ?, ?, ?, 'pending')`)
      .run(String(ctx.from.id), productId, product.price_cents, payment.reference);

    await ctx.reply(
      `💳 *Pagamento gerado!*\n\nConteúdo: *${product.title}*\nValor: R$ ${(product.price_cents/100).toFixed(2).replace(".", ",")}\nEmail: ${email}\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Após confirmar, libero no Drive apenas para este email por 30 dias.`,
      { parse_mode:"Markdown" }
    );
  } catch(e){ console.error(e); await ctx.reply("❌ Erro ao gerar pagamento."); }
});

bot.action("MENU_SUPORTE", async (ctx)=>{
  await ctx.answerCbQuery();
  await ctx.reply("🆘 *Suporte VIP*\n\nFale comigo no WhatsApp:", { parse_mode:"Markdown", ...supportMenu(SUPPORT_WA) });
});

app.post("/webhook/livepix", async (req,res)=>{
  try{
    if (process.env.WEBHOOK_SECRET && req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ok:false});
    const payload = req.body;
    if (payload?.resource?.type !== "payment") return res.json({ok:true});

    const { id: paymentId, reference } = payload.resource;
    const order = getOrderByReference(reference);
    if (!order || order.status==="paid") return res.json({ok:true});

    markOrderPaid(reference, paymentId);

    if (order.kind==="vip"){
      const plan = getPlan(order.plan_code);
      if (!plan) return res.json({ok:true});
      setVipExpiry(order.telegram_user_id, Date.now() + Number(plan.days)*24*60*60*1000);
      const invite = await createSingleUseInviteLink();
      await bot.telegram.sendMessage(
        order.telegram_user_id,
        `✅ Pagamento confirmado!\n\nVIP liberado por *${plan.days} dias*.\n\n⏳ Link (1 uso / expira em ${INVITE_TTL_MINUTES} min):\n${invite}`,
        { parse_mode:"Markdown" }
      );
      return res.json({ok:true});
    }

    if (order.kind==="product"){
      const product = db.prepare(`SELECT * FROM products WHERE id=?`).get(Number(order.product_id));
      if (!product) return res.json({ok:true});

      const email = getUserEmail(order.telegram_user_id);
      if (!email){
        await bot.telegram.sendMessage(order.telegram_user_id, "⚠️ Pagamento confirmado, mas seu email não está cadastrado. Use /email seuemail@exemplo.com");
        return res.json({ok:true});
      }

      const expiresAtMs = Date.now() + 30*24*60*60*1000;
      const { permissionId } = await grantFileToEmail({ driveFileId: product.drive_file_id, email });

      db.prepare(`INSERT INTO drive_access (telegram_user_id, email, drive_file_id, permission_id, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(String(order.telegram_user_id), email, product.drive_file_id, permissionId, expiresAtMs);

      const token = createContentToken({ telegramUserId: order.telegram_user_id, productId: product.id, driveFileId: product.drive_file_id, expiresAtMs });
      db.prepare(`INSERT INTO purchases (telegram_user_id, product_id) VALUES (?, ?)`).run(String(order.telegram_user_id), product.id);

      await bot.telegram.sendMessage(
        order.telegram_user_id,
        `✅ Pagamento confirmado!\n\n📁 Liberado no Drive para: *${email}*\n⏳ Validade: *30 dias*\n\n🔗 Link individual (1 uso):\n${process.env.PUBLIC_URL}/c/${token}`,
        { parse_mode:"Markdown" }
      );
      return res.json({ok:true});
    }

    return res.json({ok:true});
  }catch(e){ console.error("webhook error:", e); return res.status(500).json({ok:false}); }
});

app.get("/c/:token", (req,res)=>{
  const token = req.params.token;
  const row = db.prepare(`SELECT * FROM content_links WHERE token=?`).get(token);
  if (!row) return res.status(404).send("Link inválido.");
  if (row.used_count>=1) return res.status(410).send("Link já utilizado.");
  if (row.expires_at<=Date.now()) return res.status(410).send("Acesso expirado.");

  const ok = db.transaction(()=>{
    const cur = db.prepare(`SELECT used_count FROM content_links WHERE token=?`).get(token);
    if (!cur || cur.used_count>=1) return false;
    db.prepare(`UPDATE content_links SET used_count=1, used_at=? WHERE token=?`).run(Date.now(), token);
    return true;
  })();

  if (!ok) return res.status(410).send("Link já utilizado.");
  return res.redirect(302, `https://drive.google.com/file/d/${row.drive_file_id}/view`);
});

app.get("/admin", requireAdmin, (req,res)=>res.sendFile(path.resolve("admin","index.html")));

app.get("/admin/api/stats", requireAdmin, (req,res)=>{
  const total = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid'`).get().cents;
  const vip = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='vip'`).get().cents;
  const product = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='product'`).get().cents;
  const daily = db.prepare(`SELECT substr(created_at,1,10) AS day, COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' GROUP BY day ORDER BY day DESC LIMIT 7`).all();
  res.json({ total, vip, product, daily });
});

app.get("/admin/api/analytics/products", requireAdmin, (req,res)=>{
  const rows = db.prepare(`
    SELECT p.id AS product_id, p.title,
      COALESCE(SUM(CASE WHEN o.status='paid' AND o.kind='product' AND o.product_id=p.id THEN 1 ELSE 0 END),0) AS sales_count,
      COALESCE(SUM(CASE WHEN o.status='paid' AND o.kind='product' AND o.product_id=p.id THEN o.amount_cents ELSE 0 END),0) AS revenue_cents
    FROM products p
    LEFT JOIN orders o ON o.product_id=p.id
    GROUP BY p.id
    ORDER BY revenue_cents DESC, sales_count DESC
  `).all();
  res.json(rows);
});

app.get("/admin/api/plans", requireAdmin, (req,res)=>res.json(getPlans()));
app.post("/admin/api/plans", requireAdmin, (req,res)=>{
  const { plans } = req.body;
  if (!Array.isArray(plans)) return res.status(400).json({ ok:false });
  const stmt = db.prepare(`UPDATE config_plans SET label=?, days=?, amount_cents=? WHERE code=?`);
  db.transaction(()=>{ for (const p of plans) stmt.run(String(p.label), Number(p.days), Number(p.amount_cents), String(p.code)); })();
  res.json({ ok:true });
});

app.get("/admin/api/products", requireAdmin, (req,res)=>res.json(db.prepare(`SELECT * FROM products ORDER BY id DESC`).all()));
app.post("/admin/api/products", requireAdmin, upload.single("preview_video"), (req,res)=>{
  const { title, description, price_cents, drive_file_id } = req.body;
  if (!title || !description || !price_cents || !drive_file_id) return res.status(400).send("missing fields");
  const preview_video_url = req.file ? `/uploads/${req.file.filename}` : null;
  const info = db.prepare(`INSERT INTO products (title,description,price_cents,drive_file_id,preview_video_url) VALUES (?,?,?,?,?)`)
    .run(String(title).trim(), String(description).trim(), Number(price_cents), String(drive_file_id).trim(), preview_video_url);
  res.json({ ok:true, id: info.lastInsertRowid, preview_video_url });
});
app.delete("/admin/api/products/:id", requireAdmin, (req,res)=>{
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM products WHERE id=?`).get(id);
  if (!row) return res.status(404).send("not found");
  try{
    const p = row.preview_video_url || row.preview_gif_url;
    if (p && p.startsWith("/uploads/")){
      const local = path.resolve("uploads", p.replace("/uploads/",""));
      if (fs.existsSync(local)) fs.unlinkSync(local);
    }
  }catch{}
  db.prepare(`DELETE FROM products WHERE id=?`).run(id);
  res.json({ ok:true });
});

app.post("/admin/api/import-drive-folder", requireAdmin, async (req,res)=>{
  const folderId = String(req.body.folder_id||"").trim();
  const price = Number(req.body.price_cents||0);
  const desc = String(req.body.description||"").trim() || "Conteúdo exclusivo.";
  if (!folderId) return res.status(400).send("folder_id vazio");
  if (!(price>=0)) return res.status(400).send("price inválido");

  const files = await listFolderFiles({ folderId });
  const onlyFiles = files.filter(f => !(String(f.mimeType||"").includes("folder")));

  const existsStmt = db.prepare(`SELECT id FROM products WHERE drive_file_id=? LIMIT 1`);
  const insertStmt = db.prepare(`INSERT INTO products (title,description,price_cents,drive_file_id) VALUES (?,?,?,?)`);
  let created=0, skipped=0;

  db.transaction(()=>{
    for (const f of onlyFiles){
      if (existsStmt.get(String(f.id))) { skipped++; continue; }
      insertStmt.run(String(f.name||"Conteúdo").trim(), desc, price, String(f.id));
      created++;
    }
  })();

  res.json({ ok:true, created, skipped, total: onlyFiles.length });
});

app.get("/admin/api/orders", requireAdmin, (req,res)=>res.json(db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 200`).all()));
app.get("/admin/api/vips", requireAdmin, (req,res)=>res.json(db.prepare(`SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200`).all()));

app.get("/", (req,res)=>res.send("OK"));

async function removeExpiredUsersJob(){
  const rows = db.prepare(`SELECT telegram_user_id, expires_at FROM vip_access`).all();
  const now = Date.now();
  for (const r of rows){
    if (r.expires_at<=now){
      const userId = Number(r.telegram_user_id);
      try{ await kickFromChannel(userId); } catch(e){ console.error("kick error:", userId, e?.message||e); }
    }
  }
}
async function revokeExpiredDriveAccessJob(){
  const rows = db.prepare(`SELECT * FROM drive_access WHERE expires_at <= ?`).all(Date.now());
  for (const r of rows){
    try{ await revokePermission({ driveFileId: r.drive_file_id, permissionId: r.permission_id }); } catch(e){ console.error("revoke error:", r.id, e?.message||e); }
    db.prepare(`DELETE FROM drive_access WHERE id=?`).run(r.id);
  }
  db.prepare(`DELETE FROM content_links WHERE expires_at <= ?`).run(Date.now());
}
setInterval(()=>removeExpiredUsersJob().catch(console.error), 30*60*1000);
setInterval(()=>revokeExpiredDriveAccessJob().catch(console.error), 60*60*1000);

async function main(){
  const port = Number(process.env.PORT || 3000);
  app.listen(port, ()=>console.log(`HTTP on :${port}`));
  await bot.launch();
  console.log("Bot Telegram ON.");
}
main();

process.once("SIGINT", ()=>bot.stop("SIGINT"));
process.once("SIGTERM", ()=>bot.stop("SIGTERM"));
