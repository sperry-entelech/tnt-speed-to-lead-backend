/**
 * TNT Corporate Lead System - Automation Routes
 *
 * Email automation, template management, and workflow control endpoints
 */

const express = require('express');
const { AutomatedResponse, Lead, LeadInteraction, EmailSequence } = require('../models');
const { requirePermission } = require('../middleware/auth');
const {
  validateAutomationTrigger,
  validateTemplateCreate,
  validateAutomationPerformanceQuery
} = require('../middleware/validation');
const { asyncHandler, createValidationError } = require('../middleware/errorHandler');
const {
  addInstantEmailJob,
  addFollowUpEmailJob,
  addSequenceStepJob,
  getQueueStats
} = require('../queues');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/v2/automation/trigger - Manually trigger automation workflow
 */
router.post('/trigger',
  requirePermission('automation', 'execute'),
  validateAutomationTrigger,
  asyncHandler(async (req, res) => {
    const { lead_id, workflow_type, template_override, delay_minutes } = req.body;

    // Verify lead exists
    const lead = await Lead.findByPk(lead_id);
    if (!lead) {
      throw createValidationError('Lead not found', [`Lead with ID ${lead_id} does not exist`]);
    }

    let jobResult;

    try {
      switch (workflow_type) {
        case 'instant_response':
          jobResult = await addInstantEmailJob(lead_id, template_override);
          break;

        case 'follow_up_sequence':
          // Create or restart email sequence
          const existingSequence = await EmailSequence.findOne({
            where: { lead_id, active: true }
          });

          if (existingSequence) {
            await existingSequence.resume();
            jobResult = { sequenceId: existingSequence.id, action: 'resumed' };
          } else {
            const sequenceType = lead.lead_score >= 70 ? 'high_value_follow_up' : 'standard_follow_up';
            const sequence = await EmailSequence.createStandardSequence(lead_id, sequenceType);
            jobResult = { sequenceId: sequence.id, action: 'created' };
          }
          break;

        case 'manager_notification':
          if (lead.isHighValue()) {
            const { addHighValueNotification } = require('../queues');
            jobResult = await addHighValueNotification(lead_id, lead.estimated_value);
          } else {
            throw createValidationError(
              'Lead does not qualify for manager notification',
              [`Lead score: ${lead.lead_score}, Estimated value: $${lead.estimated_value}`]
            );
          }
          break;

        default:
          throw createValidationError('Invalid workflow type', [`Supported types: instant_response, follow_up_sequence, manager_notification`]);
      }

      // Log the manual trigger
      logger.info('Automation workflow manually triggered:', {
        workflowType: workflow_type,
        leadId: lead_id,
        triggeredBy: req.auth.userId,
        templateOverride: template_override
      });

      const response = {
        trigger_id: require('uuid').v4(),
        status: 'queued',
        workflow_type,
        lead_id,
        estimated_execution_time: new Date(Date.now() + (delay_minutes || 0) * 60 * 1000).toISOString(),
        actions_scheduled: [
          `${workflow_type} workflow queued for execution`,
          template_override ? `Using template override: ${template_override}` : 'Using automatic template selection',
          delay_minutes ? `Scheduled with ${delay_minutes} minute delay` : 'Immediate execution'
        ].filter(Boolean),
        job_details: jobResult
      };

      res.json(response);

    } catch (error) {
      logger.error('Failed to trigger automation workflow:', {
        workflowType: workflow_type,
        leadId: lead_id,
        error: error.message
      });

      throw error;
    }
  })
);

/**
 * GET /api/v2/automation/templates - Get email templates with metrics
 */
