/**
 * TNT Corporate Lead System - Lead Model
 *
 * Primary model for lead management with automatic scoring and business logic
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Lead = sequelize.define('Lead', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    // Company Information
    company_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 255]
      }
    },
    contact_name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 255]
      }
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
        notEmpty: true
      }
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true,
      validate: {
        is: /^\+?[1-9]\d{1,14}$/
      }
    },
    website: {
      type: DataTypes.STRING(255),
      allowNull: true,
      validate: {
        isUrl: true
      }
    },

    // Service Requirements
    service_type: {
      type: DataTypes.ENUM('corporate', 'airport', 'wedding', 'hourly', 'events'),
      allowNull: false
    },
    service_date: {
      type: DataTypes.DATE,
      allowNull: true
    },
    pickup_location: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    destination: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    passenger_count: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 1,
        max: 50
      }
    },
    vehicle_preference: {
      type: DataTypes.STRING(100),
      allowNull: true
    },

    // Business Classification
    estimated_value: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      validate: {
        min: 0,
        max: 99999.99
      }
    },
    budget_tier: {
      type: DataTypes.STRING(50),
      allowNull: true,
      validate: {
        isIn: [['economy', 'premium', 'luxury']]
      }
    },
    company_size_estimate: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 1
      }
    },
    industry: {
      type: DataTypes.STRING(100),
      allowNull: true
    },

    // Lead Scoring & Status
    lead_score: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0,
        max: 100
      }
    },
    status: {
      type: DataTypes.ENUM('new', 'contacted', 'qualified', 'converted', 'lost'),
      defaultValue: 'new'
    },
    priority_level: {
      type: DataTypes.INTEGER,
      defaultValue: 3,
      validate: {
        min: 1,
        max: 5
      }
    },

    // Source Attribution
    source: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'website'
    },
    utm_source: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    utm_medium: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    utm_campaign: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    referrer_url: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    // Geographic Data
    service_area: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    distance_from_base: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Distance in miles from Richmond, VA'
    },

    // Integration IDs
    zoho_lead_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true
    },
    fasttrack_customer_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },

    // Timestamps
    converted_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    last_contact_at: {
      type: DataTypes.DATE,
      allowNull: true
    },

    // Custom fields for form data
    custom_fields: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    }
  }, {
    tableName: 'leads',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['created_at'] },
      { fields: ['status'] },
      { fields: ['lead_score'] },
      { fields: ['company_name'] },
      { fields: ['service_type'] },
      { fields: ['priority_level', 'created_at'] },
      { fields: ['source'] },
      { fields: ['zoho_lead_id'], where: { zoho_lead_id: { [sequelize.Sequelize.Op.ne]: null } } }
    ]
  });

  // Instance methods
  Lead.prototype.calculateScore = function() {
    let score = 0;

    // Base score factors
    if (this.company_name && this.company_name.length > 0) {
      score += 10; // Has company name
    }

    if (this.estimated_value >= 1000) {
      score += 30; // High value booking
    } else if (this.estimated_value >= 500) {
      score += 20; // Medium value booking
    } else if (this.estimated_value > 0) {
      score += 10; // Any estimated value
    }

    // Service type scoring
    const serviceTypeScores = {
      corporate: 25,
      airport: 20,
      events: 15,
      wedding: 15,
      hourly: 10
    };
    score += serviceTypeScores[this.service_type] || 0;

    // Geographic proximity (closer = higher score)
    if (this.distance_from_base <= 25) {
      score += 15;
    } else if (this.distance_from_base <= 50) {
      score += 10;
    } else if (this.distance_from_base <= 100) {
      score += 5;
    }

    // Passenger count (group bookings score higher)
    if (this.passenger_count >= 8) {
      score += 15;
    } else if (this.passenger_count >= 4) {
      score += 10;
    }

    // Cap score at 100
    return Math.min(score, 100);
  };

  Lead.prototype.updatePriority = function() {
    if (this.lead_score >= 80) {
      this.priority_level = 5; // Critical
    } else if (this.lead_score >= 60) {
      this.priority_level = 4; // High
    } else if (this.lead_score >= 40) {
      this.priority_level = 3; // Medium
    } else if (this.lead_score >= 20) {
      this.priority_level = 2; // Low
    } else {
      this.priority_level = 1; // Very Low
    }
  };

  Lead.prototype.isHighValue = function() {
    return this.estimated_value >= 1000 || this.lead_score >= 70;
  };

  Lead.prototype.getMinutesSinceCreated = function() {
    return Math.floor((new Date() - new Date(this.created_at)) / 60000);
  };

  // Hooks for automatic processing
  Lead.beforeCreate(async (lead) => {
    lead.lead_score = lead.calculateScore();
    lead.updatePriority();
  });

  Lead.beforeUpdate(async (lead) => {
    if (lead.changed('estimated_value') || lead.changed('service_type') ||
        lead.changed('passenger_count') || lead.changed('distance_from_base')) {
      lead.lead_score = lead.calculateScore();
      lead.updatePriority();
    }

    if (lead.changed('status') && lead.status === 'converted') {
      lead.converted_at = new Date();
    }
  });

  // Define associations
  Lead.associate = (models) => {
    Lead.hasMany(models.LeadInteraction, {
      foreignKey: 'lead_id',
      as: 'interactions',
      onDelete: 'CASCADE'
    });

    Lead.hasMany(models.EmailSequence, {
      foreignKey: 'lead_id',
      as: 'email_sequences',
      onDelete: 'CASCADE'
    });

    Lead.hasMany(models.Notification, {
      foreignKey: 'lead_id',
      as: 'notifications',
      onDelete: 'CASCADE'
    });

    Lead.hasMany(models.WebhookLog, {
      foreignKey: 'lead_id',
      as: 'webhook_logs'
    });
  };

  // Class methods for business logic
  Lead.findHighPriority = function(options = {}) {
    return this.findAll({
      where: {
        status: 'new',
        [sequelize.Sequelize.Op.or]: [
          { lead_score: { [sequelize.Sequelize.Op.gte]: 60 } },
          { estimated_value: { [sequelize.Sequelize.Op.gte]: 1000 } }
        ],
        ...options.where
      },
      order: [['lead_score', 'DESC'], ['created_at', 'ASC']],
      ...options
    });
  };

  Lead.findByResponseTime = function(maxMinutes = 5) {
    const cutoffTime = new Date(Date.now() - maxMinutes * 60 * 1000);
    return this.findAll({
      where: {
        created_at: { [sequelize.Sequelize.Op.gte]: cutoffTime },
        status: 'new'
      },
      order: [['created_at', 'ASC']]
    });
  };

  return Lead;
};