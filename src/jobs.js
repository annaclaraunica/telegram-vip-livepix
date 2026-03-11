const logger = require('./lib/logger');
const { JOBS, createJobScheduler } = require('./lib/queue');

async function startJobs({ botService }) {
  const scheduler = await createJobScheduler({ botService });

  await scheduler.startRecurring(JOBS.EXPIRE_VIP_ACCESS, 15 * 60 * 1000);
  await scheduler.startRecurring(JOBS.REVOKE_DRIVE_ACCESS, 30 * 60 * 1000);

  return async function stopJobs() {
    try {
      await scheduler.stop();
    } catch (error) {
      logger.error({ err: error }, 'Falha ao encerrar scheduler de jobs');
    }
  };
}

module.exports = {
  startJobs
};
