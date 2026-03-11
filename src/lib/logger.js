const pino = require('pino');

const transport =
  process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard'
        }
      };

const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-telegram-bot-api-secret-token"]',
      'req.query.secret',
      'payload.customer.email',
      'payload.customer.phone',
      'buyer_email',
      'buyer_phone',
      'adminPass',
      'livepixClientSecret',
      'telegramBotToken',
      'openaiApiKey',
      'webhookSecret',
      'telegramWebhookSecret'
    ],
    censor: '[REDACTED]'
  },
  transport
});

module.exports = logger;
