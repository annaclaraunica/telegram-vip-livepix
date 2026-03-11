const { Telegraf } = require('telegraf');
const env = require('../config/env');
const logger = require('../lib/logger');
const { mainMenu, vipPlansMenu, avulsoKeyboard, supportMenu } = require('../menus');
const { createPendingOrder } = require('./orders');
const { getLivePixToken, createPayment } = require('../livepix');
const vip = require('./vip');
const products = require('./products');
const grants = require('./grants');
const remarketing = require('./remarketing');
const appSettings = require('./app-settings');
const { safeCompare } = require('../lib/crypto');

function priceLabel(cents) {
  return `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`;
}

function normalizeCarouselIndex(index, total) {
  if (total <= 0) return 0;
  if (index < 0) return total - 1;
  if (index >= total) return 0;
  return index;
}

function buildProductCaption(product) {
  return `${product.title}\n${product.description || ''}\n${priceLabel(product.price_cents)}`;
}

function inferPreviewKind(product) {
  const previewId = String(product.preview_drive_file_id || '').trim();
  if (!previewId) {
    return null;
  }

  const mime = String(product.preview_mime || '').toLowerCase();
  if (mime === 'photo' || mime === 'image' || mime.startsWith('image/')) {
    return 'photo';
  }

  if (mime === 'gif') {
    return 'animation';
  }

  if (/^https?:\/\//i.test(previewId)) {
    return mime === 'photo' || mime === 'image' || mime.startsWith('image/') ? 'photo' : 'video';
  }

  if (/^(AgACAg)/.test(previewId)) {
    return 'photo';
  }

  if (/^(BAACAg|CQACAg|DQACAg|AAQ)/.test(previewId)) {
    return mime === 'gif' ? 'animation' : 'video';
  }

  return null;
}

async function editOrReplyProductMessage(ctx, product, keyboard) {
  const caption = buildProductCaption(product);
  const previewId = String(product.preview_drive_file_id || '').trim();
  const previewKind = inferPreviewKind(product);

  if (previewId && previewKind && typeof ctx.editMessageMedia === 'function' && ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageMedia(
        {
          type: previewKind,
          media: previewId,
          caption
        },
        {
          reply_markup: keyboard.reply_markup
        }
      );
      return;
    } catch (error) {
      logger.warn({ err: error, productId: product.id, previewKind }, 'Falha ao editar preview do carrossel; fallback para texto');
    }
  }

  if (previewId && previewKind && typeof ctx.replyWithVideo === 'function' && !ctx.callbackQuery) {
    try {
      if (previewKind === 'photo') {
        await ctx.replyWithPhoto(previewId, {
          caption,
          ...keyboard
        });
        return;
      }

      if (previewKind === 'animation') {
        await ctx.replyWithAnimation(previewId, {
          caption,
          ...keyboard
        });
        return;
      }

      await ctx.replyWithVideo(previewId, {
        caption,
        ...keyboard
      });
      return;
    } catch (error) {
      logger.warn({ err: error, productId: product.id, previewKind }, 'Falha ao enviar preview inicial do carrossel; fallback para texto');
    }
  }

  if (typeof ctx.editMessageText === 'function' && ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.editMessageText(caption, keyboard);
    return;
  }

  await ctx.reply(caption, keyboard);
}

async function renderProductCarousel(ctx, items, index) {
  if (!Array.isArray(items) || items.length === 0) {
    if (typeof ctx.editMessageText === 'function') {
      return ctx.editMessageText('Nenhum conteudo disponivel no momento.');
    }
    return ctx.reply('Nenhum conteudo disponivel no momento.');
  }

  const currentIndex = normalizeCarouselIndex(index, items.length);
  const product = items[currentIndex];
  const keyboard = avulsoKeyboard({
    idx: currentIndex,
    total: items.length,
    productId: product.id,
    freeGroupUrl: env.freeGroupUrl
  });

  return editOrReplyProductMessage(ctx, product, keyboard);
}

