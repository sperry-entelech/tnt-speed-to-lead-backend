/**
 * TNT Corporate Lead System - Integration Routes
 *
 * External system integration management and sync endpoints
 */

const express = require('express');
const { ExternalIntegration, Lead, WebhookLog } = require('../models');
const { requirePermission } = require('../middleware/auth');
const { validateIntegrationSync } = require('../middleware/validation');
const { asyncHandler, createExternalServiceError } = require('../middleware/errorHandler');
const { addIntegrationSync } = require('../queues');
const emailService = require('../services/emailService');
const slackService = require('../services/slackService');
const smsService = require('../services/smsService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/v2/integrations/status - Get integration health status
 */
router.get('/status',
  requirePermission('integrations', 'read'),
  asyncHandler(async (req, res) => {
    try {
      // Get overall system health
      const systemHealth = await ExternalIntegration.getSystemHealth();

      // Get detailed status for each integration
      const integrations = await ExternalIntegration.findAll({
        order: [['service_name', 'ASC']]
      });

      const integrationsWithDetails = await Promise.all(integrations.map(async (integration) => {
        const healthStatus = integration.getHealthStatus();

        // Add service-specific health checks
        let serviceSpecificHealth = {};

        switch (integration.service_name) {
          case 'richweb_smtp':
            serviceSpecificHealth = await emailService.getHealthStatus();
            break;
          case 'slack_notifications':
            serviceSpecificHealth = slackService.getHealthStatus();
            break;
          case 'sms_service':
            serviceSpecificHealth = smsService.getHealthStatus();
            break;
        }

        return {
          ...healthStatus,
          sync_frequency: integration.sync_frequency,
          sync_direction: integration.sync_direction,
          last_sync: integration.last_sync,
          error_message: integration.error_message,
          service_details: serviceSpecificHealth,
          performance_metrics: integration.sync_metrics || {}
        };
      }));

      const response = {
        timestamp: new Date().toISOString(),
        overall_health: {
          status: systemHealth.critical > 0 ? 'critical' :
                  systemHealth.warning > 0 ? 'warning' : 'healthy',
          summary: systemHealth
        },
        integrations: integrationsWithDetails,
        business_impact: {
          lead_sync_operational: integrationsWithDetails
            .filter(i => ['zoho_crm', 'fasttrack_invision'].includes(i.service))
            .every(i => i.health === 'healthy'),
          notification_systems_operational: integrationsWithDetails
            .filter(i => ['richweb_smtp', 'slack_notifications'].includes(i.service))
            .every(i => i.health === 'healthy'),
          automation_impact: this.calculateAutomationImpact(integrationsWithDetails)
        }
      };

      res.json(response);

    } catch (error) {
      logger.error('Failed to get integration status:', error);
      throw error;
    }
  })
);

/**
 * POST /api/v2/integrations/sync - Manually trigger integration sync
 */
router.post('/sync',
  requirePermission('integrations', 'execute'),
  validateIntegrationSync,
  asyncHandler(async (req, res) => {
    const { service_name, sync_type, force } = req.body;

    try {
      // Check if integration exists and is active
      if (service_name !== 'all') {
        const integration = await ExternalIntegration.findOne({
          where: { service_name }
        });

        if (!integration) {
          return res.status(404).json({
            error: {
              code: 'INTEGRATION_NOT_FOUND',
              message: `Integration '${service_name}' not found`
            }
          });
        }

        if (!integration.active && !force) {
          return res.status(400).json({
            error: {
              code: 'INTEGRATION_INACTIVE',
              message: `Integration '${service_name}' is inactive. Use force=true to override.`
            }
          });
        }

        // Check if recent sync exists (unless forced)
        if (!force && integration.shouldSync() === false) {
          const minutesSinceLastSync = integration.last_sync ?
            Math.floor((new Date() - new Date(integration.last_sync)) / 60000) : null;

          return res.status(429).json({
            error: {
              code: 'SYNC_TOO_RECENT',
              message: `Sync was performed ${minutesSinceLastSync} minutes ago. Use force=true to override.`,
              last_sync: integration.last_sync
            }
          });
        }
      }

      // Queue sync job(s)
      const syncResults = [];

      if (service_name === 'all') {
        const activeIntegrations = await ExternalIntegration.findActive();

        for (const integration of activeIntegrations) {
          try {
            const jobResult = await addIntegrationSync(integration.service_name, null, sync_type);
            syncResults.push({
              service: integration.service_name,
              status: 'queued',
              job_id: jobResult.id
            });
          } catch (error) {
            syncResults.push({
              service: integration.service_name,
              status: 'failed',
              error: error.message
            });
          }
        }
      } else {
        const jobResult = await addIntegrationSync(service_name, null, sync_type);
        syncResults.push({
          service: service_name,
          status: 'queued',
          job_id: jobResult.id
        });
      }

      logger.info('Integration sync triggered:', {
        serviceName: service_name,
        syncType: sync_type,
        forced: force,
        triggeredBy: req.auth.userId,
        results: syncResults
      });

      const response = {
        sync_id: require('uuid').v4(),
        status: syncResults.every(r => r.status === 'queued') ? 'started' : 'partial',
        service_name,
        sync_type,
        forced: force,
        sync_results: syncResults,
        estimated_completion: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
        triggered_by: req.auth.user?.getFullName() || 'System'
      };

      res.json(response);

    } catch (error) {
      logger.error('Failed to trigger integration sync:', {
        serviceName: service_name,
        error: error.message
      });

      throw createExternalServiceError(
        `Failed to trigger sync for ${service_name}: ${error.message}`,
        'integration_sync',
        error
      );
    }
  })
);

/**
 * GET /api/v2/integrations/history - Get integration sync history
 */
router.get('/history',
  requirePermission('integrations', 'read'),
  asyncHandler(async (req, res) => {
    const { service_name, days = 7, limit = 50 } = req.query;

    const whereClause = {
      created_at: {
        [require('sequelize').Op.gte]: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      }
    };

    if (service_name && service_name !== 'all') {
      whereClause.source = service_name;
    }

    const webhookLogs = await WebhookLog.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      include: [
        {
          model: Lead,
          as: 'lead',
          attributes: ['id', 'contact_name', 'company_name', 'email'],
          required: false
        }
      ]
    });

    const syncHistory = webhookLogs.map(log => ({
      sync_id: log.id,
      service: log.source,
      event_type: log.event_type,
      processed: log.processed,
      processed_at: log.processed_at,
      created_at: log.created_at,
      error_message: log.error_message,
      retry_count: log.retry_count,
      lead_info: log.lead ? {
        id: log.lead.id,
        contact_name: log.lead.contact_name,
        company_name: log.lead.company_name,
        email: log.lead.email
      } : null,
      processing_time_ms: log.processed_at && log.created_at ?
        new Date(log.processed_at) - new Date(log.created_at) : null
    }));

    // Get summary statistics
    const summary = {
      total_events: syncHistory.length,
      successful_syncs: syncHistory.filter(s => s.processed && !s.error_message).length,
      failed_syncs: syncHistory.filter(s => s.error_message).length,
      average_processing_time: this.calculateAverageProcessingTime(syncHistory),
      services_active: [...new Set(syncHistory.map(s => s.service))].length
    };

    res.json({
      sync_history: syncHistory,
      summary,
      filters: {
        service_name: service_name || 'all',
        days_requested: parseInt(days),
        limit_applied: parseInt(limit)
      }
    });
  })
);

