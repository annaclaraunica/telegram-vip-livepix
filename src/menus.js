function mainMenu(){
return{
reply_markup:{
inline_keyboard:[
[{text:"🔐 Acessar VIP",callback_data:"MENU_VIP"}],
[{text:"🎬 Conteúdos exclusivos",callback_data:"MENU_AVULSO"}],
[{text:"📸 Instagram",url:"https://www.instagram.com/the.annaofc/"}],
[{text:"🆘 Suporte WhatsApp",url:"https://wa.me/5522988046948"}]
]
}
}
}

function avulsoKeyboard({idx,total,productId}){
const rows = [
[{text:"💳 Comprar",callback_data:`BUY_PRODUCT_${productId}`}]
]

if(total > 1){
rows.push([
{text:"⬅️",callback_data:`AV_PREV_${idx}`},
{text:`${idx+1}/${total}`,callback_data:"AV_NOOP"},
{text:"➡️",callback_data:`AV_NEXT_${idx}`}
])
}

rows.push([{text:"🔥 Mais vendidos",callback_data:"MENU_TOP"}])
rows.push([{text:"📸 Instagram",url:"https://www.instagram.com/the.annaofc/"}])
rows.push([{text:"🚫 Parar mensagens",callback_data:"MARKETING_STOP"}])
rows.push([{text:"🏠 Menu",callback_data:"MENU_HOME"}])

return {reply_markup:{inline_keyboard:rows}}
}

module.exports={mainMenu,avulsoKeyboard}