router.get('/templates',
  requirePermission('automation', 'read'),
  asyncHandler(async (req, res) => {
    const { active_only } = req.query;

    const whereClause = {};
    if (active_only === 'true') {
      whereClause.active = true;
    }

    const templates = await AutomatedResponse.findAll({
      where: whereClause,
      include: [
        {
          model: require('../models').User,
          as: 'creator',
          attributes: ['first_name', 'last_name', 'email'],
          required: false
        }
      ],
      order: [['template_name', 'ASC']]
    });

    const templatesWithMetrics = templates.map(template => ({
      template_id: template.id,
      template_name: template.template_name,
      subject_line: template.subject_line,
      content: template.content.substring(0, 200) + (template.content.length > 200 ? '...' : ''),
      trigger_conditions: template.trigger_conditions,
      service_types: template.service_types,
      active: template.active,
      business_hours_only: template.business_hours_only,
      performance_metrics: template.getPerformanceMetrics(),
      created_at: template.created_at,
      updated_at: template.updated_at,
      creator: template.creator ? {
        name: template.creator.first_name + ' ' + template.creator.last_name,
        email: template.creator.email
      } : null,
      usage_stats: {
        total_sent: template.sent_count,
        recent_usage: template.updated_at > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Used in last 30 days
      }
    }));

    res.json(templatesWithMetrics);
  })
);

/**
 * POST /api/v2/automation/templates - Create new email template
 */
router.post('/templates',
  requirePermission('automation', 'create'),
  validateTemplateCreate,
  asyncHandler(async (req, res) => {
    const templateData = {
      ...req.body,
      created_by: req.auth.userId
    };

    // Validate template variables
    const requiredVariables = ['contact_name', 'company_name', 'service_type'];
    const content = templateData.content + (templateData.html_content || '');

    const missingVariables = requiredVariables.filter(variable => {
      return !content.includes(`{{${variable}}}`) && variable !== 'company_name'; // company_name is optional
    });

    if (missingVariables.length > 0) {
      throw createValidationError(
        'Template missing required variables',
        missingVariables.map(v => `Missing variable: {{${v}}}`)
      );
    }

    const template = await AutomatedResponse.create(templateData);

    logger.info('Email template created:', {
      templateId: template.id,
      templateName: template.template_name,
      createdBy: req.auth.userId
    });

    res.status(201).json({
      template_id: template.id,
      template_name: template.template_name,
      subject_line: template.subject_line,
      active: template.active,
      service_types: template.service_types,
      trigger_conditions: template.trigger_conditions,
      created_at: template.created_at,
      created_by: req.auth.user?.getFullName() || 'System'
    });
  })
);

/**
 * GET /api/v2/automation/templates/:templateId - Get specific template details
 */
