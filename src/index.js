const { createApp } = require('./server');
const { createBotService } = require('./services/bot');
const { startJobs } = require('./jobs');
const db = require('./lib/db');
const env = require('./config/env');
const logger = require('./lib/logger');

async function main() {
  await db.migrate();

  const botService = await createBotService();
  const shouldRunJobs = env.appRole === 'worker' || (env.appRole === 'web' && env.runJobsInWeb);
  const app = createApp({ botService });
  const server = app.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        nodeEnv: env.nodeEnv,
        telegramEnabled: botService.enabled,
        jobsEnabled: shouldRunJobs
      },
      'Servidor iniciado'
    );
  });

  if (botService.enabled) {
    try {
      await botService.start();
    } catch (error) {
      logger.error({ err: error }, 'Falha ao iniciar webhook do Telegram; servidor segue ativo');
    }
  }

  const stopJobs = shouldRunJobs ? await startJobs({ botService }) : async () => {};

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.warn({ signal }, 'Encerrando aplicação');
    await stopJobs();

    try {
      await botService.stop();
    } catch (error) {
      logger.error({ err: error }, 'Falha ao encerrar bot');
    }

    await new Promise((resolve) => {
      server.close(resolve);
    });

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
  logger.fatal({ err: error }, 'Falha fatal na inicialização');
  process.exit(1);
});
