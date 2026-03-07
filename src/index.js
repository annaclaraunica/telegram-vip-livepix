
require("dotenv").config();
const express = require("express");
const { Telegraf } = require("telegraf");
const basicAuth = require("basic-auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { nanoid } = require("nanoid");
const db = require("./db");
const { getLivePixToken, createPayment } = require("./livepix");
const { grantFileToEmail, revokePermission } = require("./drive");
const { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu } = require("./menus");

const app = express();
app.use(express.json());
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

function requireAdmin(req,res,next){
  const user = basicAuth(req);
  if (!(user && user.name === process.env.ADMIN_USER && user.pass === process.env.ADMIN_PASS)) {
    res.set("WWW-Authenticate",'Basic realm="Admin Panel"');
    return res.status(401).send("Auth required");
  }
  next();
}

const storage = multer.diskStorage({
  destination: (req,file,cb)=>cb(null,"uploads"),
  filename: (req,file,cb)=>cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`)
});
const upload = multer({ storage });

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const VIP_CHAT_ID = Number(process.env.VIP_CHAT_ID || "-1002216871314");
const SUPPORT_WA = (process.env.SUPPORT_WA || "5522988046948").replace(/[^0-9]/g,"");
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || "https://www.instagram.com/the.annaofc/";
const INVITE_TTL_MINUTES = 15;
const remarketingTexts = ["👀 Eu vi que você deu uma olhada nos conteúdos… quer que eu te mostre o que está chamando mais atenção hoje?","🔥 Esse conteúdo está entre os que mais despertam curiosidade.","💎 Conteúdo exclusivo disponível agora.","⚡ Você ficou muito perto de liberar esse acesso."];

function pickText(){ return remarketingTexts[Math.floor(Math.random()*remarketingTexts.length)]; }
function touchUser(uid){ uid=String(uid); const now=Date.now(); const row=db.prepare("SELECT * FROM users WHERE telegram_user_id=?").get(uid); if(!row){db.prepare("INSERT INTO users (telegram_user_id,first_seen_at,last_seen_at,marketing_opt_out,last_marketing_at) VALUES (?,?,?,?,?)").run(uid,now,now,0,null); return true} db.prepare("UPDATE users SET last_seen_at=? WHERE telegram_user_id=?").run(now,uid); return false }

function getPlans(){ return db.prepare("SELECT * FROM config_plans ORDER BY days ASC").all(); }
function getPlan(code){ return db.prepare("SELECT * FROM config_plans WHERE code=?").get(code); }
function getVip(userId){ return db.prepare("SELECT * FROM vip_access WHERE telegram_user_id=?").get(String(userId)); }
function isVipActive(userId){ const r=getVip(userId); return r && r.expires_at > Date.now(); }
function setVipExpiry(userId, expiresAtMs){ db.prepare("INSERT INTO vip_access (telegram_user_id,expires_at,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET expires_at=excluded.expires_at, updated_at=datetime('now')").run(String(userId), expiresAtMs); }
function getUserEmail(userId){ return db.prepare("SELECT email FROM user_emails WHERE telegram_user_id=?").get(String(userId))?.email || null; }
function setUserEmail(userId,email){ db.prepare("INSERT INTO user_emails (telegram_user_id,email,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET email=excluded.email, updated_at=datetime('now')").run(String(userId), email); }
function getOrderByReference(reference){ return db.prepare("SELECT * FROM orders WHERE reference=?").get(reference); }
function markOrderPaid(reference,paymentId){ db.prepare("UPDATE orders SET status='paid', payment_id=? WHERE reference=?").run(paymentId||null, reference); }
function getAvulsoIndex(userId){ return db.prepare("SELECT avulso_index FROM ui_state WHERE telegram_user_id=?").get(String(userId))?.avulso_index ?? 0; }
function setAvulsoIndex(userId, idx){ db.prepare("INSERT INTO ui_state (telegram_user_id,avulso_index) VALUES (?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET avulso_index=excluded.avulso_index").run(String(userId), Number(idx)); }
function getProducts(){ return db.prepare("SELECT * FROM products ORDER BY id DESC").all(); }
function getTopProducts(limit=3){ return db.prepare("SELECT p.*, COUNT(o.id) AS paid_count FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.kind='product' AND o.status='paid' GROUP BY p.id ORDER BY paid_count DESC, p.id DESC LIMIT ?").all(limit); }
function getRecentPaidCount(productId){ return Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE product_id=? AND kind='product' AND status='paid' AND datetime(created_at)>=datetime('now','-24 hours')").get(Number(productId)).c || 0); }
function getPreviewUrl(p){ return p.preview_gif_url ? process.env.PUBLIC_URL + p.preview_gif_url : (p.preview_video_url ? process.env.PUBLIC_URL + p.preview_video_url : null); }
function getPreviewKind(p){ return p.preview_gif_url ? "gif" : (p.preview_video_url ? "video" : "none"); }
function scarcity(p){ const c=getRecentPaidCount(p.id); if(c>=5) return `🔥 ${c} compras desse conteúdo nas últimas 24h`; if(c>=2) return `⚡ Esse conteúdo está saindo rápido hoje`; if(c>=1) return `👀 Compra recente detectada`; if(getTopProducts(3).map(x=>Number(x.id)).includes(Number(p.id))) return "🔥 Entre os mais vendidos do momento"; return "💎 Conteúdo exclusivo disponível agora"; }
async function createSingleUseInviteLink(){ const expire = Math.floor((Date.now() + INVITE_TTL_MINUTES*60000)/1000); const link = await bot.telegram.createChatInviteLink(VIP_CHAT_ID,{expire_date:expire,member_limit:1,creates_join_request:false}); return link.invite_link; }
async function kickFromChannel(userId){ await bot.telegram.banChatMember(VIP_CHAT_ID, userId); await bot.telegram.unbanChatMember(VIP_CHAT_ID, userId); }
function createContentToken({telegramUserId,productId,driveFileId,expiresAtMs}){ const token=nanoid(24); db.prepare("INSERT INTO content_links (token,telegram_user_id,product_id,drive_file_id,expires_at,used_count) VALUES (?,?,?,?,?,0)").run(token,String(telegramUserId),Number(productId),driveFileId,expiresAtMs); return token; }

async function sendCoverIfFirstAccess(ctx){ const isNew = touchUser(ctx.from.id); if(isNew && process.env.COVER_FILE_ID){ await ctx.replyWithPhoto(process.env.COVER_FILE_ID,{caption:"🔥 *Bem-vinda ao VIP da Anna*\n\nConteúdos exclusivos, previews e acesso rápido.\n\n👇 Escolha uma opção no menu.", parse_mode:"Markdown"}); } }
async function showProduct(ctx, idx){
  const items=getProducts(); if(!items.length){ return ctx.updateType==="callback_query" ? ctx.editMessageText("Sem conteúdos cadastrados no momento.") : ctx.reply("Sem conteúdos cadastrados no momento.");}
  const total=items.length; const safe=((idx%total)+total)%total; const p=items[safe]; setAvulsoIndex(ctx.from.id,safe);
  const caption = `${scarcity(p)}\n\n🎬 *${p.title}*\n\n${p.description}\n\n💰 R$ ${(p.price_cents/100).toFixed(2).replace(".",",")}`;
  const keyboard = avulsoKeyboard({idx:safe,total,productId:p.id}); const url=getPreviewUrl(p); const kind=getPreviewKind(p);
  if(url){
    if(ctx.updateType==="callback_query"){ try{ await ctx.editMessageMedia({type:kind==="gif"?"animation":"video",media:url,caption,parse_mode:"Markdown"}, keyboard); return; }catch{} }
    return kind==="gif" ? ctx.replyWithAnimation(url,{caption,parse_mode:"Markdown",...keyboard}) : ctx.replyWithVideo(url,{caption,parse_mode:"Markdown",...keyboard});
  }
  return ctx.updateType==="callback_query" ? ctx.editMessageText(caption,{parse_mode:"Markdown",...keyboard}) : ctx.reply(caption,{parse_mode:"Markdown",...keyboard});
}
async function processPending(ctx,email){
  const rows = db.prepare("SELECT * FROM pending_grants WHERE telegram_user_id=?").all(String(ctx.from.id));
  for(const pg of rows){
    const perm = await grantFileToEmail({driveFileId:pg.drive_file_id,email});
    db.prepare("INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)").run(String(ctx.from.id),email,pg.drive_file_id,perm.permissionId,pg.expires_at);
    const token = createContentToken({telegramUserId:ctx.from.id,productId:pg.product_id,driveFileId:pg.drive_file_id,expiresAtMs:pg.expires_at});
    db.prepare("INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)").run(String(ctx.from.id),pg.product_id);
    db.prepare("DELETE FROM pending_grants WHERE id=?").run(pg.id);
    await ctx.reply(`🎁 *Acesso liberado!*\n\n🔗 Link individual (1 uso):\n${process.env.PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`, {parse_mode:"Markdown"});
  }
}

bot.start(async ctx=>{ await sendCoverIfFirstAccess(ctx); await ctx.reply("Menu principal", mainMenu(INSTAGRAM_URL)); });
bot.command("email", async ctx=>{ const parts=(ctx.message.text||"").trim().split(/\s+/); if(parts.length<2) return ctx.reply("📧 Envie assim: /email seuemail@exemplo.com"); const email=parts[1].trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ctx.reply("❌ Email inválido."); setUserEmail(ctx.from.id,email); await ctx.reply(`✅ Email cadastrado: ${email}`); await processPending(ctx,email); });
bot.command("parar", async ctx=>{ db.prepare("UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?").run(String(ctx.from.id)); await ctx.reply("✅ Não vou mais enviar mensagens automáticas."); });
bot.command("voltar", async ctx=>{ db.prepare("UPDATE users SET marketing_opt_out=0 WHERE telegram_user_id=?").run(String(ctx.from.id)); await ctx.reply("✅ Reativei as mensagens automáticas."); });

bot.action("MENU_HOME", async ctx=>{ await ctx.answerCbQuery(); await ctx.editMessageText("Menu principal", mainMenu(INSTAGRAM_URL)); });
bot.action("MENU_VIP", async ctx=>{ await ctx.answerCbQuery(); const plans=getPlans(); if(isVipActive(ctx.from.id)){ const row=getVip(ctx.from.id); return ctx.editMessageText(`✅ VIP ativo até: ${new Date(row.expires_at).toLocaleString("pt-BR")}\n\nQuer renovar?`, vipPlansMenu(plans)); } await ctx.editMessageText("🕵️ Pagamento 100% anônimo\n\n🔥 Escolha o plano:", vipPlansMenu(plans)); });
bot.action(/^VIP_BUY_(week|month|months3)$/, async ctx=>{ await ctx.answerCbQuery(); const plan=getPlan(ctx.match[1]); const token=await getLivePixToken({clientId:process.env.LIVEPIX_CLIENT_ID,clientSecret:process.env.LIVEPIX_CLIENT_SECRET}); const payment=await createPayment({token,amountCents:plan.amount_cents,redirectUrl:"https://example.com/obrigado"}); db.prepare("INSERT INTO orders (telegram_user_id,kind,plan_code,amount_cents,reference,status) VALUES (?, 'vip', ?, ?, ?, 'pending')").run(String(ctx.from.id), ctx.match[1], plan.amount_cents, payment.reference); await ctx.editMessageText(`💳 *Pagamento gerado!*\n\nPlano: *${plan.label}*\nValor: R$ ${(plan.amount_cents/100).toFixed(2).replace(".",",")}\n\n👉 ${payment.redirectUrl}`, {parse_mode:"Markdown"}); });
bot.action("MENU_AVULSO", async ctx=>{ await ctx.answerCbQuery(); await showProduct(ctx, getAvulsoIndex(ctx.from.id)); });
bot.action(/^AV_NEXT_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); await showProduct(ctx, Number(ctx.match[1])+1); });
bot.action(/^AV_PREV_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); await showProduct(ctx, Number(ctx.match[1])-1); });
bot.action("AV_NOOP", async ctx=>{ await ctx.answerCbQuery(); });
bot.action("MENU_TOP", async ctx=>{ await ctx.answerCbQuery(); const tops=getTopProducts(3); const txt=tops.map((p,i)=>`${i+1}. ${p.title}${p.paid_count?` — ${p.paid_count} vendas`:""}`).join("\n"); await ctx.reply(`🔥 *Mais vendidos*\n\n${txt || "Sem dados ainda."}`, {parse_mode:"Markdown"}); });
bot.action("AV_MY", async ctx=>{ await ctx.answerCbQuery(); const rows=db.prepare("SELECT p.id,p.title FROM purchases pu JOIN products p ON p.id=pu.product_id WHERE pu.telegram_user_id=? ORDER BY pu.id DESC LIMIT 20").all(String(ctx.from.id)); if(!rows.length) return ctx.reply("🧾 Você ainda não comprou conteúdos."); const kb=rows.map(r=>[{text:`🔁 Reenviar: ${r.title}`,callback_data:`REDELIVER_${r.id}`}]); kb.push([{text:"⬅️ Voltar",callback_data:"MENU_HOME"}]); await ctx.reply("🧾 *Minhas compras*\n\nEscolha um item para gerar um novo link:", {parse_mode:"Markdown", reply_markup:{inline_keyboard:kb}}); });
bot.action(/^REDELIVER_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); const product=db.prepare("SELECT * FROM products WHERE id=?").get(Number(ctx.match[1])); if(!product) return ctx.reply("❌ Conteúdo não encontrado."); const email=getUserEmail(ctx.from.id); if(!email) return ctx.reply("📧 Primeiro cadastre seu email com /email seuemail@exemplo.com"); const expires=Date.now()+30*24*60*60*1000; const token=createContentToken({telegramUserId:ctx.from.id,productId:product.id,driveFileId:product.drive_file_id,expiresAtMs:expires}); await ctx.reply(`🔗 Novo link (1 uso):\n${process.env.PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`); });
bot.action(/^BUY_PRODUCT_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); const product=db.prepare("SELECT * FROM products WHERE id=?").get(Number(ctx.match[1])); if(!product) return ctx.reply("❌ Conteúdo não encontrado."); const token=await getLivePixToken({clientId:process.env.LIVEPIX_CLIENT_ID,clientSecret:process.env.LIVEPIX_CLIENT_SECRET}); const payment=await createPayment({token,amountCents:product.price_cents,redirectUrl:"https://example.com/obrigado"}); db.prepare("INSERT INTO orders (telegram_user_id,kind,product_id,amount_cents,reference,status) VALUES (?, 'product', ?, ?, ?, 'pending')").run(String(ctx.from.id), product.id, product.price_cents, payment.reference); await ctx.reply(`💳 *Pagamento gerado!*\n\nConteúdo: *${product.title}*\nValor: R$ ${(product.price_cents/100).toFixed(2).replace(".",",")}\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Após confirmar, vou pedir seu email para liberar o acesso.`, {parse_mode:"Markdown"}); });
bot.action("MENU_SUPORTE", async ctx=>{ await ctx.answerCbQuery(); await ctx.reply("🆘 *Suporte VIP*\n\nFale comigo no WhatsApp:", {parse_mode:"Markdown", ...supportMenu(SUPPORT_WA)}); });
bot.action("MARKETING_STOP", async ctx=>{ await ctx.answerCbQuery(); db.prepare("UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?").run(String(ctx.from.id)); await ctx.reply("✅ Tudo certo. Não vou mais enviar mensagens automáticas."); });
bot.on("photo", async ctx=>{ const photo=ctx.message.photo[ctx.message.photo.length-1]; console.log("COVER_FILE_ID:", photo.file_id); await ctx.reply("✅ File ID capturado no console."); });

async function sendMarketingMessage(userId, product, extraText){
  const url=getPreviewUrl(product); const kind=getPreviewKind(product);
  const caption=`${extraText}\n\n${scarcity(product)}\n\n🎬 *${product.title}*\n💰 R$ ${(product.price_cents/100).toFixed(2).replace(".",",")}`;
  const reply_markup={inline_keyboard:[[{text:"💳 Comprar agora",callback_data:`BUY_PRODUCT_${product.id}`}],[{text:"📸 Instagram",url:INSTAGRAM_URL}],[{text:"🚫 Parar mensagens",callback_data:"MARKETING_STOP"}]]};
  if(url){ if(kind==="gif") return bot.telegram.sendAnimation(userId,url,{caption,parse_mode:"Markdown",reply_markup}); return bot.telegram.sendVideo(userId,url,{caption,parse_mode:"Markdown",reply_markup}); }
  return bot.telegram.sendMessage(userId,caption,{parse_mode:"Markdown",reply_markup});
}
async function marketingJob(){
  const users=db.prepare("SELECT * FROM users WHERE marketing_opt_out=0").all();
  const products=db.prepare("SELECT * FROM products ORDER BY RANDOM() LIMIT 8").all();
  if(!products.length) return;
  for(const u of users){
    if(db.prepare("SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1").get(u.telegram_user_id)) continue;
    const can=!u.last_marketing_at || (Date.now()-Number(u.last_marketing_at))>86400000;
    if(!can) continue;
    try{ await sendMarketingMessage(u.telegram_user_id, products[Math.floor(Math.random()*products.length)], pickText()); db.prepare("UPDATE users SET last_marketing_at=? WHERE telegram_user_id=?").run(Date.now(), u.telegram_user_id); }catch(e){ console.log("marketing error:", e.message); }
  }
}

app.post("/webhook/livepix", async (req,res)=>{
  try{
    if(process.env.WEBHOOK_SECRET && req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ok:false});
    const payload=req.body;
    if(payload?.resource?.type !== "payment") return res.json({ok:true});
    const {id:paymentId, reference} = payload.resource;
    const order=getOrderByReference(reference);
    if(!order || order.status==="paid") return res.json({ok:true});
    markOrderPaid(reference,paymentId);

    if(order.kind==="vip"){
      const plan=getPlan(order.plan_code);
      setVipExpiry(order.telegram_user_id, Date.now()+Number(plan.days)*24*60*60*1000);
      const invite=await createSingleUseInviteLink();
      await bot.telegram.sendMessage(order.telegram_user_id, `✅ Pagamento confirmado!\n\nVIP liberado por *${plan.days} dias*.\n\n⏳ Link (1 uso / expira em ${INVITE_TTL_MINUTES} min):\n${invite}`, {parse_mode:"Markdown"});
      return res.json({ok:true});
    }

    if(order.kind==="product"){
      const product=db.prepare("SELECT * FROM products WHERE id=?").get(Number(order.product_id));
      if(!product || !product.drive_file_id){ await bot.telegram.sendMessage(order.telegram_user_id, "⚠️ Pagamento confirmado, mas este item está sem Drive ID cadastrado. Fale no suporte."); return res.json({ok:true}); }
      const email=getUserEmail(order.telegram_user_id);
      const expires=Date.now()+30*24*60*60*1000;
      if(!email){
        db.prepare("INSERT INTO pending_grants (telegram_user_id,order_reference,product_id,drive_file_id,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(order_reference) DO NOTHING").run(String(order.telegram_user_id), reference, Number(product.id), product.drive_file_id, expires);
        await bot.telegram.sendMessage(order.telegram_user_id, "✅ Pagamento confirmado!\n\n📧 Agora envie seu email do Google para liberar o conteúdo por 30 dias.\n\nExemplo:\n/email seuemail@exemplo.com");
        return res.json({ok:true});
      }
      const perm=await grantFileToEmail({driveFileId:product.drive_file_id,email});
      db.prepare("INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)").run(String(order.telegram_user_id),email,product.drive_file_id,perm.permissionId,expires);
      const token=createContentToken({telegramUserId:order.telegram_user_id,productId:product.id,driveFileId:product.drive_file_id,expiresAtMs:expires});
      db.prepare("INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)").run(String(order.telegram_user_id), product.id);
      await bot.telegram.sendMessage(order.telegram_user_id, `✅ Pagamento confirmado!\n\n📁 Conteúdo liberado para: *${email}*\n⏳ Validade: *30 dias*\n\n🔗 Link individual (1 uso):\n${process.env.PUBLIC_URL}/c/${token}`, {parse_mode:"Markdown"});
      return res.json({ok:true});
    }

    return res.json({ok:true});
  }catch(e){ console.error("webhook error:", e); return res.status(500).json({ok:false}); }
});

app.get("/c/:token", (req,res)=>{
  const row=db.prepare("SELECT * FROM content_links WHERE token=?").get(req.params.token);
  if(!row) return res.status(404).send("Link inválido.");
  if(row.used_count>=1) return res.status(410).send("Link já utilizado.");
  if(row.expires_at<=Date.now()) return res.status(410).send("Acesso expirado.");
  const ok=db.transaction(()=>{ const cur=db.prepare("SELECT used_count FROM content_links WHERE token=?").get(req.params.token); if(!cur || cur.used_count>=1) return false; db.prepare("UPDATE content_links SET used_count=1, used_at=? WHERE token=?").run(Date.now(), req.params.token); return true; })();
  if(!ok) return res.status(410).send("Link já utilizado.");
  return res.redirect(302, `https://drive.google.com/file/d/${row.drive_file_id}/view`);
});

app.get("/admin", requireAdmin, (req,res)=>res.sendFile(path.resolve("admin","index.html")));
app.get("/admin/api/stats", requireAdmin, (req,res)=>{ const total=db.prepare("SELECT COALESCE(SUM(amount_cents),0) cents FROM orders WHERE status='paid'").get().cents; const vip=db.prepare("SELECT COALESCE(SUM(amount_cents),0) cents FROM orders WHERE status='paid' AND kind='vip'").get().cents; const product=db.prepare("SELECT COALESCE(SUM(amount_cents),0) cents FROM orders WHERE status='paid' AND kind='product'").get().cents; res.json({total,vip,product}); });
app.get("/admin/api/plans", requireAdmin, (req,res)=>res.json(getPlans()));
app.post("/admin/api/plans", requireAdmin, (req,res)=>{ const {plans}=req.body; const stmt=db.prepare("UPDATE config_plans SET label=?, days=?, amount_cents=? WHERE code=?"); db.transaction(()=>{ for(const p of plans) stmt.run(String(p.label),Number(p.days),Number(p.amount_cents),String(p.code)); })(); res.json({ok:true}); });
app.get("/admin/api/products", requireAdmin, (req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all()));
app.post("/admin/api/products", requireAdmin, upload.fields([{name:"preview_video",maxCount:1},{name:"preview_gif",maxCount:1}]), (req,res)=>{ const {title,description,price_cents,drive_file_id}=req.body; const pv=req.files?.preview_video?.[0] ? `/uploads/${req.files.preview_video[0].filename}` : null; const pg=req.files?.preview_gif?.[0] ? `/uploads/${req.files.preview_gif[0].filename}` : null; db.prepare("INSERT INTO products (title,description,price_cents,drive_file_id,preview_video_url,preview_gif_url) VALUES (?,?,?,?,?,?)").run(String(title),String(description),Number(price_cents),String(drive_file_id||"")||null,pv,pg); res.json({ok:true}); });
app.delete("/admin/api/products/:id", requireAdmin, (req,res)=>{ const row=db.prepare("SELECT * FROM products WHERE id=?").get(Number(req.params.id)); if(!row) return res.status(404).send("not found"); db.prepare("DELETE FROM products WHERE id=?").run(Number(req.params.id)); res.json({ok:true}); });
app.get("/admin/api/orders", requireAdmin, (req,res)=>res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all()));
app.get("/admin/api/vips", requireAdmin, (req,res)=>res.json(db.prepare("SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200").all()));
app.get("/", (req,res)=>res.send("OK"));

async function removeExpiredUsersJob(){ const rows=db.prepare("SELECT telegram_user_id,expires_at FROM vip_access").all(); for(const r of rows){ if(r.expires_at<=Date.now()){ try{ await kickFromChannel(Number(r.telegram_user_id)); }catch(e){ console.log("kick error:", e.message); } } } }
async function revokeExpiredDriveAccessJob(){ const rows=db.prepare("SELECT * FROM drive_access WHERE expires_at <= ?").all(Date.now()); for(const r of rows){ try{ await revokePermission({driveFileId:r.drive_file_id,permissionId:r.permission_id}); }catch(e){ console.log("revoke error:", e.message); } db.prepare("DELETE FROM drive_access WHERE id=?").run(r.id); } db.prepare("DELETE FROM content_links WHERE expires_at <= ?").run(Date.now()); }

setInterval(()=>marketingJob().catch(console.error), 6*60*60*1000);
setInterval(()=>removeExpiredUsersJob().catch(console.error), 30*60*1000);
setInterval(()=>revokeExpiredDriveAccessJob().catch(console.error), 60*60*1000);

async function main() {
  const port = Number(process.env.PORT || 3000);

  app.use(bot.webhookCallback("/telegram"));

  app.listen(port, async () => {
    console.log(`HTTP on :${port}`);

    if (process.env.PUBLIC_URL) {
      const webhookUrl = `${process.env.PUBLIC_URL}/telegram`;
      await bot.telegram.setWebhook(webhookUrl);
      console.log("✅ Telegram webhook set:", webhookUrl);
    }

    console.log("BOT ONLINE");
  });
}

main();
