/**
 * TNT Corporate Lead System - Request Validation Middleware
 *
 * Comprehensive request validation using Joi schemas
 */

const Joi = require('joi');
const { createValidationError } = require('./errorHandler');

/**
 * Common validation schemas
 */
const commonSchemas = {
  uuid: Joi.string().uuid().required(),
  email: Joi.string().email().max(255).required(),
  phone: Joi.string().pattern(/^\+?[1-9]\d{1,14}$/).optional(),
  url: Joi.string().uri().max(255).optional(),
  serviceType: Joi.string().valid('corporate', 'airport', 'wedding', 'hourly', 'events').required(),
  leadStatus: Joi.string().valid('new', 'contacted', 'qualified', 'converted', 'lost'),
  interactionType: Joi.string().valid('email_sent', 'email_opened', 'email_clicked', 'call_made', 'meeting_scheduled', 'sms_sent'),
  paginationQuery: {
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(25),
    sort_by: Joi.string().valid('created_at', 'lead_score', 'estimated_value', 'status').default('created_at'),
    sort_order: Joi.string().valid('asc', 'desc').default('desc')
  }
};

/**
 * Lead validation schemas
 */
const leadSchemas = {
  create: Joi.object({
    company_name: Joi.string().max(255).optional().allow(''),
    contact_name: Joi.string().max(255).required(),
    email: commonSchemas.email,
    phone: commonSchemas.phone,
    website: commonSchemas.url,
    service_type: commonSchemas.serviceType,
    service_date: Joi.date().iso().optional(),
    pickup_location: Joi.string().max(500).optional(),
    destination: Joi.string().max(500).optional(),
    passenger_count: Joi.number().integer().min(1).max(50).optional(),
    vehicle_preference: Joi.string().max(100).optional(),
    estimated_value: Joi.number().precision(2).min(0).max(99999.99).optional(),
    budget_tier: Joi.string().valid('economy', 'premium', 'luxury').optional(),
    company_size_estimate: Joi.number().integer().min(1).optional(),
    industry: Joi.string().max(100).optional(),
    source: Joi.string().max(100).default('website'),
    utm_source: Joi.string().max(100).optional(),
    utm_medium: Joi.string().max(100).optional(),
    utm_campaign: Joi.string().max(100).optional(),
    referrer_url: Joi.string().uri().optional(),
    service_area: Joi.string().max(100).optional(),
    distance_from_base: Joi.number().precision(2).min(0).optional(),
    custom_fields: Joi.object().optional()
  }),

  update: Joi.object({
    status: commonSchemas.leadStatus,
    estimated_value: Joi.number().precision(2).min(0).max(99999.99).optional(),
    notes: Joi.string().max(2000).optional(),
    converted_revenue: Joi.number().precision(2).min(0).optional(),
    lost_reason: Joi.string().max(255).optional(),
    priority_level: Joi.number().integer().min(1).max(5).optional()
  }).min(1),

  query: Joi.object({
    status: commonSchemas.leadStatus.optional(),
    service_type: commonSchemas.serviceType.optional(),
    lead_score_min: Joi.number().integer().min(0).max(100).optional(),
    date_from: Joi.date().iso().optional(),
    date_to: Joi.date().iso().optional(),
    search: Joi.string().max(255).optional(),
    ...commonSchemas.paginationQuery
  })
};

/**
 * Interaction validation schemas
 */
const interactionSchemas = {
  create: Joi.object({
    interaction_type: commonSchemas.interactionType.required(),
    subject: Joi.string().max(255).optional(),
    content: Joi.string().max(2000).required(),
    scheduled_for: Joi.date().iso().optional(),
    next_action: Joi.string().max(255).optional()
  }),

  query: Joi.object({
    type: commonSchemas.interactionType.optional(),
    ...commonSchemas.paginationQuery
  })
};

/**
 * Automation validation schemas
 */
const automationSchemas = {
  trigger: Joi.object({
    lead_id: commonSchemas.uuid,
    workflow_type: Joi.string().valid('instant_response', 'follow_up_sequence', 'manager_notification').required(),
    template_override: Joi.string().max(100).optional(),
    delay_minutes: Joi.number().integer().min(0).optional()
  }),

  templateCreate: Joi.object({
    template_name: Joi.string().max(100).required(),
    subject_line: Joi.string().max(255).required(),
    content: Joi.string().max(10000).required(),
    html_content: Joi.string().max(20000).optional(),
    trigger_conditions: Joi.object().required(),
    service_types: Joi.array().items(commonSchemas.serviceType.optional()).optional(),
    lead_score_min: Joi.number().integer().min(0).max(100).default(0),
    lead_score_max: Joi.number().integer().min(0).max(100).default(100),
    active: Joi.boolean().default(true),
    send_delay_minutes: Joi.number().integer().min(0).default(0),
    business_hours_only: Joi.boolean().default(true)
  }),

  performanceQuery: Joi.object({
    date_from: Joi.date().iso().optional(),
    date_to: Joi.date().iso().optional(),
    granularity: Joi.string().valid('hour', 'day', 'week', 'month').default('day')
  })
};

/**
 * Analytics validation schemas
 */
const analyticsSchemas = {
  conversionFunnelQuery: Joi.object({
    date_range: Joi.string().valid('7d', '30d', '90d', '1y').default('30d'),
    segment_by: Joi.string().valid('service_type', 'source', 'lead_score_tier').optional()
  }),

  responseTimeQuery: Joi.object({
    date_range: Joi.string().valid('7d', '30d', '90d').default('30d')
  })
};

/**
 * Integration validation schemas
 */
const integrationSchemas = {
  sync: Joi.object({
    service_name: Joi.string().valid('zoho_crm', 'fasttrack_invision', 'all').required(),
    sync_type: Joi.string().valid('full', 'incremental').default('incremental'),
    force: Joi.boolean().default(false)
  })
};

/**
 * Webhook validation schemas
 */
const webhookSchemas = {
  formSubmission: Joi.object({
    // Extends lead creation schema
    ...leadSchemas.create.describe().keys,
    form_id: Joi.string().optional(),
    page_url: Joi.string().uri().optional(),
    user_agent: Joi.string().optional(),
    ip_address: Joi.string().ip().optional()
  }),

  emailEngagement: Joi.object({
    event_type: Joi.string().valid('delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed').required(),
    message_id: Joi.string().required(),
    email: commonSchemas.email,
    timestamp: Joi.date().iso().optional(),
    url: Joi.string().uri().optional(),
    user_agent: Joi.string().optional()
  }),

  crmUpdate: Joi.object({
    event_type: Joi.string().valid('lead_created', 'lead_updated', 'deal_closed', 'contact_updated').required(),
    record_id: Joi.string().required(),
    external_id: Joi.string().optional(),
    data: Joi.object().required(),
    timestamp: Joi.date().iso().optional()
  })
};

/**
 * Create validation middleware for a specific schema
 */
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const dataToValidate = source === 'query' ? req.query :
                          source === 'params' ? req.params :
                          source === 'headers' ? req.headers :
                          req.body;

    const { error, value } = schema.validate(dataToValidate, {
      abortEarly: false,
      stripUnknown: true,
      convert: true
    });

    if (error) {
      const details = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value
      }));

      throw createValidationError('Request validation failed', details);
    }

    // Replace the original data with validated/converted data
    if (source === 'query') req.query = value;
    else if (source === 'params') req.params = value;
    else if (source === 'headers') req.headers = value;
    else req.body = value;

    next();
  };
};

/**
 * TNT-specific business validation rules
 */
