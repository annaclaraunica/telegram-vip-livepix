
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

const storage = multer.diskStorage({
  destination: (req,file,cb)=>cb(null,"uploads"),
  filename: (req,file,cb)=>cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function requireAdmin(req,res,next){
  const user = basicAuth(req);
  const ok = user && user.name === process.env.ADMIN_USER && user.pass === process.env.ADMIN_PASS;
  if(!ok){ res.set("WWW-Authenticate",'Basic realm="Admin Panel"'); return res.status(401).send("Auth required"); }
  next();
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const VIP_CHAT_ID = Number(process.env.VIP_CHAT_ID || "-1002216871314");
const SUPPORT_WA = (process.env.SUPPORT_WA || "5522988046948").replace(/[^0-9]/g,"");
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || "https://www.instagram.com/the.annaofc/";
const FREE_GROUP_URL = process.env.FREE_GROUP_URL || "https://t.me/+dlUFej0xfmZhZWE5";
const INVITE_TTL_MINUTES = 15;
const remarketingHooks = ["👀 Vi que você olhou alguns conteúdos...","🔥 Esse preview está chamando muita atenção hoje.","💎 Conteúdo exclusivo liberado agora.","⚡ Você ficou muito perto de liberar esse acesso.","👀 Quer ver o que está mais forte hoje?"];
const socialProofs = ["🔥 alguém acabou de liberar esse conteúdo","⚡ esse preview está chamando atenção agora","💎 um dos conteúdos mais pedidos hoje","👀 muita curiosidade nesse conteúdo hoje","🔥 esse vídeo acabou de receber novos acessos","⚡ várias pessoas estão olhando esse preview","💎 esse está entre os mais vistos do momento"];
const randomItem = arr => arr[Math.floor(Math.random()*arr.length)];

function trackEvent(userId,event,productId=null,meta=null){
  db.prepare("INSERT INTO user_events (telegram_user_id,event,product_id,meta) VALUES (?,?,?,?)")
    .run(String(userId), String(event), productId ? Number(productId) : null, meta ? JSON.stringify(meta) : null);
}
function touchUser(userId){
  const uid=String(userId); const now=Date.now();
  const row=db.prepare("SELECT * FROM users WHERE telegram_user_id=?").get(uid);
  if(!row){
    db.prepare("INSERT INTO users (telegram_user_id,first_seen_at,last_seen_at,marketing_opt_out,last_marketing_at,score) VALUES (?,?,?,?,?,?)")
      .run(uid, now, now, 0, null, 0);
    trackEvent(uid,"start");
    return true;
  }
  db.prepare("UPDATE users SET last_seen_at=? WHERE telegram_user_id=?").run(now,uid);
  return false;
}
function addScore(userId, points){
  db.prepare("UPDATE users SET score = COALESCE(score,0) + ? WHERE telegram_user_id=?").run(Number(points), String(userId));
}
const getPlans = ()=>db.prepare("SELECT * FROM config_plans ORDER BY days ASC").all();
const getPlan = code=>db.prepare("SELECT * FROM config_plans WHERE code=?").get(code);
const getVip = userId=>db.prepare("SELECT * FROM vip_access WHERE telegram_user_id=?").get(String(userId));
const isVipActive = userId=>{const r=getVip(userId); return r && r.expires_at > Date.now();};
function setVipExpiry(userId, expiresAtMs){
  db.prepare("INSERT INTO vip_access (telegram_user_id,expires_at,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET expires_at=excluded.expires_at, updated_at=datetime('now')")
    .run(String(userId), expiresAtMs);
}
const getUserEmail = userId=>db.prepare("SELECT email FROM user_emails WHERE telegram_user_id=?").get(String(userId))?.email || null;
function setUserEmail(userId,email){
  db.prepare("INSERT INTO user_emails (telegram_user_id,email,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(telegram_user_id) DO UPDATE SET email=excluded.email, updated_at=datetime('now')")
    .run(String(userId), email);
}
const getOrderByReference = reference=>db.prepare("SELECT * FROM orders WHERE reference=?").get(reference);
function markOrderPaid(reference,paymentId){ db.prepare("UPDATE orders SET status='paid', payment_id=? WHERE reference=?").run(paymentId || null, reference); }
const getAvulsoIndex = userId=>db.prepare("SELECT avulso_index FROM ui_state WHERE telegram_user_id=?").get(String(userId))?.avulso_index ?? 0;
function setAvulsoIndex(userId,idx){
  db.prepare("INSERT INTO ui_state (telegram_user_id,avulso_index) VALUES (?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET avulso_index=excluded.avulso_index").run(String(userId), Number(idx));
}
const getProducts = ()=>db.prepare("SELECT * FROM products WHERE is_active=1 ORDER BY id DESC").all();
const getProductById = id=>db.prepare("SELECT * FROM products WHERE id=?").get(Number(id));
const getTopProducts = (limit=5)=>db.prepare("SELECT p.*, COUNT(o.id) AS paid_count FROM products p LEFT JOIN orders o ON o.product_id=p.id AND o.kind='product' AND o.status='paid' WHERE p.is_active=1 GROUP BY p.id ORDER BY paid_count DESC, p.id DESC LIMIT ?").all(limit);
const getRecentPaidCount = (productId,hours=24)=>Number(db.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_id=? AND kind='product' AND status='paid' AND datetime(created_at)>=datetime('now',?)").get(Number(productId), `-${hours} hours`).c || 0);
const getRecentViewsCount = (productId,hours=24)=>Number(db.prepare("SELECT COUNT(*) AS c FROM user_events WHERE event='view_preview' AND product_id=? AND datetime(created_at)>=datetime('now',?)").get(Number(productId), `-${hours} hours`).c || 0);
function getUserBehavior(userId){
  const rows=db.prepare("SELECT event, product_id, created_at FROM user_events WHERE telegram_user_id=? ORDER BY id DESC LIMIT 25").all(String(userId));
  const previews=rows.filter(r=>r.event==='view_preview').length;
  const buys=rows.filter(r=>r.event==='buy_click').length;
  const returns=rows.filter(r=>r.event==='start').length;
  const lastViewed=rows.find(r=>r.event==='view_preview')?.product_id || null;
  let segment='cold'; if(previews>=3 || buys>=1) segment='hot'; else if(previews>=1 || returns>=2) segment='warm';
  return { previews, buys, returns, lastViewed, segment };
}
function behaviorHook(behavior){
  if(behavior.segment==='hot') return '👀 Você voltou nesse preview e ficou muito perto de liberar.';
  if(behavior.segment==='warm') return '🔥 Você já demonstrou interesse em alguns conteúdos.';
  return randomItem(remarketingHooks);
}
function randomSocialProof(product){
  const sales=getRecentPaidCount(product.id,24); const views=getRecentViewsCount(product.id,24);
  if(sales>=1) return `🔥 ${sales} pessoa${sales>1?'s':''} liberou esse hoje`;
  if(views>=3) return `👀 ${views} visualizações recentes nesse preview`;
  return randomItem(socialProofs);
}
function scarcityLine(product){
  const sales=getRecentPaidCount(product.id,24); const topIds=getTopProducts(3).map(p=>Number(p.id));
  if(sales>=5) return `🔥 ${sales} compras desse conteúdo nas últimas 24h`;
  if(sales>=2) return `⚡ Esse conteúdo está saindo rápido hoje`;
  if(sales>=1) return '👀 Compra recente detectada';
  if(topIds.includes(Number(product.id))) return '💎 Entre os mais vendidos do momento';
  return '✨ Conteúdo exclusivo disponível agora';
}
const getMenuMedia = key=>db.prepare("SELECT * FROM menu_media WHERE menu_key=?").get(String(key)) || null;
function getMediaUrl(row){ if(!row) return null; if(row.preview_gif_url) return process.env.PUBLIC_URL + row.preview_gif_url; if(row.preview_video_url) return process.env.PUBLIC_URL + row.preview_video_url; return null; }
function getMediaKind(row){ if(!row) return 'none'; if(row.preview_gif_url) return 'gif'; if(row.preview_video_url) return 'video'; return 'none'; }
function getProductPreviewUrl(product){ if(product.preview_gif_url) return process.env.PUBLIC_URL + product.preview_gif_url; if(product.preview_video_url) return process.env.PUBLIC_URL + product.preview_video_url; return null; }
function getProductPreviewKind(product){ if(product.preview_gif_url) return 'gif'; if(product.preview_video_url) return 'video'; return 'none'; }

async function sendMenuWithVideo(ctx, menuKey, fallbackText, menuMarkup){
  const media=getMenuMedia(menuKey); const url=getMediaUrl(media); const kind=getMediaKind(media); const caption=media?.caption || fallbackText;
  if(url){ if(kind==='gif') return ctx.replyWithAnimation(url,{caption,...menuMarkup}); return ctx.replyWithVideo(url,{caption,...menuMarkup}); }
  return ctx.reply(caption, menuMarkup);
}
async function createSingleUseInviteLink(){
  const expireDateSeconds=Math.floor((Date.now()+INVITE_TTL_MINUTES*60000)/1000);
  const link=await bot.telegram.createChatInviteLink(VIP_CHAT_ID,{expire_date:expireDateSeconds,member_limit:1,creates_join_request:false});
  return link.invite_link;
}
async function kickFromChannel(userId){ await bot.telegram.banChatMember(VIP_CHAT_ID,userId); await bot.telegram.unbanChatMember(VIP_CHAT_ID,userId); }
function createContentToken({telegramUserId,productId,driveFileId,expiresAtMs}){ const token=nanoid(24); db.prepare("INSERT INTO content_links (token,telegram_user_id,product_id,drive_file_id,expires_at,used_count) VALUES (?,?,?,?,?,0)").run(token,String(telegramUserId),Number(productId),driveFileId,expiresAtMs); return token; }

async function showProduct(ctx, idx){
  const items=getProducts();
  if(!items.length) return ctx.updateType==='callback_query' ? ctx.editMessageText('Sem conteúdos cadastrados no momento.') : ctx.reply('Sem conteúdos cadastrados no momento.');
  const total=items.length; const safe=((idx%total)+total)%total; const p=items[safe];
  setAvulsoIndex(ctx.from.id,safe); trackEvent(ctx.from.id,'view_preview',p.id); addScore(ctx.from.id,2);
  const caption=`${scarcityLine(p)}\n${randomSocialProof(p)}\n\n🎬 *${p.title}*\n\n${p.description}\n\n💰 R$ ${(p.price_cents/100).toFixed(2).replace('.',',')}`;
  const keyboard=avulsoKeyboard({idx:safe,total,productId:p.id,freeGroupUrl:FREE_GROUP_URL});
  const previewUrl=getProductPreviewUrl(p); const previewKind=getProductPreviewKind(p);
  if(previewUrl){
    if(ctx.updateType==='callback_query'){ try{ await ctx.editMessageMedia({type:previewKind==='gif'?'animation':'video',media:previewUrl,caption,parse_mode:'Markdown'}, keyboard); return; }catch{} }
    return previewKind==='gif' ? ctx.replyWithAnimation(previewUrl,{caption,parse_mode:'Markdown',...keyboard}) : ctx.replyWithVideo(previewUrl,{caption,parse_mode:'Markdown',...keyboard});
  }
  return ctx.updateType==='callback_query' ? ctx.editMessageText(caption,{parse_mode:'Markdown',...keyboard}) : ctx.reply(caption,{parse_mode:'Markdown',...keyboard});
}
async function processPendingGrantsForUser(ctx,email){
  const pendings=db.prepare('SELECT * FROM pending_grants WHERE telegram_user_id=?').all(String(ctx.from.id));
  for(const pg of pendings){
    try{
      const {permissionId}=await grantFileToEmail({driveFileId:pg.drive_file_id,email});
      db.prepare('INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)').run(String(ctx.from.id),email,pg.drive_file_id,permissionId,pg.expires_at);
      const token=createContentToken({telegramUserId:ctx.from.id,productId:pg.product_id,driveFileId:pg.drive_file_id,expiresAtMs:pg.expires_at});
      db.prepare('INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)').run(String(ctx.from.id),pg.product_id);
      db.prepare('DELETE FROM pending_grants WHERE id=?').run(pg.id);
      trackEvent(ctx.from.id,'content_unlocked',pg.product_id); addScore(ctx.from.id,10);
      await ctx.reply(`🎁 *Acesso liberado!*\n\n🔗 Link individual (1 uso):\n${process.env.PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`, {parse_mode:'Markdown'});
      const plans=getPlans(); const best=plans[plans.length-1] || plans[0];
      await ctx.reply('💎 *Gostou?*\n\nQuer acesso ao *VIP completo* com muito mais conteúdo?', {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:`🔐 Ver VIP (${best.label})`,callback_data:'MENU_VIP'}]]}});
    }catch(e){ console.error('pending grant error:', e.message); await ctx.reply('⚠️ Tive um erro ao liberar seu conteúdo. Fale no suporte.'); }
  }
}
async function sendMarketingMessage(userId, product, extraText){
  const previewUrl=getProductPreviewUrl(product); const previewKind=getProductPreviewKind(product);
  const caption=`${extraText}\n\n${randomSocialProof(product)}\n${scarcityLine(product)}\n\n🎬 *${product.title}*\n💰 R$ ${(product.price_cents/100).toFixed(2).replace('.',',')}`;
  const reply_markup={inline_keyboard:[[{text:'💳 Comprar agora',callback_data:`BUY_PRODUCT_${product.id}`}],[{text:'🆓 Grupo FREE',url:FREE_GROUP_URL}],[{text:'📸 Instagram',url:INSTAGRAM_URL}],[{text:'🚫 Parar mensagens',callback_data:'MARKETING_STOP'}]]};
  if(previewUrl){ if(previewKind==='gif') return bot.telegram.sendAnimation(userId,previewUrl,{caption,parse_mode:'Markdown',reply_markup}); return bot.telegram.sendVideo(userId,previewUrl,{caption,parse_mode:'Markdown',reply_markup}); }
  return bot.telegram.sendMessage(userId,caption,{parse_mode:'Markdown',reply_markup});
}
async function marketingJob(){
  const users=db.prepare('SELECT * FROM users WHERE marketing_opt_out=0').all(); const products=getProducts(); if(!products.length) return;
  for(const u of users){
    const alreadyBought=db.prepare('SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1').get(u.telegram_user_id);
    if(alreadyBought) continue;
    const canSend=!u.last_marketing_at || (Date.now()-Number(u.last_marketing_at)) > 24*60*60*1000;
    if(!canSend) continue;
    const behavior=getUserBehavior(u.telegram_user_id); const preferred=behavior.lastViewed ? getProductById(behavior.lastViewed) : null; const product=preferred || randomItem(products); const hook=behaviorHook(behavior);
    try{ await sendMarketingMessage(u.telegram_user_id,product,hook); db.prepare('UPDATE users SET last_marketing_at=? WHERE telegram_user_id=?').run(Date.now(),u.telegram_user_id); trackEvent(u.telegram_user_id,'remarketing_sent',product.id); }catch(e){ console.log('marketing error:', e.message); }
  }
}
async function funnelJob(){
  const users=db.prepare('SELECT * FROM users WHERE marketing_opt_out=0').all(); const products=getProducts(); if(!products.length) return;
  for(const u of users){
    const bought=db.prepare('SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1').get(u.telegram_user_id);
    if(bought) continue;
    const sinceFirst=Date.now()-Number(u.first_seen_at || Date.now()); let stepText=null;
    if(sinceFirst > 10*60*1000 && sinceFirst < 20*60*1000) stepText='👀 Você viu a capa… agora vale olhar um preview mais de perto.';
    else if(sinceFirst > 60*60*1000 && sinceFirst < 80*60*1000) stepText='🔥 Esse é um dos conteúdos que mais chama atenção quando alguém volta.';
    else if(sinceFirst > 24*60*60*1000 && sinceFirst < 26*60*60*1000) stepText='⚡ Última chamada para olhar esse destaque com calma.';
    if(!stepText) continue;
    const behavior=getUserBehavior(u.telegram_user_id); const preferred=behavior.lastViewed ? getProductById(behavior.lastViewed) : null; const product=preferred || randomItem(products);
    try{ await sendMarketingMessage(u.telegram_user_id, product, stepText); trackEvent(u.telegram_user_id,'funnel_step_sent',product.id); }catch(e){ console.log('funnel error:', e.message); }
  }
}
async function removeExpiredUsersJob(){ const rows=db.prepare('SELECT telegram_user_id,expires_at FROM vip_access').all(); for(const r of rows){ if(r.expires_at <= Date.now()){ try{ await kickFromChannel(Number(r.telegram_user_id)); }catch(e){ console.log('kick error:', e.message); } } } }
async function revokeExpiredDriveAccessJob(){ const rows=db.prepare('SELECT * FROM drive_access WHERE expires_at <= ?').all(Date.now()); for(const r of rows){ try{ await revokePermission({driveFileId:r.drive_file_id,permissionId:r.permission_id}); }catch(e){ console.log('revoke error:', e.message); } db.prepare('DELETE FROM drive_access WHERE id=?').run(r.id); } db.prepare('DELETE FROM content_links WHERE expires_at <= ?').run(Date.now()); }

