const { Markup } = require("telegraf");

function mainMenu(instagramUrl, freeGroupUrl) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔞 Conteúdos adultos", "MENU_AVULSO")],
    [Markup.button.callback("💎 Grupo VIP", "MENU_VIP")],
    [
      Markup.button.url("🆓 Grupo FREE", freeGroupUrl),
      Markup.button.callback("🔥 Mais vendidos", "MENU_TOP")
    ],
    [
      Markup.button.url("📸 Instagram", instagramUrl),
      Markup.button.callback("🆘 Suporte", "MENU_SUPORTE")
    ]
  ]);
}

function vipPlansMenu(plans = []) {
  const rows = plans.map((plan) => [
    Markup.button.callback(
      `💳 ${plan.label} — R$ ${(Number(plan.amount_cents || 0) / 100).toFixed(2).replace(".", ",")}`,
      `VIP_BUY_${plan.code}`
    )
  ]);

  rows.push([Markup.button.callback("⬅️ Voltar", "MENU_HOME")]);

  return Markup.inlineKeyboard(rows);
}

function avulsoKeyboard({ idx = 0, total = 1, productId, freeGroupUrl }) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💳 COMPRAR AGORA", `BUY_PRODUCT_${productId}`)],
    [
      Markup.button.callback("⬅️", `AV_PREV_${idx}`),
      Markup.button.callback(`📍 ${idx + 1}/${total}`, "AV_NOOP"),
      Markup.button.callback("➡️", `AV_NEXT_${idx}`)
    ],
    [
      Markup.button.callback("📦 Minhas compras", "AV_MY"),
      Markup.button.callback("🔥 Mais vendidos", "MENU_TOP")
    ],
    [
      Markup.button.url("🆓 Grupo FREE", freeGroupUrl),
      Markup.button.callback("⬅️ Menu", "MENU_HOME")
    ]
  ]);
}

function supportMenu(whatsAppNumber) {
  const wa = `https://wa.me/${String(whatsAppNumber || "").replace(/[^0-9]/g, "")}`;
  return Markup.inlineKeyboard([
    [Markup.button.url("📞 WhatsApp", wa)],
    [Markup.button.callback("⬅️ Voltar", "MENU_HOME")]
  ]);
}

module.exports = {
  mainMenu,
  vipPlansMenu,
  avulsoKeyboard,
  supportMenu
};
