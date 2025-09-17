/**
 * TNT Corporate Lead System - External Integration Model
 *
 * Manages external system integrations (Zoho CRM, FastTrack, SMTP)
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ExternalIntegration = sequelize.define('ExternalIntegration', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    // Service Information
    service_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true,
        isIn: [['zoho_crm', 'fasttrack_invision', 'richweb_smtp', 'slack_notifications']]
      }
    },
    api_endpoint: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    api_version: {
      type: DataTypes.STRING(50),
      allowNull: true
    },

    // Authentication (encrypted)
    credentials_encrypted: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Encrypted JSON with auth details'
    },

    // Sync Status
    last_sync: {
      type: DataTypes.DATE,
      allowNull: true
    },
    sync_status: {
      type: DataTypes.ENUM('success', 'error', 'pending'),
      defaultValue: 'pending'
    },
    sync_frequency: {
      type: DataTypes.STRING(50),
      defaultValue: '15_minutes',
      validate: {
        isIn: [['real_time', '15_minutes', 'hourly', 'daily']]
      }
    },

    // Error Handling
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    consecutive_failures: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    max_failures: {
      type: DataTypes.INTEGER,
      defaultValue: 5,
      validate: {
        min: 1
      }
    },

    // Configuration
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    sync_direction: {
      type: DataTypes.STRING(50),
      defaultValue: 'bidirectional',
      validate: {
        isIn: [['inbound', 'outbound', 'bidirectional']]
      }
    },

    // Performance tracking
    sync_metrics: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      comment: 'Performance and sync statistics'
    }
  }, {
    tableName: 'external_integrations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['service_name'], unique: true },
      { fields: ['active'] },
      { fields: ['sync_status'] },
      { fields: ['last_sync'] }
    ]
  });

  // Instance methods
  ExternalIntegration.prototype.recordSuccessfulSync = function(recordCount = 0) {
    this.last_sync = new Date();
    this.sync_status = 'success';
    this.consecutive_failures = 0;
    this.error_message = null;

    // Update metrics
    const metrics = this.sync_metrics || {};
    metrics.last_success = new Date();
    metrics.total_syncs = (metrics.total_syncs || 0) + 1;
    metrics.last_record_count = recordCount;
    this.sync_metrics = metrics;

    return this.save();
  };

  ExternalIntegration.prototype.recordFailedSync = function(errorMessage) {
    this.sync_status = 'error';
    this.consecutive_failures += 1;
    this.error_message = errorMessage;

    // Update metrics
    const metrics = this.sync_metrics || {};
    metrics.last_error = new Date();
    metrics.total_failures = (metrics.total_failures || 0) + 1;
    metrics.last_error_message = errorMessage;
    this.sync_metrics = metrics;

    // Disable if too many consecutive failures
    if (this.consecutive_failures >= this.max_failures) {
      this.active = false;
    }

    return this.save();
  };

  ExternalIntegration.prototype.isHealthy = function() {
    return this.active &&
           this.sync_status === 'success' &&
           this.consecutive_failures < 3;
  };

  ExternalIntegration.prototype.shouldSync = function() {
    if (!this.active) return false;

    const now = new Date();
    const lastSync = this.last_sync ? new Date(this.last_sync) : null;

    if (!lastSync) return true; // Never synced

    const intervals = {
      'real_time': 0,
      '15_minutes': 15 * 60 * 1000,
      'hourly': 60 * 60 * 1000,
      'daily': 24 * 60 * 60 * 1000
    };

    const interval = intervals[this.sync_frequency] || intervals['15_minutes'];
    return (now - lastSync) >= interval;
  };

  ExternalIntegration.prototype.getHealthStatus = function() {
    const status = {
      service: this.service_name,
      active: this.active,
      status: this.sync_status,
      last_sync: this.last_sync,
      consecutive_failures: this.consecutive_failures,
      health: 'unknown'
    };

    if (!this.active) {
      status.health = 'disabled';
    } else if (this.consecutive_failures >= this.max_failures) {
      status.health = 'critical';
    } else if (this.consecutive_failures >= 3) {
      status.health = 'warning';
    } else if (this.sync_status === 'success') {
      status.health = 'healthy';
    } else {
      status.health = 'error';
    }

    return status;
  };

  ExternalIntegration.prototype.resetFailures = function() {
    this.consecutive_failures = 0;
    this.error_message = null;
    this.active = true;
    return this.save();
  };

  // Define associations
  ExternalIntegration.associate = (models) => {
    ExternalIntegration.hasMany(models.WebhookLog, {
      foreignKey: 'source',
      sourceKey: 'service_name',
      as: 'webhook_logs'
    });
  };

  // Class methods
  ExternalIntegration.findActive = function() {
    return this.findAll({
      where: { active: true },
      order: [['service_name', 'ASC']]
    });
  };

  ExternalIntegration.findDueForSync = function() {
    return this.findAll({
      where: { active: true }
    }).then(integrations => {
      return integrations.filter(integration => integration.shouldSync());
    });
  };

  ExternalIntegration.getSystemHealth = async function() {
    const integrations = await this.findAll();

    const health = {
      total_integrations: integrations.length,
      healthy: 0,
      warning: 0,
      critical: 0,
      disabled: 0,
      services: {}
    };

    integrations.forEach(integration => {
      const status = integration.getHealthStatus();
      health.services[integration.service_name] = status;

      switch (status.health) {
        case 'healthy':
          health.healthy++;
          break;
        case 'warning':
          health.warning++;
          break;
        case 'critical':
          health.critical++;
          break;
        case 'disabled':
          health.disabled++;
          break;
      }
    });

    return health;
  };

  ExternalIntegration.createDefaultIntegrations = async function() {
    const defaultIntegrations = [
      {
        service_name: 'zoho_crm',
        api_endpoint: 'https://www.zohoapis.com/crm/v2/',
        api_version: 'v2',
        sync_frequency: 'real_time',
        active: true
      },
      {
        service_name: 'fasttrack_invision',
        api_endpoint: 'https://api.fasttrack.com/v1/',
        api_version: 'v1',
        sync_frequency: '15_minutes',
        active: true
      },
      {
        service_name: 'richweb_smtp',
        api_endpoint: 'mail.richweb.net:587',
        sync_frequency: 'real_time',
        active: true
      },
      {
        service_name: 'slack_notifications',
        api_endpoint: 'https://hooks.slack.com/services/',
        sync_frequency: 'real_time',
        active: false // Disabled by default until configured
      }
    ];

    const results = [];
    for (const integration of defaultIntegrations) {
      const [instance, created] = await this.findOrCreate({
        where: { service_name: integration.service_name },
        defaults: integration
      });
      results.push({ instance, created });
    }

    return results;
  };

  return ExternalIntegration;
};