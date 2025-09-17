/**
 * TNT Corporate Lead System - Health Check Routes
 *
 * System health monitoring and status endpoints
 */

const express = require('express');
const { sequelize } = require('../database/connection');
const { getQueueStats } = require('../queues');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const { ExternalIntegration } = require('../models');

const router = express.Router();

/**
 * Basic health check endpoint
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();

  try {
    // Test database connection
    await sequelize.authenticate();

    const responseTime = Date.now() - startTime;

    res.json({
      status: 'healthy',
      service: 'TNT Corporate Lead Automation System',
      version: process.env.API_VERSION || 'v2',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      response_time_ms: responseTime,
      environment: process.env.NODE_ENV || 'development',
      business_goal: 'Sub-5-minute lead response time',
      revenue_target: '$15K+ monthly recovery'
    });

  } catch (error) {
    logger.error('Health check failed:', error);

    res.status(503).json({
      status: 'unhealthy',
      service: 'TNT Corporate Lead Automation System',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

/**
 * Detailed system health check
 */
router.get('/detailed', async (req, res) => {
  const startTime = Date.now();
  const healthReport = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    response_time_ms: 0,
    components: {}
  };

  try {
    // Database health
    try {
      const dbStart = Date.now();
      await sequelize.authenticate();
      healthReport.components.database = {
        status: 'healthy',
        response_time_ms: Date.now() - dbStart,
        details: {
          dialect: sequelize.getDialect(),
          pool: sequelize.connectionManager.pool
        }
      };
    } catch (error) {
      healthReport.components.database = {
        status: 'unhealthy',
        error: error.message
      };
      healthReport.status = 'degraded';
    }

    // Queue system health
    try {
      const queueStart = Date.now();
      const queueStats = await getQueueStats();
      healthReport.components.queues = {
        status: 'healthy',
        response_time_ms: Date.now() - queueStart,
        stats: queueStats
      };
    } catch (error) {
      healthReport.components.queues = {
        status: 'unhealthy',
        error: error.message
      };
      healthReport.status = 'degraded';
    }

    // Email service health
    try {
      const emailStart = Date.now();
      const emailHealth = await emailService.getHealthStatus();
      healthReport.components.email = {
        ...emailHealth,
        response_time_ms: Date.now() - emailStart
      };

      if (emailHealth.status !== 'healthy') {
        healthReport.status = 'degraded';
      }
    } catch (error) {
      healthReport.components.email = {
        status: 'unhealthy',
        error: error.message
      };
      healthReport.status = 'degraded';
    }

    // External integrations health
    try {
      const integrationStart = Date.now();
      const integrationHealth = await ExternalIntegration.getSystemHealth();
      healthReport.components.integrations = {
        status: integrationHealth.critical > 0 ? 'unhealthy' :
                integrationHealth.warning > 0 ? 'degraded' : 'healthy',
        response_time_ms: Date.now() - integrationStart,
        summary: integrationHealth
      };

      if (integrationHealth.critical > 0) {
        healthReport.status = 'degraded';
      }
    } catch (error) {
      healthReport.components.integrations = {
        status: 'unhealthy',
        error: error.message
      };
      healthReport.status = 'degraded';
    }

    // System resources
    healthReport.components.system = {
      status: 'healthy',
      details: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu_usage: process.cpuUsage(),
        node_version: process.version,
        platform: process.platform
      }
    };

    healthReport.response_time_ms = Date.now() - startTime;

    // Return appropriate status code
    const statusCode = healthReport.status === 'healthy' ? 200 :
                      healthReport.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(healthReport);

  } catch (error) {
    logger.error('Detailed health check failed:', error);

    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      response_time_ms: Date.now() - startTime
    });
  }
});

/**
 * Business metrics health check
 */
router.get('/business', async (req, res) => {
  try {
    // Query recent business metrics
    const results = await sequelize.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) as leads_today,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days') as leads_week,
        COUNT(*) FILTER (WHERE status = 'converted' AND created_at >= CURRENT_DATE) as conversions_today,
        AVG(
          EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60
        ) FILTER (WHERE li.created_at >= CURRENT_DATE) as avg_response_time_today,
        COUNT(*) FILTER (
          WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5
          AND li.created_at >= CURRENT_DATE
        ) as under_5min_today,
        COUNT(*) FILTER (WHERE li.created_at >= CURRENT_DATE) as total_responses_today
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
        AND li.created_at = (
          SELECT MIN(created_at)
          FROM lead_interactions
          WHERE lead_id = l.id AND interaction_type = 'email_sent'
        )
      WHERE l.created_at >= CURRENT_DATE - INTERVAL '7 days'
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    const metrics = results[0];
    const responseTimeTarget = 5; // TNT's 5-minute commitment
    const avgResponseTime = parseFloat(metrics.avg_response_time_today) || 0;
    const under5MinRate = metrics.total_responses_today > 0 ?
      (metrics.under_5min_today / metrics.total_responses_today) * 100 : 0;

    const businessHealth = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      tnt_commitment: {
        target_response_time_minutes: responseTimeTarget,
        current_avg_response_time: avgResponseTime,
        under_5min_rate_today: parseFloat(under5MinRate.toFixed(2)),
        meets_commitment: avgResponseTime <= responseTimeTarget
      },
      daily_metrics: {
        leads_today: parseInt(metrics.leads_today),
        conversions_today: parseInt(metrics.conversions_today),
        conversion_rate_today: metrics.leads_today > 0 ?
          ((metrics.conversions_today / metrics.leads_today) * 100).toFixed(2) : '0.00'
      },
      weekly_metrics: {
        leads_this_week: parseInt(metrics.leads_week)
      },
      business_goals: {
        revenue_target: '$15K+ monthly recovery',
        response_time_commitment: 'Sub-5-minute response',
        conversion_goal: '25%+ inquiry-to-booking rate'
      }
    };

    // Determine health status based on business metrics
    if (avgResponseTime > responseTimeTarget * 2) {
      businessHealth.status = 'unhealthy';
      businessHealth.alert = 'Response time significantly exceeds TNT commitment';
    } else if (avgResponseTime > responseTimeTarget) {
      businessHealth.status = 'degraded';
      businessHealth.alert = 'Response time exceeds TNT 5-minute commitment';
    }

    res.json(businessHealth);

  } catch (error) {
    logger.error('Business health check failed:', error);

    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

/**
 * Ready check for deployment health
 */
router.get('/ready', async (req, res) => {
  try {
    // Quick checks for essential services
    await sequelize.authenticate();

    res.json({
      status: 'ready',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

/**
 * Live check for load balancer
 */
router.get('/live', (req, res) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

module.exports = router;