const logger = require('./logger');
const env = require('../config/env');
const vip = require('../services/vip');
const grants = require('../services/grants');
const contentLinks = require('../services/content-links');

let Queue;
let Worker;
let QueueScheduler;
let IORedis;

try {
  ({ Queue, Worker, QueueScheduler } = require('bullmq'));
  IORedis = require('ioredis');
} catch (error) {
  logger.warn({ err: error }, 'BullMQ/ioredis nao disponiveis; fila Redis desabilitada');
}

const JOBS = {
  EXPIRE_VIP_ACCESS: 'expire-vip-access',
  REVOKE_DRIVE_ACCESS: 'revoke-drive-access'
};

function createLocalScheduler() {
  const timers = [];

  return {
    mode: 'local',
    async startRecurring(jobName, everyMs, handler) {
      const run = async () => {
        try {
          await handler();
        } catch (error) {
          logger.error({ err: error, jobName }, 'Falha no job local');
        }
      };

      timers.push(setInterval(run, everyMs));
      await run();
    },
    async stop() {
      for (const timer of timers) {
        clearInterval(timer);
      }
    }
  };
}

function getJobHandler(jobName, { botService }) {
  if (jobName === JOBS.EXPIRE_VIP_ACCESS) {
    return async () => {
      const expired = await vip.expireVipAccesses();
      for (const row of expired) {
        if (botService.enabled) {
          await botService.removeVipMember(Number(row.telegram_user_id));
        }
      }
    };
  }

  if (jobName === JOBS.REVOKE_DRIVE_ACCESS) {
    return async () => {
      await grants.revokeExpiredDriveAccesses();
      await contentLinks.cleanupExpiredContentLinks();
    };
  }

  throw new Error(`Job desconhecido: ${jobName}`);
}

async function createRedisScheduler({ botService }) {
  if (!env.redisUrl || !Queue || !Worker || !IORedis) {
    return createLocalScheduler();
  }

  const connection = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

  connection.on('error', (error) => {
    logger.error({ err: error }, 'Erro na conexao Redis');
  });

  const queueName = `${env.redisQueuePrefix}:jobs`;
  const queue = new Queue(queueName, {
    connection,
    prefix: env.redisQueuePrefix,
    defaultJobOptions: {
      removeOnComplete: 200,
      removeOnFail: 200
    }
  });

  const scheduler = QueueScheduler
    ? new QueueScheduler(queueName, {
        connection,
        prefix: env.redisQueuePrefix
      })
    : null;

  const worker = new Worker(
    queueName,
    async (job) => {
      const handler = getJobHandler(job.name, { botService });
      await handler();
    },
    {
      connection,
      prefix: env.redisQueuePrefix,
      concurrency: 1
    }
  );

  worker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job && job.id, jobName: job && job.name }, 'Job Redis falhou');
  });

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, jobName: job.name }, 'Job Redis concluido');
  });

  return {
    mode: 'redis',
    async startRecurring(jobName, everyMs) {
      await queue.upsertJobScheduler(
        `${jobName}:scheduler`,
        {
          every: everyMs
        },
        {
          name: jobName,
          data: {}
        }
      );
    },
    async stop() {
      await worker.close();
      if (scheduler) {
        await scheduler.close();
      }
      await queue.close();
      await connection.quit();
    }
  };
}

async function createJobScheduler({ botService }) {
  try {
    const scheduler = await createRedisScheduler({ botService });
    logger.info({ mode: scheduler.mode }, 'Scheduler de jobs inicializado');
    return scheduler;
  } catch (error) {
    logger.error({ err: error }, 'Falha ao iniciar BullMQ; fallback para scheduler local');
    return createLocalScheduler();
  }
}

module.exports = {
  JOBS,
  createJobScheduler
};
