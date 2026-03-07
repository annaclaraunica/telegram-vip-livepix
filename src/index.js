require("dotenv").config()

const {Telegraf} = require("telegraf")
const db = require("./db")
const {mainMenu, avulsoKeyboard} = require("./menus")

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

const remarketingTexts = [
  "👀 Eu vi que você deu uma olhada nos conteúdos… quer que eu te mostre o que está chamando mais atenção hoje?",
  "🔥 Esse conteúdo está entre os que mais despertam curiosidade.",
  "💎 Nem todo mundo chega até essa parte… quer ver melhor?",
  "⚡ Você ficou muito perto de liberar esse acesso.",
  "👀 Posso te mostrar uma prévia que costuma prender atenção.",
  "🔥 Esse costuma ser um dos primeiros escolhidos.",
  "💎 Conteúdo exclusivo disponível agora.",
  "⚡ Algumas pessoas voltam só para rever esse vídeo.",
  "👀 Tem algo nesse preview que sempre chama atenção.",
  "🔥 Quer ver por que esse está entre os mais procurados?",
  "💎 Esse conteúdo costuma impressionar logo nos primeiros segundos.",
  "⚡ Você olhou na hora certa.",
  "👀 Posso te mostrar algo que normalmente não fica disponível por muito tempo.",
  "🔥 Esse preview costuma gerar muita curiosidade.",
  "💎 Tem gente que escolhe exatamente esse primeiro.",
  "⚡ Quer ver a versão completa?",
  "👀 Talvez esse seja o conteúdo que você estava procurando.",
  "🔥 Ele costuma receber bastante atenção.",
  "💎 Um dos destaques do catálogo agora.",
  "⚡ Quer descobrir o motivo de tanta procura?",
  "👀 Você chegou perto de ver tudo.",
  "🔥 Posso te mostrar um dos conteúdos mais quentes do momento.",
  "💎 Esse vídeo chama atenção muito rápido.",
  "⚡ Quer aproveitar enquanto está disponível?",
  "👀 Esse é o tipo de conteúdo que faz a pessoa voltar.",
  "🔥 Vale a pena olhar mais de perto.",
  "💎 Esse preview costuma ser decisivo.",
  "⚡ Posso te mostrar mais um pouco.",
  "👀 Você ainda pode garantir acesso agora.",
  "🔥 Esse conteúdo está dando o que falar.",
  "💎 Talvez você tenha parado justamente no melhor.",
  "⚡ Quer liberar agora?",
  "👀 Algumas pessoas entram só para ver esse.",
  "🔥 Esse costuma ficar entre os favoritos.",
  "💎 Posso te mostrar por que ele chama tanta atenção.",
  "⚡ Tem algo especial nesse conteúdo.",
  "👀 Você vai entender quando assistir completo.",
  "🔥 Quer uma prévia melhor antes de decidir?",
  "💎 Esse é um dos que mais convertem curiosidade em compra.",
  "⚡ Ainda está disponível para você agora.",
  "👀 Esse conteúdo merece uma segunda olhada.",
  "🔥 Muita gente começa por esse.",
  "💎 Um dos mais fortes do catálogo.",
  "⚡ Quer ver antes que você deixe passar?",
  "👀 Esse preview costuma mexer com a curiosidade.",
  "🔥 Dá para entender o sucesso dele só pelos primeiros segundos.",
  "💎 Quer ver a parte completa agora?",
  "⚡ Esse conteúdo chama atenção quase instantaneamente.",
  "👀 Você ainda pode aproveitar esse acesso.",
  "🔥 Eu te mostro."
]

function pickText(){
  return remarketingTexts[Math.floor(Math.random()*remarketingTexts.length)]
}

function getOrCreateUser(id){
  const uid = String(id)
  const now = Date.now()
  const user = db.prepare(`SELECT * FROM users WHERE telegram_user_id=?`).get(uid)
  if(!user){
    db.prepare(`INSERT INTO users (telegram_user_id,first_seen_at,last_seen_at,marketing_opt_out,last_marketing_at) VALUES (?,?,?,?,?)`)
      .run(uid, now, now, 0, null)
    return {isNew:true}
  }
  db.prepare(`UPDATE users SET last_seen_at=? WHERE telegram_user_id=?`).run(now, uid)
  return {isNew:false}
}

