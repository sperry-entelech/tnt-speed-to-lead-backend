/**
 * TNT Corporate Lead System - Daily Metrics Model
 *
 * Aggregated daily performance metrics for analytics
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const DailyMetric = sequelize.define('DailyMetric', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    metric_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      unique: true
    },

    // Lead Metrics
    leads_created: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    leads_qualified: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    leads_converted: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    conversion_rate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true
    },

    // Response Metrics
    avg_response_time_minutes: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true
    },
    responses_under_5min: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    weekend_leads_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },

    // Email Metrics
    emails_sent: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    emails_opened: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    emails_clicked: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    email_response_rate: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true
    },

    // Revenue Metrics
    estimated_pipeline_value: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true
    },
    converted_revenue: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true
    },
    avg_deal_size: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },

    // Service Type Breakdown
    corporate_leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    airport_leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    wedding_leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    hourly_leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },
    events_leads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: { min: 0 }
    },

    // Calculated timestamp
    calculated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'daily_metrics',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['metric_date'], unique: true },
      { fields: ['metric_date'], order: [['metric_date', 'DESC']] }
    ]
  });

  // Instance methods
  DailyMetric.prototype.calculateConversionRate = function() {
    if (this.leads_created === 0) {
      this.conversion_rate = 0;
    } else {
      this.conversion_rate = (this.leads_converted / this.leads_created) * 100;
    }
  };

  DailyMetric.prototype.calculateEmailResponseRate = function() {
    if (this.emails_sent === 0) {
      this.email_response_rate = 0;
    } else {
      this.email_response_rate = (this.emails_clicked / this.emails_sent) * 100;
    }
  };

  DailyMetric.prototype.calculateAvgDealSize = function() {
    if (this.leads_converted === 0) {
      this.avg_deal_size = 0;
    } else {
      this.avg_deal_size = this.converted_revenue / this.leads_converted;
    }
  };

  DailyMetric.prototype.getResponseTimePerformance = function() {
    const targetTime = 5; // TNT's 5-minute target
    const responseTimeGrade = this.avg_response_time_minutes <= targetTime ? 'A' :
                             this.avg_response_time_minutes <= 10 ? 'B' :
                             this.avg_response_time_minutes <= 30 ? 'C' : 'F';

    return {
      avg_response_time: this.avg_response_time_minutes,
      under_5min_count: this.responses_under_5min,
      under_5min_rate: this.leads_created > 0 ?
        ((this.responses_under_5min / this.leads_created) * 100).toFixed(2) : '0.00',
      grade: responseTimeGrade,
      meets_target: this.avg_response_time_minutes <= targetTime
    };
  };

  DailyMetric.prototype.getServiceTypeBreakdown = function() {
    const total = this.corporate_leads + this.airport_leads + this.wedding_leads +
                  this.hourly_leads + this.events_leads;

    if (total === 0) return {};

    return {
      corporate: { count: this.corporate_leads, percentage: ((this.corporate_leads / total) * 100).toFixed(1) },
      airport: { count: this.airport_leads, percentage: ((this.airport_leads / total) * 100).toFixed(1) },
      wedding: { count: this.wedding_leads, percentage: ((this.wedding_leads / total) * 100).toFixed(1) },
      hourly: { count: this.hourly_leads, percentage: ((this.hourly_leads / total) * 100).toFixed(1) },
      events: { count: this.events_leads, percentage: ((this.events_leads / total) * 100).toFixed(1) }
    };
  };

  // Hooks
  DailyMetric.beforeSave(async (metric) => {
    metric.calculateConversionRate();
    metric.calculateEmailResponseRate();
    metric.calculateAvgDealSize();
    metric.calculated_at = new Date();
  });

  // Class methods
  DailyMetric.calculateMetricsForDate = async function(date) {
    const targetDate = new Date(date);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    // Lead metrics
    const leadMetrics = await sequelize.query(`
      SELECT
        COUNT(*) as leads_created,
        COUNT(*) FILTER (WHERE status IN ('qualified', 'converted')) as leads_qualified,
        COUNT(*) FILTER (WHERE status = 'converted') as leads_converted,
        SUM(estimated_value) FILTER (WHERE status != 'converted') as estimated_pipeline_value,
        SUM(estimated_value) FILTER (WHERE status = 'converted') as converted_revenue,
        COUNT(*) FILTER (WHERE service_type = 'corporate') as corporate_leads,
        COUNT(*) FILTER (WHERE service_type = 'airport') as airport_leads,
        COUNT(*) FILTER (WHERE service_type = 'wedding') as wedding_leads,
        COUNT(*) FILTER (WHERE service_type = 'hourly') as hourly_leads,
        COUNT(*) FILTER (WHERE service_type = 'events') as events_leads,
        COUNT(*) FILTER (WHERE EXTRACT(DOW FROM created_at) IN (0, 6)) as weekend_leads_count
      FROM leads
      WHERE created_at >= :targetDate AND created_at < :nextDate
    `, {
      replacements: { targetDate, nextDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Response time metrics
    const responseMetrics = await sequelize.query(`
      SELECT
        ROUND(AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 2) as avg_response_time_minutes,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) as responses_under_5min
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
        AND li.created_at = (
          SELECT MIN(created_at)
          FROM lead_interactions
          WHERE lead_id = l.id AND interaction_type = 'email_sent'
        )
      WHERE l.created_at >= :targetDate AND l.created_at < :nextDate
    `, {
      replacements: { targetDate, nextDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Email metrics
    const emailMetrics = await sequelize.query(`
      SELECT
        COUNT(*) FILTER (WHERE interaction_type = 'email_sent') as emails_sent,
        COUNT(*) FILTER (WHERE email_opened_at IS NOT NULL) as emails_opened,
        COUNT(*) FILTER (WHERE email_clicked_at IS NOT NULL) as emails_clicked
      FROM lead_interactions
      WHERE created_at >= :targetDate AND created_at < :nextDate
    `, {
      replacements: { targetDate, nextDate },
      type: sequelize.QueryTypes.SELECT
    });

    const leadData = leadMetrics[0];
    const responseData = responseMetrics[0];
    const emailData = emailMetrics[0];

    const metrics = {
      metric_date: targetDate.toISOString().split('T')[0],
      leads_created: parseInt(leadData.leads_created) || 0,
      leads_qualified: parseInt(leadData.leads_qualified) || 0,
      leads_converted: parseInt(leadData.leads_converted) || 0,
      avg_response_time_minutes: responseData.avg_response_time_minutes ?
        parseFloat(responseData.avg_response_time_minutes) : null,
      responses_under_5min: parseInt(responseData.responses_under_5min) || 0,
      weekend_leads_count: parseInt(leadData.weekend_leads_count) || 0,
      emails_sent: parseInt(emailData.emails_sent) || 0,
      emails_opened: parseInt(emailData.emails_opened) || 0,
      emails_clicked: parseInt(emailData.emails_clicked) || 0,
      estimated_pipeline_value: leadData.estimated_pipeline_value ?
        parseFloat(leadData.estimated_pipeline_value) : null,
      converted_revenue: leadData.converted_revenue ?
        parseFloat(leadData.converted_revenue) : null,
      corporate_leads: parseInt(leadData.corporate_leads) || 0,
      airport_leads: parseInt(leadData.airport_leads) || 0,
      wedding_leads: parseInt(leadData.wedding_leads) || 0,
      hourly_leads: parseInt(leadData.hourly_leads) || 0,
      events_leads: parseInt(leadData.events_leads) || 0
    };

    // Upsert the daily metric
    const [instance] = await this.findOrCreate({
      where: { metric_date: metrics.metric_date },
      defaults: metrics
    });

    if (!instance.isNewRecord) {
      await instance.update(metrics);
    }

    return instance;
  };

  DailyMetric.getDateRange = function(startDate, endDate) {
    return this.findAll({
      where: {
        metric_date: {
          [sequelize.Sequelize.Op.between]: [startDate, endDate]
        }
      },
      order: [['metric_date', 'ASC']]
    });
  };

  DailyMetric.getLastNDays = function(days = 30) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.getDateRange(startDate, endDate);
  };

  DailyMetric.generateMissingMetrics = async function(daysBack = 30) {
    const results = [];

    for (let i = 0; i < daysBack; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);

      try {
        const metric = await this.calculateMetricsForDate(date);
        results.push(metric);
      } catch (error) {
        console.error(`Error calculating metrics for ${date}:`, error);
      }
    }

    return results;
  };

  return DailyMetric;
};