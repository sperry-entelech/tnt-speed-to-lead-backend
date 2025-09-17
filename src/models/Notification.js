/**
 * TNT Corporate Lead System - Notification Model
 *
 * High-value lead notifications and manager alerts
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Notification = sequelize.define('Notification', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    lead_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'leads',
        key: 'id'
      }
    },

    // Notification Details
    notification_type: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        isIn: [['high_value_lead', 'response_needed', 'conversion_opportunity', 'system_alert']]
      }
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 255]
      }
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    priority: {
      type: DataTypes.INTEGER,
      defaultValue: 3,
      validate: {
        min: 1,
        max: 5
      }
    },

    // Delivery Channels
    send_email: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    send_sms: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    send_slack: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    // Recipients
    recipient_user_ids: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      allowNull: true,
      defaultValue: []
    },

    // Status
    sent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    sent_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    read_at: {
      type: DataTypes.DATE,
      allowNull: true
    },

    // Actions
    action_required: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    action_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
      validate: {
        isUrl: true
      }
    },
    action_completed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    // Expiration
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    },

    // Delivery tracking
    delivery_status: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      comment: 'Track delivery status for each channel'
    }
  }, {
    tableName: 'notifications',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['lead_id'] },
      { fields: ['sent', 'created_at'] },
      { fields: ['priority', 'created_at'] },
      { fields: ['notification_type'] },
      { fields: ['recipient_user_ids'], using: 'gin' },
      { fields: ['expires_at'], where: { expires_at: { [sequelize.Sequelize.Op.ne]: null } } }
    ]
  });

  // Instance methods
  Notification.prototype.markSent = function(channel = 'email') {
    this.sent = true;
    this.sent_at = new Date();

    // Update delivery status
    const deliveryStatus = this.delivery_status || {};
    deliveryStatus[channel] = {
      sent: true,
      sent_at: new Date(),
      status: 'delivered'
    };
    this.delivery_status = deliveryStatus;

    return this.save();
  };

  Notification.prototype.markRead = function(userId = null) {
    this.read = true;
    this.read_at = new Date();

    // Track which user read the notification
    if (userId) {
      const deliveryStatus = this.delivery_status || {};
      deliveryStatus.read_by = userId;
      deliveryStatus.read_at = new Date();
      this.delivery_status = deliveryStatus;
    }

    return this.save();
  };

  Notification.prototype.markActionCompleted = function() {
    this.action_completed = true;
    return this.save();
  };

  Notification.prototype.isExpired = function() {
    return this.expires_at && new Date() > new Date(this.expires_at);
  };

  Notification.prototype.getPriorityLabel = function() {
    const labels = {
      1: 'Very Low',
      2: 'Low',
      3: 'Medium',
      4: 'High',
      5: 'Critical'
    };
    return labels[this.priority] || 'Medium';
  };

  Notification.prototype.shouldSendToChannel = function(channel) {
    switch (channel) {
      case 'email':
        return this.send_email;
      case 'sms':
        return this.send_sms;
      case 'slack':
        return this.send_slack;
      default:
        return false;
    }
  };

  // Define associations
  Notification.associate = (models) => {
    Notification.belongsTo(models.Lead, {
      foreignKey: 'lead_id',
      as: 'lead'
    });

    // Note: recipient_user_ids is an array, so we can't use a direct association
    // We'll handle user lookups in the service layer
  };

  // Class methods
  Notification.createHighValueLeadAlert = async function(lead) {
    const notification = await this.create({
      lead_id: lead.id,
      notification_type: 'high_value_lead',
      title: `High-Value Lead Alert: ${lead.company_name || lead.contact_name}`,
      message: `A high-value lead (Score: ${lead.lead_score}, Value: $${lead.estimated_value}) has been received from ${lead.contact_name} at ${lead.company_name}. Immediate attention required to maintain 5-minute response time.`,
      priority: 5,
      send_email: true,
      send_slack: true,
      action_required: true,
      action_url: `/leads/${lead.id}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
    });

    return notification;
  };

  Notification.createResponseNeededAlert = async function(lead, minutesSinceCreated) {
    const notification = await this.create({
      lead_id: lead.id,
      notification_type: 'response_needed',
      title: `Response Time Alert: ${lead.contact_name}`,
      message: `Lead from ${lead.contact_name} has been waiting for ${minutesSinceCreated} minutes. TNT's 5-minute response commitment is at risk.`,
      priority: 4,
      send_email: true,
      send_slack: true,
      action_required: true,
      action_url: `/leads/${lead.id}`,
      expires_at: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
    });

    return notification;
  };

  Notification.findPending = function() {
    return this.findAll({
      where: {
        sent: false,
        [sequelize.Sequelize.Op.or]: [
          { expires_at: null },
          { expires_at: { [sequelize.Sequelize.Op.gt]: new Date() } }
        ]
      },
      include: [
        {
          model: sequelize.models.Lead,
          as: 'lead',
          attributes: ['id', 'company_name', 'contact_name', 'email', 'lead_score', 'estimated_value']
        }
      ],
      order: [['priority', 'DESC'], ['created_at', 'ASC']]
    });
  };

  Notification.findUnread = function(userId = null) {
    const whereClause = {
      read: false,
      sent: true,
      [sequelize.Sequelize.Op.or]: [
        { expires_at: null },
        { expires_at: { [sequelize.Sequelize.Op.gt]: new Date() } }
      ]
    };

    if (userId) {
      whereClause.recipient_user_ids = {
        [sequelize.Sequelize.Op.contains]: [userId]
      };
    }

    return this.findAll({
      where: whereClause,
      include: [
        {
          model: sequelize.models.Lead,
          as: 'lead',
          attributes: ['id', 'company_name', 'contact_name', 'service_type']
        }
      ],
      order: [['priority', 'DESC'], ['created_at', 'DESC']]
    });
  };

  Notification.cleanupExpired = async function() {
    const result = await this.destroy({
      where: {
        expires_at: { [sequelize.Sequelize.Op.lt]: new Date() },
        read: true
      }
    });

    return result;
  };

  Notification.getDeliveryReport = async function(dateRange = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - dateRange);

    const notifications = await this.findAll({
      where: {
        created_at: { [sequelize.Sequelize.Op.gte]: cutoffDate }
      },
      attributes: [
        'notification_type',
        'priority',
        [sequelize.fn('COUNT', sequelize.col('id')), 'total_count'],
        [sequelize.fn('COUNT', sequelize.col('sent')), 'sent_count'],
        [sequelize.fn('COUNT', sequelize.col('read')), 'read_count'],
        [sequelize.fn('AVG', sequelize.literal('EXTRACT(EPOCH FROM (sent_at - created_at))/60')), 'avg_delivery_minutes']
      ],
      group: ['notification_type', 'priority'],
      raw: true
    });

    return notifications.map(notification => ({
      type: notification.notification_type,
      priority: notification.priority,
      total: parseInt(notification.total_count),
      sent: parseInt(notification.sent_count),
      read: parseInt(notification.read_count),
      delivery_rate: ((parseInt(notification.sent_count) / parseInt(notification.total_count)) * 100).toFixed(2),
      read_rate: ((parseInt(notification.read_count) / parseInt(notification.sent_count || 1)) * 100).toFixed(2),
      avg_delivery_time: notification.avg_delivery_minutes ? parseFloat(notification.avg_delivery_minutes).toFixed(2) : null
    }));
  };

  return Notification;
};