
require("dotenv").config();
const express=require("express");
const {Telegraf}=require("telegraf");
const basicAuth=require("basic-auth");
const path=require("path");
const {nanoid}=require("nanoid");
const db=require("./db");
const {getLivePixToken,createPayment}=require("./livepix");
const {grantFileToEmail,revokePermission,listFolderFiles,driveDirectUrl,downloadDriveFileBuffer,getDriveFileMeta}=require("./drive");
const {mainMenu,vipPlansMenu,avulsoKeyboard,supportMenu}=require("./menus");
const { AsyncQueue } = require("./queue");
const fs = require("fs");
const os = require("os");

const app=express();
app.use(express.json({limit:"10mb"}));

function requireAdmin(req,res,next){const u=basicAuth(req);if(!(u&&u.name===process.env.ADMIN_USER&&u.pass===process.env.ADMIN_PASS)){res.set("WWW-Authenticate",'Basic realm="Admin Panel"');return res.status(401).send("Auth required");}next();}
const bot=new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const VIP_CHAT_ID=Number(process.env.VIP_CHAT_ID||"-1002216871314");
const SUPPORT_WA=(process.env.SUPPORT_WA||"5522988046948").replace(/[^0-9]/g,"");
const INSTAGRAM_URL=process.env.INSTAGRAM_URL||"https://www.instagram.com/the.annaofc/";
const FREE_GROUP_URL=process.env.FREE_GROUP_URL||"https://t.me/+dlUFej0xfmZhZWE5";
const INVITE_TTL_MINUTES=15;
const hooks=["👀 Vi que você olhou alguns conteúdos...","🔥 Esse preview está chamando muita atenção hoje.","💎 Conteúdo exclusivo liberado agora.","⚡ Você ficou muito perto de liberar esse acesso."];
const social=["🔥 alguém acabou de liberar esse conteúdo","⚡ esse preview está chamando atenção agora","💎 um dos conteúdos mais pedidos hoje","👀 muita curiosidade nesse conteúdo hoje","🔥 esse vídeo acabou de receber novos acessos"];

