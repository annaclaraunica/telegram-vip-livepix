
function mainMenu(){
return{
reply_markup:{
inline_keyboard:[
[{text:"🎬 Conteúdos VIP",callback_data:"MENU_AVULSO"}],
[{text:"📸 Instagram",url:"https://www.instagram.com/the.annaofc/"}],
[{text:"🆘 Suporte WhatsApp",url:"https://wa.me/5522988046948"}]
]
}
}
}

module.exports={mainMenu}
