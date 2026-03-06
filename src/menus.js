function mainMenu(instaUrl) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔐 Grupo VIP", callback_data: "MENU_VIP" }],
        [{ text: "📦 Conteúdo avulso", callback_data: "MENU_AVULSO" }],
        [
          { text: "📷 Meu Instagram", url: instaUrl },
          { text: "🆘 Suporte", callback_data: "MENU_SUPORTE" },
        ],
      ],
    },
  };
}

function vipPlansMenu(plans) {
  const rows = plans.map((p) => [
    {
      text: `${p.label} - R$ ${(p.amount_cents / 100).toFixed(2).replace(".", ",")}`,
      callback_data: `VIP_BUY_${p.code}`,
    },
  ]);
  rows.push([{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function avulsoKeyboard({ idx, total, productId, hasEmail }) {
  const rows = [];
  rows.push([{ text: "💳 Comprar", callback_data: `BUY_PRODUCT_${productId}` }]);
  if (!hasEmail) rows.push([{ text: "📧 Cadastrar email", callback_data: "EMAIL_HELP" }]);

  if (total > 1) {
    rows.push([
      { text: "⬅️ Anterior", callback_data: `AV_PREV_${idx}` },
      { text: `${idx + 1}/${total}`, callback_data: "AV_NOOP" },
      { text: "Próximo ➡️", callback_data: `AV_NEXT_${idx}` },
    ]);
  }

  rows.push([{ text: "🧾 Minhas compras", callback_data: "AV_MY" }]);
  rows.push([{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function supportMenu(waDigits) {
  const url = `https://wa.me/${waDigits}?text=${encodeURIComponent("Oi, preciso de ajuda no VIP")}`;
  return { reply_markup: { inline_keyboard: [[{ text: "📲 Falar no WhatsApp", url }]] } };
}

module.exports = { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu };
