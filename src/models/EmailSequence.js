/**
 * TNT Corporate Lead System - Email Sequence Model
 *
 * Manages follow-up email sequences and drip campaigns
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const EmailSequence = sequelize.define('EmailSequence', {
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

    // Sequence Configuration
    sequence_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    current_step: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      validate: {
        min: 1
      }
    },
    total_steps: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 1,
        max: 10
      }
    },

    // Timing
    started_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    next_send_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },

    // Status
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    paused_reason: {
      type: DataTypes.STRING(255),
      allowNull: true
    },

    // Performance
    emails_sent: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    emails_opened: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    responses_received: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },

    // Configuration
    sequence_config: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      comment: 'Sequence-specific configuration and timing'
    }
  }, {
    tableName: 'email_sequences',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['lead_id'] },
      { fields: ['next_send_at'], where: { active: true } },
      { fields: ['sequence_name'] },
      { fields: ['active', 'next_send_at'] }
    ]
  });

  // Instance methods
  EmailSequence.prototype.advance = function() {
    if (this.current_step < this.total_steps) {
      this.current_step += 1;
      this.calculateNextSendTime();
    } else {
      this.complete();
    }
    return this.save();
  };

  EmailSequence.prototype.complete = function() {
    this.active = false;
    this.completed_at = new Date();
    this.next_send_at = null;
    return this.save();
  };

  EmailSequence.prototype.pause = function(reason) {
    this.active = false;
    this.paused_reason = reason;
    this.next_send_at = null;
    return this.save();
  };

  EmailSequence.prototype.resume = function() {
    this.active = true;
    this.paused_reason = null;
    this.calculateNextSendTime();
    return this.save();
  };

  EmailSequence.prototype.calculateNextSendTime = function() {
    const sequences = {
      'standard_follow_up': [0, 3 * 24 * 60, 7 * 24 * 60, 14 * 24 * 60], // 0, 3 days, 7 days, 14 days (in minutes)
      'high_value_follow_up': [0, 2 * 60, 24 * 60, 3 * 24 * 60], // 0, 2 hours, 1 day, 3 days
      'corporate_nurture': [0, 24 * 60, 7 * 24 * 60, 30 * 24 * 60], // 0, 1 day, 7 days, 30 days
      'wedding_follow_up': [0, 2 * 24 * 60, 7 * 24 * 60, 21 * 24 * 60] // 0, 2 days, 7 days, 21 days
    };

    const timingMinutes = sequences[this.sequence_name] || sequences['standard_follow_up'];

    if (this.current_step <= timingMinutes.length) {
      const delayMinutes = timingMinutes[this.current_step - 1] || 0;
      this.next_send_at = new Date(Date.now() + delayMinutes * 60 * 1000);
    }
  };

  EmailSequence.prototype.recordEmailSent = function() {
    this.emails_sent += 1;
    return this.save();
  };

  EmailSequence.prototype.recordEmailOpened = function() {
    this.emails_opened += 1;
    return this.save();
  };

  EmailSequence.prototype.recordResponse = function() {
    this.responses_received += 1;
    // Complete sequence on response
    this.complete();
    return this.save();
  };

  EmailSequence.prototype.getPerformanceMetrics = function() {
    const sent = this.emails_sent || 1;

    return {
      sequence_name: this.sequence_name,
      current_step: this.current_step,
      total_steps: this.total_steps,
      progress_percentage: ((this.current_step / this.total_steps) * 100).toFixed(1),
      emails_sent: this.emails_sent,
      open_rate: ((this.emails_opened / sent) * 100).toFixed(2),
      response_rate: ((this.responses_received / sent) * 100).toFixed(2),
      days_active: Math.floor((new Date() - new Date(this.started_at)) / (1000 * 60 * 60 * 24)),
      status: this.active ? 'active' : (this.completed_at ? 'completed' : 'paused')
    };
  };

  // Hooks
  EmailSequence.beforeCreate(async (sequence) => {
    sequence.calculateNextSendTime();
  });

  // Define associations
  EmailSequence.associate = (models) => {
    EmailSequence.belongsTo(models.Lead, {
      foreignKey: 'lead_id',
      as: 'lead'
    });
  };

  // Class methods
  EmailSequence.findDue = function() {
    return this.findAll({
      where: {
        active: true,
        next_send_at: {
          [sequelize.Sequelize.Op.lte]: new Date()
        }
      },
      include: [
        {
          model: sequelize.models.Lead,
          as: 'lead'
        }
      ],
      order: [['next_send_at', 'ASC']]
    });
  };

  EmailSequence.createStandardSequence = async function(leadId, sequenceType = 'standard_follow_up') {
    const sequenceConfig = {
      'standard_follow_up': { total_steps: 4, name: 'Standard Follow-up' },
      'high_value_follow_up': { total_steps: 4, name: 'High Value Follow-up' },
      'corporate_nurture': { total_steps: 4, name: 'Corporate Nurture' },
      'wedding_follow_up': { total_steps: 4, name: 'Wedding Follow-up' }
    };

    const config = sequenceConfig[sequenceType] || sequenceConfig['standard_follow_up'];

    return this.create({
      lead_id: leadId,
      sequence_name: sequenceType,
      total_steps: config.total_steps,
      sequence_config: { display_name: config.name }
    });
  };

  EmailSequence.getPerformanceReport = async function(dateRange = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - dateRange);

    const sequences = await this.findAll({
      where: {
        created_at: { [sequelize.Sequelize.Op.gte]: cutoffDate }
      },
      include: [
        {
          model: sequelize.models.Lead,
          as: 'lead',
          attributes: ['service_type', 'lead_score', 'estimated_value']
        }
      ]
    });

    const report = {
      total_sequences: sequences.length,
      active_sequences: sequences.filter(s => s.active).length,
      completed_sequences: sequences.filter(s => s.completed_at).length,
      average_completion_rate: 0,
      sequence_performance: {}
    };

    // Group by sequence type
    const byType = sequences.reduce((acc, seq) => {
      if (!acc[seq.sequence_name]) {
        acc[seq.sequence_name] = [];
      }
      acc[seq.sequence_name].push(seq);
      return acc;
    }, {});

    // Calculate metrics for each sequence type
    Object.entries(byType).forEach(([type, seqs]) => {
      const totalSent = seqs.reduce((sum, s) => sum + s.emails_sent, 0);
      const totalOpened = seqs.reduce((sum, s) => sum + s.emails_opened, 0);
      const totalResponses = seqs.reduce((sum, s) => sum + s.responses_received, 0);
      const completedCount = seqs.filter(s => s.completed_at).length;

      report.sequence_performance[type] = {
        count: seqs.length,
        completion_rate: ((completedCount / seqs.length) * 100).toFixed(2),
        total_emails_sent: totalSent,
        open_rate: totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(2) : '0.00',
        response_rate: totalSent > 0 ? ((totalResponses / totalSent) * 100).toFixed(2) : '0.00'
      };
    });

    // Overall completion rate
    const totalCompleted = sequences.filter(s => s.completed_at).length;
    report.average_completion_rate = sequences.length > 0 ?
      ((totalCompleted / sequences.length) * 100).toFixed(2) : '0.00';

    return report;
  };

  return EmailSequence;
};