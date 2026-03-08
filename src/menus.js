
function mainMenu(instaUrl, freeGroupUrl) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔐 Grupo VIP", callback_data: "MENU_VIP" }],
        [{ text: "🎬 Conteúdo avulso", callback_data: "MENU_AVULSO" }],
        [{ text: "🔥 Mais vendidos", callback_data: "MENU_TOP" }],
        [{ text: "🆓 Grupo FREE", url: freeGroupUrl }],
        [{ text: "📸 Instagram", url: instaUrl }, { text: "🆘 Suporte", callback_data: "MENU_SUPORTE" }]
      ]
    }
  };
}
function vipPlansMenu(plans) {
  const rows = plans.map(p => [{ text: `${p.label} - R$ ${(p.amount_cents / 100).toFixed(2).replace(".", ",")}`, callback_data: `VIP_BUY_${p.code}` }]);
  rows.push([{ text: "🆓 Grupo FREE", callback_data: "PROMO_FREE" }]);
  rows.push([{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }]);
  return { reply_markup: { inline_keyboard: rows } };
}
function avulsoKeyboard({ idx, total, productId, freeGroupUrl }) {
  const rows = [[{ text: "💳 Comprar", callback_data: `BUY_PRODUCT_${productId}` }]];
  if (total > 1) rows.push([{ text: "⬅️", callback_data: `AV_PREV_${idx}` }, { text: `${idx + 1}/${total}`, callback_data: "AV_NOOP" }, { text: "➡️", callback_data: `AV_NEXT_${idx}` }]);
  rows.push([{ text: "🔥 Mais vendidos", callback_data: "MENU_TOP" }]);
  rows.push([{ text: "🧾 Minhas compras", callback_data: "AV_MY" }]);
  rows.push([{ text: "🆓 Grupo FREE", url: freeGroupUrl }]);
  rows.push([{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }]);
  return { reply_markup: { inline_keyboard: rows } };
}
function supportMenu(waDigits) {
  const url = `https://wa.me/${waDigits}?text=${encodeURIComponent("Oi, preciso de ajuda no VIP")}`;
  return { reply_markup: { inline_keyboard: [[{ text: "📲 Falar no WhatsApp", url }]] } };
}
module.exports = { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu };
