/**
 * TNT Corporate Lead System - Lead Management Routes
 *
 * Core lead capture, scoring, and management API endpoints
 */

const express = require('express');
const { Op } = require('sequelize');
const { Lead, LeadInteraction, EmailSequence, Notification } = require('../models');
const {
  validateLeadCreate,
  validateLeadUpdate,
  validateLeadQuery,
  validateLeadId,
  validateInteractionCreate,
  validateBusinessHours,
  validateServiceArea,
  validateLeadScoring
} = require('../middleware/validation');
const { asyncHandler, createLeadError } = require('../middleware/errorHandler');
const { requirePermission } = require('../middleware/auth');
const {
  addInstantEmailJob,
  addHighValueNotification,
  addResponseTimeAlert,
  addIntegrationSync
} = require('../queues');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/v2/leads - Create new lead with automatic processing
 */
router.post('/',
  validateLeadCreate,
  validateBusinessHours,
  validateServiceArea,
  validateLeadScoring,
  asyncHandler(async (req, res) => {
    const startTime = Date.now();

    try {
      // Create lead with automatic scoring
      const lead = await Lead.create(req.body);

      logger.leadProcessed(lead.id, 'created', Date.now() - startTime);

      // Trigger immediate automation workflows
      const automationResults = {
        email_sent: false,
        notification_sent: false,
        crm_sync_queued: false
      };

      // 1. Send instant email response (highest priority for 5-minute commitment)
      try {
        await addInstantEmailJob(lead.id);
        automationResults.email_sent = true;
        logger.info('Instant email job queued', { leadId: lead.id });
      } catch (error) {
        logger.error('Failed to queue instant email:', { leadId: lead.id, error: error.message });
      }

      // 2. Send high-value lead notifications
      if (lead.isHighValue()) {
        try {
          await addHighValueNotification(lead.id, lead.estimated_value);
          automationResults.notification_sent = true;
          logger.info('High-value notification queued', { leadId: lead.id, value: lead.estimated_value });
        } catch (error) {
          logger.error('Failed to queue high-value notification:', { leadId: lead.id, error: error.message });
        }
      }

      // 3. Queue CRM integration sync
      try {
        await addIntegrationSync('zoho_crm', lead.id, 'incremental');
        automationResults.crm_sync_queued = true;
      } catch (error) {
        logger.error('Failed to queue CRM sync:', { leadId: lead.id, error: error.message });
      }

      // Response with automation status
      const response = {
        lead_id: lead.id,
        status: lead.status,
        lead_score: lead.lead_score,
        priority_level: lead.priority_level,
        automated_response_sent: automationResults.email_sent,
        manager_notified: automationResults.notification_sent,
        estimated_response_time: '3-5 minutes',
        next_actions: [
          automationResults.email_sent ? 'Automated email queued for immediate delivery' : 'Email automation failed - manual follow-up required',
          automationResults.notification_sent ? 'High-value lead notification sent to managers' : 'Standard lead processing',
          automationResults.crm_sync_queued ? 'CRM sync queued' : 'CRM sync failed - manual sync may be required',
          'Lead scoring and prioritization completed'
        ].filter(Boolean),
        processing_time_ms: Date.now() - startTime
      };

      res.status(201).json(response);

    } catch (error) {
      logger.error('Lead creation failed:', {
        error: error.message,
        body: req.body,
        processingTime: Date.now() - startTime
      });

      throw createLeadError(
        `Failed to create lead: ${error.message}`,
        null,
        'creation'
      );
    }
  })
);

/**
 * GET /api/v2/leads - Retrieve leads with filtering and pagination
 */
router.get('/',
  requirePermission('leads', 'read'),
  validateLeadQuery,
  asyncHandler(async (req, res) => {
    const {
      status,
      service_type,
      lead_score_min,
      date_from,
      date_to,
      search,
      page,
      limit,
      sort_by,
      sort_order
    } = req.query;

    // Build where clause
    const whereClause = {};

    if (status) whereClause.status = status;
    if (service_type) whereClause.service_type = service_type;
    if (lead_score_min) whereClause.lead_score = { [Op.gte]: lead_score_min };

    // Date range filter
    if (date_from || date_to) {
      whereClause.created_at = {};
      if (date_from) whereClause.created_at[Op.gte] = new Date(date_from);
      if (date_to) whereClause.created_at[Op.lte] = new Date(date_to);
    }

    // Full-text search
    if (search) {
      whereClause[Op.or] = [
        { company_name: { [Op.iLike]: `%${search}%` } },
        { contact_name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // Pagination
    const offset = (page - 1) * limit;

    // Execute query
    const { rows: leads, count: totalCount } = await Lead.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: LeadInteraction,
          as: 'interactions',
          limit: 1,
          order: [['created_at', 'DESC']],
          attributes: ['interaction_type', 'created_at']
        }
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit,
      offset,
      distinct: true
    });

    // Calculate additional metrics for each lead
    const leadsWithMetrics = leads.map(lead => {
      const leadData = lead.toJSON();
      const lastInteraction = leadData.interactions?.[0];

      return {
        lead_id: leadData.id,
        company_name: leadData.company_name,
        contact_name: leadData.contact_name,
        email: leadData.email,
        service_type: leadData.service_type,
        estimated_value: leadData.estimated_value,
        lead_score: leadData.lead_score,
        status: leadData.status,
        priority_level: leadData.priority_level,
        created_at: leadData.created_at,
        minutes_since_created: Math.floor((new Date() - new Date(leadData.created_at)) / 60000),
        last_interaction_type: lastInteraction?.interaction_type || null,
        last_interaction_at: lastInteraction?.created_at || null
      };
    });

    // Response with pagination info
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      leads: leadsWithMetrics,
      pagination: {
        page,
        limit,
        total_pages: totalPages,
        total_count: totalCount,
        has_next: page < totalPages,
        has_previous: page > 1
      },
      filters_applied: {
        status,
        service_type,
        lead_score_min,
        date_from,
        date_to,
        search
      },
      total_count: totalCount
    });
  })
);