bot.start(async ctx=>{ const isNew=touchUser(ctx.from.id); if(isNew && process.env.COVER_FILE_ID){ await ctx.replyWithPhoto(process.env.COVER_FILE_ID,{caption:'🔥 *Bem-vinda ao VIP da Anna*\n\nConteúdos exclusivos, previews e acesso rápido.\n\n👇 Escolha uma opção no menu.', parse_mode:'Markdown'}); } await sendMenuWithVideo(ctx,'home','Menu principal', mainMenu(INSTAGRAM_URL, FREE_GROUP_URL)); });
bot.command('email', async ctx=>{ const parts=(ctx.message.text||'').trim().split(/\s+/); if(parts.length<2) return ctx.reply('📧 Envie assim: /email seuemail@exemplo.com'); const email=parts[1].trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ctx.reply('❌ Email inválido.'); setUserEmail(ctx.from.id,email); trackEvent(ctx.from.id,'email_set'); await ctx.reply(`✅ Email cadastrado: ${email}`); await processPendingGrantsForUser(ctx,email); });
bot.command('parar', async ctx=>{ db.prepare('UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?').run(String(ctx.from.id)); await ctx.reply('✅ Não vou mais enviar mensagens automáticas.'); });
bot.command('voltar', async ctx=>{ db.prepare('UPDATE users SET marketing_opt_out=0 WHERE telegram_user_id=?').run(String(ctx.from.id)); await ctx.reply('✅ Reativei as mensagens automáticas.'); });

