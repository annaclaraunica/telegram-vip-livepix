const db = require('./lib/db');
const env = require('./config/env');
const logger = require('./lib/logger');
const { createBotService } = require('./services/bot');
const { startJobs } = require('./jobs');

async function main() {
  await db.migrate();

  const botService = await createBotService();
  const stopJobs = await startJobs({ botService });

  logger.info(
    {
      appRole: 'worker',
      nodeEnv: env.nodeEnv,
      telegramEnabled: botService.enabled
    },
    'Worker iniciado'
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.warn({ signal }, 'Encerrando worker');
    await stopJobs();

    try {
      await botService.stop();
    } catch (error) {
      logger.error({ err: error }, 'Falha ao encerrar bot no worker');
    }

    await db.close();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaughtException');
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Falha fatal na inicializacao do worker');
  process.exit(1);
});