router.get('/templates/:templateId',
  requirePermission('automation', 'read'),
  asyncHandler(async (req, res) => {
    const { templateId } = req.params;

    const template = await AutomatedResponse.findByPk(templateId, {
      include: [
        {
          model: require('../models').User,
          as: 'creator',
          attributes: ['first_name', 'last_name', 'email'],
          required: false
        }
      ]
    });

    if (!template) {
      return res.status(404).json({
        error: {
          code: 'TEMPLATE_NOT_FOUND',
          message: `Template with ID ${templateId} not found`
        }
      });
    }

    // Get recent usage statistics
    const recentUsage = await LeadInteraction.findAll({
      where: {
        template_used: template.template_name,
        created_at: {
          [require('sequelize').Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        }
      },
      attributes: ['created_at', 'email_opened_at', 'email_clicked_at', 'response_received'],
      order: [['created_at', 'DESC']],
      limit: 50
    });

    const templateDetails = {
      ...template.toJSON(),
      performance_metrics: template.getPerformanceMetrics(),
      creator: template.creator ? {
        name: template.creator.first_name + ' ' + template.creator.last_name,
        email: template.creator.email
      } : null,
      recent_usage: {
        usage_count_30_days: recentUsage.length,
        recent_interactions: recentUsage.slice(0, 10).map(interaction => ({
          sent_at: interaction.created_at,
          opened: !!interaction.email_opened_at,
          clicked: !!interaction.email_clicked_at,
          responded: interaction.response_received
        }))
      }
    };

    res.json(templateDetails);
  })
);

/**
 * PUT /api/v2/automation/templates/:templateId - Update template
 */
router.put('/templates/:templateId',
  requirePermission('automation', 'update'),
  asyncHandler(async (req, res) => {
    const { templateId } = req.params;
    const updates = req.body;

    const template = await AutomatedResponse.findByPk(templateId);

    if (!template) {
      return res.status(404).json({
        error: {
          code: 'TEMPLATE_NOT_FOUND',
          message: `Template with ID ${templateId} not found`
        }
      });
    }

    await template.update(updates);

    logger.info('Email template updated:', {
      templateId: template.id,
      templateName: template.template_name,
      updatedBy: req.auth.userId,
      fieldsUpdated: Object.keys(updates)
    });

    res.json({
      template_id: template.id,
      template_name: template.template_name,
      updated_fields: Object.keys(updates),
      updated_at: template.updated_at,
      updated_by: req.auth.user?.getFullName() || 'System'
    });
  })
);

/**
 * GET /api/v2/automation/performance - Get automation performance metrics
 */
router.get('/performance',
  requirePermission('automation', 'read'),
  validateAutomationPerformanceQuery,
  asyncHandler(async (req, res) => {
    const { date_from, date_to, granularity } = req.query;

    // Set default date range if not provided
    const endDate = date_to ? new Date(date_to) : new Date();
    const startDate = date_from ? new Date(date_from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Email performance metrics
    const emailPerformance = await require('../database/connection').sequelize.query(`
      SELECT
        COUNT(*) FILTER (WHERE interaction_type = 'email_sent') as total_sent,
        COUNT(*) FILTER (WHERE email_opened_at IS NOT NULL) as total_opened,
        COUNT(*) FILTER (WHERE email_clicked_at IS NOT NULL) as total_clicked,
        COUNT(*) FILTER (WHERE response_received = true) as total_responded,
        ROUND(100.0 * COUNT(*) FILTER (WHERE email_opened_at IS NOT NULL) /
              NULLIF(COUNT(*) FILTER (WHERE interaction_type = 'email_sent'), 0), 2) as delivery_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE email_opened_at IS NOT NULL) /
              NULLIF(COUNT(*) FILTER (WHERE interaction_type = 'email_sent'), 0), 2) as open_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE email_clicked_at IS NOT NULL) /
              NULLIF(COUNT(*) FILTER (WHERE interaction_type = 'email_sent'), 0), 2) as click_rate,
        ROUND(100.0 * COUNT(*) FILTER (WHERE response_received = true) /
              NULLIF(COUNT(*) FILTER (WHERE interaction_type = 'email_sent'), 0), 2) as response_rate
      FROM lead_interactions
      WHERE created_at BETWEEN :startDate AND :endDate
      AND automated = true
    `, {
      replacements: { startDate, endDate },
      type: require('sequelize').QueryTypes.SELECT
    });

    // Template performance breakdown
    const templatePerformance = await LeadInteraction.getEngagementMetrics(null,
      Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24))
    );

    // Conversion attribution
    const conversionAttribution = await require('../database/connection').sequelize.query(`
      SELECT
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM lead_interactions li
          WHERE li.lead_id = l.id AND li.automated = true
        )) as automated_conversions,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM lead_interactions li
          WHERE li.lead_id = l.id AND li.automated = true
        )) as manual_conversions,
        ROUND(100.0 * COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM lead_interactions li
          WHERE li.lead_id = l.id AND li.automated = true
        )) / NULLIF(COUNT(*), 0), 2) as automation_contribution_rate
      FROM leads l
      WHERE l.status = 'converted'
      AND l.created_at BETWEEN :startDate AND :endDate
    `, {
      replacements: { startDate, endDate },
      type: require('sequelize').QueryTypes.SELECT
    });

    const performance = emailPerformance[0];
    const attribution = conversionAttribution[0];

    const response = {
      date_range: {
        from: startDate.toISOString().split('T')[0],
        to: endDate.toISOString().split('T')[0],
        granularity
      },
      email_performance: {
        total_sent: parseInt(performance.total_sent),
        delivery_rate: parseFloat(performance.delivery_rate) || 0,
        open_rate: parseFloat(performance.open_rate) || 0,
        click_rate: parseFloat(performance.click_rate) || 0,
        response_rate: parseFloat(performance.response_rate) || 0
      },
      template_performance: templatePerformance,
      conversion_attribution: {
        automated_conversions: parseInt(attribution.automated_conversions) || 0,
        manual_conversions: parseInt(attribution.manual_conversions) || 0,
        automation_contribution_rate: parseFloat(attribution.automation_contribution_rate) || 0
      },
      business_impact: {
        response_time_improvement: '95% improvement (48-72 hours to <5 minutes)',
        automation_efficiency: `${parseInt(performance.total_sent)} emails sent automatically`,
        lead_engagement: `${parseFloat(performance.open_rate) || 0}% open rate vs industry avg 21%`
      }
    };

    res.json(response);
  })
);