bot.action('MENU_HOME', async ctx=>{ await ctx.answerCbQuery(); await sendMenuWithVideo(ctx,'home','Menu principal', mainMenu(INSTAGRAM_URL, FREE_GROUP_URL)); });
bot.action('MENU_VIP', async ctx=>{ await ctx.answerCbQuery(); trackEvent(ctx.from.id,'menu_vip'); addScore(ctx.from.id,3); const plans=getPlans(); if(isVipActive(ctx.from.id)){ const row=getVip(ctx.from.id); return ctx.reply(`✅ VIP ativo até: ${new Date(row.expires_at).toLocaleString('pt-BR')}\n\nQuer renovar?`, vipPlansMenu(plans)); } await sendMenuWithVideo(ctx,'vip','🔐 Planos VIP', vipPlansMenu(plans)); });
bot.action('PROMO_FREE', async ctx=>{ await ctx.answerCbQuery(); await sendMenuWithVideo(ctx,'free',`🆓 Grupo FREE\n\nEntre aqui: ${FREE_GROUP_URL}`, {reply_markup:{inline_keyboard:[[{text:'🆓 Entrar no grupo FREE',url:FREE_GROUP_URL}],[{text:'⬅️ Voltar',callback_data:'MENU_HOME'}]]}}); });
bot.action(/^VIP_BUY_(week|month|months3)$/, async ctx=>{ await ctx.answerCbQuery(); const planCode=ctx.match[1]; const plan=getPlan(planCode); if(!plan) return ctx.reply('Plano inválido.'); try{ const token=await getLivePixToken({clientId:process.env.LIVEPIX_CLIENT_ID, clientSecret:process.env.LIVEPIX_CLIENT_SECRET}); const payment=await createPayment({token,amountCents:plan.amount_cents,redirectUrl:'https://example.com/obrigado'}); db.prepare("INSERT INTO orders (telegram_user_id,kind,plan_code,amount_cents,reference,status) VALUES (?, 'vip', ?, ?, ?, 'pending')").run(String(ctx.from.id), planCode, plan.amount_cents, payment.reference); trackEvent(ctx.from.id,'buy_vip_click'); addScore(ctx.from.id,5); await ctx.reply(`💳 *Pagamento gerado!*\n\nPlano: *${plan.label}*\nValor: R$ ${(plan.amount_cents/100).toFixed(2).replace('.',',')}\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Assim que confirmar, eu libero automaticamente.`, {parse_mode:'Markdown'}); }catch(e){ console.error(e); await ctx.reply('❌ Erro ao gerar pagamento.'); } });
bot.action('MENU_AVULSO', async ctx=>{ await ctx.answerCbQuery(); trackEvent(ctx.from.id,'menu_avulso'); addScore(ctx.from.id,3); await showProduct(ctx, getAvulsoIndex(ctx.from.id)); });
bot.action(/^AV_NEXT_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); await showProduct(ctx, Number(ctx.match[1])+1); });
bot.action(/^AV_PREV_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); await showProduct(ctx, Number(ctx.match[1])-1); });
bot.action('AV_NOOP', async ctx=>{ await ctx.answerCbQuery(); });
bot.action('MENU_TOP', async ctx=>{ await ctx.answerCbQuery(); trackEvent(ctx.from.id,'menu_top'); const tops=getTopProducts(5); if(!tops.length) return ctx.reply('Ainda não há vendas suficientes para mostrar ranking.'); const text=tops.map((p,i)=>`${i+1}. ${p.title}${p.paid_count ? ` — ${p.paid_count} vendas` : ''}`).join('\n'); await ctx.reply(`🔥 *Mais vendidos*\n\n${text}`, {parse_mode:'Markdown'}); });
bot.action('AV_MY', async ctx=>{ await ctx.answerCbQuery(); const rows=db.prepare('SELECT p.id, p.title FROM purchases pu JOIN products p ON p.id=pu.product_id WHERE pu.telegram_user_id=? ORDER BY pu.id DESC LIMIT 20').all(String(ctx.from.id)); if(!rows.length) return ctx.reply('🧾 Você ainda não comprou conteúdos.'); const kb=rows.map(r=>[{text:`🔁 Reenviar: ${r.title}`,callback_data:`REDELIVER_${r.id}`}]); kb.push([{text:'⬅️ Voltar',callback_data:'MENU_HOME'}]); await ctx.reply('🧾 *Minhas compras*\n\nEscolha um item para gerar um novo link:', {parse_mode:'Markdown', reply_markup:{inline_keyboard:kb}}); });
bot.action(/^REDELIVER_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); const product=getProductById(Number(ctx.match[1])); if(!product) return ctx.reply('❌ Conteúdo não encontrado.'); const email=getUserEmail(ctx.from.id); if(!email) return ctx.reply('📧 Primeiro cadastre seu email com /email seuemail@exemplo.com'); if(!product.drive_file_id) return ctx.reply('⚠️ Esse item não tem Drive ID cadastrado.'); const expires=Date.now()+30*24*60*60*1000; const token=createContentToken({telegramUserId:ctx.from.id,productId:product.id,driveFileId:product.drive_file_id,expiresAtMs:expires}); await ctx.reply(`🔗 Novo link (1 uso):\n${process.env.PUBLIC_URL}/c/${token}\n\n⏳ Validade: 30 dias`); });
bot.action(/^BUY_PRODUCT_(\d+)$/, async ctx=>{ await ctx.answerCbQuery(); const product=getProductById(Number(ctx.match[1])); if(!product) return ctx.reply('❌ Conteúdo não encontrado.'); try{ const token=await getLivePixToken({clientId:process.env.LIVEPIX_CLIENT_ID,clientSecret:process.env.LIVEPIX_CLIENT_SECRET}); const payment=await createPayment({token,amountCents:product.price_cents,redirectUrl:'https://example.com/obrigado'}); db.prepare("INSERT INTO orders (telegram_user_id,kind,product_id,amount_cents,reference,status) VALUES (?, 'product', ?, ?, ?, 'pending')").run(String(ctx.from.id),product.id,product.price_cents,payment.reference); trackEvent(ctx.from.id,'buy_click',product.id); addScore(ctx.from.id,5); await ctx.reply(`💳 *Pagamento gerado!*\n\nConteúdo: *${product.title}*\nValor: R$ ${(product.price_cents/100).toFixed(2).replace('.',',')}\n\n👉 Pague por aqui:\n${payment.redirectUrl}\n\n✅ Após confirmar, eu vou pedir seu email para liberar o acesso.`, {parse_mode:'Markdown'}); }catch(e){ console.error(e); await ctx.reply('❌ Erro ao gerar pagamento.'); } });
bot.action('MENU_SUPORTE', async ctx=>{ await ctx.answerCbQuery(); await ctx.reply('🆘 *Suporte VIP*\n\nFale comigo no WhatsApp:', {parse_mode:'Markdown', ...supportMenu(SUPPORT_WA)}); });
bot.action('MARKETING_STOP', async ctx=>{ await ctx.answerCbQuery(); db.prepare('UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?').run(String(ctx.from.id)); await ctx.reply('✅ Tudo certo. Não vou mais enviar mensagens automáticas.'); });
bot.on('photo', async ctx=>{ const photo=ctx.message.photo[ctx.message.photo.length-1]; console.log('COVER_FILE_ID:', photo.file_id); await ctx.reply('✅ File ID capturado no console.'); });

