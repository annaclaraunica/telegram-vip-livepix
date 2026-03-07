
require("dotenv").config()

const {Telegraf}=require("telegraf")
const db=require("./db")
const {mainMenu}=require("./menus")

const bot=new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

const remarketingTexts=[
"👀 Eu vi que você deu uma olhada nos conteúdos… quer que eu te mostre algo especial?",
"🔥 Esse conteúdo está entre os mais procurados hoje.",
"💎 Conteúdo exclusivo disponível agora.",
"⚡ Algumas pessoas voltam só para ver esse vídeo novamente.",
"👀 Posso te mostrar uma prévia melhor."
]

function pickText(){
return remarketingTexts[Math.floor(Math.random()*remarketingTexts.length)]
}

function scarcity(product){

const r=db.prepare(`
SELECT COUNT(*) c
FROM orders
WHERE product_id=?
AND status='paid'
AND datetime(created_at)>=datetime('now','-24 hours')
`).get(product.id)

if(r.c>=5)return`🔥 ${r.c} compras nas últimas horas`
if(r.c>=2)return`⚡ Conteúdo saindo rápido`
if(r.c>=1)return`👀 Compra recente detectada`

return`💎 Conteúdo exclusivo`
}

bot.start(async(ctx)=>{

const id=String(ctx.from.id)
const now=Date.now()

const user=db.prepare(`SELECT * FROM users WHERE telegram_user_id=?`).get(id)

if(!user){

db.prepare(`INSERT INTO users VALUES(?,?,?,0,null)`).run(id,now,now)

if(process.env.COVER_FILE_ID){
await ctx.replyWithPhoto(process.env.COVER_FILE_ID,{
caption:"🔥 Bem‑vindo ao VIP. Conteúdos exclusivos liberados após pagamento.",
})
}

}else{

db.prepare(`UPDATE users SET last_seen_at=? WHERE telegram_user_id=?`).run(now,id)

}

await ctx.reply("Menu principal",mainMenu())

})

bot.action("MENU_AVULSO",async(ctx)=>{

await ctx.answerCbQuery()

const p=db.prepare(`
SELECT * FROM products
ORDER BY created_at DESC
LIMIT 1
`).get()

if(!p)return ctx.reply("Sem conteúdos")

const s=scarcity(p)

await ctx.replyWithVideo(
process.env.PUBLIC_URL+p.preview_video_url,
{
caption:
`${s}

🎬 ${p.title}

${p.description}

💰 R$ ${(p.price_cents/100).toFixed(2).replace(".",",")}`,
reply_markup:{
inline_keyboard:[
[{text:"💳 Comprar",callback_data:`BUY_PRODUCT_${p.id}`}]
]
}
}
)

})

bot.action("MARKETING_STOP",async(ctx)=>{

db.prepare(`UPDATE users SET marketing_opt_out=1 WHERE telegram_user_id=?`)
.run(String(ctx.from.id))

await ctx.reply("🚫 Remarketing desativado")

})

async function marketing(){

const users=db.prepare(`SELECT * FROM users WHERE marketing_opt_out=0`).all()

const products=db.prepare(`SELECT * FROM products ORDER BY RANDOM() LIMIT 5`).all()

for(const u of users){

const bought=db.prepare(`SELECT 1 FROM purchases WHERE telegram_user_id=? LIMIT 1`)
.get(u.telegram_user_id)

if(bought)continue

const can=
!u.last_marketing_at||
(Date.now()-u.last_marketing_at)>86400000

if(!can)continue

const p=products[Math.floor(Math.random()*products.length)]

const text=pickText()

try{

await bot.telegram.sendVideo(
u.telegram_user_id,
process.env.PUBLIC_URL+p.preview_video_url,
{
caption:
`${text}

${scarcity(p)}

🎬 ${p.title}

💰 R$ ${(p.price_cents/100).toFixed(2).replace(".",",")}`,
reply_markup:{
inline_keyboard:[
[{text:"💳 Comprar agora",callback_data:`BUY_PRODUCT_${p.id}`}],
[{text:"📸 Instagram",url:"https://www.instagram.com/the.annaofc/"}],
[{text:"🚫 Parar mensagens",callback_data:"MARKETING_STOP"}]
]
}
}
)

db.prepare(`UPDATE users SET last_marketing_at=? WHERE telegram_user_id=?`)
.run(Date.now(),u.telegram_user_id)

}catch(e){
console.log(e.message)
}

}

}

setInterval(marketing,21600000)

bot.launch()

console.log("BOT ONLINE")
