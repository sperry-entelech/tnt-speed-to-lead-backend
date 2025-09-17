/**
 * TNT Corporate Lead System - Webhook Log Model
 *
 * Event logs for debugging and replay functionality
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const WebhookLog = sequelize.define('WebhookLog', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    // Source Information
    source: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        isIn: [['website_form', 'zoho_crm', 'email_provider', 'slack', 'fasttrack_invision']]
      }
    },
    event_type: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },

    // Payload Data
    payload: {
      type: DataTypes.JSONB,
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    headers: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },

    // Processing Status
    processed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    retry_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },

    // Associated Records
    lead_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'leads',
        key: 'id'
      }
    },
    interaction_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'lead_interactions',
        key: 'id'
      }
    },

    // Network Information
    ip_address: {
      type: DataTypes.INET,
      allowNull: true
    },
    user_agent: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'webhook_logs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['source', 'created_at'] },
      { fields: ['processed', 'created_at'] },
      { fields: ['lead_id'], where: { lead_id: { [sequelize.Sequelize.Op.ne]: null } } },
      { fields: ['event_type'] },
      { fields: ['retry_count'] }
    ]
  });

  // Instance methods
  WebhookLog.prototype.markProcessed = function(leadId = null, interactionId = null) {
    this.processed = true;
    this.processed_at = new Date();
    this.error_message = null;

    if (leadId) this.lead_id = leadId;
    if (interactionId) this.interaction_id = interactionId;

    return this.save();
  };

  WebhookLog.prototype.markFailed = function(errorMessage) {
    this.processed = false;
    this.error_message = errorMessage;
    this.retry_count += 1;
    return this.save();
  };

  WebhookLog.prototype.canRetry = function(maxRetries = 3) {
    return this.retry_count < maxRetries && !this.processed;
  };

  WebhookLog.prototype.getProcessingTime = function() {
    if (!this.processed_at) return null;
    return new Date(this.processed_at) - new Date(this.created_at);
  };

  WebhookLog.prototype.extractLeadData = function() {
    const payload = this.payload;

    // Different sources structure data differently
    switch (this.source) {
      case 'website_form':
        return {
          company_name: payload.company_name || '',
          contact_name: payload.contact_name || payload.name || '',
          email: payload.email || '',
          phone: payload.phone || '',
          service_type: payload.service_type || 'corporate',
          pickup_location: payload.pickup_location || payload.pickup || '',
          destination: payload.destination || '',
          estimated_value: payload.estimated_value || 0,
          source: 'website',
          utm_source: payload.utm_source,
          utm_medium: payload.utm_medium,
          utm_campaign: payload.utm_campaign,
          custom_fields: payload.custom_fields || {}
        };

      case 'zoho_crm':
        return {
          company_name: payload.Company || payload.Account_Name || '',
          contact_name: `${payload.First_Name || ''} ${payload.Last_Name || ''}`.trim(),
          email: payload.Email || '',
          phone: payload.Phone || payload.Mobile || '',
          service_type: payload.Lead_Source === 'Corporate' ? 'corporate' : 'airport',
          estimated_value: payload.Annual_Revenue || 0,
          source: 'zoho_crm',
          zoho_lead_id: payload.id
        };

      case 'email_provider':
        return {
          email_message_id: payload.message_id,
          event_type: payload.event,
          email: payload.email,
          timestamp: payload.timestamp
        };

      default:
        return payload;
    }
  };

  // Define associations
  WebhookLog.associate = (models) => {
    WebhookLog.belongsTo(models.Lead, {
      foreignKey: 'lead_id',
      as: 'lead'
    });

    WebhookLog.belongsTo(models.LeadInteraction, {
      foreignKey: 'interaction_id',
      as: 'interaction'
    });
  };

  // Class methods
  WebhookLog.findUnprocessed = function(source = null) {
    const whereClause = { processed: false };
    if (source) whereClause.source = source;

    return this.findAll({
      where: whereClause,
      order: [['created_at', 'ASC']]
    });
  };

  WebhookLog.findForRetry = function(maxRetries = 3) {
    return this.findAll({
      where: {
        processed: false,
        retry_count: { [sequelize.Sequelize.Op.lt]: maxRetries }
      },
      order: [['created_at', 'ASC']]
    });
  };

  WebhookLog.getProcessingStats = async function(dateRange = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - dateRange);

    const stats = await this.findAll({
      where: {
        created_at: { [sequelize.Sequelize.Op.gte]: cutoffDate }
      },
      attributes: [
        'source',
        'event_type',
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_count'],
        [sequelize.fn('COUNT', sequelize.col('processed')), 'processed_count'],
        [sequelize.fn('AVG', sequelize.col('retry_count')), 'avg_retries'],
        [sequelize.fn('AVG', sequelize.literal('EXTRACT(EPOCH FROM (processed_at - created_at))')), 'avg_processing_seconds']
      ],
      group: ['source', 'event_type'],
      raw: true
    });

    return stats.map(stat => ({
      source: stat.source,
      event_type: stat.event_type,
      total: parseInt(stat.total_count),
      processed: parseInt(stat.processed_count),
      success_rate: ((parseInt(stat.processed_count) / parseInt(stat.total_count)) * 100).toFixed(2),
      avg_retries: parseFloat(stat.avg_retries).toFixed(2),
      avg_processing_time: stat.avg_processing_seconds ? parseFloat(stat.avg_processing_seconds).toFixed(2) : null
    }));
  };

  WebhookLog.cleanup = async function(daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.destroy({
      where: {
        created_at: { [sequelize.Sequelize.Op.lt]: cutoffDate },
        processed: true
      }
    });

    return result;
  };

  WebhookLog.createFromRequest = async function(source, eventType, payload, headers = {}, ipAddress = null) {
    return this.create({
      source,
      event_type: eventType,
      payload,
      headers,
      ip_address: ipAddress,
      user_agent: headers['user-agent'] || null
    });
  };

  return WebhookLog;
};