const businessValidation = {
  /**
   * Validate TNT business hours for scheduling
   */
  validateBusinessHours: (req, res, next) => {
    const { service_date, business_hours_only } = req.body;

    if (service_date && business_hours_only !== false) {
      const serviceDateTime = new Date(service_date);
      const hour = serviceDateTime.getHours();
      const dayOfWeek = serviceDateTime.getDay();

      // TNT business hours: Monday-Friday 6 AM - 10 PM, Saturday-Sunday 8 AM - 8 PM
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const minHour = isWeekend ? 8 : 6;
      const maxHour = isWeekend ? 20 : 22;

      if (hour < minHour || hour >= maxHour) {
        throw createValidationError(
          'Service time is outside TNT business hours',
          [`TNT operates ${isWeekend ? '8 AM - 8 PM' : '6 AM - 10 PM'} ${isWeekend ? 'on weekends' : 'Monday-Friday'}`]
        );
      }
    }

    next();
  },

  /**
   * Validate service area coverage
   */
  validateServiceArea: (req, res, next) => {
    const { pickup_location, destination, distance_from_base } = req.body;

    // TNT primarily serves Richmond, VA metro area
    if (distance_from_base && distance_from_base > 150) {
      throw createValidationError(
        'Service location is outside TNT coverage area',
        ['TNT primarily serves the Richmond, VA metropolitan area and surrounding regions within 150 miles']
      );
    }

    next();
  },

  /**
   * Validate lead scoring requirements
   */
  validateLeadScoring: (req, res, next) => {
    const { service_type, estimated_value, passenger_count } = req.body;

    // Corporate bookings should have estimated value
    if (service_type === 'corporate' && (!estimated_value || estimated_value < 100)) {
      throw createValidationError(
        'Corporate bookings require estimated value of at least $100',
        ['Please provide a realistic estimated value for corporate transportation services']
      );
    }

    // Wedding bookings should have passenger count
    if (service_type === 'wedding' && (!passenger_count || passenger_count < 2)) {
      throw createValidationError(
        'Wedding transportation requires at least 2 passengers',
        ['Please specify the number of passengers for wedding transportation']
      );
    }

    next();
  },

  /**
   * Validate response time requirements
   */
  validateResponseTime: (req, res, next) => {
    const { lead_id } = req.params;
    const { priority_level } = req.body;

    // This would be implemented with database lookup to check actual response times
    // For now, we'll add the structure for future implementation
    req.responseTimeValidation = {
      leadId: lead_id,
      priorityLevel: priority_level,
      targetResponseTime: 5 // TNT's 5-minute commitment
    };

    next();
  }
};

/**
 * Validation middleware exports
 */
module.exports = {
  // Schema validation
  validate,

  // Specific endpoint validations
  validateLeadCreate: validate(leadSchemas.create),
  validateLeadUpdate: validate(leadSchemas.update),
  validateLeadQuery: validate(leadSchemas.query, 'query'),
  validateLeadId: validate(Joi.object({ leadId: commonSchemas.uuid }), 'params'),

  validateInteractionCreate: validate(interactionSchemas.create),
  validateInteractionQuery: validate(interactionSchemas.query, 'query'),

  validateAutomationTrigger: validate(automationSchemas.trigger),
  validateTemplateCreate: validate(automationSchemas.templateCreate),
  validateAutomationPerformanceQuery: validate(automationSchemas.performanceQuery, 'query'),

  validateConversionFunnelQuery: validate(analyticsSchemas.conversionFunnelQuery, 'query'),
  validateResponseTimeQuery: validate(analyticsSchemas.responseTimeQuery, 'query'),

  validateIntegrationSync: validate(integrationSchemas.sync),

  validateWebhookFormSubmission: validate(webhookSchemas.formSubmission),
  validateWebhookEmailEngagement: validate(webhookSchemas.emailEngagement),
  validateWebhookCrmUpdate: validate(webhookSchemas.crmUpdate),

  // Business validation
  ...businessValidation,

  // Schemas for external use
  schemas: {
    lead: leadSchemas,
    interaction: interactionSchemas,
    automation: automationSchemas,
    analytics: analyticsSchemas,
    integration: integrationSchemas,
    webhook: webhookSchemas,
    common: commonSchemas
  }
};