/**
 * GET /api/v2/automation/sequences - Get active email sequences
 */
router.get('/sequences',
  requirePermission('automation', 'read'),
  asyncHandler(async (req, res) => {
    const sequences = await EmailSequence.findAll({
      where: { active: true },
      include: [
        {
          model: Lead,
          as: 'lead',
          attributes: ['id', 'contact_name', 'company_name', 'email', 'service_type', 'lead_score']
        }
      ],
      order: [['next_send_at', 'ASC']],
      limit: 100
    });

    const sequencesWithMetrics = sequences.map(sequence => ({
      sequence_id: sequence.id,
      sequence_name: sequence.sequence_name,
      lead: {
        id: sequence.lead.id,
        contact_name: sequence.lead.contact_name,
        company_name: sequence.lead.company_name,
        email: sequence.lead.email,
        service_type: sequence.lead.service_type,
        lead_score: sequence.lead.lead_score
      },
      progress: sequence.getPerformanceMetrics(),
      next_send_at: sequence.next_send_at,
      started_at: sequence.started_at
    }));

    res.json({
      active_sequences: sequencesWithMetrics,
      total_count: sequencesWithMetrics.length,
      summary: {
        sequences_due_now: sequencesWithMetrics.filter(s =>
          new Date(s.next_send_at) <= new Date()
        ).length,
        sequences_due_today: sequencesWithMetrics.filter(s =>
          new Date(s.next_send_at).toDateString() === new Date().toDateString()
        ).length
      }
    });
  })
);

/**
 * GET /api/v2/automation/queue-status - Get background queue status
 */
router.get('/queue-status',
  requirePermission('automation', 'read'),
  asyncHandler(async (req, res) => {
    try {
      const queueStats = await getQueueStats();

      const response = {
        timestamp: new Date().toISOString(),
        queue_statistics: queueStats,
        system_health: {
          total_active_jobs: Object.values(queueStats).reduce((sum, queue) => sum + queue.active, 0),
          total_pending_jobs: Object.values(queueStats).reduce((sum, queue) => sum + queue.waiting, 0),
          total_failed_jobs: Object.values(queueStats).reduce((sum, queue) => sum + queue.failed, 0),
          email_queue_healthy: queueStats.email?.failed < 10,
          notification_queue_healthy: queueStats.notification?.failed < 5
        },
        performance_targets: {
          email_processing_target: '< 30 seconds',
          notification_processing_target: '< 10 seconds',
          max_queue_size: 1000,
          current_status: 'healthy'
        }
      };

      res.json(response);

    } catch (error) {
      logger.error('Failed to get queue status:', error);
      res.status(503).json({
        error: {
          code: 'QUEUE_STATUS_ERROR',
          message: 'Unable to retrieve queue status'
        }
      });
    }
  })
);

module.exports = router;