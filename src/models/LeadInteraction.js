/**
 * TNT Corporate Lead System - Lead Interaction Model
 *
 * Tracks all customer touchpoints and engagement activities
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const LeadInteraction = sequelize.define('LeadInteraction', {
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

    // Interaction Details
    interaction_type: {
      type: DataTypes.ENUM(
        'email_sent',
        'email_opened',
        'email_clicked',
        'call_made',
        'meeting_scheduled',
        'sms_sent'
      ),
      allowNull: false
    },
    subject: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    // Automation & Attribution
    automated: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    template_used: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Reference to user who performed manual action'
    },

    // Email Specific Data
    email_message_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'For tracking bounces/replies'
    },
    email_opened_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    email_clicked_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    click_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },

    // Outcome Tracking
    response_received: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    response_content: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    next_action: {
      type: DataTypes.STRING(255),
      allowNull: true
    },

    // Scheduling
    scheduled_for: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'For future scheduled interactions'
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'lead_interactions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['lead_id', 'created_at'] },
      { fields: ['interaction_type'] },
      { fields: ['scheduled_for'], where: { scheduled_for: { [sequelize.Sequelize.Op.ne]: null } } },
      { fields: ['automated', 'created_at'] },
      { fields: ['email_message_id'], where: { email_message_id: { [sequelize.Sequelize.Op.ne]: null } } }
    ]
  });

  // Instance methods
  LeadInteraction.prototype.markOpened = function() {
    this.email_opened_at = new Date();
    return this.save();
  };

  LeadInteraction.prototype.markClicked = function(url = null) {
    this.email_clicked_at = new Date();
    this.click_count += 1;
    if (url && this.content) {
      this.content += `\n\nClicked URL: ${url}`;
    }
    return this.save();
  };

  LeadInteraction.prototype.recordResponse = function(responseContent) {
    this.response_received = true;
    this.response_content = responseContent;
    this.completed_at = new Date();
    return this.save();
  };

  LeadInteraction.prototype.getEngagementRate = function() {
    if (this.interaction_type !== 'email_sent') return null;

    const metrics = {
      sent: 1,
      opened: this.email_opened_at ? 1 : 0,
      clicked: this.email_clicked_at ? 1 : 0,
      responded: this.response_received ? 1 : 0
    };

    return {
      open_rate: metrics.opened / metrics.sent,
      click_rate: metrics.clicked / metrics.sent,
      response_rate: metrics.responded / metrics.sent
    };
  };

  // Hooks
  LeadInteraction.beforeCreate(async (interaction) => {
    // Auto-complete immediate interactions
    if (['email_sent', 'call_made', 'sms_sent'].includes(interaction.interaction_type)) {
      interaction.completed_at = new Date();
    }
  });

  LeadInteraction.afterCreate(async (interaction) => {
    // Update lead's last_contact_at timestamp
    if (interaction.lead_id) {
      await sequelize.models.Lead.update(
        { last_contact_at: new Date() },
        { where: { id: interaction.lead_id } }
      );
    }
  });

  // Define associations
  LeadInteraction.associate = (models) => {
    LeadInteraction.belongsTo(models.Lead, {
      foreignKey: 'lead_id',
      as: 'lead'
    });

    LeadInteraction.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user'
    });
  };

  // Class methods for analytics
  LeadInteraction.getResponseTimeMetrics = async function(dateRange = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - dateRange);

    const results = await sequelize.query(`
      SELECT
        DATE_TRUNC('day', l.created_at) as date,
        COUNT(l.id) as total_leads,
        COUNT(li.id) as responded_leads,
        ROUND(AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 2) as avg_response_minutes,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) as under_5_minutes,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) /
          NULLIF(COUNT(*), 0), 2
        ) as under_5_minutes_rate
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
      WHERE l.created_at >= :cutoffDate
      GROUP BY DATE_TRUNC('day', l.created_at)
      ORDER BY date DESC
    `, {
      replacements: { cutoffDate },
      type: sequelize.QueryTypes.SELECT
    });

    return results;
  };

  LeadInteraction.getEngagementMetrics = async function(templateName = null, dateRange = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - dateRange);

    const whereClause = {
      interaction_type: 'email_sent',
      created_at: { [sequelize.Sequelize.Op.gte]: cutoffDate }
    };

    if (templateName) {
      whereClause.template_used = templateName;
    }

    const interactions = await this.findAll({
      where: whereClause,
      attributes: [
        'template_used',
        [sequelize.fn('COUNT', sequelize.col('id')), 'sent_count'],
        [sequelize.fn('COUNT', sequelize.col('email_opened_at')), 'opened_count'],
        [sequelize.fn('COUNT', sequelize.col('email_clicked_at')), 'clicked_count'],
        [sequelize.fn('COUNT', sequelize.col('response_received')), 'responded_count']
      ],
      group: ['template_used'],
      raw: true
    });

    return interactions.map(interaction => ({
      template_name: interaction.template_used,
      metrics: {
        sent: parseInt(interaction.sent_count),
        opened: parseInt(interaction.opened_count),
        clicked: parseInt(interaction.clicked_count),
        responded: parseInt(interaction.responded_count),
        open_rate: (parseInt(interaction.opened_count) / parseInt(interaction.sent_count)) * 100,
        click_rate: (parseInt(interaction.clicked_count) / parseInt(interaction.sent_count)) * 100,
        response_rate: (parseInt(interaction.responded_count) / parseInt(interaction.sent_count)) * 100
      }
    }));
  };

  return LeadInteraction;
};