async function replyWithConfiguredMenuMedia(ctx, menuKey, fallbackText, extra = {}) {
  try {
    const mediaSettings = await appSettings.getMenuMediaSettings();
    const media = mediaSettings && mediaSettings[menuKey];
    const previewId = String(media?.preview_drive_file_id || '').trim();
    const previewMime = String(media?.preview_mime || 'video').trim().toLowerCase();
    const caption = String(media?.caption || fallbackText || '').trim() || fallbackText;

    if (!previewId) {
      await ctx.reply(fallbackText, extra);
      return;
    }

    if (previewMime === 'photo' || previewMime === 'image') {
      await ctx.replyWithPhoto(previewId, { caption, ...extra });
      return;
    }

    if (previewMime === 'gif') {
      await ctx.replyWithAnimation(previewId, { caption, ...extra });
      return;
    }

    await ctx.replyWithVideo(previewId, { caption, ...extra });
  } catch (error) {
    logger.warn({ err: error, menuKey }, 'Falha ao enviar midia configurada do menu; fallback para texto');
    await ctx.reply(fallbackText, extra);
  }
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
    verifyWebhookRequest(req, res, next) {
      if (!env.telegramWebhookSecret) {
        logger.error('TELEGRAM_WEBHOOK_SECRET ausente; recusando webhook Telegram');
        return res.status(503).end();
      }

      const header = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (!safeCompare(header, env.telegramWebhookSecret)) {
        return res.status(401).end();
      }

      return next();
    },
    webhookMiddleware: () => bot.webhookCallback('/telegram'),
    async start() {
      const webhookUrl = new URL('/telegram', env.appBaseUrl).toString();
      await bot.telegram.setWebhook(webhookUrl, {
        secret_token: env.telegramWebhookSecret
      });
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
        return true;
      } catch (error) {
        logger.warn({ err: error, chatId }, 'Falha ao enviar mensagem Telegram');
        return false;
      }
    },
    async safeSendVideo(chatId, video, extra = {}) {
      try {
        await bot.telegram.sendVideo(chatId, video, extra);
        return true;
      } catch (error) {
        logger.warn({ err: error, chatId }, 'Falha ao enviar video Telegram');
        return false;
      }
    },
    async safeSendVoice(chatId, voice, extra = {}) {
      try {
        await bot.telegram.sendVoice(chatId, voice, extra);
        return true;
      } catch (error) {
        logger.warn({ err: error, chatId }, 'Falha ao enviar audio Telegram');
        return false;
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
    verifyWebhookRequest(req, res, next) {
      return next();
    },
    webhookMiddleware: () => (req, res) => res.status(503).end(),
    async start() {},
    async stop() {},
    async safeSendMessage() { return false; },
    async safeSendVideo() { return false; },
    async safeSendVoice() { return false; },
    async createVipInviteLink() {
      return null;
    },
    async removeVipMember() {}
  };
}

function registerHandlers(service) {
  const { bot } = service;
  const trackEvent = async (ctx, eventType, extra = {}) => {
    try {
      await remarketing.trackUserEvent({
        telegramUserId: ctx.from && ctx.from.id,
        telegramUsername: (ctx.from && ctx.from.username) || '',
        eventType,
        ...extra
      });
    } catch (error) {
      logger.warn({ err: error, eventType }, 'Falha ao registrar evento do usuario');
    }
  };

  bot.start(async (ctx) => {
    await trackEvent(ctx, 'bot_start');
    await replyWithConfiguredMenuMedia(
      ctx,
      'home',
      'Menu principal',
      mainMenu(env.instagramUrl, env.freeGroupUrl)
    );
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
    await trackEvent(ctx, 'menu_home');
    await replyWithConfiguredMenuMedia(
      ctx,
      'home',
      'Menu principal',
      mainMenu(env.instagramUrl, env.freeGroupUrl)
    );
  });

  bot.action('MENU_SUPORTE', async (ctx) => {
    await ctx.answerCbQuery();
    await trackEvent(ctx, 'menu_support');
    await ctx.reply('Suporte', supportMenu(env.supportWhatsappUrl));
  });

  bot.action('MENU_VIP', async (ctx) => {
    await ctx.answerCbQuery();
    await trackEvent(ctx, 'view_vip_menu', { targetType: 'vip' });
    const activeAccess = await vip.getActiveVipAccess(ctx.from.id);
    if (activeAccess) {
      return ctx.reply(`Seu VIP esta ativo ate ${new Date(activeAccess.expires_at).toLocaleString('pt-BR')}`);
    }

    const plans = await vip.listActivePlans();
    return replyWithConfiguredMenuMedia(
      ctx,
      'vip',
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
    await trackEvent(ctx, 'view_product_menu', { targetType: 'product' });
    await replyWithConfiguredMenuMedia(ctx, 'free', 'Conteudos avulsos');
    const items = await products.listCarouselProducts(20);
    return renderProductCarousel(ctx, items, 0);
  });

  bot.action(/^AV_(NEXT|PREV)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const items = await products.listCarouselProducts(20);
    if (items.length === 0) {
      return ctx.editMessageText('Nenhum conteudo disponivel no momento.');
    }

    const currentIndex = Number(ctx.match[2]);
    const nextIndex = ctx.match[1] === 'NEXT' ? currentIndex + 1 : currentIndex - 1;
    await trackEvent(ctx, 'carousel_navigate', {
      targetType: 'product',
      metadata: {
        direction: ctx.match[1].toLowerCase(),
        from_index: currentIndex,
        to_index: normalizeCarouselIndex(nextIndex, items.length)
      }
    });
    return renderProductCarousel(ctx, items, nextIndex);
  });

  bot.action('AV_NOOP', async (ctx) => {
    await ctx.answerCbQuery();
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

      const order = await createPendingOrder({
        provider: 'livepix',
        providerReference: payment.reference,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || '',
        targetType: 'vip',
        targetCode: plan.code,
        amountCents: plan.price_cents,
        rawPayload: payment.raw
      });
      await trackEvent(ctx, 'checkout_started', {
        targetType: 'vip',
        targetCode: plan.code,
        orderId: order.id
      });
      await remarketing.scheduleCheckoutRemarketing({
        orderId: order.id,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || '',
        targetType: 'vip',
        targetCode: plan.code
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

      const order = await createPendingOrder({
        provider: 'livepix',
        providerReference: payment.reference,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || '',
        targetType: 'product',
        productId: product.id,
        amountCents: product.price_cents,
        rawPayload: payment.raw
      });
      await trackEvent(ctx, 'checkout_started', {
        targetType: 'product',
        productId: product.id,
        orderId: order.id
      });
      await remarketing.scheduleCheckoutRemarketing({
        orderId: order.id,
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || '',
        targetType: 'product',
        productId: product.id
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
