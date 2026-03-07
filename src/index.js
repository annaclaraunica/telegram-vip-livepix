
require("dotenv").config()

const express=require("express")
const {Telegraf}=require("telegraf")
const db=require("./db")
const {mainMenu}=require("./menus")

const bot=new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

const app=express()
app.use(express.json())

let emailWaitList = {}

bot.start(async(ctx)=>{

const id=String(ctx.from.id)
const now=Date.now()

const user=db.prepare("SELECT * FROM users WHERE telegram_user_id=?").get(id)

if(!user){
db.prepare("INSERT INTO users VALUES(?,?,?,?,?)")
.run(id,now,now,0,null)

if(process.env.COVER_FILE_ID){
await ctx.replyWithPhoto(process.env.COVER_FILE_ID,{
caption:"🔥 Bem-vinda ao VIP da Anna. Conteúdos exclusivos."
})
}
}

await ctx.reply("Menu principal",mainMenu())

})

bot.action("MENU_AVULSO",async(ctx)=>{

await ctx.answerCbQuery()

const p=db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 1").get()

if(!p)return ctx.reply("Sem conteúdos disponíveis")

await ctx.replyWithVideo(
process.env.PUBLIC_URL+p.preview_video_url,
{
caption:`🎬 ${p.title}

${p.description}

💰 R$ ${(p.price_cents/100).toFixed(2).replace(".",",")}`,
reply_markup:{
inline_keyboard:[
[{text:"💳 Comprar",callback_data:`BUY_${p.id}`}]
]
}
}
)

})

bot.action(/BUY_(.*)/,async(ctx)=>{

const productId=ctx.match[1]
const userId=String(ctx.from.id)

db.prepare(`
INSERT INTO purchases (telegram_user_id,product_id,paid)
VALUES (?,?,0)
`).run(userId,productId)

await ctx.reply("💳 Gerando pagamento...")

})

app.post("/webhook/payment",async(req,res)=>{

const {telegram_user_id,product_id}=req.body

db.prepare(`
UPDATE purchases
SET paid=1
WHERE telegram_user_id=? AND product_id=?
`).run(telegram_user_id,product_id)

emailWaitList[telegram_user_id]=product_id

await bot.telegram.sendMessage(
telegram_user_id,
"✅ Pagamento confirmado!\n\nAgora envie seu **email** para liberar o conteúdo.",
{parse_mode:"Markdown"}
)

res.json({ok:true})

})

bot.on("text",async(ctx)=>{

const userId=String(ctx.from.id)

if(emailWaitList[userId]){

const email=ctx.message.text

db.prepare(`
INSERT OR REPLACE INTO user_emails
VALUES (?,?)
`).run(userId,email)

delete emailWaitList[userId]

await ctx.reply("📩 Email registrado. Liberando conteúdo...")

}

})

app.get("/admin/api/products",(req,res)=>{

const rows=db.prepare("SELECT * FROM products ORDER BY id DESC").all()

res.json(rows)

})

app.post("/admin/api/products",(req,res)=>{

const {title,description,price_cents,preview_video_url}=req.body

db.prepare(`
INSERT INTO products (title,description,price_cents,preview_video_url)
VALUES (?,?,?,?)
`).run(title,description,price_cents,preview_video_url)

res.json({ok:true})

})

app.listen(3000,()=>{
console.log("Admin API running")
})

bot.launch()

console.log("BOT ONLINE")
