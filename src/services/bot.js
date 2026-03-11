const { Telegraf } = require('telegraf');
const env = require('../config/env');
const logger = require('../lib/logger');
const { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu } = require('../menus');
const { createPendingOrder } = require('./orders');
const { getLivePixToken, createPayment } = require('../livepix');
const vip = require('./vip');
const products = require('./products');
const grants = require('./grants');

function priceLabel(cents) {
  return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
}

async function createBotService() {
  if (!env.telegramBotToken) {
    logger.warn('TELEGRAM_BOT_TOKEN ausente; bot desabilitado');
    return disabledBotService();
  }

  const bot = new Telegraf(env.telegramBotToken);
  bot.catch((error, ctx) => {
    logger.error({ err: error, updateType: ctx.updateType }, 'Erro no bot Telegram');
  });

  const service = {
    enabled: true,
    bot,
    webhookPath: '/telegram',
    webhookMiddleware: () => bot.webhookCallback('/telegram'),
    async start() {
      const webhookUrl = new URL('/telegram', env.appBaseUrl).toString();
      await bot.telegram.setWebhook(webhookUrl);
      logger.info({ webhookUrl }, 'Webhook do Telegram configurado');
    },
    async stop() {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      } catch (error) {
        logger.warn({ err: error }, 'Falha ao remover webhook');
      }
    },
    async safeSendMessage(chatId, text, extra = {}) {
      try {
        await bot.telegram.sendMessage(chatId, text, extra);
      } catch (error) {
        logger.warn({ err: error, chatId }, 'Falha ao enviar mensagem Telegram');
      }
    },
    async createVipInviteLink() {
      if (!env.telegramVipChatId) {
        return null;
      }

      const expiresAt = Math.floor((Date.now() + env.vipInviteTtlMinutes * 60 * 1000) / 1000);
      const link = await bot.telegram.createChatInviteLink(env.telegramVipChatId, {
        expire_date: expiresAt,
        member_limit: 1,
        creates_join_request: false
      });
      return link.invite_link;
    },
    async removeVipMember(telegramUserId) {
      if (!env.telegramVipChatId) {
        return;
      }

      try {
        await bot.telegram.banChatMember(env.telegramVipChatId, telegramUserId);
        await bot.telegram.unbanChatMember(env.telegramVipChatId, telegramUserId);
      } catch (error) {
        logger.warn({ err: error, telegramUserId }, 'Falha ao remover usuario VIP');
      }
    }
  };

  registerHandlers(service);
  return service;
}

function disabledBotService() {
  return {
    enabled: false,
    webhookPath: '/telegram',
    webhookMiddleware: () => (req, res) => res.status(503).end(),
    async start() {},
    async stop() {},
    async safeSendMessage() {},
    async createVipInviteLink() {
      return null;
    },
    async removeVipMember() {}
  };
}

function registerHandlers(service) {
  const { bot } = service;

  bot.start(async (ctx) => {
    await ctx.reply('Menu principal', mainMenu(env.instagramUrl, env.freeGroupUrl));
  });

  bot.command('email', async (ctx) => {
    const email = String((ctx.message.text || '').split(/\s+/)[1] || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return ctx.reply('Use: /email seuemail@exemplo.com');
    }

    await grants.storeUserEmail(ctx.from.id, email);
    const links = await grants.processPendingGrantsForUser(ctx.from.id, email);

    if (links.length === 0) {
      return ctx.reply(`Email salvo: ${email}`);
    }

    return ctx.reply(`Email salvo. Conteudos liberados:\n${links.map((item) => item.url).join('\n')}`);
  });

  bot.action('MENU_HOME', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Menu principal', mainMenu(env.instagramUrl, env.freeGroupUrl));
  });

  bot.action('MENU_SUPORTE', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Suporte', supportMenu(env.supportWhatsappUrl));
  });

  bot.action('MENU_VIP', async (ctx) => {
    await ctx.answerCbQuery();
    const activeAccess = await vip.getActiveVipAccess(ctx.from.id);
    if (activeAccess) {
      return ctx.reply(`Seu VIP esta ativo ate ${new Date(activeAccess.expires_at).toLocaleString('pt-BR')}`);
    }

    const plans = await vip.listActivePlans();
    return ctx.reply(
      'Planos VIP',
      vipPlansMenu(
        plans.map((plan) => ({
          code: plan.code,
          label: plan.title,
          amount_cents: plan.price_cents
        }))
      )
    );
  });

  bot.action('MENU_AVULSO', async (ctx) => {
    await ctx.answerCbQuery();
    const items = await products.listActiveProducts(1);
    if (items.length === 0) {
      return ctx.reply('Nenhum conteudo disponivel no momento.');
    }

    const product = items[0];
    return ctx.reply(
      `${product.title}\n${product.description || ''}\n${priceLabel(product.price_cents)}`,
      avulsoKeyboard({ idx: 0, total: 1, productId: product.id, freeGroupUrl: env.freeGroupUrl })
    );
  });

  bot.action(/^VIP_BUY_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const plan = await vip.getPlanByCode(ctx.match[1]);
    if (!plan) {
      return ctx.reply('Plano invalido.');
    }

    try {
      const payment = await createLivePixPayment({
        amountCents: plan.price_cents,
        targetType: 'vip',
        targetCode: plan.code,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || ''
      });

      await createPendingOrder({
        provider: 'livepix',
        providerReference: payment.reference,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || '',
        targetType: 'vip',
        targetCode: plan.code,
        amountCents: plan.price_cents,
        rawPayload: payment.raw
      });

      await ctx.reply(`Pague aqui: ${payment.redirectUrl}`);
    } catch (error) {
      logger.error({ err: error }, 'Falha ao criar pagamento VIP');
      await ctx.reply('Nao consegui gerar o pagamento agora.');
    }
  });

  bot.action(/^BUY_PRODUCT_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const product = await products.getProductById(Number(ctx.match[1]));
    if (!product) {
      return ctx.reply('Produto nao encontrado.');
    }

    try {
      const payment = await createLivePixPayment({
        amountCents: product.price_cents,
        targetType: 'product',
        productId: product.id,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || ''
      });

      await createPendingOrder({
        provider: 'livepix',
        providerReference: payment.reference,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || '',
        targetType: 'product',
        productId: product.id,
        amountCents: product.price_cents,
        rawPayload: payment.raw
      });

      await ctx.reply(`Pague aqui: ${payment.redirectUrl}`);
    } catch (error) {
      logger.error({ err: error }, 'Falha ao criar pagamento de produto');
      await ctx.reply('Nao consegui gerar o pagamento agora.');
    }
  });
}

async function createLivePixPayment({ amountCents, targetType, targetCode, productId, telegramUserId, telegramUsername }) {
  const token = await getLivePixToken({
    clientId: env.livepixClientId,
    clientSecret: env.livepixClientSecret
  });

  const payment = await createPayment({
    token,
    amountCents,
    redirectUrl: new URL('/', env.appBaseUrl).toString()
  });

  return {
    reference: payment.reference || payment.id,
    redirectUrl: payment.redirectUrl || payment.checkoutUrl || payment.paymentUrl,
    raw: {
      payment,
      metadata: {
        target_type: targetType,
        target_code: targetCode || null,
        product_id: productId || null,
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername
      }
    }
  };
}

module.exports = {
  createBotService
};
