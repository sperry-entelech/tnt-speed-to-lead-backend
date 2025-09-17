/**
 * TNT Corporate Lead System - Queue Management
 *
 * Bull queue system for background job processing including email automation
 */

const Bull = require('bull');
const Redis = require('redis');
const logger = require('../utils/logger');

// Queue instances
let emailQueue;
let notificationQueue;
let integrationQueue;
let analyticsQueue;

// Redis connection
let redisClient;

/**
 * Initialize Redis connection
 */
async function initializeRedis() {
  const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: process.env.REDIS_DB || 0,
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null
  };

  if (process.env.REDIS_URL) {
    redisClient = Redis.createClient(process.env.REDIS_URL);
  } else {
    redisClient = Redis.createClient(redisConfig);
  }

  redisClient.on('error', (err) => {
    logger.error('Redis connection error:', err);
  });

  redisClient.on('connect', () => {
    logger.info('✅ Redis connected successfully');
  });

  await redisClient.connect();
  return redisClient;
}

/**
 * Initialize all queues
 */
async function initializeQueues() {
  try {
    await initializeRedis();

    const queueConfig = {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: process.env.REDIS_DB || 0
      },
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 20,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      }
    };

    // Email automation queue - highest priority for 5-minute response time
    emailQueue = new Bull('email automation', queueConfig);
    emailQueue.process('instant_response', 10, require('./processors/emailProcessor').processInstantResponse);
    emailQueue.process('follow_up', 5, require('./processors/emailProcessor').processFollowUp);
    emailQueue.process('sequence_step', 5, require('./processors/emailProcessor').processSequenceStep);

    // Notification queue for manager alerts
    notificationQueue = new Bull('notifications', queueConfig);
    notificationQueue.process('high_value_alert', 10, require('./processors/notificationProcessor').processHighValueAlert);
    notificationQueue.process('response_time_alert', 10, require('./processors/notificationProcessor').processResponseTimeAlert);
    notificationQueue.process('slack_notification', 5, require('./processors/notificationProcessor').processSlackNotification);

    // Integration sync queue
    integrationQueue = new Bull('integrations', queueConfig);
    integrationQueue.process('zoho_sync', 3, require('./processors/integrationProcessor').processZohoSync);
    integrationQueue.process('fasttrack_sync', 3, require('./processors/integrationProcessor').processFasttrackSync);
    integrationQueue.process('webhook_replay', 5, require('./processors/integrationProcessor').processWebhookReplay);

    // Analytics calculation queue
    analyticsQueue = new Bull('analytics', queueConfig);
    analyticsQueue.process('daily_metrics', 1, require('./processors/analyticsProcessor').processDailyMetrics);
    analyticsQueue.process('response_time_metrics', 1, require('./processors/analyticsProcessor').processResponseTimeMetrics);

    // Queue event handlers
    setupQueueEventHandlers();

    // Schedule recurring jobs
    await scheduleRecurringJobs();

    logger.info('✅ All background queues initialized successfully');

  } catch (error) {
    logger.error('❌ Failed to initialize queues:', error);
    throw error;
  }
}

/**
 * Setup event handlers for all queues
 */
function setupQueueEventHandlers() {
  const queues = [
    { name: 'email', queue: emailQueue },
    { name: 'notification', queue: notificationQueue },
    { name: 'integration', queue: integrationQueue },
    { name: 'analytics', queue: analyticsQueue }
  ];

  queues.forEach(({ name, queue }) => {
    queue.on('completed', (job, result) => {
      logger.info(`${name} job completed:`, {
        jobId: job.id,
        jobType: job.name,
        duration: Date.now() - job.timestamp,
        result: typeof result === 'object' ? JSON.stringify(result) : result
      });
    });

    queue.on('failed', (job, err) => {
      logger.error(`${name} job failed:`, {
        jobId: job.id,
        jobType: job.name,
        error: err.message,
        attempts: job.attemptsMade,
        data: job.data
      });
    });

    queue.on('stalled', (job) => {
      logger.warn(`${name} job stalled:`, {
        jobId: job.id,
        jobType: job.name,
        data: job.data
      });
    });
  });
}

/**
 * Schedule recurring jobs
 */
async function scheduleRecurringJobs() {
  // Daily metrics calculation (runs at 1 AM EST)
  await analyticsQueue.add('daily_metrics', {}, {
    repeat: { cron: '0 1 * * *', tz: 'America/New_York' },
    removeOnComplete: 5,
    removeOnFail: 2
  });

  // Response time metrics (every 15 minutes during business hours)
  await analyticsQueue.add('response_time_metrics', {}, {
    repeat: { cron: '*/15 6-22 * * 1-5', tz: 'America/New_York' },
    removeOnComplete: 10,
    removeOnFail: 3
  });

  // Integration health check (every 30 minutes)
  await integrationQueue.add('health_check', {}, {
    repeat: { cron: '*/30 * * * *' },
    removeOnComplete: 5,
    removeOnFail: 2
  });

  // Email sequence processing (every 5 minutes)
  await emailQueue.add('process_sequences', {}, {
    repeat: { cron: '*/5 * * * *' },
    removeOnComplete: 10,
    removeOnFail: 3
  });

  logger.info('✅ Recurring jobs scheduled successfully');
}