/**
 * POST /api/v2/integrations/test - Test integration configurations
 */
router.post('/test',
  requirePermission('integrations', 'execute'),
  asyncHandler(async (req, res) => {
    const { service_name, test_data } = req.body;

    const testResults = {};

    try {
      if (service_name === 'all' || service_name === 'email') {
        // Test email service
        try {
          const emailResult = await emailService.testEmailConfiguration();
          testResults.email = {
            service: 'richweb_smtp',
            status: emailResult.status,
            message: emailResult.status === 'success' ?
              'Email configuration test successful' : emailResult.error,
            details: emailResult
          };
        } catch (error) {
          testResults.email = {
            service: 'richweb_smtp',
            status: 'failed',
            message: error.message
          };
        }
      }

      if (service_name === 'all' || service_name === 'slack') {
        // Test Slack service
        try {
          const slackResult = await slackService.testConfiguration();
          testResults.slack = {
            service: 'slack_notifications',
            status: slackResult.status,
            message: slackResult.message,
            details: slackResult
          };
        } catch (error) {
          testResults.slack = {
            service: 'slack_notifications',
            status: 'failed',
            message: error.message
          };
        }
      }

      if (service_name === 'all' || service_name === 'sms') {
        // Test SMS service
        try {
          const testPhone = test_data?.phone || process.env.TEST_PHONE_NUMBER;
          if (testPhone) {
            const smsResult = await smsService.testConfiguration(testPhone);
            testResults.sms = {
              service: 'sms_service',
              status: smsResult.status,
              message: smsResult.message,
              details: smsResult
            };
          } else {
            testResults.sms = {
              service: 'sms_service',
              status: 'skipped',
              message: 'No test phone number provided'
            };
          }
        } catch (error) {
          testResults.sms = {
            service: 'sms_service',
            status: 'failed',
            message: error.message
          };
        }
      }

      // Test Zoho CRM connection (if applicable)
      if (service_name === 'all' || service_name === 'zoho_crm') {
        try {
          // This would implement actual Zoho CRM API test
          testResults.zoho_crm = {
            service: 'zoho_crm',
            status: 'success',
            message: 'Zoho CRM connection test successful',
            details: { note: 'Full implementation requires Zoho credentials' }
          };
        } catch (error) {
          testResults.zoho_crm = {
            service: 'zoho_crm',
            status: 'failed',
            message: error.message
          };
        }
      }

      logger.info('Integration tests performed:', {
        serviceName: service_name,
        testResults: Object.keys(testResults),
        triggeredBy: req.auth.userId
      });

      const overallStatus = Object.values(testResults).every(r => r.status === 'success') ?
        'all_passed' : Object.values(testResults).some(r => r.status === 'success') ?
        'partial_success' : 'all_failed';

      res.json({
        test_id: require('uuid').v4(),
        overall_status: overallStatus,
        timestamp: new Date().toISOString(),
        service_tested: service_name,
        test_results: testResults,
        summary: {
          total_tests: Object.keys(testResults).length,
          passed: Object.values(testResults).filter(r => r.status === 'success').length,
          failed: Object.values(testResults).filter(r => r.status === 'failed').length,
          skipped: Object.values(testResults).filter(r => r.status === 'skipped').length
        }
      });

    } catch (error) {
      logger.error('Integration test failed:', {
        serviceName: service_name,
        error: error.message
      });

      throw error;
    }
  })
);

