/**
 * TNT Corporate Lead System - Automated Response Model
 *
 * Email templates and automation sequence management
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const AutomatedResponse = sequelize.define('AutomatedResponse', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    // Template Information
    template_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true,
        len: [1, 100]
      }
    },
    subject_line: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 255]
      }
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    html_content: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    // Targeting & Triggers
    trigger_conditions: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: 'JSON object defining when to send'
    },
    service_types: {
      type: DataTypes.ARRAY(DataTypes.ENUM('corporate', 'airport', 'wedding', 'hourly', 'events')),
      allowNull: true,
      defaultValue: []
    },
    lead_score_min: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0,
        max: 100
      }
    },
    lead_score_max: {
      type: DataTypes.INTEGER,
      defaultValue: 100,
      validate: {
        min: 0,
        max: 100
      }
    },

    // A/B Testing
    a_b_test_variant: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    test_percentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 100.00,
      validate: {
        min: 0,
        max: 100
      }
    },

    // Performance Tracking
    sent_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    opened_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    clicked_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    responded_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },

    // Configuration
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    send_delay_minutes: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      },
      comment: 'Delay after trigger'
    },
    business_hours_only: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },

    // User tracking
    created_by: {
      type: DataTypes.UUID,
      allowNull: true
    }
  }, {
    tableName: 'automated_responses',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['active'] },
      { fields: ['template_name'], unique: true },
      { fields: ['service_types'], using: 'gin' },
      { fields: ['trigger_conditions'], using: 'gin' }
    ]
  });

  // Instance methods
  AutomatedResponse.prototype.shouldTrigger = function(lead) {
    // Check if template is active
    if (!this.active) return false;

    // Check lead score range
    if (lead.lead_score < this.lead_score_min || lead.lead_score > this.lead_score_max) {
      return false;
    }

    // Check service type match
    if (this.service_types.length > 0 && !this.service_types.includes(lead.service_type)) {
      return false;
    }

    // Check trigger conditions
    const conditions = this.trigger_conditions;

    if (conditions.immediate && lead.status === 'new') {
      return true;
    }

    if (conditions.service_types && conditions.service_types.includes(lead.service_type)) {
      return true;
    }

    if (conditions.min_value && lead.estimated_value >= conditions.min_value) {
      return true;
    }

    if (conditions.high_priority && lead.priority_level >= 4) {
      return true;
    }

    return false;
  };

  AutomatedResponse.prototype.renderTemplate = function(lead) {
    let subject = this.subject_line;
    let content = this.content;
    let htmlContent = this.html_content;

    // Template variables for replacement
    const variables = {
      contact_name: lead.contact_name || 'Valued Customer',
      company_name: lead.company_name || '',
      service_type: lead.service_type || '',
      service_date: lead.service_date ? new Date(lead.service_date).toLocaleDateString() : 'TBD',
      estimated_value: lead.estimated_value ? lead.estimated_value.toFixed(2) : '0.00',
      phone: lead.phone || '',
      pickup_location: lead.pickup_location || '',
      destination: lead.destination || '',
      passenger_count: lead.passenger_count || 1
    };

    // Replace template variables
    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      subject = subject.replace(regex, value);
      content = content.replace(regex, value);
      if (htmlContent) {
        htmlContent = htmlContent.replace(regex, value);
      }
    });

    return {
      subject,
      content,
      htmlContent
    };
  };

  AutomatedResponse.prototype.incrementSentCount = function() {
    this.sent_count += 1;
    return this.save();
  };

  AutomatedResponse.prototype.incrementOpenedCount = function() {
    this.opened_count += 1;
    return this.save();
  };

  AutomatedResponse.prototype.incrementClickedCount = function() {
    this.clicked_count += 1;
    return this.save();
  };

  AutomatedResponse.prototype.incrementRespondedCount = function() {
    this.responded_count += 1;
    return this.save();
  };

  AutomatedResponse.prototype.getPerformanceMetrics = function() {
    const sent = this.sent_count || 1; // Avoid division by zero

    return {
      sent_count: this.sent_count,
      open_rate: ((this.opened_count / sent) * 100).toFixed(2),
      click_rate: ((this.clicked_count / sent) * 100).toFixed(2),
      response_rate: ((this.responded_count / sent) * 100).toFixed(2),
      engagement_score: (
        (this.opened_count * 1 + this.clicked_count * 2 + this.responded_count * 3) / sent
      ).toFixed(2)
    };
  };

  // Define associations
  AutomatedResponse.associate = (models) => {
    AutomatedResponse.belongsTo(models.User, {
      foreignKey: 'created_by',
      as: 'creator'
    });
  };

  // Class methods
  AutomatedResponse.findActiveForLead = function(lead) {
    return this.findAll({
      where: {
        active: true,
        lead_score_min: { [sequelize.Sequelize.Op.lte]: lead.lead_score },
        lead_score_max: { [sequelize.Sequelize.Op.gte]: lead.lead_score }
      },
      order: [['send_delay_minutes', 'ASC']]
    });
  };

  AutomatedResponse.findByServiceType = function(serviceType) {
    return this.findAll({
      where: {
        active: true,
        service_types: { [sequelize.Sequelize.Op.contains]: [serviceType] }
      }
    });
  };

  AutomatedResponse.getPerformanceReport = async function(dateRange = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - dateRange);

    const templates = await this.findAll({
      where: {
        updated_at: { [sequelize.Sequelize.Op.gte]: cutoffDate }
      },
      order: [['sent_count', 'DESC']]
    });

    return templates.map(template => ({
      template_name: template.template_name,
      active: template.active,
      metrics: template.getPerformanceMetrics(),
      service_types: template.service_types,
      last_updated: template.updated_at
    }));
  };

  return AutomatedResponse;
};