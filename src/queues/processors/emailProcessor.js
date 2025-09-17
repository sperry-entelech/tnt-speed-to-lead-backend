/**
 * TNT Corporate Lead System - Email Queue Processor
 *
 * Processes email automation jobs for instant responses and follow-ups
 */

const { Lead, AutomatedResponse, LeadInteraction, EmailSequence } = require('../../models');
const logger = require('../../utils/logger');
const emailService = require('../../services/emailService');
const { createExternalServiceError } = require('../../middleware/errorHandler');

/**
 * Process instant email response (highest priority)
 * Target: Under 5 minutes per TNT commitment
 */
async function processInstantResponse(job) {
  const { leadId, templateName, timestamp } = job.data;
  const startTime = Date.now();

  try {
    logger.info('Processing instant email response:', {
      jobId: job.id,
      leadId,
      templateName,
      timestamp
    });

    // Fetch lead with full details
    const lead = await Lead.findByPk(leadId);
    if (!lead) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    // Find appropriate template
    let template;
    if (templateName) {
      template = await AutomatedResponse.findOne({
        where: { template_name: templateName, active: true }
      });
    } else {
      // Auto-select best template based on lead
      const templates = await AutomatedResponse.findActiveForLead(lead);
      template = templates.find(t => t.shouldTrigger(lead));
    }

    if (!template) {
      logger.warn('No suitable email template found:', { leadId, serviceType: lead.service_type });
      return { status: 'skipped', reason: 'no_template_found' };
    }

    // Render template with lead data
    const renderedEmail = template.renderTemplate(lead);

    // Send email
    const emailResult = await emailService.sendEmail({
      to: lead.email,
      subject: renderedEmail.subject,
      text: renderedEmail.content,
      html: renderedEmail.htmlContent,
      leadId: lead.id,
      templateName: template.template_name
    });

    // Record interaction
    const interaction = await LeadInteraction.create({
      lead_id: lead.id,
      interaction_type: 'email_sent',
      subject: renderedEmail.subject,
      content: renderedEmail.content,
      automated: true,
      template_used: template.template_name,
      email_message_id: emailResult.messageId
    });

    // Update template metrics
    await template.incrementSentCount();

    // Create follow-up sequence if this is the first email
    const existingSequences = await EmailSequence.findAll({
      where: { lead_id: lead.id, active: true }
    });

    if (existingSequences.length === 0) {
      const sequenceType = lead.lead_score >= 70 ? 'high_value_follow_up' :
                          lead.service_type === 'corporate' ? 'corporate_nurture' :
                          lead.service_type === 'wedding' ? 'wedding_follow_up' :
                          'standard_follow_up';

      await EmailSequence.createStandardSequence(lead.id, sequenceType);
    }

    const processingTime = Date.now() - startTime;

    logger.emailSent(lead.id, template.template_name, lead.email);
    logger.performanceMetric('instant_email_response_time', processingTime, {
      leadId: lead.id,
      templateName: template.template_name
    });

    return {
      status: 'sent',
      interactionId: interaction.id,
      templateUsed: template.template_name,
      processingTime,
      emailId: emailResult.messageId
    };

  } catch (error) {
    logger.error('Failed to process instant email response:', {
      jobId: job.id,
      leadId,
      error: error.message,
      stack: error.stack
    });

    throw createExternalServiceError(
      `Failed to send instant email response: ${error.message}`,
      'email_service',
      error
    );
  }
}

/**
 * Process follow-up email
 */
async function processFollowUp(job) {
  const { leadId, templateName, timestamp } = job.data;

  try {
    logger.info('Processing follow-up email:', {
      jobId: job.id,
      leadId,
      templateName,
      timestamp
    });

    const lead = await Lead.findByPk(leadId);
    if (!lead) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    // Skip if lead has already converted or been lost
    if (['converted', 'lost'].includes(lead.status)) {
      logger.info('Skipping follow-up for converted/lost lead:', { leadId, status: lead.status });
      return { status: 'skipped', reason: 'lead_closed' };
    }

    // Find template
    const template = await AutomatedResponse.findOne({
      where: { template_name: templateName, active: true }
    });

    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    // Check if we should still send (business hours, etc.)
    if (template.business_hours_only && !isBusinessHours()) {
      // Reschedule for next business hour
      const nextBusinessTime = getNextBusinessHour();
      const delay = nextBusinessTime - new Date();

      throw new Error(`RESCHEDULE:${Math.floor(delay / 1000)}`);
    }

    // Render and send email
    const renderedEmail = template.renderTemplate(lead);

    const emailResult = await emailService.sendEmail({
      to: lead.email,
      subject: renderedEmail.subject,
      text: renderedEmail.content,
      html: renderedEmail.htmlContent,
      leadId: lead.id,
      templateName: template.template_name
    });

    // Record interaction
    const interaction = await LeadInteraction.create({
      lead_id: lead.id,
      interaction_type: 'email_sent',
      subject: renderedEmail.subject,
      content: renderedEmail.content,
      automated: true,
      template_used: template.template_name,
      email_message_id: emailResult.messageId
    });

    // Update metrics
    await template.incrementSentCount();

    logger.emailSent(lead.id, template.template_name, lead.email);

    return {
      status: 'sent',
      interactionId: interaction.id,
      templateUsed: template.template_name,
      emailId: emailResult.messageId
    };

  } catch (error) {
    // Handle reschedule requests
    if (error.message.startsWith('RESCHEDULE:')) {
      const delaySeconds = parseInt(error.message.split(':')[1]);
      return { status: 'rescheduled', delaySeconds };
    }

    logger.error('Failed to process follow-up email:', {
      jobId: job.id,
      leadId,
      error: error.message
    });

    throw error;
  }
}