function getAvulsoIndex(userId){
  const row = db.prepare(`SELECT avulso_index FROM ui_state WHERE telegram_user_id=?`).get(String(userId))
  return row ? Number(row.avulso_index || 0) : 0
}

function setAvulsoIndex(userId, idx){
  db.prepare(`
  INSERT INTO ui_state (telegram_user_id,avulso_index)
  VALUES (?,?)
  ON CONFLICT(telegram_user_id) DO UPDATE SET avulso_index=excluded.avulso_index
  `).run(String(userId), Number(idx))
}

function getProducts(){
  return db.prepare(`SELECT * FROM products ORDER BY created_at DESC, id DESC`).all()
}

function getTopProducts(limit=3){
  return db.prepare(`
  SELECT p.*, COUNT(o.id) AS paid_count
  FROM products p
  LEFT JOIN orders o
    ON o.product_id = p.id
   AND o.status='paid'
   AND o.kind='product'
  GROUP BY p.id
  ORDER BY paid_count DESC, p.id DESC
  LIMIT ?
  `).all(limit)
}

function getRecentPaidCount(productId,hours=24){
  const row = db.prepare(`
  SELECT COUNT(*) AS c
  FROM orders
  WHERE product_id=?
    AND status='paid'
    AND kind='product'
    AND datetime(created_at)>=datetime('now',?)
  `).get(Number(productId), `-${hours} hours`)
  return Number(row?.c || 0)
}

function getAllRecentPaidCount(hours=24){
  const row = db.prepare(`
  SELECT COUNT(*) AS c
  FROM orders
  WHERE status='paid'
    AND datetime(created_at)>=datetime('now',?)
  `).get(`-${hours} hours`)
  return Number(row?.c || 0)
}

function getRecentViewsEstimate(){
  const row = db.prepare(`
  SELECT COUNT(*) AS c
  FROM users
  WHERE last_seen_at IS NOT NULL
    AND last_seen_at >= ?
  `).get(Date.now() - (60*60*1000))
  return Number(row?.c || 0)
}

function buildScarcityLine(product){
  const p24 = getRecentPaidCount(product.id,24)
  const all24 = getAllRecentPaidCount(24)
  const topIds = getTopProducts(3).map(x => Number(x.id))

  if(p24 >= 5) return `🔥 ${p24} compras desse conteúdo nas últimas 24h`
  if(p24 >= 2) return `⚡ Esse conteúdo está saindo rápido hoje`
  if(p24 >= 1) return `👀 Compra recente detectada`
  if(topIds.includes(Number(product.id))) return `🔥 Entre os mais vendidos do momento`
  if(all24 >= 5) return `⚡ Catálogo com movimentação alta hoje`
  return `💎 Conteúdo exclusivo disponível agora`
}

function buildActivityLine(product){
  const views = getRecentViewsEstimate()
  const p24 = getRecentPaidCount(product.id,24)

  if(views >= 10 && p24 >= 1) return `👀 Produto em destaque agora`
  if(views >= 5) return `✨ Conteúdo com bastante interesse hoje`
  if(p24 >= 1) return `🔥 Um dos destaques recentes`
  return `🌙 Disponível para acesso imediato`
}

function getPreviewUrl(product){
  if(product.preview_gif_url) return process.env.PUBLIC_URL + product.preview_gif_url
  if(product.preview_video_url) return process.env.PUBLIC_URL + product.preview_video_url
  return null
}

function getPreviewKind(product){
  if(product.preview_gif_url) return "gif"
  if(product.preview_video_url) return "video"
  return "none"
}

async function sendCoverIfFirstAccess(ctx){
  const state = getOrCreateUser(ctx.from.id)
  if(state.isNew && process.env.COVER_FILE_ID){
    await ctx.replyWithPhoto(process.env.COVER_FILE_ID,{
      caption:`🔥 *Bem-vinda ao VIP da Anna*\n\nConteúdos exclusivos, previews, acesso rápido e novidades frequentes.\n\n👇 Escolha uma opção no menu.`,
      parse_mode:"Markdown"
    })
  }
}