/**
 * Add instant email response job (highest priority)
 */
async function addInstantEmailJob(leadId, templateName = null) {
  return emailQueue.add('instant_response', {
    leadId,
    templateName,
    timestamp: new Date().toISOString()
  }, {
    priority: 1, // Highest priority
    delay: 0, // No delay for instant response
    attempts: 5, // Extra attempts for critical job
    removeOnComplete: 100
  });
}

/**
 * Add follow-up email job
 */
async function addFollowUpEmailJob(leadId, delayMinutes = 0, templateName = null) {
  return emailQueue.add('follow_up', {
    leadId,
    templateName,
    timestamp: new Date().toISOString()
  }, {
    priority: 5,
    delay: delayMinutes * 60 * 1000, // Convert to milliseconds
    attempts: 3
  });
}

/**
 * Add email sequence step job
 */
async function addSequenceStepJob(sequenceId) {
  return emailQueue.add('sequence_step', {
    sequenceId,
    timestamp: new Date().toISOString()
  }, {
    priority: 7,
    attempts: 3
  });
}

/**
 * Add high-value lead notification
 */
async function addHighValueNotification(leadId, estimatedValue) {
  return notificationQueue.add('high_value_alert', {
    leadId,
    estimatedValue,
    timestamp: new Date().toISOString()
  }, {
    priority: 2, // High priority
    delay: 0, // Immediate
    attempts: 3
  });
}

/**
 * Add response time alert
 */
async function addResponseTimeAlert(leadId, minutesElapsed) {
  return notificationQueue.add('response_time_alert', {
    leadId,
    minutesElapsed,
    timestamp: new Date().toISOString()
  }, {
    priority: 3,
    delay: 0,
    attempts: 3
  });
}

/**
 * Add Slack notification job
 */
async function addSlackNotification(message, channel = 'general', priority = 5) {
  return notificationQueue.add('slack_notification', {
    message,
    channel,
    timestamp: new Date().toISOString()
  }, {
    priority,
    attempts: 2
  });
}

/**
 * Add integration sync job
 */
async function addIntegrationSync(serviceName, leadId = null, syncType = 'incremental') {
  const jobName = `${serviceName}_sync`;

  return integrationQueue.add(jobName, {
    serviceName,
    leadId,
    syncType,
    timestamp: new Date().toISOString()
  }, {
    priority: 8,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });
}

/**
 * Get queue statistics
 */
async function getQueueStats() {
  const stats = {};

  const queues = [
    { name: 'email', queue: emailQueue },
    { name: 'notification', queue: notificationQueue },
    { name: 'integration', queue: integrationQueue },
    { name: 'analytics', queue: analyticsQueue }
  ];

  for (const { name, queue } of queues) {
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed()
    ]);

    stats[name] = {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      total: waiting.length + active.length + completed.length + failed.length
    };
  }

  return stats;
}

/**
 * Clean up completed and failed jobs
 */
async function cleanupQueues() {
  const queues = [emailQueue, notificationQueue, integrationQueue, analyticsQueue];

  for (const queue of queues) {
    await queue.clean(24 * 60 * 60 * 1000, 'completed', 100); // Keep last 100 completed jobs for 24 hours
    await queue.clean(7 * 24 * 60 * 60 * 1000, 'failed', 50); // Keep last 50 failed jobs for 7 days
  }

  logger.info('✅ Queue cleanup completed');
}

/**
 * Gracefully close all queues
 */
async function closeQueues() {
  try {
    const queues = [emailQueue, notificationQueue, integrationQueue, analyticsQueue];

    await Promise.all(queues.map(queue => queue.close()));

    if (redisClient) {
      await redisClient.disconnect();
    }

    logger.info('✅ All queues closed successfully');
  } catch (error) {
    logger.error('❌ Error closing queues:', error);
  }
}

module.exports = {
  initializeQueues,
  closeQueues,
  cleanupQueues,
  getQueueStats,

  // Queue instances
  emailQueue: () => emailQueue,
  notificationQueue: () => notificationQueue,
  integrationQueue: () => integrationQueue,
  analyticsQueue: () => analyticsQueue,

  // Job creation helpers
  addInstantEmailJob,
  addFollowUpEmailJob,
  addSequenceStepJob,
  addHighValueNotification,
  addResponseTimeAlert,
  addSlackNotification,
  addIntegrationSync
};