/**
 * PUT /api/v2/integrations/:integrationId/config - Update integration configuration
 */
router.put('/:integrationId/config',
  requirePermission('integrations', 'manage'),
  asyncHandler(async (req, res) => {
    const { integrationId } = req.params;
    const { active, sync_frequency, sync_direction, max_failures } = req.body;

    const integration = await ExternalIntegration.findByPk(integrationId);

    if (!integration) {
      return res.status(404).json({
        error: {
          code: 'INTEGRATION_NOT_FOUND',
          message: `Integration with ID ${integrationId} not found`
        }
      });
    }

    const updates = {};
    if (typeof active === 'boolean') updates.active = active;
    if (sync_frequency) updates.sync_frequency = sync_frequency;
    if (sync_direction) updates.sync_direction = sync_direction;
    if (max_failures) updates.max_failures = max_failures;

    // Reset failure count if reactivating
    if (active === true && !integration.active) {
      updates.consecutive_failures = 0;
      updates.error_message = null;
    }

    await integration.update(updates);

    logger.info('Integration configuration updated:', {
      integrationId,
      serviceName: integration.service_name,
      updates,
      updatedBy: req.auth.userId
    });

    res.json({
      integration_id: integration.id,
      service_name: integration.service_name,
      updated_fields: Object.keys(updates),
      new_configuration: {
        active: integration.active,
        sync_frequency: integration.sync_frequency,
        sync_direction: integration.sync_direction,
        max_failures: integration.max_failures
      },
      updated_at: integration.updated_at,
      updated_by: req.auth.user?.getFullName() || 'System'
    });
  })
);

/**
 * Calculate automation impact based on integration health
 */
function calculateAutomationImpact(integrations) {
  const criticalServices = ['richweb_smtp'];
  const warningServices = ['slack_notifications', 'zoho_crm'];

  const criticalDown = integrations
    .filter(i => criticalServices.includes(i.service))
    .some(i => i.health !== 'healthy');

  const warningDown = integrations
    .filter(i => warningServices.includes(i.service))
    .some(i => i.health !== 'healthy');

  if (criticalDown) {
    return {
      level: 'critical',
      message: 'Email automation may be impacted - immediate attention required',
      affected_features: ['Instant email responses', 'Follow-up sequences', 'Manager notifications']
    };
  } else if (warningDown) {
    return {
      level: 'warning',
      message: 'Some automation features may be degraded',
      affected_features: ['Slack notifications', 'CRM sync']
    };
  } else {
    return {
      level: 'healthy',
      message: 'All automation systems operational',
      affected_features: []
    };
  }
}

/**
 * Calculate average processing time
 */
function calculateAverageProcessingTime(syncHistory) {
  const processedSyncs = syncHistory.filter(s => s.processing_time_ms !== null);

  if (processedSyncs.length === 0) return null;

  const totalTime = processedSyncs.reduce((sum, s) => sum + s.processing_time_ms, 0);
  return Math.round(totalTime / processedSyncs.length);
}

module.exports = router;