app.post('/webhook/livepix', async (req,res)=>{
  try{
    if(process.env.WEBHOOK_SECRET && req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ok:false});
    const payload=req.body;
    if(payload?.resource?.type !== 'payment') return res.json({ok:true});
    const {id:paymentId, reference} = payload.resource;
    const order=getOrderByReference(reference);
    if(!order || order.status==='paid') return res.json({ok:true});
    markOrderPaid(reference,paymentId);

    if(order.kind==='vip'){
      const plan=getPlan(order.plan_code); if(!plan) return res.json({ok:true});
      setVipExpiry(order.telegram_user_id, Date.now()+Number(plan.days)*24*60*60*1000);
      trackEvent(order.telegram_user_id,'vip_paid'); addScore(order.telegram_user_id,20);
      const invite=await createSingleUseInviteLink();
      await bot.telegram.sendMessage(order.telegram_user_id, `✅ Pagamento confirmado!\n\nVIP liberado por *${plan.days} dias*.\n\n⏳ Link (1 uso / expira em ${INVITE_TTL_MINUTES} min):\n${invite}`, {parse_mode:'Markdown'});
      return res.json({ok:true});
    }

    if(order.kind==='product'){
      const product=getProductById(Number(order.product_id));
      if(!product || !product.drive_file_id){ await bot.telegram.sendMessage(order.telegram_user_id, '⚠️ Pagamento confirmado, mas este item está sem Drive ID cadastrado. Fale no suporte.'); return res.json({ok:true}); }
      const email=getUserEmail(order.telegram_user_id);
      const expires=Date.now()+30*24*60*60*1000;
      if(!email){
        db.prepare('INSERT INTO pending_grants (telegram_user_id,order_reference,product_id,drive_file_id,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(order_reference) DO NOTHING').run(String(order.telegram_user_id), reference, Number(product.id), product.drive_file_id, expires);
        await bot.telegram.sendMessage(order.telegram_user_id, '✅ Pagamento confirmado!\n\n📧 Agora envie seu email do Google para liberar o conteúdo por 30 dias.\n\nExemplo:\n/email seuemail@exemplo.com');
        return res.json({ok:true});
      }
      const perm=await grantFileToEmail({driveFileId:product.drive_file_id,email});
      db.prepare('INSERT INTO drive_access (telegram_user_id,email,drive_file_id,permission_id,expires_at) VALUES (?,?,?,?,?)').run(String(order.telegram_user_id),email,product.drive_file_id,perm.permissionId,expires);
      const token=createContentToken({telegramUserId:order.telegram_user_id,productId:product.id,driveFileId:product.drive_file_id,expiresAtMs:expires});
      db.prepare('INSERT INTO purchases (telegram_user_id,product_id) VALUES (?,?)').run(String(order.telegram_user_id),product.id);
      trackEvent(order.telegram_user_id,'product_paid',product.id); addScore(order.telegram_user_id,15);
      await bot.telegram.sendMessage(order.telegram_user_id, `✅ Pagamento confirmado!\n\n📁 Conteúdo liberado para: *${email}*\n⏳ Validade: *30 dias*\n\n🔗 Link individual (1 uso):\n${process.env.PUBLIC_URL}/c/${token}`, {parse_mode:'Markdown'});
      const plans=getPlans(); const best=plans[plans.length-1] || plans[0];
      await bot.telegram.sendMessage(order.telegram_user_id, '💎 *Quer mais?*\n\nVocê acabou de liberar um conteúdo. Quer acesso ao *VIP completo* agora?', {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:`🔐 Ver VIP (${best.label})`,callback_data:'MENU_VIP'}]]}});
      return res.json({ok:true});
    }

    return res.json({ok:true});
  }catch(e){ console.error('webhook error:', e); return res.status(500).json({ok:false}); }
});
app.get('/c/:token', (req,res)=>{
  const row=db.prepare('SELECT * FROM content_links WHERE token=?').get(req.params.token);
  if(!row) return res.status(404).send('Link inválido.');
  if(row.used_count>=1) return res.status(410).send('Link já utilizado.');
  if(row.expires_at<=Date.now()) return res.status(410).send('Acesso expirado.');
  const ok=db.transaction(()=>{ const cur=db.prepare('SELECT used_count FROM content_links WHERE token=?').get(req.params.token); if(!cur || cur.used_count>=1) return false; db.prepare('UPDATE content_links SET used_count=1, used_at=? WHERE token=?').run(Date.now(), req.params.token); return true; })();
  if(!ok) return res.status(410).send('Link já utilizado.');
  return res.redirect(302, `https://drive.google.com/file/d/${row.drive_file_id}/view`);
});

