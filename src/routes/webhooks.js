/**
 * TNT Corporate Lead System - Webhook Routes
 *
 * Handles incoming webhooks from website forms, email providers, and CRM systems
 */

const express = require('express');
const { Lead, LeadInteraction, WebhookLog } = require('../models');
const { validateWebhookSignature } = require('../middleware/auth');
const {
  validateWebhookFormSubmission,
  validateWebhookEmailEngagement,
  validateWebhookCrmUpdate
} = require('../middleware/validation');
const { asyncHandler, createLeadError } = require('../middleware/errorHandler');
const {
  addInstantEmailJob,
  addHighValueNotification,
  addIntegrationSync
} = require('../queues');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /api/v2/webhooks/form-submission - Handle website form submissions
 * This is the primary lead capture endpoint for TNT's website
 */
router.post('/form-submission',
  validateWebhookFormSubmission,
  asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const clientIP = req.ip || req.connection.remoteAddress;

    try {
      // Log webhook for debugging and replay
      const webhookLog = await WebhookLog.createFromRequest(
        'website_form',
        'form_submission',
        req.body,
        req.headers,
        clientIP
      );

      logger.info('Website form submission received:', {
        webhookId: webhookLog.id,
        email: req.body.email,
        serviceType: req.body.service_type,
        estimatedValue: req.body.estimated_value,
        ip: clientIP
      });

      // Extract and clean lead data
      const leadData = {
        company_name: req.body.company_name || '',
        contact_name: req.body.contact_name,
        email: req.body.email,
        phone: req.body.phone || null,
        website: req.body.website || null,
        service_type: req.body.service_type,
        service_date: req.body.service_date ? new Date(req.body.service_date) : null,
        pickup_location: req.body.pickup_location || null,
        destination: req.body.destination || null,
        passenger_count: req.body.passenger_count || null,
        vehicle_preference: req.body.vehicle_preference || null,
        estimated_value: req.body.estimated_value || null,
        budget_tier: req.body.budget_tier || null,
        industry: req.body.industry || null,
        source: 'website',
        utm_source: req.body.utm_source || null,
        utm_medium: req.body.utm_medium || null,
        utm_campaign: req.body.utm_campaign || null,
        referrer_url: req.body.page_url || null,
        custom_fields: {
          form_id: req.body.form_id,
          page_url: req.body.page_url,
          user_agent: req.body.user_agent || req.headers['user-agent'],
          ip_address: clientIP,
          ...req.body.custom_fields
        }
      };

      // Check for duplicate leads (same email within 24 hours)
      const existingLead = await Lead.findOne({
        where: {
          email: leadData.email,
          created_at: {
            [require('sequelize').Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      });

      if (existingLead) {
        logger.warn('Duplicate lead submission detected:', {
          email: leadData.email,
          existingLeadId: existingLead.id,
          webhookId: webhookLog.id
        });

        await webhookLog.markProcessed(existingLead.id);

        return res.json({
          processing_id: webhookLog.id,
          status: 'processed',
          lead_created: false,
          lead_id: existingLead.id,
          message: 'Duplicate submission - existing lead updated',
          estimated_response_time: '1-2 minutes'
        });
      }

      // Create new lead
      const lead = await Lead.create(leadData);
      await webhookLog.markProcessed(lead.id);

      logger.leadProcessed(lead.id, 'created_from_webhook', Date.now() - startTime);

      // Queue immediate automation workflows
      const actions = [];

      // 1. Instant email response (critical for 5-minute commitment)
      try {
        await addInstantEmailJob(lead.id);
        actions.push('Instant email response queued');
      } catch (error) {
        logger.error('Failed to queue instant email for webhook lead:', {
          leadId: lead.id,
          error: error.message
        });
        actions.push('Email automation failed - manual follow-up required');
      }

      // 2. High-value lead notifications
      if (lead.isHighValue()) {
        try {
          await addHighValueNotification(lead.id, lead.estimated_value);
          actions.push('High-value lead notification sent to managers');
        } catch (error) {
          logger.error('Failed to queue high-value notification:', {
            leadId: lead.id,
            error: error.message
          });
        }
      }

      // 3. CRM sync
      try {
        await addIntegrationSync('zoho_crm', lead.id);
        actions.push('CRM sync queued');
      } catch (error) {
        logger.error('Failed to queue CRM sync:', {
          leadId: lead.id,
          error: error.message
        });
      }

      const processingTime = Date.now() - startTime;

      res.json({
        processing_id: webhookLog.id,
        status: 'processed',
        lead_created: true,
        lead_id: lead.id,
        lead_score: lead.lead_score,
        priority_level: lead.priority_level,
        actions_taken: actions,
        estimated_response_time: lead.isHighValue() ? '2-3 minutes' : '3-5 minutes',
        processing_time_ms: processingTime,
        tnt_commitment: 'Sub-5-minute response guaranteed'
      });

    } catch (error) {
      logger.error('Webhook form submission processing failed:', {
        error: error.message,
        body: req.body,
        ip: clientIP
      });

      // Try to log the failed webhook
      try {
        const webhookLog = await WebhookLog.createFromRequest(
          'website_form',
          'form_submission_failed',
          req.body,
          req.headers,
          clientIP
        );
        await webhookLog.markFailed(error.message);
      } catch (logError) {
        logger.error('Failed to log webhook error:', logError);
      }

      throw createLeadError(
        `Webhook processing failed: ${error.message}`,
        null,
        'webhook_processing'
      );
    }
  })
);

/**
 * POST /api/v2/webhooks/email-engagement - Track email opens, clicks, bounces
 */
router.post('/email-engagement',
  validateWebhookSignature('email_provider'),
  validateWebhookEmailEngagement,
  asyncHandler(async (req, res) => {
    const { event_type, message_id, email, timestamp, url, user_agent } = req.body;

    try {
      // Log webhook
      const webhookLog = await WebhookLog.createFromRequest(
        'email_provider',
        `email_${event_type}`,
        req.body,
        req.headers,
        req.ip
      );

      logger.info('Email engagement webhook received:', {
        eventType: event_type,
        messageId: message_id,
        email,
        webhookId: webhookLog.id
      });

      // Find interaction by message ID
      const interaction = await LeadInteraction.findOne({
        where: { email_message_id: message_id },
        include: [{ model: Lead, as: 'lead' }]
      });

      if (!interaction) {
        logger.warn('Email interaction not found for engagement event:', {
          messageId: message_id,
          eventType: event_type
        });

        await webhookLog.markProcessed();
        return res.json({ status: 'processed', message: 'Interaction not found' });
      }

      // Process engagement event
      switch (event_type) {
        case 'opened':
          if (!interaction.email_opened_at) {
            await interaction.markOpened();

            // Update template metrics
            if (interaction.template_used) {
              const template = await require('../models').AutomatedResponse.findOne({
                where: { template_name: interaction.template_used }
              });
              if (template) {
                await template.incrementOpenedCount();
              }
            }

            logger.info('Email opened:', {
              leadId: interaction.lead_id,
              templateUsed: interaction.template_used
            });
          }
          break;

        case 'clicked':
          if (!interaction.email_clicked_at) {
            await interaction.markClicked(url);

            // Update template metrics
            if (interaction.template_used) {
              const template = await require('../models').AutomatedResponse.findOne({
                where: { template_name: interaction.template_used }
              });
              if (template) {
                await template.incrementClickedCount();
              }
            }

            logger.info('Email clicked:', {
              leadId: interaction.lead_id,
              url,
              templateUsed: interaction.template_used
            });
          }
          break;

        case 'bounced':
        case 'complained':
          // Handle bounces and complaints
          await interaction.update({
            response_content: `Email ${event_type}: ${req.body.reason || 'No reason provided'}`
          });

          // Update lead status if hard bounce
          if (event_type === 'bounced' && req.body.bounce_type === 'hard') {
            await interaction.lead.update({
              status: 'lost',
              notes: `Email hard bounced - invalid email address`
            });
          }

          logger.warn('Email delivery issue:', {
            leadId: interaction.lead_id,
            eventType: event_type,
            reason: req.body.reason
          });
          break;

        case 'unsubscribed':
          // Mark lead as unsubscribed
          await interaction.lead.update({
            custom_fields: {
              ...interaction.lead.custom_fields,
              email_unsubscribed: true,
              unsubscribed_at: new Date().toISOString()
            }
          });

          logger.info('Email unsubscribed:', {
            leadId: interaction.lead_id,
            email
          });
          break;
      }

      await webhookLog.markProcessed(interaction.lead_id, interaction.id);

      res.json({
        status: 'processed',
        interaction_id: interaction.id,
        lead_id: interaction.lead_id,
        event_processed: event_type
      });

    } catch (error) {
      logger.error('Email engagement webhook processing failed:', {
        error: error.message,
        eventType: event_type,
        messageId: message_id
      });

      res.status(500).json({
        status: 'failed',
        error: error.message
      });
    }
  })
);

/**
 * POST /api/v2/webhooks/crm-updates - Handle bidirectional CRM updates
 */
router.post('/crm-updates',
  validateWebhookSignature('zoho_crm'),
  validateWebhookCrmUpdate,
  asyncHandler(async (req, res) => {
    const { event_type, record_id, external_id, data, timestamp } = req.body;

    try {
      // Log webhook
      const webhookLog = await WebhookLog.createFromRequest(
        'zoho_crm',
        event_type,
        req.body,
        req.headers,
        req.ip
      );

      logger.info('CRM update webhook received:', {
        eventType: event_type,
        recordId: record_id,
        externalId: external_id,
        webhookId: webhookLog.id
      });

      let lead = null;

      // Find lead by external ID or Zoho ID
      if (external_id) {
        lead = await Lead.findByPk(external_id);
      } else if (record_id) {
        lead = await Lead.findOne({
          where: { zoho_lead_id: record_id }
        });
      }

      switch (event_type) {
        case 'lead_created':
          // Lead created in CRM - sync back if not exists
          if (!lead && data.Email) {
            const leadData = {
              company_name: data.Company || data.Account_Name || '',
              contact_name: `${data.First_Name || ''} ${data.Last_Name || ''}`.trim(),
              email: data.Email,
              phone: data.Phone || data.Mobile || null,
              service_type: data.Lead_Source === 'Corporate' ? 'corporate' : 'airport',
              estimated_value: data.Annual_Revenue || null,
              source: 'zoho_crm',
              zoho_lead_id: record_id
            };

            lead = await Lead.create(leadData);
            logger.info('Lead created from CRM webhook:', { leadId: lead.id });
          }
          break;

        case 'lead_updated':
          if (lead) {
            const updates = {};

            // Map CRM fields to lead fields
            if (data.Lead_Status) {
              const statusMap = {
                'Not Contacted': 'new',
                'Contacted': 'contacted',
                'Qualified': 'qualified',
                'Converted': 'converted',
                'Lost Lead': 'lost'
              };
              updates.status = statusMap[data.Lead_Status] || lead.status;
            }

            if (data.Annual_Revenue) {
              updates.estimated_value = parseFloat(data.Annual_Revenue);
            }

            if (Object.keys(updates).length > 0) {
              await lead.update(updates);
              logger.info('Lead updated from CRM webhook:', {
                leadId: lead.id,
                updates
              });
            }
          }
          break;

        case 'deal_closed':
          if (lead) {
            await lead.update({
              status: 'converted',
              converted_at: new Date(),
              custom_fields: {
                ...lead.custom_fields,
                crm_deal_value: data.Amount,
                crm_close_date: data.Closing_Date
              }
            });

            logger.info('Lead converted from CRM webhook:', {
              leadId: lead.id,
              dealValue: data.Amount
            });
          }
          break;
      }

      await webhookLog.markProcessed(lead?.id);

      res.json({
        status: 'synced',
        lead_id: lead?.id,
        event_processed: event_type,
        record_id
      });

    } catch (error) {
      logger.error('CRM webhook processing failed:', {
        error: error.message,
        eventType: event_type,
        recordId: record_id
      });

      res.status(500).json({
        status: 'failed',
        error: error.message
      });
    }
  })
);

/**
 * GET /api/v2/webhooks/health - Webhook system health check
 */
router.get('/health', asyncHandler(async (req, res) => {
  try {
    // Get recent webhook statistics
    const stats = await WebhookLog.getProcessingStats(7); // Last 7 days

    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      webhook_stats: stats,
      processing_summary: {
        total_webhooks: stats.reduce((sum, s) => sum + s.total, 0),
        success_rate: stats.length > 0 ?
          ((stats.reduce((sum, s) => sum + s.processed, 0) /
            stats.reduce((sum, s) => sum + s.total, 0)) * 100).toFixed(2) : '100.00'
      }
    };

    res.json(health);

  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}));

module.exports = router;