async function showProduct(ctx, idx){
  const products = getProducts()
  if(!products.length){
    if(ctx.updateType === "callback_query"){
      return ctx.editMessageText("Sem conteúdos cadastrados no momento.")
    }
    return ctx.reply("Sem conteúdos cadastrados no momento.")
  }

  const total = products.length
  const safeIdx = ((idx % total) + total) % total
  const p = products[safeIdx]
  setAvulsoIndex(ctx.from.id, safeIdx)

  const scarcity = buildScarcityLine(p)
  const activity = buildActivityLine(p)

  const caption =
`${scarcity}
${activity}

🎬 *${p.title}*

${p.description}

💰 R$ ${(p.price_cents/100).toFixed(2).replace(".",",")}`

  const keyboard = avulsoKeyboard({idx:safeIdx,total,productId:p.id})
  const previewUrl = getPreviewUrl(p)
  const previewKind = getPreviewKind(p)

  if(previewUrl){
    if(ctx.updateType === "callback_query"){
      try{
        await ctx.editMessageMedia({
          type: previewKind === "gif" ? "animation" : "video",
          media: previewUrl,
          caption,
          parse_mode:"Markdown"
        }, keyboard)
        return
      }catch(e){}
    }

    if(previewKind === "gif"){
      return ctx.replyWithAnimation(previewUrl,{caption,parse_mode:"Markdown",...keyboard})
    }
    return ctx.replyWithVideo(previewUrl,{caption,parse_mode:"Markdown",...keyboard})
  }

  if(ctx.updateType === "callback_query"){
    return ctx.editMessageText(caption,{parse_mode:"Markdown",...keyboard})
  }
  return ctx.reply(caption,{parse_mode:"Markdown",...keyboard})
}

bot.start(async(ctx)=>{
  await sendCoverIfFirstAccess(ctx)
  await ctx.reply("Menu principal", mainMenu())
})

bot.action("MENU_HOME", async(ctx)=>{
  await ctx.answerCbQuery()
  await ctx.editMessageText("Menu principal", mainMenu())
})

bot.action("MENU_AVULSO", async(ctx)=>{
  await ctx.answerCbQuery()
  await showProduct(ctx, getAvulsoIndex(ctx.from.id))
})

bot.action(/^AV_NEXT_(\d+)$/, async(ctx)=>{
  await ctx.answerCbQuery()
  await showProduct(ctx, Number(ctx.match[1]) + 1)
})

bot.action(/^AV_PREV_(\d+)$/, async(ctx)=>{
  await ctx.answerCbQuery()
  await showProduct(ctx, Number(ctx.match[1]) - 1)
})

bot.action("AV_NOOP", async(ctx)=>{
  await ctx.answerCbQuery()
})

bot.action("MENU_TOP", async(ctx)=>{
  await ctx.answerCbQuery()
  const tops = getTopProducts(3)
  if(!tops.length) return ctx.reply("Ainda não há vendas suficientes para mostrar ranking.")
  const text = tops.map((p,i)=>`${i+1}. ${p.title}${p.paid_count ? ` — ${p.paid_count} vendas` : ""}`).join("\n")
  await ctx.reply(`🔥 *Mais vendidos*\n\n${text}`, {parse_mode:"Markdown"})
})

bot.action("MARKETING_STOP",async(ctx)=>{
  await ctx.answerCbQuery()
  db.prepare(`UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?`).run(String(ctx.from.id))
  await ctx.reply("✅ Tudo certo. Não vou mais enviar mensagens automáticas.")
})

bot.command("voltar", async(ctx)=>{
  db.prepare(`UPDATE users SET marketing_opt_out=0 WHERE telegram_user_id=?`).run(String(ctx.from.id))
  await ctx.reply("✅ Reativei as mensagens automáticas.")
})