const rand=a=>a[Math.floor(Math.random()*a.length)];
const SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_SEND_TIMEOUT_MS || 20000);
const JOB_SEND_DELAY_MS = Number(process.env.JOB_SEND_DELAY_MS || 700);
const PREVIEW_CACHE_DIR = path.join(os.tmpdir(), "tg-preview-cache");
const previewSendQueue = new AsyncQueue({ delayMs: 0 });
const jobSendQueue = new AsyncQueue({ delayMs: JOB_SEND_DELAY_MS });
const memo = new Map();
try { fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true }); } catch {}
function withTimeout(promise, ms = SEND_TIMEOUT_MS, label = "operation") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function cached(key, ttlMs, factory) {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = factory();
  memo.set(key, { value, expiresAt: now + ttlMs });
  return value;
}
function invalidatePrefix(prefix) {
  for (const key of memo.keys()) {
    if (key.startsWith(prefix)) memo.delete(key);
  }
}
function looksLikeTelegramFileId(value) {
  return typeof value === "string" && /^(BA|Cg|DQ|Aw|Ag)[A-Za-z0-9_-]{20,}$/.test(value);
}
function looksLikeHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}
function safeMarkdown(value) {
  return String(value || "").replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, "\\$1");
}
async function sendViaQueue(fn, queue = previewSendQueue, label = "telegram send") {
  return queue.push(() => withTimeout(Promise.resolve().then(fn), SEND_TIMEOUT_MS, label));
}
async function getCachedPreviewPath(fileId, kind = "video") {
  const ext = kind === "gif" ? "gif" : "mp4";
  const filePath = path.join(PREVIEW_CACHE_DIR, `${fileId}.${ext}`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return filePath;
  const buffer = await downloadDriveFileBuffer(fileId);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
async function resolveTelegramMediaSource(identifier, kind = "video") {
  if (!identifier) return null;
  if (looksLikeTelegramFileId(identifier)) return identifier;
  if (looksLikeHttpUrl(identifier)) return identifier;
  const filePath = await getCachedPreviewPath(identifier, kind);
  return { source: filePath, filename: `${identifier}.${kind === "gif" ? "gif" : "mp4"}` };
}

function trackEvent(userId,event,productId=null,meta=null){db.prepare("INSERT INTO user_events (telegram_user_id,event,product_id,meta) VALUES (?,?,?,?)").run(String(userId),String(event),productId?Number(productId):null,meta?JSON.stringify(meta):null);}
function touchUser(userId){const uid=String(userId),now=Date.now();const row=db.prepare("SELECT * FROM users WHERE telegram_user_id=?").get(uid);if(!row){db.prepare("INSERT INTO users (telegram_user_id,first_seen_at,last_seen_at,marketing_opt_out,last_marketing_at,score) VALUES (?,?,?,?,?,?)").run(uid,now,now,0,null,0);trackEvent(uid,"start");return true;}db.prepare("UPDATE users SET last_seen_at=? WHERE telegram_user_id=?").run(now,uid);return false;}
function addScore(userId,points){db.prepare("UPDATE users SET score=COALESCE(score,0)+? WHERE telegram_user_id=?").run(Number(points),String(userId));}
const getPlans=()=>cached("plans", 15000, ()=>db.prepare("SELECT * FROM config_plans ORDER BY days ASC").all());
const getPlan=code=>db.prepare("SELECT * FROM config_plans WHERE code=?").get(code);
const getVip=userId=>db.prepare("SELECT * FROM vip_access WHERE telegram_user_id=?").get(String(userId));
const isVipActive=userId=>{const r=getVip(userId);return r&&r.expires_at>Date.now();};
function setVipExpiry(userId,expiresAtMs){db.prepare("INSERT INTO vip_access (telegram_user_id,expires_at,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET expires_at=excluded.expires_at,updated_at=datetime('now')").run(String(userId),expiresAtMs); invalidatePrefix("stats:");}
const getUserEmail=userId=>db.prepare("SELECT email FROM user_emails WHERE telegram_user_id=?").get(String(userId))?.email||null;
function setUserEmail(userId,email){db.prepare("INSERT INTO user_emails (telegram_user_id,email,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET email=excluded.email,updated_at=datetime('now')").run(String(userId),email);}
const getOrderByReference=reference=>db.prepare("SELECT * FROM orders WHERE reference=?").get(reference);
function markOrderPaid(reference,paymentId){db.prepare("UPDATE orders SET status='paid', payment_id=? WHERE reference=?").run(paymentId||null,reference); invalidatePrefix("stats:"); invalidatePrefix("metrics:");}
const getAvulsoIndex=userId=>db.prepare("SELECT avulso_index FROM ui_state WHERE telegram_user_id=?").get(String(userId))?.avulso_index??0;
function setAvulsoIndex(userId,idx){db.prepare("INSERT INTO ui_state (telegram_user_id,avulso_index) VALUES (?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET avulso_index=excluded.avulso_index").run(String(userId),Number(idx));}
const getProducts=()=>cached("products:active", 10000, ()=>db.prepare("SELECT * FROM products WHERE is_active=1 ORDER BY sort_order DESC, id DESC").all());
const getProductById=id=>db.prepare("SELECT * FROM products WHERE id=?").get(Number(id));
const getTopProducts=(limit=5)=>cached(`top:${limit}`, 30000, ()=>db.prepare("SELECT p.*, COUNT(o.id) AS paid_count FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.kind='product' AND o.status='paid' WHERE p.is_active=1 GROUP BY p.id ORDER BY paid_count DESC, p.sort_order DESC, p.id DESC LIMIT ?").all(limit));
function getRecentMetrics(hours=24){
  return cached(`metrics:${hours}`, 30000, ()=>({
    paid: db.prepare("SELECT product_id, COUNT(*) AS c FROM orders WHERE kind='product' AND status='paid' AND datetime(created_at)>=datetime('now',?) GROUP BY product_id").all(`-${hours} hours`),
    views: db.prepare("SELECT product_id, COUNT(*) AS c FROM user_events WHERE event='view_preview' AND datetime(created_at)>=datetime('now',?) GROUP BY product_id").all(`-${hours} hours`)
  }));
}
function getUserBehavior(userId){const rows=db.prepare("SELECT event,product_id FROM user_events WHERE telegram_user_id=? ORDER BY id DESC LIMIT 25").all(String(userId));const previews=rows.filter(r=>r.event==='view_preview').length;const buys=rows.filter(r=>r.event==='buy_click').length;const lastViewed=rows.find(r=>r.event==='view_preview')?.product_id||null;let segment='cold';if(previews>=3||buys>=1)segment='hot';else if(previews>=1)segment='warm';return {previews,buys,lastViewed,segment};}
function behaviorHook(b){if(b.segment==='hot') return '👀 Você voltou nesse preview e ficou muito perto de liberar.'; if(b.segment==='warm') return '🔥 Você já demonstrou interesse em alguns conteúdos.'; return rand(hooks);}
function randomSocialProof(product, metrics=getRecentMetrics(24)){const salesMap=new Map(metrics.paid.map(r=>[Number(r.product_id), Number(r.c)]));const viewsMap=new Map(metrics.views.map(r=>[Number(r.product_id), Number(r.c)]));const sales=salesMap.get(Number(product.id))||0;const views=viewsMap.get(Number(product.id))||0;if(sales>=1) return `🔥 ${sales} pessoa${sales>1?'s':''} liberou esse hoje`;if(views>=3) return `👀 ${views} visualizações recentes nesse preview`;return rand(social);}
function scarcityLine(product, metrics=getRecentMetrics(24)){const salesMap=new Map(metrics.paid.map(r=>[Number(r.product_id), Number(r.c)]));const sales=salesMap.get(Number(product.id))||0;const topIds=getTopProducts(3).map(p=>Number(p.id));if(sales>=5) return `🔥 ${sales} compras desse conteúdo nas últimas 24h`;if(sales>=2) return '⚡ Esse conteúdo está saindo rápido hoje';if(sales>=1) return '👀 Compra recente detectada';if(topIds.includes(Number(product.id))) return '💎 Entre os mais vendidos do momento';return '✨ Conteúdo exclusivo disponível agora';}

const getMenuMedia=key=>cached(`menu:${String(key)}`, 10000, ()=>db.prepare("SELECT * FROM menu_media WHERE menu_key=?").get(String(key))||null);
const mediaUrl=id=>id?driveDirectUrl(id):null;
const mediaKind=m=>m==='gif'?'gif':'video';
async function replyWithResolvedMedia(ctx, identifier, kind, options = {}) {
  const source = await resolveTelegramMediaSource(identifier, kind);
  if (!source) return false;
  if (kind === 'gif') {
    await sendViaQueue(() => ctx.replyWithAnimation(source, options), previewSendQueue, 'replyWithAnimation');
  } else {
    await sendViaQueue(() => ctx.replyWithVideo(source, options), previewSendQueue, 'replyWithVideo');
  }
  return true;
}
async function sendMenuWithMedia(ctx,key,fallback,markup){
  const row=getMenuMedia(key);const identifier=row?.preview_drive_file_id;const kind=mediaKind(row?.preview_mime);const caption=row?.caption||fallback;
  try{
    if(identifier){
      const sent = await replyWithResolvedMedia(ctx, identifier, kind, {caption,...markup});
      if(sent) return;
    }
  }catch(e){ console.log('menu media error:', e.message); }
  return ctx.reply(caption,markup);
}
async function createSingleUseInviteLink(){const exp=Math.floor((Date.now()+INVITE_TTL_MINUTES*60000)/1000);const link=await bot.telegram.createChatInviteLink(VIP_CHAT_ID,{expire_date:exp,member_limit:1,creates_join_request:false});return link.invite_link;}
async function kickFromChannel(userId){await bot.telegram.banChatMember(VIP_CHAT_ID,userId);await bot.telegram.unbanChatMember(VIP_CHAT_ID,userId);}
function createContentToken({telegramUserId,productId,driveFileId,expiresAtMs}){const token=nanoid(24);db.prepare("INSERT INTO content_links (token,telegram_user_id,product_id,drive_file_id,expires_at,used_count) VALUES (?,?,?,?,?,0)").run(token,String(telegramUserId),Number(productId),driveFileId,expiresAtMs);return token;}
const productPreviewUrl=p=>p?.preview_drive_file_id||null;
const productPreviewKind=p=>mediaKind(p.preview_mime);

function getCtxUserId(ctx) {
  return (
    ctx?.from?.id ||
    ctx?.callbackQuery?.from?.id ||
    ctx?.update?.callback_query?.from?.id ||
    ctx?.message?.from?.id ||
    null
  );
}

async function showProduct(ctx, idx) {
  const items = getProducts();

  if (!items.length) {
    return ctx.updateType === 'callback_query'
      ? ctx.editMessageText('Sem conteúdos cadastrados no momento.')
      : ctx.reply('Sem conteúdos cadastrados no momento.');
  }

  const userId = getCtxUserId(ctx);
  if (!userId) {
    console.log('showProduct: userId não encontrado');
    return ctx.reply('⚠️ Não consegui identificar seu usuário. Tente novamente.');
  }

  const total = items.length;
  const safe = ((idx % total) + total) % total;
  const p = items[safe];

  setAvulsoIndex(userId, safe);
  trackEvent(userId, 'view_preview', p.id);
  addScore(userId, 2);
  invalidatePrefix('metrics:');

  const caption = `${scarcityLine(p)}
${randomSocialProof(p)}

🎬 *${safeMarkdown(p.title)}*

${safeMarkdown(p.description || '')}

💰 R$ ${(p.price_cents / 100).toFixed(2).replace('.', ',')}`;

  const keyboard = avulsoKeyboard({
    idx: safe,
    total,
    productId: p.id,
    freeGroupUrl: FREE_GROUP_URL
  });

  const identifier = productPreviewUrl(p);
  const kind = productPreviewKind(p);

  if (identifier) {
    try {
      const sent = await replyWithResolvedMedia(ctx, identifier, kind, {
        caption,
        parse_mode: 'Markdown',
        ...keyboard
      });
      if (sent) return;
    } catch (e) {
      console.log('preview send error:', e.message);
    }
  }

  if (ctx.updateType === 'callback_query') {
    try {
      return await ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
      console.log('showProduct text fallback error:', e.message);
    }
  }

  return ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
}

async function processPendingGrantsForUser(ctx, email) {
  const userId = getCtxUserId(ctx);
  if (!userId) {
    await ctx.reply('⚠️ Não consegui identificar seu usuário para liberar o conteúdo.');
    return;
  }

  const pendings = db.prepare("SELECT * FROM pending_grants WHERE telegram_user_id=?").all(String(userId));

  for (const pg of pendings) {
    try {
      const { permissionId } = await grantFileToEmail({ driveFileId: pg.drive_file_id, email });

      db.prepare("INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)")
        .run(String(userId), email, pg.drive_file_id, permissionId, pg.expires_at);

      const token = createContentToken({
        telegramUserId: userId,
        productId: pg.product_id,
        driveFileId: pg.drive_file_id,
        expiresAtMs: pg.expires_at
      });

      db.prepare("INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)")
        .run(String(userId), pg.product_id);

      db.prepare("DELETE FROM pending_grants WHERE id=?").run(pg.id);

      trackEvent(userId, 'content_unlocked', pg.product_id);
      addScore(userId, 10);

      await ctx.reply(`🎁 *Acesso liberado!*

🔗 Link individual (1 uso):
${process.env.PUBLIC_URL}/c/${token}

⏳ Validade: 30 dias`, {
        parse_mode: 'Markdown'
      });
    } catch (e) {
      console.error('pending grant error:', e.message);
      await ctx.reply('⚠️ Tive um erro ao liberar seu conteúdo.');
    }
  }
}
async function sendMarketingMessage(userId,product,extraText){const url=productPreviewUrl(product);const kind=productPreviewKind(product);const caption=`${extraText}\n\n${randomSocialProof(product)}\n${scarcityLine(product)}\n\n🎬 *${product.title}*\n💰 R$ ${(product.price_cents/100).toFixed(2).replace('.',',')}`;const reply_markup={inline_keyboard:[[{text:'💳 Comprar agora',callback_data:`BUY_PRODUCT_${product.id}`}],[{text:'🆓 Grupo FREE',url:FREE_GROUP_URL}],[{text:'📸 Instagram',url:INSTAGRAM_URL}],[{text:'🚫 Parar mensagens',callback_data:'MARKETING_STOP'}]]};
if(url){
  const source = await resolveTelegramMediaSource(url, kind);
  if(kind==='gif') return sendViaQueue(()=>bot.telegram.sendAnimation(userId,source,{caption,parse_mode:'Markdown',reply_markup}), jobSendQueue, 'marketing animation');
  return sendViaQueue(()=>bot.telegram.sendVideo(userId,source,{caption,parse_mode:'Markdown',reply_markup}), jobSendQueue, 'marketing video');
}
return sendViaQueue(()=>bot.telegram.sendMessage(userId,caption,{parse_mode:'Markdown',reply_markup}), jobSendQueue, 'marketing text');}

async function marketingJob(){const users=db.prepare("SELECT * FROM users WHERE marketing_opt_out=0").all();const products=getProducts();if(!products.length)return;for(const u of users){if(db.prepare("SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1").get(u.telegram_user_id)) continue;const can=!u.last_marketing_at||(Date.now()-Number(u.last_marketing_at))>24*60*60*1000;if(!can) continue;const behavior=getUserBehavior(u.telegram_user_id);const preferred=behavior.lastViewed?getProductById(behavior.lastViewed):null;const product=preferred||rand(products);try{await sendMarketingMessage(u.telegram_user_id,product,behaviorHook(behavior));db.prepare("UPDATE users SET last_marketing_at=? WHERE telegram_user_id=?").run(Date.now(),u.telegram_user_id);trackEvent(u.telegram_user_id,'remarketing_sent',product.id);}catch(e){console.log('marketing error:',e.message);}}}
async function funnelJob(){const users=db.prepare("SELECT * FROM users WHERE marketing_opt_out=0").all();const products=getProducts();if(!products.length)return;for(const u of users){if(db.prepare("SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1").get(u.telegram_user_id)) continue;const sinceFirst=Date.now()-Number(u.first_seen_at||Date.now());let stepText=null;if(sinceFirst>10*60*1000&&sinceFirst<20*60*1000) stepText='👀 Você viu a capa… agora vale olhar um preview mais de perto.';else if(sinceFirst>60*60*1000&&sinceFirst<80*60*1000) stepText='🔥 Esse é um dos conteúdos que mais chama atenção quando alguém volta.';else if(sinceFirst>24*60*60*1000&&sinceFirst<26*60*60*1000) stepText='⚡ Última chamada para olhar esse destaque com calma.';if(!stepText) continue;const behavior=getUserBehavior(u.telegram_user_id);const preferred=behavior.lastViewed?getProductById(behavior.lastViewed):null;const product=preferred||rand(products);try{await sendMarketingMessage(u.telegram_user_id,product,stepText);trackEvent(u.telegram_user_id,'funnel_step_sent',product.id);}catch(e){console.log('funnel error:',e.message);}}}
async function removeExpiredUsersJob(){const rows=db.prepare("SELECT telegram_user_id,expires_at FROM vip_access").all();for(const r of rows){if(r.expires_at<=Date.now()){try{await kickFromChannel(Number(r.telegram_user_id));}catch(e){console.log('kick error:',e.message);}}}}
async function revokeExpiredDriveAccessJob(){const rows=db.prepare("SELECT * FROM drive_access WHERE expires_at <= ?").all(Date.now());for(const r of rows){try{await revokePermission({driveFileId:r.drive_file_id,permissionId:r.permission_id});}catch(e){console.log('revoke error:',e.message);}db.prepare("DELETE FROM drive_access WHERE id=?").run(r.id);}db.prepare("DELETE FROM content_links WHERE expires_at <= ?").run(Date.now());}

bot.start(async ctx=>{const isNew=touchUser(ctx.from.id);if(isNew&&process.env.COVER_FILE_ID){await ctx.replyWithPhoto(process.env.COVER_FILE_ID,{caption:'🔥 *Bem-vinda ao VIP da Anna*\n\nConteúdos exclusivos, previews e acesso rápido.\n\n👇 Escolha uma opção no menu.',parse_mode:'Markdown'});}await sendMenuWithMedia(ctx,'home','Menu principal',mainMenu(INSTAGRAM_URL,FREE_GROUP_URL));});
bot.command('email', async ctx=>{const parts=(ctx.message.text||'').trim().split(/\s+/);if(parts.length<2) return ctx.reply('📧 Envie assim: /email seuemail@exemplo.com');const email=parts[1].trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ctx.reply('❌ Email inválido.');const userId=getCtxUserId(ctx);if(!userId) return ctx.reply('⚠️ Não consegui identificar seu usuário.');setUserEmail(userId,email);trackEvent(userId,'email_set');await ctx.reply(`✅ Email cadastrado: ${email}`);await processPendingGrantsForUser(ctx,email);});
bot.command('parar', async ctx=>{db.prepare("UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?").run(String(ctx.from.id));await ctx.reply('✅ Não vou mais enviar mensagens automáticas.');});
bot.command('voltar', async ctx=>{db.prepare("UPDATE users SET marketing_opt_out=0 WHERE telegram_user_id=?").run(String(ctx.from.id));await ctx.reply('✅ Reativei as mensagens automáticas.');});
bot.action('MENU_HOME', async ctx=>{await ctx.answerCbQuery();await sendMenuWithMedia(ctx,'home','Menu principal',mainMenu(INSTAGRAM_URL,FREE_GROUP_URL));});
bot.action('MENU_VIP', async ctx=>{await ctx.answerCbQuery();const userId=getCtxUserId(ctx);if(!userId) return ctx.reply('⚠️ Não consegui identificar seu usuário.');trackEvent(userId,'menu_vip');addScore(userId,3);const plans=getPlans();if(isVipActive(userId)){const row=getVip(userId);return ctx.reply(`✅ VIP ativo até: ${new Date(row.expires_at).toLocaleString('pt-BR')}\n\nQuer renovar?`,vipPlansMenu(plans));}await sendMenuWithMedia(ctx,'vip','🔐 Planos VIP',vipPlansMenu(plans));});
bot.action('PROMO_FREE', async ctx=>{await ctx.answerCbQuery();await sendMenuWithMedia(ctx,'free',`🆓 Grupo FREE\n\nEntre aqui: ${FREE_GROUP_URL}`,{reply_markup:{inline_keyboard:[[{text:'🆓 Entrar no grupo FREE',url:FREE_GROUP_URL}],[{text:'⬅️ Voltar',callback_data:'MENU_HOME'}]]}});});
bot.action(/^VIP_BUY_(week|month|months3)$/, async ctx=>{await ctx.answerCbQuery();const userId=getCtxUserId(ctx);if(!userId) return ctx.reply('⚠️ Não consegui identificar seu usuário.');const planCode=ctx.match[1];const plan=getPlan(planCode);if(!plan) return ctx.reply('Plano inválido.');try{const token=await getLivePixToken({clientId:process.env.LIVEPIX_CLIENT_ID,clientSecret:process.env.LIVEPIX_CLIENT_SECRET});const payment=await createPayment({token,amountCents:plan.amount_cents,redirectUrl:'https://example.com/obrigado'});db.prepare("INSERT INTO orders (telegram_user_id,kind,plan_code,amount_cents,reference,status) VALUES (?, 'vip', ?, ?, ?, 'pending')").run(String(userId),planCode,plan.amount_cents,payment.reference);trackEvent(userId,'buy_vip_click');addScore(userId,5);await ctx.reply(`💳 *Pagamento gerado!*\n\nPlano: *${plan.label}*\nValor: R$ ${(plan.amount_cents/100).toFixed(2).replace('.',',')}\n\n👉 Pague por aqui:\n${payment.redirectUrl}`,{parse_mode:'Markdown'});}catch(e){console.error(e);await ctx.reply('❌ Erro ao gerar pagamento.');}});
bot.action('MENU_AVULSO', async (ctx) => {
  await ctx.answerCbQuery();

  const userId = getCtxUserId(ctx);
  if (!userId) {
    return ctx.reply('⚠️ Não consegui identificar seu usuário. Tente novamente.');
  }

  trackEvent(userId, 'menu_avulso');
  addScore(userId, 3);

  await showProduct(ctx, getAvulsoIndex(userId));
});
bot.action(/^AV_NEXT_(\d+)$/, async ctx=>{await ctx.answerCbQuery();await showProduct(ctx,Number(ctx.match[1])+1);});
bot.action(/^AV_PREV_(\d+)$/, async ctx=>{await ctx.answerCbQuery();await showProduct(ctx,Number(ctx.match[1])-1);});
bot.action('AV_NOOP', async ctx=>{await ctx.answerCbQuery();});
bot.action('MENU_TOP', async ctx=>{await ctx.answerCbQuery();const tops=getTopProducts(5);if(!tops.length) return ctx.reply('Ainda não há vendas suficientes para mostrar ranking.');const text=tops.map((p,i)=>`${i+1}. ${p.title}${p.paid_count?` — ${p.paid_count} vendas`:''}`).join('\n');await ctx.reply(`🔥 *Mais vendidos*\n\n${text}`,{parse_mode:'Markdown'});});
bot.action('AV_MY', async ctx=>{await ctx.answerCbQuery();const rows=db.prepare("SELECT p.id,p.title FROM purchases pu JOIN products p ON p.id=pu.product_id WHERE pu.telegram_user_id=? ORDER BY pu.id DESC LIMIT 20").all(String(ctx.from.id));if(!rows.length) return ctx.reply('🧾 Você ainda não comprou conteúdos.');const kb=rows.map(r=>[{text:`🔁 Reenviar: ${r.title}`,callback_data:`REDELIVER_${r.id}`}]);kb.push([{text:'⬅️ Voltar',callback_data:'MENU_HOME'}]);await ctx.reply('🧾 *Minhas compras*\n\nEscolha um item para gerar um novo link:',{parse_mode:'Markdown',reply_markup:{inline_keyboard:kb}});});
bot.action(/^REDELIVER_(\d+)$/, async ctx=>{await ctx.answerCbQuery();const product=getProductById(Number(ctx.match[1]));if(!product) return ctx.reply('❌ Conteúdo não encontrado.');const email=getUserEmail(ctx.from.id);if(!email) return ctx.reply('📧 Primeiro cadastre seu email com /email seuemail@exemplo.com');if(!product.drive_file_id) return ctx.reply('⚠️ Esse item não tem Drive ID cadastrado.');const expires=Date.now()+30*24*60*60*1000;const token=createContentToken({telegramUserId:ctx.from.id,productId:product.id,driveFileId:product.drive_file_id,expiresAtMs:expires});await ctx.reply(`🔗 Novo link (1 uso):\n${process.env.PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`);});
bot.action(/^BUY_PRODUCT_(\d+)$/, async ctx=>{await ctx.answerCbQuery();const userId=getCtxUserId(ctx);if(!userId) return ctx.reply('⚠️ Não consegui identificar seu usuário.');const product=getProductById(Number(ctx.match[1]));if(!product) return ctx.reply('❌ Conteúdo não encontrado.');try{const token=await getLivePixToken({clientId:process.env.LIVEPIX_CLIENT_ID,clientSecret:process.env.LIVEPIX_CLIENT_SECRET});const payment=await createPayment({token,amountCents:product.price_cents,redirectUrl:'https://example.com/obrigado'});db.prepare("INSERT INTO orders (telegram_user_id,kind,product_id,amount_cents,reference,status) VALUES (?, 'product', ?, ?, ?, 'pending')").run(String(userId),product.id,product.price_cents,payment.reference);trackEvent(userId,'buy_click',product.id);addScore(userId,5);await ctx.reply(`💳 *Pagamento gerado!*\n\nConteúdo: *${product.title}*\nValor: R$ ${(product.price_cents/100).toFixed(2).replace('.',',')}\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Após confirmar, eu vou pedir seu email para liberar o acesso.`,{parse_mode:'Markdown'});}catch(e){console.error(e);await ctx.reply('❌ Erro ao gerar pagamento.');}});
bot.action('MENU_SUPORTE', async ctx=>{await ctx.answerCbQuery();await ctx.reply('🆘 *Suporte VIP*\n\nFale comigo no WhatsApp:',{parse_mode:'Markdown',...supportMenu(SUPPORT_WA)});});
bot.action('MARKETING_STOP', async ctx=>{await ctx.answerCbQuery();db.prepare("UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?").run(String(ctx.from.id));await ctx.reply('✅ Tudo certo. Não vou mais enviar mensagens automáticas.');});
bot.on('photo', async ctx=>{const photo=ctx.message.photo[ctx.message.photo.length-1];console.log('COVER_FILE_ID:',photo.file_id);await ctx.reply('✅ File ID capturado no console.');});

app.post('/webhook/livepix', async (req,res)=>{try{if(process.env.WEBHOOK_SECRET&&req.query.secret!==process.env.WEBHOOK_SECRET)return res.status(401).json({ok:false});const payload=req.body;if(payload?.resource?.type!=='payment') return res.json({ok:true});const {id:paymentId,reference}=payload.resource;const order=getOrderByReference(reference);if(!order||order.status==='paid') return res.json({ok:true});markOrderPaid(reference,paymentId);if(order.kind==='vip'){const plan=getPlan(order.plan_code);if(!plan)return res.json({ok:true});setVipExpiry(order.telegram_user_id,Date.now()+Number(plan.days)*24*60*60*1000);trackEvent(order.telegram_user_id,'vip_paid');addScore(order.telegram_user_id,20);const invite=await createSingleUseInviteLink();await bot.telegram.sendMessage(order.telegram_user_id,`✅ Pagamento confirmado!\n\nVIP liberado por *${plan.days} dias*.\n\n⏳ Link (1 uso / expira em ${INVITE_TTL_MINUTES} min):\n${invite}`,{parse_mode:'Markdown'});return res.json({ok:true});}if(order.kind==='product'){const product=getProductById(Number(order.product_id));if(!product||!product.drive_file_id){await bot.telegram.sendMessage(order.telegram_user_id,'⚠️ Pagamento confirmado, mas este item está sem Drive ID cadastrado. Fale no suporte.');return res.json({ok:true});}const email=getUserEmail(order.telegram_user_id);const expires=Date.now()+30*24*60*60*1000;if(!email){db.prepare("INSERT INTO pending_grants (telegram_user_id,order_reference,product_id,drive_file_id,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(order_reference) DO NOTHING").run(String(order.telegram_user_id),reference,Number(product.id),product.drive_file_id,expires);await bot.telegram.sendMessage(order.telegram_user_id,'✅ Pagamento confirmado!\n\n📧 Agora envie seu email do Google para liberar o conteúdo por 30 dias.\n\nExemplo:\n/email seuemail@exemplo.com');return res.json({ok:true});}const perm=await grantFileToEmail({driveFileId:product.drive_file_id,email});db.prepare("INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)").run(String(order.telegram_user_id),email,product.drive_file_id,perm.permissionId,expires);const token=createContentToken({telegramUserId:order.telegram_user_id,productId:product.id,driveFileId:product.drive_file_id,expiresAtMs:expires});db.prepare("INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)").run(String(order.telegram_user_id),product.id);trackEvent(order.telegram_user_id,'product_paid',product.id);addScore(order.telegram_user_id,15);await bot.telegram.sendMessage(order.telegram_user_id,`✅ Pagamento confirmado!\n\n📁 Conteúdo liberado para: *${email}*\n⏳ Validade: *30 dias*\n\n🔗 Link individual (1 uso):\n${process.env.PUBLIC_URL}/c/${token}`,{parse_mode:'Markdown'});return res.json({ok:true});}return res.json({ok:true});}catch(e){console.error('webhook error:',e);return res.status(500).json({ok:false});}});
app.get('/c/:token',(req,res)=>{const row=db.prepare("SELECT * FROM content_links WHERE token=?").get(req.params.token);if(!row)return res.status(404).send('Link inválido.');if(row.used_count>=1)return res.status(410).send('Link já utilizado.');if(row.expires_at<=Date.now())return res.status(410).send('Acesso expirado.');const ok=db.transaction(()=>{const cur=db.prepare("SELECT used_count FROM content_links WHERE token=?").get(req.params.token);if(!cur||cur.used_count>=1)return false;db.prepare("UPDATE content_links SET used_count=1, used_at=? WHERE token=?").run(Date.now(),req.params.token);return true;})();if(!ok)return res.status(410).send('Link já utilizado.');return res.redirect(302,`https://drive.google.com/file/d/${row.drive_file_id}/view`);});

app.get('/admin',requireAdmin,(req,res)=>res.sendFile(path.resolve('admin','index.html')));
app.get('/admin/api/stats',requireAdmin,(req,res)=>{const total=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid'").get().cents;const vip=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='vip'").get().cents;const product=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='product'").get().cents;const users=db.prepare("SELECT COUNT(*) AS c FROM users").get().c;const activeProducts=db.prepare("SELECT COUNT(*) AS c FROM products WHERE is_active=1").get().c;res.json({total,vip,product,users,activeProducts});});
app.get('/admin/api/plans',requireAdmin,(req,res)=>res.json(getPlans()));
app.post('/admin/api/plans',requireAdmin,(req,res)=>{const {plans}=req.body;const stmt=db.prepare("UPDATE config_plans SET label=?, days=?, amount_cents=?, active=? WHERE code=?");db.transaction(()=>{for(const p of plans)stmt.run(String(p.label),Number(p.days),Number(p.amount_cents),Number(p.active ?? 1),String(p.code));})();invalidatePrefix('plans');res.json({ok:true});});
app.get('/admin/api/products',requireAdmin,(req,res)=>res.json(getProducts()));
app.post('/admin/api/products',requireAdmin,(req,res)=>{const {title,tagline='',description='',price_cents,sort_order=0,drive_file_id,preview_drive_file_id,preview_mime}=req.body;if(!title||!price_cents)return res.status(400).send('missing fields');db.prepare("INSERT INTO products (title,tagline,description,price_cents,sort_order,drive_file_id,preview_drive_file_id,preview_mime) VALUES (?,?,?,?,?,?,?,?)").run(String(title),String(tagline),String(description),Number(price_cents),Number(sort_order||0),String(drive_file_id||'')||null,String(preview_drive_file_id||'')||null,String(preview_mime||'video'));invalidatePrefix('products:');invalidatePrefix('top:');res.json({ok:true});});
app.put('/admin/api/products/:id',requireAdmin,(req,res)=>{const {title,tagline='',description='',price_cents,sort_order=0,drive_file_id,preview_drive_file_id,preview_mime='video',is_active=1}=req.body;db.prepare("UPDATE products SET title=?, tagline=?, description=?, price_cents=?, sort_order=?, drive_file_id=?, preview_drive_file_id=?, preview_mime=?, is_active=? WHERE id=?").run(String(title),String(tagline),String(description),Number(price_cents),Number(sort_order||0),String(drive_file_id||'')||null,String(preview_drive_file_id||'')||null,String(preview_mime||'video'),Number(is_active??1),Number(req.params.id));invalidatePrefix('products:');invalidatePrefix('top:');invalidatePrefix('metrics:');res.json({ok:true});});
app.delete('/admin/api/products/:id',requireAdmin,(req,res)=>{db.prepare("UPDATE products SET is_active=0 WHERE id=?").run(Number(req.params.id));invalidatePrefix('products:');invalidatePrefix('top:');res.json({ok:true});});
app.post('/admin/api/menu-media',requireAdmin,(req,res)=>{const {menu_key,caption,preview_drive_file_id,preview_mime}=req.body;const row=db.prepare("SELECT * FROM menu_media WHERE menu_key=?").get(String(menu_key));db.prepare("INSERT INTO menu_media (menu_key,preview_drive_file_id,preview_mime,caption) VALUES (?,?,?,?) ON CONFLICT(menu_key) DO UPDATE SET preview_drive_file_id=COALESCE(excluded.preview_drive_file_id,menu_media.preview_drive_file_id), preview_mime=COALESCE(excluded.preview_mime,menu_media.preview_mime), caption=COALESCE(excluded.caption,menu_media.caption)").run(String(menu_key),String(preview_drive_file_id||'')||null,String(preview_mime||'video'),caption||row?.caption||null);invalidatePrefix('menu:');res.json({ok:true});});
app.post('/admin/api/import-drive-folder',requireAdmin,async (req,res)=>{const folderId=String(req.body.folder_id||'').trim();const desc=String(req.body.description||'').trim()||'Conteúdo exclusivo.';const price=Number(req.body.price_cents||0);if(!folderId)return res.status(400).send('folder_id vazio');const files=await listFolderFiles({folderId});const only=files.filter(f=>!(String(f.mimeType||'').includes('folder')));const exists=db.prepare("SELECT id FROM products WHERE drive_file_id=? LIMIT 1");const ins=db.prepare("INSERT INTO products (title,description,price_cents,drive_file_id,preview_drive_file_id,preview_mime) VALUES (?,?,?,?,?,?)");let created=0;db.transaction(()=>{for(const f of only){if(exists.get(String(f.id)))continue;ins.run(String(f.name||'Conteúdo'),desc,price,String(f.id),null,'video');created++;}})();invalidatePrefix('products:');invalidatePrefix('top:');res.json({ok:true,created});});
app.get('/admin/api/orders',requireAdmin,(req,res)=>res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all()));
app.get('/admin/api/vips',requireAdmin,(req,res)=>res.json(db.prepare("SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200").all()));
app.get('/',(req,res)=>res.send('OK'));
app.post('/telegram', bot.webhookCallback('/telegram'));

setInterval(()=>marketingJob().catch(console.error),6*60*60*1000);
setInterval(()=>funnelJob().catch(console.error),60*60*1000);
setInterval(()=>removeExpiredUsersJob().catch(console.error),30*60*1000);
setInterval(()=>revokeExpiredDriveAccessJob().catch(console.error),60*60*1000);

async function main(){const port=Number(process.env.PORT||3000);app.listen(port,async()=>{console.log(`HTTP on :${port}`);if(process.env.PUBLIC_URL){const webhookUrl=`${process.env.PUBLIC_URL}/telegram`;await bot.telegram.setWebhook(webhookUrl);console.log('✅ Telegram webhook set:',webhookUrl);}console.log('BOT ONLINE');});}
main();
