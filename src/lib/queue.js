const logger = require('./logger');
const env = require('../config/env');

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
  REVOKE_DRIVE_ACCESS: 'revoke-drive-access',
  PROCESS_REMARKETING: 'process-remarketing'
};

let schedulerState = {
  mode: 'uninitialized',
  ready: false,
  registeredJobs: []
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
      schedulerState = {
        mode: 'stopped',
        ready: false,
        registeredJobs: []
      };
    }
  };
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
  const handlers = new Map();
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
      const handler = handlers.get(job.name);
      if (!handler) {
        throw new Error(`Job sem handler registrado: ${job.name}`);
      }
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
    async startRecurring(jobName, everyMs, handler) {
      handlers.set(jobName, handler);
      schedulerState = {
        mode: 'redis',
        ready: true,
        registeredJobs: [...new Set([...schedulerState.registeredJobs, jobName])]
      };
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
      schedulerState = {
        mode: 'stopped',
        ready: false,
        registeredJobs: []
      };
    }
  };
}

async function createJobScheduler({ botService }) {
  try {
    const scheduler = await createRedisScheduler({ botService });
    schedulerState = {
      mode: scheduler.mode,
      ready: true,
      registeredJobs: []
    };
    logger.info({ mode: scheduler.mode }, 'Scheduler de jobs inicializado');
    return scheduler;
  } catch (error) {
    logger.error({ err: error }, 'Falha ao iniciar BullMQ; fallback para scheduler local');
    const scheduler = createLocalScheduler();
    schedulerState = {
      mode: scheduler.mode,
      ready: true,
      registeredJobs: []
    };
    return scheduler;
  }
}

function getQueueStatus() {
  return { ...schedulerState };
}

module.exports = {
  JOBS,
  createJobScheduler,
  getQueueStatus
};
