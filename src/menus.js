function mainMenu(instagramUrl, freeGroupUrl) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💎 Grupo VIP", callback_data: "MENU_VIP" }],
        [{ text: "🎁 Conteúdo avulso", callback_data: "MENU_AVULSO" }],
        [{ text: "🔥 Mais vendidos", callback_data: "MENU_TOP" }],
        [{ text: "🆓 Grupo FREE", url: freeGroupUrl }],
        [{ text: "📸 Instagram", url: instagramUrl }],
        [{ text: "🆘 Suporte", callback_data: "MENU_SUPORTE" }],
      ],
    },
  }
}

function vipPlansMenu(plans) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...plans.filter(p => Number(p.active) !== 0).map((plan) => [{
          text: `${plan.label} - R$ ${(plan.amount_cents / 100).toFixed(2).replace(".", ",")}`,
          callback_data: `VIP_BUY_${plan.code}`,
        }]),
        [{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }],
      ],
    },
  }
}

function avulsoKeyboard({ idx, total, productId, freeGroupUrl }) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️", callback_data: `AV_PREV_${idx}` },
          { text: `${idx + 1}/${total}`, callback_data: "AV_NOOP" },
          { text: "➡️", callback_data: `AV_NEXT_${idx}` },
        ],
        [{ text: "💳 Comprar agora", callback_data: `BUY_PRODUCT_${productId}` }],
        [{ text: "🧾 Minhas compras", callback_data: "AV_MY" }],
        [{ text: "🆓 Grupo FREE", url: freeGroupUrl }],
        [{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }],
      ],
    },
  }
}

function supportMenu(phone) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📞 Abrir WhatsApp", url: `https://wa.me/${phone}` }],
        [{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }],
      ],
    },
  }
}

module.exports = { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu }
