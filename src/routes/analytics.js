/**
 * TNT Corporate Lead System - Analytics Routes
 *
 * Business intelligence and performance tracking endpoints
 */

const express = require('express');
const { sequelize } = require('../database/connection');
const { Lead, LeadInteraction, DailyMetric } = require('../models');
const { requirePermission } = require('../middleware/auth');
const {
  validateConversionFunnelQuery,
  validateResponseTimeQuery
} = require('../middleware/validation');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /api/v2/analytics/dashboard - Main dashboard metrics
 */
router.get('/dashboard',
  requirePermission('analytics', 'access'),
  asyncHandler(async (req, res) => {
    try {
      // Get today's metrics
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);

      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - 1);

      // Execute parallel queries for performance
      const [todayMetrics, weekMetrics, monthMetrics, responseTimeMetrics] = await Promise.all([
        // Today's metrics
        sequelize.query(`
          SELECT
            COUNT(*) as leads_count,
            COUNT(*) FILTER (WHERE status = 'converted') as conversions_count,
            COALESCE(AVG(lead_score), 0) as average_lead_score,
            COALESCE(SUM(estimated_value) FILTER (WHERE status = 'converted'), 0) as revenue
          FROM leads
          WHERE created_at >= :todayStart
        `, {
          replacements: { todayStart },
          type: sequelize.QueryTypes.SELECT
        }),

        // Week's metrics
        sequelize.query(`
          SELECT
            COUNT(*) as leads_count,
            COUNT(*) FILTER (WHERE status = 'converted') as conversions_count,
            COALESCE(AVG(lead_score), 0) as average_lead_score,
            COALESCE(SUM(estimated_value) FILTER (WHERE status = 'converted'), 0) as revenue
          FROM leads
          WHERE created_at >= :weekStart
        `, {
          replacements: { weekStart },
          type: sequelize.QueryTypes.SELECT
        }),

        // Month's metrics
        sequelize.query(`
          SELECT
            COUNT(*) as leads_count,
            COUNT(*) FILTER (WHERE status = 'converted') as conversions_count,
            COALESCE(AVG(lead_score), 0) as average_lead_score,
            COALESCE(SUM(estimated_value) FILTER (WHERE status = 'converted'), 0) as revenue
          FROM leads
          WHERE created_at >= :monthStart
        `, {
          replacements: { monthStart },
          type: sequelize.QueryTypes.SELECT
        }),

        // Response time metrics
        sequelize.query(`
          SELECT
            COALESCE(AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 0) as average_response_minutes,
            COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) as under_5_minutes,
            COUNT(li.id) as total_responses,
            COUNT(*) FILTER (WHERE EXTRACT(DOW FROM l.created_at) IN (0, 6)) as weekend_leads
          FROM leads l
          LEFT JOIN lead_interactions li ON l.id = li.lead_id
            AND li.interaction_type = 'email_sent'
            AND li.automated = true
            AND li.created_at = (
              SELECT MIN(created_at)
              FROM lead_interactions
              WHERE lead_id = l.id AND interaction_type = 'email_sent'
            )
          WHERE l.created_at >= :todayStart
        `, {
          replacements: { todayStart },
          type: sequelize.QueryTypes.SELECT
        })
      ]);

      // Get top performing sources
      const topSources = await sequelize.query(`
        SELECT
          source,
          COUNT(*) as lead_count,
          COUNT(*) FILTER (WHERE status = 'converted') as conversions,
          ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'converted') / COUNT(*), 2) as conversion_rate
        FROM leads
        WHERE created_at >= :weekStart
        GROUP BY source
        ORDER BY lead_count DESC
        LIMIT 5
      `, {
        replacements: { weekStart },
        type: sequelize.QueryTypes.SELECT
      });

      // Get high priority alerts
      const highPriorityAlerts = await Lead.findAll({
        where: {
          status: 'new',
          created_at: {
            [require('sequelize').Op.gte]: new Date(Date.now() - 2 * 60 * 60 * 1000) // Last 2 hours
          }
        },
        order: [['lead_score', 'DESC'], ['created_at', 'ASC']],
        limit: 5,
        attributes: ['id', 'contact_name', 'company_name', 'lead_score', 'created_at', 'estimated_value']
      });

      // Calculate metrics
      const today = todayMetrics[0];
      const week = weekMetrics[0];
      const month = monthMetrics[0];
      const responseTime = responseTimeMetrics[0];

      const dashboard = {
        time_period: {
          today: {
            leads_count: parseInt(today.leads_count),
            conversions_count: parseInt(today.conversions_count),
            conversion_rate: today.leads_count > 0 ?
              parseFloat(((today.conversions_count / today.leads_count) * 100).toFixed(2)) : 0,
            revenue: parseFloat(today.revenue) || 0,
            average_lead_score: parseFloat(today.average_lead_score).toFixed(1)
          },
          this_week: {
            leads_count: parseInt(week.leads_count),
            conversions_count: parseInt(week.conversions_count),
            conversion_rate: week.leads_count > 0 ?
              parseFloat(((week.conversions_count / week.leads_count) * 100).toFixed(2)) : 0,
            revenue: parseFloat(week.revenue) || 0,
            average_lead_score: parseFloat(week.average_lead_score).toFixed(1)
          },
          this_month: {
            leads_count: parseInt(month.leads_count),
            conversions_count: parseInt(month.conversions_count),
            conversion_rate: month.leads_count > 0 ?
              parseFloat(((month.conversions_count / month.leads_count) * 100).toFixed(2)) : 0,
            revenue: parseFloat(month.revenue) || 0,
            average_lead_score: parseFloat(month.average_lead_score).toFixed(1)
          }
        },
        response_time_performance: {
          average_response_minutes: parseFloat(responseTime.average_response_minutes).toFixed(2),
          under_5_minutes_rate: responseTime.total_responses > 0 ?
            parseFloat(((responseTime.under_5_minutes / responseTime.total_responses) * 100).toFixed(2)) : 0,
          weekend_coverage_rate: today.leads_count > 0 ?
            parseFloat(((responseTime.weekend_leads / today.leads_count) * 100).toFixed(2)) : 0,
          meets_tnt_commitment: parseFloat(responseTime.average_response_minutes) <= 5
        },
        top_performing_sources: topSources.map(source => ({
          source: source.source,
          lead_count: parseInt(source.lead_count),
          conversion_rate: parseFloat(source.conversion_rate)
        })),
        high_priority_alerts: highPriorityAlerts.map(lead => ({
          alert_type: lead.getMinutesSinceCreated() > 5 ? 'response_overdue' : 'high_value_lead',
          message: `${lead.contact_name} from ${lead.company_name || 'Individual'} - Score: ${lead.lead_score}`,
          lead_id: lead.id,
          created_at: lead.created_at,
          minutes_elapsed: lead.getMinutesSinceCreated(),
          estimated_value: lead.estimated_value
        })),
        business_goals: {
          response_time_target: '5 minutes',
          conversion_target: '25%',
          revenue_target: '$15,000 monthly',
          current_performance: {
            response_time_met: parseFloat(responseTime.average_response_minutes) <= 5,
            conversion_rate_met: month.leads_count > 0 &&
              (month.conversions_count / month.leads_count) * 100 >= 25,
            on_track_for_revenue: parseFloat(month.revenue) >= 500 // $500/day = $15K/month
          }
        }
      };

      res.json(dashboard);

    } catch (error) {
      logger.error('Dashboard metrics query failed:', error);
      throw error;
    }
  })
);

/**
 * GET /api/v2/analytics/conversion-funnel - Conversion funnel analysis
 */
router.get('/conversion-funnel',
  requirePermission('analytics', 'access'),
  validateConversionFunnelQuery,
  asyncHandler(async (req, res) => {
    const { date_range, segment_by } = req.query;

    // Calculate date range
    const daysBack = {
      '7d': 7,
      '30d': 30,
      '90d': 90,
      '1y': 365
    }[date_range] || 30;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    // Base query
    let segmentField = '';
    let groupByClause = '';

    if (segment_by) {
      segmentField = `, ${segment_by}`;
      groupByClause = `, ${segment_by}`;
    }

    const funnelData = await sequelize.query(`
      SELECT
        DATE_TRUNC('day', created_at) as date${segmentField},
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE status IN ('contacted', 'qualified', 'converted')) as contacted,
        COUNT(*) FILTER (WHERE status IN ('qualified', 'converted')) as qualified,
        COUNT(*) FILTER (WHERE status = 'converted') as converted,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'converted') / NULLIF(COUNT(*), 0), 2) as conversion_rate
      FROM leads
      WHERE created_at >= :startDate
      GROUP BY DATE_TRUNC('day', created_at)${groupByClause}
      ORDER BY date DESC
    `, {
      replacements: { startDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Calculate overall funnel stages
    const totalMetrics = await sequelize.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status IN ('contacted', 'qualified', 'converted')) as contacted,
        COUNT(*) FILTER (WHERE status IN ('qualified', 'converted')) as qualified,
        COUNT(*) FILTER (WHERE status = 'converted') as converted
      FROM leads
      WHERE created_at >= :startDate
    `, {
      replacements: { startDate },
      type: sequelize.QueryTypes.SELECT
    });

    const total = totalMetrics[0];

    const funnelStages = [
      {
        stage: 'new',
        count: parseInt(total.total),
        percentage: 100,
        conversion_rate_to_next: total.total > 0 ?
          parseFloat(((total.contacted / total.total) * 100).toFixed(2)) : 0
      },
      {
        stage: 'contacted',
        count: parseInt(total.contacted),
        percentage: total.total > 0 ?
          parseFloat(((total.contacted / total.total) * 100).toFixed(2)) : 0,
        conversion_rate_to_next: total.contacted > 0 ?
          parseFloat(((total.qualified / total.contacted) * 100).toFixed(2)) : 0
      },
      {
        stage: 'qualified',
        count: parseInt(total.qualified),
        percentage: total.total > 0 ?
          parseFloat(((total.qualified / total.total) * 100).toFixed(2)) : 0,
        conversion_rate_to_next: total.qualified > 0 ?
          parseFloat(((total.converted / total.qualified) * 100).toFixed(2)) : 0
      },
      {
        stage: 'converted',
        count: parseInt(total.converted),
        percentage: total.total > 0 ?
          parseFloat(((total.converted / total.total) * 100).toFixed(2)) : 0,
        conversion_rate_to_next: null
      }
    ];

    const response = {
      date_range,
      segment_by,
      funnel_stages: funnelStages,
      time_series: funnelData.map(row => ({
        date: row.date.toISOString().split('T')[0],
        segment: segment_by ? row[segment_by] : null,
        stage_counts: {
          total: parseInt(row.total_leads),
          contacted: parseInt(row.contacted),
          qualified: parseInt(row.qualified),
          converted: parseInt(row.converted)
        },
        conversion_rate: parseFloat(row.conversion_rate)
      })),
      summary: {
        total_leads: parseInt(total.total),
        overall_conversion_rate: parseFloat(((total.converted / total.total) * 100).toFixed(2)),
        days_analyzed: daysBack
      }
    };

    res.json(response);
  })
);

/**
 * GET /api/v2/analytics/response-times - Response time performance analysis
 */
router.get('/response-times',
  requirePermission('analytics', 'access'),
  validateResponseTimeQuery,
  asyncHandler(async (req, res) => {
    const { date_range } = req.query;

    const daysBack = {
      '7d': 7,
      '30d': 30,
      '90d': 90
    }[date_range] || 30;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    // Overall response time metrics
    const overallMetrics = await sequelize.query(`
      SELECT
        COUNT(l.id) as total_leads,
        COUNT(li.id) as responded_leads,
        ROUND(AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 2) as average_response_minutes,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 2) as median_response_minutes,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) as under_5_minutes_count,
        ROUND(100.0 * COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) / NULLIF(COUNT(*), 0), 2) as under_5_minutes_rate
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
        AND li.created_at = (
          SELECT MIN(created_at)
          FROM lead_interactions
          WHERE lead_id = l.id AND interaction_type = 'email_sent'
        )
      WHERE l.created_at >= :startDate
    `, {
      replacements: { startDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Daily breakdown
    const dailyBreakdown = await sequelize.query(`
      SELECT
        DATE_TRUNC('day', l.created_at) as date,
        COUNT(l.id) as leads_count,
        ROUND(AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 2) as average_response_minutes,
        ROUND(100.0 * COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) / NULLIF(COUNT(*), 0), 2) as under_5_minutes_rate
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
        AND li.created_at = (
          SELECT MIN(created_at)
          FROM lead_interactions
          WHERE lead_id = l.id AND interaction_type = 'email_sent'
        )
      WHERE l.created_at >= :startDate
      GROUP BY DATE_TRUNC('day', l.created_at)
      ORDER BY date DESC
    `, {
      replacements: { startDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Hourly patterns (for optimization)
    const hourlyPatterns = await sequelize.query(`
      SELECT
        EXTRACT(HOUR FROM l.created_at) as hour,
        COUNT(l.id) as lead_volume,
        ROUND(AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60), 2) as average_response_minutes
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
        AND li.created_at = (
          SELECT MIN(created_at)
          FROM lead_interactions
          WHERE lead_id = l.id AND interaction_type = 'email_sent'
        )
      WHERE l.created_at >= :startDate
      GROUP BY EXTRACT(HOUR FROM l.created_at)
      ORDER BY hour
    `, {
      replacements: { startDate },
      type: sequelize.QueryTypes.SELECT
    });

    const overall = overallMetrics[0];

    const response = {
      date_range,
      overall_metrics: {
        total_leads: parseInt(overall.total_leads),
        responded_leads: parseInt(overall.responded_leads),
        average_response_minutes: parseFloat(overall.average_response_minutes) || 0,
        median_response_minutes: parseFloat(overall.median_response_minutes) || 0,
        under_5_minutes_count: parseInt(overall.under_5_minutes_count),
        under_5_minutes_rate: parseFloat(overall.under_5_minutes_rate) || 0,
        response_rate: overall.total_leads > 0 ?
          parseFloat(((overall.responded_leads / overall.total_leads) * 100).toFixed(2)) : 0
      },
      daily_breakdown: dailyBreakdown.map(day => ({
        date: day.date.toISOString().split('T')[0],
        leads_count: parseInt(day.leads_count),
        average_response_minutes: parseFloat(day.average_response_minutes) || 0,
        under_5_minutes_rate: parseFloat(day.under_5_minutes_rate) || 0
      })),
      hourly_patterns: hourlyPatterns.map(hour => ({
        hour: parseInt(hour.hour),
        lead_volume: parseInt(hour.lead_volume),
        average_response_minutes: parseFloat(hour.average_response_minutes) || 0
      })),
      tnt_performance: {
        target_response_time: 5,
        meets_target: (parseFloat(overall.average_response_minutes) || 0) <= 5,
        target_achievement_rate: parseFloat(overall.under_5_minutes_rate) || 0,
        performance_grade: this.calculatePerformanceGrade(parseFloat(overall.under_5_minutes_rate) || 0)
      }
    };

    res.json(response);
  })
);

/**
 * GET /api/v2/analytics/revenue-pipeline - Revenue tracking and forecasting
 */
router.get('/revenue-pipeline',
  requirePermission('analytics', 'access'),
  asyncHandler(async (req, res) => {
    // Current pipeline value by stage
    const pipelineValue = await sequelize.query(`
      SELECT
        status,
        COUNT(*) as count,
        COALESCE(SUM(estimated_value), 0) as total_value,
        COALESCE(AVG(estimated_value), 0) as average_value
      FROM leads
      WHERE status IN ('new', 'contacted', 'qualified')
      AND estimated_value > 0
      GROUP BY status
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    // Monthly revenue trends (last 12 months)
    const monthlyTrends = await sequelize.query(`
      SELECT
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as lead_count,
        COUNT(*) FILTER (WHERE status = 'converted') as conversions,
        COALESCE(SUM(estimated_value) FILTER (WHERE status = 'converted'), 0) as revenue,
        COALESCE(AVG(estimated_value) FILTER (WHERE status = 'converted'), 0) as average_deal_size
      FROM leads
      WHERE created_at >= CURRENT_DATE - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    // Service type revenue breakdown
    const serviceTypeBreakdown = await sequelize.query(`
      SELECT
        service_type,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE status = 'converted') as conversions,
        COALESCE(SUM(estimated_value) FILTER (WHERE status = 'converted'), 0) as revenue,
        COALESCE(AVG(estimated_value) FILTER (WHERE status = 'converted'), 0) as average_value
      FROM leads
      WHERE created_at >= CURRENT_DATE - INTERVAL '3 months'
      GROUP BY service_type
      ORDER BY revenue DESC
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    // Calculate totals
    const totalPipelineValue = pipelineValue.reduce((sum, stage) => sum + parseFloat(stage.total_value), 0);

    const response = {
      pipeline_value: {
        total: totalPipelineValue,
        by_stage: pipelineValue.reduce((acc, stage) => {
          acc[stage.status] = {
            count: parseInt(stage.count),
            value: parseFloat(stage.total_value),
            average_value: parseFloat(stage.average_value)
          };
          return acc;
        }, {})
      },
      revenue_trends: monthlyTrends.map(month => ({
        month: month.month.toISOString().split('T')[0].substring(0, 7), // YYYY-MM format
        lead_count: parseInt(month.lead_count),
        conversions: parseInt(month.conversions),
        revenue: parseFloat(month.revenue),
        average_deal_size: parseFloat(month.average_deal_size),
        conversion_rate: month.lead_count > 0 ?
          parseFloat(((month.conversions / month.lead_count) * 100).toFixed(2)) : 0
      })),
      service_type_breakdown: serviceTypeBreakdown.map(service => ({
        service_type: service.service_type,
        count: parseInt(service.count),
        conversions: parseInt(service.conversions),
        revenue: parseFloat(service.revenue),
        average_value: parseFloat(service.average_value),
        conversion_rate: service.count > 0 ?
          parseFloat(((service.conversions / service.count) * 100).toFixed(2)) : 0
      })),
      forecasting: {
        current_month_projection: this.calculateMonthlyProjection(monthlyTrends),
        quarterly_target: 45000, // $15K * 3 months
        annual_target: 180000 // $15K * 12 months
      }
    };

    res.json(response);
  })
);

/**
 * Calculate performance grade based on 5-minute achievement rate
 */
function calculatePerformanceGrade(achievementRate) {
  if (achievementRate >= 95) return 'A+';
  if (achievementRate >= 90) return 'A';
  if (achievementRate >= 85) return 'B+';
  if (achievementRate >= 80) return 'B';
  if (achievementRate >= 70) return 'C';
  if (achievementRate >= 60) return 'D';
  return 'F';
}

/**
 * Calculate monthly revenue projection
 */
function calculateMonthlyProjection(monthlyTrends) {
  if (monthlyTrends.length === 0) return 0;

  const currentMonth = monthlyTrends[0];
  const currentDate = new Date();
  const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
  const daysPassed = currentDate.getDate();

  const dailyAverage = currentMonth.revenue / daysPassed;
  return Math.round(dailyAverage * daysInMonth);
}

module.exports = router;