bot.command("parar", async(ctx)=>{
  db.prepare(`UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?`).run(String(ctx.from.id))
  await ctx.reply("✅ Não vou mais enviar mensagens automáticas.")
})

// opcional: enviar uma foto para capturar o file_id da capa
bot.on("photo", async(ctx)=>{
  const photo = ctx.message.photo[ctx.message.photo.length-1]
  console.log("COVER_FILE_ID:", photo.file_id)
  await ctx.reply("✅ File ID capturado no console.")
})

async function sendMarketingMessage(userId, product, extraText){
  const previewUrl = getPreviewUrl(product)
  const previewKind = getPreviewKind(product)
  const caption =
`${extraText}

${buildScarcityLine(product)}
${buildActivityLine(product)}

🎬 *${product.title}*
💰 R$ ${(product.price_cents/100).toFixed(2).replace(".",",")}`

  const reply_markup = {
    inline_keyboard:[
      [{text:"💳 Comprar agora",callback_data:`BUY_PRODUCT_${product.id}`}],
      [{text:"📸 Instagram",url:"https://www.instagram.com/the.annaofc/"}],
      [{text:"🚫 Parar mensagens",callback_data:"MARKETING_STOP"}]
    ]
  }

  if(previewUrl){
    if(previewKind === "gif"){
      await bot.telegram.sendAnimation(userId, previewUrl, {caption, parse_mode:"Markdown", reply_markup})
    }else{
      await bot.telegram.sendVideo(userId, previewUrl, {caption, parse_mode:"Markdown", reply_markup})
    }
  }else{
    await bot.telegram.sendMessage(userId, caption, {parse_mode:"Markdown", reply_markup})
  }
}

async function marketingJob(){
  const users = db.prepare(`SELECT * FROM users WHERE marketing_opt_out=0`).all()
  const products = db.prepare(`SELECT * FROM products ORDER BY RANDOM() LIMIT 8`).all()
  if(!products.length) return

  for(const u of users){
    const bought = db.prepare(`SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1`).get(u.telegram_user_id)
    if(bought) continue

    const canSend = !u.last_marketing_at || (Date.now() - Number(u.last_marketing_at)) > 86400000
    if(!canSend) continue

    const product = products[Math.floor(Math.random()*products.length)]
    const text = pickText()

    try{
      await sendMarketingMessage(u.telegram_user_id, product, text)
      db.prepare(`UPDATE users SET last_marketing_at=? WHERE telegram_user_id=?`).run(Date.now(), u.telegram_user_id)
    }catch(e){
      console.log("marketing error:", e.message)
    }
  }
}

// funil simples
async function funnelJob(){
  const users = db.prepare(`SELECT * FROM users WHERE marketing_opt_out=0`).all()
  const products = db.prepare(`SELECT * FROM products ORDER BY RANDOM() LIMIT 5`).all()
  if(!products.length) return

  for(const u of users){
    const bought = db.prepare(`SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1`).get(u.telegram_user_id)
    if(bought) continue

    const sinceFirst = Date.now() - Number(u.first_seen_at || Date.now())
    let stepText = null

    if(sinceFirst > 10*60*1000 && sinceFirst < 20*60*1000){
      stepText = "👀 Você viu a capa… agora vale olhar um preview mais de perto."
    }else if(sinceFirst > 60*60*1000 && sinceFirst < 80*60*1000){
      stepText = "🔥 Esse é um dos conteúdos que mais chama atenção quando alguém volta."
    }else if(sinceFirst > 24*60*60*1000 && sinceFirst < 26*60*60*1000){
      stepText = "⚡ Última chamada para olhar esse destaque com calma."
    }

    if(!stepText) continue

    const product = products[Math.floor(Math.random()*products.length)]

    try{
      await sendMarketingMessage(u.telegram_user_id, product, stepText)
    }catch(e){
      console.log("funnel error:", e.message)
    }
  }
}

setInterval(()=>marketingJob().catch(console.error), 21600000)
setInterval(()=>funnelJob().catch(console.error), 3600000)

bot.launch()
console.log("BOT ONLINE")
