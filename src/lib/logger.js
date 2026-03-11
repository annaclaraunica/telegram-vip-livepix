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
  transport
});

module.exports = logger;