/**
 * GET /api/v2/leads/:leadId - Get detailed lead information
 */
router.get('/:leadId',
  requirePermission('leads', 'read'),
  validateLeadId,
  asyncHandler(async (req, res) => {
    const { leadId } = req.params;

    const lead = await Lead.findByPk(leadId, {
      include: [
        {
          model: LeadInteraction,
          as: 'interactions',
          order: [['created_at', 'DESC']]
        },
        {
          model: EmailSequence,
          as: 'email_sequences',
          where: { active: true },
          required: false
        },
        {
          model: Notification,
          as: 'notifications',
          order: [['created_at', 'DESC']],
          limit: 5
        }
      ]
    });

    if (!lead) {
      return res.status(404).json({
        error: {
          code: 'LEAD_NOT_FOUND',
          message: `Lead with ID ${leadId} not found`
        }
      });
    }

    // Get scoring breakdown
    const scoringBreakdown = await require('../models/ScoringFactor').getScoreBreakdown(lead);

    // Calculate response time metrics
    const firstResponse = lead.interactions.find(i => i.interaction_type === 'email_sent');
    const responseTimeMinutes = firstResponse ?
      Math.floor((new Date(firstResponse.created_at) - new Date(lead.created_at)) / 60000) : null;

    const response = {
      ...lead.toJSON(),
      minutes_since_created: lead.getMinutesSinceCreated(),
      response_time_minutes: responseTimeMinutes,
      meets_response_commitment: responseTimeMinutes ? responseTimeMinutes <= 5 : null,
      scoring_breakdown: scoringBreakdown,
      business_metrics: {
        is_high_value: lead.isHighValue(),
        priority_label: lead.priority_level >= 4 ? 'High' : lead.priority_level >= 3 ? 'Medium' : 'Low',
        total_interactions: lead.interactions.length,
        email_interactions: lead.interactions.filter(i => i.interaction_type.includes('email')).length,
        phone_interactions: lead.interactions.filter(i => i.interaction_type === 'call_made').length
      }
    };

    res.json(response);
  })
);

/**
 * PUT /api/v2/leads/:leadId - Update lead information and status
 */
router.put('/:leadId',
  requirePermission('leads', 'update'),
  validateLeadId,
  validateLeadUpdate,
  asyncHandler(async (req, res) => {
    const { leadId } = req.params;
    const updates = req.body;

    const lead = await Lead.findByPk(leadId);

    if (!lead) {
      return res.status(404).json({
        error: {
          code: 'LEAD_NOT_FOUND',
          message: `Lead with ID ${leadId} not found`
        }
      });
    }

    const oldStatus = lead.status;

    // Update lead
    await lead.update(updates);

    // Log status changes
    if (updates.status && updates.status !== oldStatus) {
      logger.leadProcessed(lead.id, `status_changed_${oldStatus}_to_${updates.status}`);

      // Create interaction record for status change
      await LeadInteraction.create({
        lead_id: lead.id,
        interaction_type: updates.status === 'converted' ? 'meeting_scheduled' : 'call_made',
        subject: `Lead status updated to ${updates.status}`,
        content: updates.notes || `Lead status changed from ${oldStatus} to ${updates.status}`,
        automated: false,
        user_id: req.auth.userId
      });

      // Stop email sequences if converted or lost
      if (['converted', 'lost'].includes(updates.status)) {
        await EmailSequence.update(
          { active: false, completed_at: new Date() },
          { where: { lead_id: lead.id, active: true } }
        );
      }

      // Queue CRM sync for status changes
      await addIntegrationSync('zoho_crm', lead.id, 'incremental');
    }

    // Get updated lead with full details
    const updatedLead = await Lead.findByPk(leadId, {
      include: [
        {
          model: LeadInteraction,
          as: 'interactions',
          order: [['created_at', 'DESC']],
          limit: 5
        }
      ]
    });

    res.json({
      ...updatedLead.toJSON(),
      update_summary: {
        fields_updated: Object.keys(updates),
        status_changed: updates.status && updates.status !== oldStatus,
        old_status: oldStatus,
        new_status: updates.status,
        updated_by: req.auth.user?.getFullName() || 'System',
        updated_at: new Date().toISOString()
      }
    });
  })
);

