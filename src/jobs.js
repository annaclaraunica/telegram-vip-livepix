const db = require('./lib/db');
const logger = require('./lib/logger');
const { JOBS, createJobScheduler } = require('./lib/queue');
const vip = require('./services/vip');
const grants = require('./services/grants');
const contentLinks = require('./services/content-links');
const remarketing = require('./services/remarketing');

async function acquireJobLock(jobName, leaseMs) {
  const result = await db.query(
    `INSERT INTO job_locks (job_name, locked_until, updated_at)
     VALUES ($1, NOW() + ($2 * INTERVAL '1 millisecond'), NOW())
     ON CONFLICT (job_name)
     DO UPDATE
     SET locked_until = EXCLUDED.locked_until,
         updated_at = NOW()
     WHERE job_locks.locked_until <= NOW()
     RETURNING job_name, locked_until`,
    [jobName, leaseMs]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

async function releaseJobLock(jobName) {
  await db.query(
    `UPDATE job_locks
     SET locked_until = NOW(), updated_at = NOW()
     WHERE job_name = $1`,
    [jobName]
  );
}

async function runLockedJob(jobName, leaseMs, handler) {
  const lock = await acquireJobLock(jobName, leaseMs);
  if (!lock) {
    logger.debug({ jobName }, 'Job ignorado porque outro processo possui o lock');
    return { skipped: true, reason: 'lock_not_acquired' };
  }

  const startedAt = Date.now();
  logger.info({ jobName, lockedUntil: lock.locked_until }, 'Job iniciado');

  try {
    const result = await handler();
    logger.info(
      {
        jobName,
        duration_ms: Date.now() - startedAt,
        result
      },
      'Job concluido com sucesso'
    );
    return { skipped: false, result };
  } catch (error) {
    logger.error(
      {
        err: error,
        jobName,
        duration_ms: Date.now() - startedAt
      },
      'Job falhou'
    );
    throw error;
  } finally {
    await releaseJobLock(jobName);
  }
}

function createJobHandler(jobName, { botService }) {
  if (jobName === JOBS.EXPIRE_VIP_ACCESS) {
    return async () => {
      const { expiredUsers, expiredCount } = await vip.expireVipAccesses();
      let removalFailures = 0;

      for (const row of expiredUsers) {
        if (!botService.enabled) {
          continue;
        }

        try {
          await botService.removeVipMember(Number(row.telegram_user_id));
        } catch (error) {
          removalFailures += 1;
          logger.warn({ err: error, telegramUserId: row.telegram_user_id }, 'Falha ao remover membro VIP expirado');
        }
      }

      return {
        expiredCount,
        removalFailures
      };
    };
  }

  if (jobName === JOBS.REVOKE_DRIVE_ACCESS) {
    return async () => {
      const revokeResult = await grants.revokeExpiredDriveAccesses();
      const expiredLinksDeleted = await contentLinks.cleanupExpiredContentLinks();

      return {
        ...revokeResult,
        expiredLinksDeleted
      };
    };
  }

  if (jobName === JOBS.PROCESS_REMARKETING) {
    return async () => {
      return remarketing.processDueMessages({ botService });
    };
  }

  throw new Error(`Job desconhecido: ${jobName}`);
}

async function runJobNow(jobName, { botService }) {
  const everyMsByJob = {
    [JOBS.EXPIRE_VIP_ACCESS]: 15 * 60 * 1000,
    [JOBS.REVOKE_DRIVE_ACCESS]: 30 * 60 * 1000,
    [JOBS.PROCESS_REMARKETING]: 5 * 60 * 1000
  };

  const leaseMs = everyMsByJob[jobName];
  if (!leaseMs) {
    throw new Error(`Job desconhecido: ${jobName}`);
  }

  const handler = createJobHandler(jobName, { botService });
  return runLockedJob(jobName, leaseMs, handler);
}

async function startJobs({ botService }) {
  const scheduler = await createJobScheduler({ botService });
  const registerRecurringJob = async (jobName, everyMs) => {
    const handler = createJobHandler(jobName, { botService });
    await scheduler.startRecurring(jobName, everyMs, () => runLockedJob(jobName, everyMs, handler));
  };

  await registerRecurringJob(JOBS.EXPIRE_VIP_ACCESS, 15 * 60 * 1000);
  await registerRecurringJob(JOBS.REVOKE_DRIVE_ACCESS, 30 * 60 * 1000);
  await registerRecurringJob(JOBS.PROCESS_REMARKETING, 5 * 60 * 1000);

  return async function stopJobs() {
    try {
      await scheduler.stop();
    } catch (error) {
      logger.error({ err: error }, 'Falha ao encerrar scheduler de jobs');
    }
  };
}

module.exports = {
  startJobs,
  runJobNow
};