/**
 * Process email sequence step
 */
async function processSequenceStep(job) {
  const { sequenceId, timestamp } = job.data;

  try {
    logger.info('Processing email sequence step:', {
      jobId: job.id,
      sequenceId,
      timestamp
    });

    const sequence = await EmailSequence.findByPk(sequenceId, {
      include: [{ model: Lead, as: 'lead' }]
    });

    if (!sequence || !sequence.active) {
      logger.info('Sequence not found or inactive:', { sequenceId });
      return { status: 'skipped', reason: 'sequence_inactive' };
    }

    const lead = sequence.lead;

    // Skip if lead has converted or responded
    if (['converted', 'lost'].includes(lead.status)) {
      await sequence.complete();
      return { status: 'completed', reason: 'lead_closed' };
    }

    // Check for recent interactions (if customer responded, pause sequence)
    const recentInteractions = await LeadInteraction.findAll({
      where: {
        lead_id: lead.id,
        response_received: true,
        created_at: {
          [require('sequelize').Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
        }
      }
    });

    if (recentInteractions.length > 0) {
      await sequence.pause('customer_responded');
      return { status: 'paused', reason: 'customer_responded' };
    }

    // Get step template name
    const stepTemplates = {
      'standard_follow_up': ['instant_response', 'follow_up_3day', 'follow_up_7day', 'follow_up_14day'],
      'high_value_follow_up': ['instant_response', 'follow_up_2hour', 'follow_up_1day', 'follow_up_3day'],
      'corporate_nurture': ['corporate_instant_response', 'corporate_follow_up', 'corporate_proposal', 'corporate_final'],
      'wedding_follow_up': ['wedding_instant_response', 'wedding_follow_up', 'wedding_package', 'wedding_final']
    };

    const templates = stepTemplates[sequence.sequence_name] || stepTemplates['standard_follow_up'];
    const templateName = templates[sequence.current_step - 1];

    if (!templateName) {
      await sequence.complete();
      return { status: 'completed', reason: 'sequence_finished' };
    }

    // Send the email
    const followUpResult = await processFollowUp({
      id: `sequence-${sequence.id}-${sequence.current_step}`,
      data: {
        leadId: lead.id,
        templateName,
        timestamp
      }
    });

    if (followUpResult.status === 'sent') {
      // Record sequence progress
      await sequence.recordEmailSent();
      await sequence.advance();
    }

    return {
      status: 'step_completed',
      currentStep: sequence.current_step,
      totalSteps: sequence.total_steps,
      emailResult: followUpResult
    };

  } catch (error) {
    logger.error('Failed to process sequence step:', {
      jobId: job.id,
      sequenceId,
      error: error.message
    });

    throw error;
  }
}

/**
 * Check if current time is within business hours
 */
function isBusinessHours() {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();

  // TNT business hours: Monday-Friday 6 AM - 10 PM, Saturday-Sunday 8 AM - 8 PM
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const minHour = isWeekend ? 8 : 6;
  const maxHour = isWeekend ? 20 : 22;

  return hour >= minHour && hour < maxHour;
}

/**
 * Get next business hour
 */
function getNextBusinessHour() {
  const now = new Date();
  const next = new Date(now);

  // Move to next hour
  next.setHours(next.getHours() + 1, 0, 0, 0);

  // Adjust for business hours
  while (!isBusinessHours(next)) {
    next.setHours(next.getHours() + 1);
  }

  return next;
}

module.exports = {
  processInstantResponse,
  processFollowUp,
  processSequenceStep
};