/**
 * POST /api/v2/leads/:leadId/interactions - Record manual interaction
 */
router.post('/:leadId/interactions',
  requirePermission('leads', 'update'),
  validateLeadId,
  validateInteractionCreate,
  asyncHandler(async (req, res) => {
    const { leadId } = req.params;
    const interactionData = req.body;

    const lead = await Lead.findByPk(leadId);

    if (!lead) {
      return res.status(404).json({
        error: {
          code: 'LEAD_NOT_FOUND',
          message: `Lead with ID ${leadId} not found`
        }
      });
    }

    // Create interaction
    const interaction = await LeadInteraction.create({
      ...interactionData,
      lead_id: leadId,
      automated: false,
      user_id: req.auth.userId
    });

    // Update lead status if this is first contact
    if (lead.status === 'new' && ['call_made', 'email_sent'].includes(interaction.interaction_type)) {
      await lead.update({ status: 'contacted' });
    }

    logger.info('Manual interaction recorded:', {
      leadId,
      interactionType: interaction.interaction_type,
      userId: req.auth.userId
    });

    res.status(201).json({
      interaction_id: interaction.id,
      interaction_type: interaction.interaction_type,
      subject: interaction.subject,
      content: interaction.content,
      created_at: interaction.created_at,
      lead_status_updated: lead.status === 'new',
      recorded_by: req.auth.user?.getFullName() || 'System'
    });
  })
);

/**
 * GET /api/v2/leads/:leadId/interactions - Get interaction history
 */
router.get('/:leadId/interactions',
  requirePermission('leads', 'read'),
  validateLeadId,
  asyncHandler(async (req, res) => {
    const { leadId } = req.params;
    const { type } = req.query;

    const whereClause = { lead_id: leadId };
    if (type) whereClause.interaction_type = type;

    const interactions = await LeadInteraction.findAll({
      where: whereClause,
      include: [
        {
          model: require('../models').User,
          as: 'user',
          attributes: ['first_name', 'last_name', 'email'],
          required: false
        }
      ],
      order: [['created_at', 'DESC']]
    });

    const interactionsWithMetrics = interactions.map(interaction => ({
      interaction_id: interaction.id,
      interaction_type: interaction.interaction_type,
      subject: interaction.subject,
      content: interaction.content,
      automated: interaction.automated,
      template_used: interaction.template_used,
      created_at: interaction.created_at,
      email_opened_at: interaction.email_opened_at,
      email_clicked_at: interaction.email_clicked_at,
      response_received: interaction.response_received,
      user: interaction.user ? {
        name: interaction.user.getFullName(),
        email: interaction.user.email
      } : null,
      engagement_metrics: interaction.getEngagementRate()
    }));

    res.json(interactionsWithMetrics);
  })
);

/**
 * GET /api/v2/leads/high-priority - Get high-priority leads requiring immediate attention
 */
router.get('/high-priority',
  requirePermission('leads', 'read'),
  asyncHandler(async (req, res) => {
    const highPriorityLeads = await Lead.findHighPriority({
      include: [
        {
          model: LeadInteraction,
          as: 'interactions',
          limit: 1,
          order: [['created_at', 'DESC']],
          required: false
        }
      ],
      limit: 50
    });

    const leadsWithAlerts = highPriorityLeads.map(lead => {
      const minutesSinceCreated = lead.getMinutesSinceCreated();
      const needsResponseAlert = minutesSinceCreated > 5 && lead.status === 'new';

      return {
        ...lead.toJSON(),
        minutes_since_created: minutesSinceCreated,
        needs_immediate_attention: needsResponseAlert,
        alert_level: minutesSinceCreated > 10 ? 'critical' :
                    minutesSinceCreated > 5 ? 'urgent' : 'normal',
        recommended_action: needsResponseAlert ?
          'Immediate contact required - response time commitment exceeded' :
          'Standard high-priority follow-up'
      };
    });

    res.json({
      high_priority_leads: leadsWithAlerts,
      total_count: leadsWithAlerts.length,
      urgent_count: leadsWithAlerts.filter(l => l.alert_level === 'urgent').length,
      critical_count: leadsWithAlerts.filter(l => l.alert_level === 'critical').length,
      tnt_commitment: {
        target_response_time: '5 minutes',
        leads_exceeding_target: leadsWithAlerts.filter(l => l.minutes_since_created > 5).length
      }
    });
  })
);

module.exports = router;