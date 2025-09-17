/**
 * TNT Corporate Lead System - Sequelize Models Index
 *
 * Central model registry and association definitions
 */

const { sequelize } = require('../database/connection');
const logger = require('../utils/logger');

// Import all models
const Lead = require('./Lead');
const LeadInteraction = require('./LeadInteraction');
const AutomatedResponse = require('./AutomatedResponse');
const EmailSequence = require('./EmailSequence');
const ExternalIntegration = require('./ExternalIntegration');
const WebhookLog = require('./WebhookLog');
const DailyMetric = require('./DailyMetric');
const ScoringFactor = require('./ScoringFactor');
const Notification = require('./Notification');
const User = require('./User');

// Initialize models with sequelize instance
const models = {
  Lead: Lead(sequelize),
  LeadInteraction: LeadInteraction(sequelize),
  AutomatedResponse: AutomatedResponse(sequelize),
  EmailSequence: EmailSequence(sequelize),
  ExternalIntegration: ExternalIntegration(sequelize),
  WebhookLog: WebhookLog(sequelize),
  DailyMetric: DailyMetric(sequelize),
  ScoringFactor: ScoringFactor(sequelize),
  Notification: Notification(sequelize),
  User: User(sequelize)
};

// Define associations
Object.keys(models).forEach(modelName => {
  if (models[modelName].associate) {
    models[modelName].associate(models);
  }
});

// Add sequelize instance to models object
models.sequelize = sequelize;

/**
 * Initialize database with default data
 */
async function initializeDatabase() {
  try {
    logger.info('🔄 Initializing database with default data...');

    // Create default automated response templates
    const defaultTemplates = [
      {
        template_name: 'corporate_instant_response',
        subject_line: 'TNT Limousine - Your Transportation Request [5-Minute Response]',
        content: `Dear {{contact_name}},

Thank you for contacting TNT Limousine for your corporate transportation needs. We have received your inquiry and a member of our team will contact you within the next 5 minutes.

TNT Limousine has been Richmond's premier transportation provider since 1992, serving corporate clients with:
- Certified airport access (Richmond, Dulles, Reagan, BWI)
- Professional chauffeurs with 15+ years experience
- National Limousine Association member
- Trust Analytica Top 10 Richmond limousine company

Your estimated service details:
- Service Type: {{service_type}}
- Date: {{service_date}}
- Estimated Value: ${{estimated_value}}

We will contact you shortly at {{phone}} to discuss your requirements and provide detailed pricing.

Best regards,
TNT Limousine Team
"Driven by Service, Defined by Excellence"`,
        trigger_conditions: JSON.stringify({ service_types: ['corporate'], immediate: true }),
        service_types: ['corporate'],
        active: true
      },
      {
        template_name: 'airport_service_response',
        subject_line: 'TNT Airport Transportation - Competitive Pricing & Reliability',
        content: `Hello {{contact_name}},

Thank you for choosing TNT Limousine for your airport transportation needs.

Our certified airport service includes:
- BWI: $657 (vs Richmond Limousine $650)
- Dulles: $460 (vs Richmond Limousine $450)
- Reagan National: $450 (vs Richmond Limousine $440)

Why choose TNT:
✓ Superior vehicle quality and maintenance
✓ Experienced drivers (15+ years average)
✓ 99.9% on-time performance
✓ 24/7 availability and tracking

We will contact you within 5 minutes to confirm your booking details.

TNT Limousine
Richmond, VA`,
        trigger_conditions: JSON.stringify({ service_types: ['airport'], immediate: true }),
        service_types: ['airport'],
        active: true
      }
    ];

    for (const template of defaultTemplates) {
      await models.AutomatedResponse.findOrCreate({
        where: { template_name: template.template_name },
        defaults: template
      });
    }

    // Create default scoring factors
    const defaultScoringFactors = [
      {
        factor_name: 'company_name_present',
        factor_category: 'company',
        weight: 10,
        calculation_method: 'exact_match',
        value_mappings: JSON.stringify({ present: 10, absent: 0 }),
        active: true
      },
      {
        factor_name: 'estimated_value_tier',
        factor_category: 'service',
        weight: 30,
        calculation_method: 'range',
        value_mappings: JSON.stringify({ '1000+': 30, '500-999': 20, '0-499': 10 }),
        active: true
      },
      {
        factor_name: 'service_type_priority',
        factor_category: 'service',
        weight: 25,
        calculation_method: 'exact_match',
        value_mappings: JSON.stringify({
          corporate: 25,
          airport: 20,
          events: 15,
          wedding: 15,
          hourly: 10
        }),
        active: true
      },
      {
        factor_name: 'geographic_proximity',
        factor_category: 'geographic',
        weight: 15,
        calculation_method: 'range',
        value_mappings: JSON.stringify({ '0-25': 15, '26-50': 10, '51-100': 5, '100+': 0 }),
        active: true
      },
      {
        factor_name: 'group_size_factor',
        factor_category: 'service',
        weight: 15,
        calculation_method: 'range',
        value_mappings: JSON.stringify({ '8+': 15, '4-7': 10, '1-3': 5 }),
        active: true
      }
    ];

    for (const factor of defaultScoringFactors) {
      await models.ScoringFactor.findOrCreate({
        where: { factor_name: factor.factor_name },
        defaults: factor
      });
    }

    // Create default admin user
    const bcrypt = require('bcrypt');
    const defaultPassword = await bcrypt.hash('TNT-Admin-2024!', 12);

    await models.User.findOrCreate({
      where: { email: 'admin@tntlimousine.com' },
      defaults: {
        email: 'admin@tntlimousine.com',
        password_hash: defaultPassword,
        first_name: 'System',
        last_name: 'Administrator',
        role: 'admin',
        permissions: JSON.stringify({
          leads: { create: true, read: true, update: true, delete: true },
          analytics: { access: true },
          settings: { manage: true }
        }),
        active: true,
        email_verified: true
      }
    });

    // Create default external integrations
    const defaultIntegrations = [
      {
        service_name: 'zoho_crm',
        api_endpoint: 'https://www.zohoapis.com/crm/v2/',
        sync_frequency: 'real_time',
        active: true
      },
      {
        service_name: 'fasttrack_invision',
        api_endpoint: 'https://api.fasttrack.com/v1/',
        sync_frequency: '15_minutes',
        active: true
      },
      {
        service_name: 'richweb_smtp',
        api_endpoint: 'mail.richweb.net:587',
        sync_frequency: 'real_time',
        active: true
      }
    ];

    for (const integration of defaultIntegrations) {
      await models.ExternalIntegration.findOrCreate({
        where: { service_name: integration.service_name },
        defaults: integration
      });
    }

    logger.info('✅ Database initialized with default data');
  } catch (error) {
    logger.error('❌ Error initializing database:', error);
    throw error;
  }
}

module.exports = {
  ...models,
  initializeDatabase
};