app.get('/admin', requireAdmin, (req,res)=>res.sendFile(path.resolve('admin','index.html')));
app.get('/admin/api/stats', requireAdmin, (req,res)=>{ const total=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid'").get().cents; const vip=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='vip'").get().cents; const product=db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM orders WHERE status='paid' AND kind='product'").get().cents; res.json({total,vip,product}); });
app.get('/admin/api/plans', requireAdmin, (req,res)=>res.json(getPlans()));
app.post('/admin/api/plans', requireAdmin, (req,res)=>{ const {plans}=req.body; const stmt=db.prepare('UPDATE config_plans SET label=?, days=?, amount_cents=? WHERE code=?'); db.transaction(()=>{ for(const p of plans) stmt.run(String(p.label),Number(p.days),Number(p.amount_cents),String(p.code)); })(); res.json({ok:true}); });
app.get('/admin/api/products', requireAdmin, (req,res)=>res.json(getProducts()));
app.post('/admin/api/products', requireAdmin, upload.fields([{name:'preview_video',maxCount:1},{name:'preview_gif',maxCount:1}]), (req,res)=>{ const {title,description,price_cents,drive_file_id}=req.body; if(!title || !description || !price_cents) return res.status(400).send('missing fields'); const pv=req.files?.preview_video?.[0] ? `/uploads/${req.files.preview_video[0].filename}` : null; const pg=req.files?.preview_gif?.[0] ? `/uploads/${req.files.preview_gif[0].filename}` : null; db.prepare('INSERT INTO products (title,description,price_cents,drive_file_id,preview_video_url,preview_gif_url) VALUES (?,?,?,?,?,?)').run(String(title),String(description),Number(price_cents),String(drive_file_id||'')||null,pv,pg); res.json({ok:true}); });
app.delete('/admin/api/products/:id', requireAdmin, (req,res)=>{ db.prepare('UPDATE products SET is_active=0 WHERE id=?').run(Number(req.params.id)); res.json({ok:true}); });
app.post('/admin/api/menu-media', requireAdmin, upload.fields([{name:'preview_video',maxCount:1},{name:'preview_gif',maxCount:1}]), (req,res)=>{ const {menu_key,caption}=req.body; const row=getMenuMedia(menu_key); const pv=req.files?.preview_video?.[0] ? `/uploads/${req.files.preview_video[0].filename}` : null; const pg=req.files?.preview_gif?.[0] ? `/uploads/${req.files.preview_gif[0].filename}` : null; db.prepare("INSERT INTO menu_media (menu_key,preview_video_url,preview_gif_url,caption) VALUES (?,?,?,?) ON CONFLICT(menu_key) DO UPDATE SET preview_video_url=COALESCE(excluded.preview_video_url,menu_media.preview_video_url), preview_gif_url=COALESCE(excluded.preview_gif_url,menu_media.preview_gif_url), caption=COALESCE(excluded.caption,menu_media.caption)").run(String(menu_key), pv, pg, caption || row?.caption || null); res.json({ok:true}); });
app.get('/admin/api/orders', requireAdmin, (req,res)=>res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all()));
app.get('/admin/api/vips', requireAdmin, (req,res)=>res.json(db.prepare('SELECT * FROM vip_access ORDER BY expires_at DESC LIMIT 200').all()));
app.get('/', (req,res)=>res.send('OK'));

app.use(bot.webhookCallback('/telegram'));
setInterval(()=>marketingJob().catch(console.error), 6*60*60*1000);
setInterval(()=>funnelJob().catch(console.error), 60*60*1000);
setInterval(()=>removeExpiredUsersJob().catch(console.error), 30*60*1000);
setInterval(()=>revokeExpiredDriveAccessJob().catch(console.error), 60*60*1000);

async function main(){
  const port=Number(process.env.PORT || 3000);
  app.listen(port, async ()=>{ console.log(`HTTP on :${port}`); if(process.env.PUBLIC_URL){ const webhookUrl=`${process.env.PUBLIC_URL}/telegram`; await bot.telegram.setWebhook(webhookUrl); console.log('✅ Telegram webhook set:', webhookUrl); } console.log('BOT ONLINE'); });
}
main();
