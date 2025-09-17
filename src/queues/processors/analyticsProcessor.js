/**
 * TNT Corporate Lead System - Analytics Queue Processor
 *
 * Processes analytics calculation jobs for performance metrics
 */

const { DailyMetric, Lead, LeadInteraction } = require('../../models');
const { sequelize } = require('../../database/connection');
const logger = require('../../utils/logger');
const slackService = require('../../services/slackService');

/**
 * Process daily metrics calculation
 */
async function processDailyMetrics(job) {
  const { date, recalculate = false } = job.data || {};

  try {
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    logger.info('Processing daily metrics calculation:', {
      jobId: job.id,
      targetDate: targetDate.toISOString().split('T')[0],
      recalculate
    });

    // Check if metrics already exist for this date
    const existingMetric = await DailyMetric.findOne({
      where: { metric_date: targetDate }
    });

    if (existingMetric && !recalculate) {
      logger.info('Daily metrics already exist, skipping calculation:', {
        date: targetDate.toISOString().split('T')[0]
      });
      return {
        status: 'skipped',
        reason: 'already_exists',
        date: targetDate.toISOString().split('T')[0]
      };
    }

    // Calculate metrics for the date
    const metrics = await DailyMetric.calculateMetricsForDate(targetDate);

    // Send daily summary to Slack if it's today's metrics
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (targetDate.getTime() === today.getTime()) {
      try {
        await slackService.sendDailySummary({
          leads_today: metrics.leads_created,
          conversions_today: metrics.leads_converted,
          avg_response_time: metrics.avg_response_time_minutes,
          under_5min_rate: metrics.responses_under_5min > 0 ?
            (metrics.responses_under_5min / metrics.leads_created) * 100 : 0
        });
      } catch (slackError) {
        logger.error('Failed to send daily summary to Slack:', slackError);
        // Don't fail the entire job for Slack errors
      }
    }

    logger.info('Daily metrics calculated successfully:', {
      date: targetDate.toISOString().split('T')[0],
      leadsCreated: metrics.leads_created,
      conversions: metrics.leads_converted,
      avgResponseTime: metrics.avg_response_time_minutes
    });

    return {
      status: 'completed',
      date: targetDate.toISOString().split('T')[0],
      metrics: {
        leads_created: metrics.leads_created,
        leads_converted: metrics.leads_converted,
        conversion_rate: metrics.conversion_rate,
        avg_response_time_minutes: metrics.avg_response_time_minutes,
        under_5min_responses: metrics.responses_under_5min
      }
    };

  } catch (error) {
    logger.error('Daily metrics calculation failed:', {
      jobId: job.id,
      error: error.message,
      stack: error.stack
    });

    throw error;
  }
}

/**
 * Process response time metrics calculation
 */
async function processResponseTimeMetrics(job) {
  const { hours_back = 24 } = job.data || {};

  try {
    logger.info('Processing response time metrics:', {
      jobId: job.id,
      hoursBack: hours_back
    });

    const cutoffTime = new Date(Date.now() - hours_back * 60 * 60 * 1000);

    // Get response time performance for recent leads
    const responseMetrics = await sequelize.query(`
      SELECT
        COUNT(l.id) as total_leads,
        COUNT(li.id) as responded_leads,
        AVG(EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60) as avg_response_minutes,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 <= 5) as under_5_minutes,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (li.created_at - l.created_at))/60 > 10) as over_10_minutes,
        COUNT(*) FILTER (WHERE l.status = 'new' AND l.created_at < NOW() - INTERVAL '10 minutes') as overdue_responses
      FROM leads l
      LEFT JOIN lead_interactions li ON l.id = li.lead_id
        AND li.interaction_type = 'email_sent'
        AND li.automated = true
        AND li.created_at = (
          SELECT MIN(created_at)
          FROM lead_interactions
          WHERE lead_id = l.id AND interaction_type = 'email_sent'
        )
      WHERE l.created_at >= :cutoffTime
    `, {
      replacements: { cutoffTime },
      type: sequelize.QueryTypes.SELECT
    });

    const metrics = responseMetrics[0];
    const avgResponseTime = parseFloat(metrics.avg_response_minutes) || 0;
    const under5MinRate = metrics.responded_leads > 0 ?
      (metrics.under_5_minutes / metrics.responded_leads) * 100 : 0;

    // Check for performance alerts
    const alerts = [];

    // Alert if average response time exceeds 5 minutes
    if (avgResponseTime > 5) {
      alerts.push({
        type: 'response_time_violation',
        message: `Average response time (${avgResponseTime.toFixed(1)} min) exceeds TNT's 5-minute commitment`,
        severity: avgResponseTime > 10 ? 'critical' : 'warning'
      });
    }

    // Alert if too many leads are overdue for response
    if (parseInt(metrics.overdue_responses) > 0) {
      alerts.push({
        type: 'overdue_responses',
        message: `${metrics.overdue_responses} leads are overdue for response (>10 minutes)`,
        severity: 'urgent'
      });
    }

    // Alert if under-5-minute rate is too low
    if (under5MinRate < 80 && metrics.responded_leads >= 5) {
      alerts.push({
        type: 'low_performance_rate',
        message: `Only ${under5MinRate.toFixed(1)}% of leads responded to within 5 minutes (target: 90%+)`,
        severity: 'warning'
      });
    }

    // Send alerts to Slack if any issues found
    for (const alert of alerts) {
      try {
        await slackService.sendSystemAlert(
          `TNT Response Time Alert: ${alert.type}`,
          alert.message,
          alert.severity
        );
      } catch (slackError) {
        logger.error('Failed to send response time alert to Slack:', slackError);
      }
    }

    // Generate alerts for overdue leads
    if (parseInt(metrics.overdue_responses) > 0) {
      const overdueLeads = await Lead.findAll({
        where: {
          status: 'new',
          created_at: {
            [require('sequelize').Op.lt]: new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
          }
        },
        limit: 5,
        order: [['created_at', 'ASC']]
      });

      for (const lead of overdueLeads) {
        const minutesElapsed = Math.floor((new Date() - new Date(lead.created_at)) / 60000);

        try {
          await slackService.sendResponseTimeWarning(lead.id, minutesElapsed, {
            contact_name: lead.contact_name,
            company_name: lead.company_name,
            service_type: lead.service_type,
            estimated_value: lead.estimated_value,
            email: lead.email,
            phone: lead.phone
          });
        } catch (slackError) {
          logger.error('Failed to send individual response time warning:', slackError);
        }
      }
    }

    logger.performanceMetric('response_time_analysis', avgResponseTime, {
      totalLeads: parseInt(metrics.total_leads),
      respondedLeads: parseInt(metrics.responded_leads),
      under5MinRate: under5MinRate.toFixed(1),
      alertsGenerated: alerts.length
    });

    return {
      status: 'completed',
      hours_analyzed: hours_back,
      metrics: {
        total_leads: parseInt(metrics.total_leads),
        responded_leads: parseInt(metrics.responded_leads),
        avg_response_minutes: avgResponseTime,
        under_5_minutes: parseInt(metrics.under_5_minutes),
        over_10_minutes: parseInt(metrics.over_10_minutes),
        overdue_responses: parseInt(metrics.overdue_responses),
        under_5min_rate: under5MinRate,
        performance_grade: calculatePerformanceGrade(under5MinRate)
      },
      alerts: alerts,
      business_impact: {
        meets_tnt_commitment: avgResponseTime <= 5,
        target_achievement_rate: under5MinRate,
        immediate_action_required: parseInt(metrics.overdue_responses) > 0
      }
    };

  } catch (error) {
    logger.error('Response time metrics calculation failed:', {
      jobId: job.id,
      error: error.message
    });

    throw error;
  }
}

/**
 * Process lead scoring analysis
 */
async function processLeadScoringAnalysis(job) {
  try {
    logger.info('Processing lead scoring analysis:', {
      jobId: job.id
    });

    // Analyze scoring accuracy by looking at conversion rates by score range
    const scoringAnalysis = await sequelize.query(`
      SELECT
        CASE
          WHEN lead_score >= 80 THEN '80-100'
          WHEN lead_score >= 60 THEN '60-79'
          WHEN lead_score >= 40 THEN '40-59'
          WHEN lead_score >= 20 THEN '20-39'
          ELSE '0-19'
        END as score_range,
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE status = 'converted') as conversions,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'converted') / COUNT(*), 2) as conversion_rate,
        AVG(estimated_value) as avg_estimated_value,
        AVG(CASE WHEN status = 'converted' THEN estimated_value END) as avg_converted_value
      FROM leads
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY
        CASE
          WHEN lead_score >= 80 THEN '80-100'
          WHEN lead_score >= 60 THEN '60-79'
          WHEN lead_score >= 40 THEN '40-59'
          WHEN lead_score >= 20 THEN '20-39'
          ELSE '0-19'
        END
      ORDER BY score_range DESC
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    // Service type performance analysis
    const serviceTypeAnalysis = await sequelize.query(`
      SELECT
        service_type,
        COUNT(*) as total_leads,
        AVG(lead_score) as avg_score,
        COUNT(*) FILTER (WHERE status = 'converted') as conversions,
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'converted') / COUNT(*), 2) as conversion_rate
      FROM leads
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY service_type
      ORDER BY conversion_rate DESC
    `, {
      type: sequelize.QueryTypes.SELECT
    });

    return {
      status: 'completed',
      scoring_effectiveness: scoringAnalysis.map(row => ({
        score_range: row.score_range,
        total_leads: parseInt(row.total_leads),
        conversions: parseInt(row.conversions),
        conversion_rate: parseFloat(row.conversion_rate),
        avg_estimated_value: parseFloat(row.avg_estimated_value) || 0,
        avg_converted_value: parseFloat(row.avg_converted_value) || 0
      })),
      service_type_performance: serviceTypeAnalysis.map(row => ({
        service_type: row.service_type,
        total_leads: parseInt(row.total_leads),
        avg_score: parseFloat(row.avg_score),
        conversions: parseInt(row.conversions),
        conversion_rate: parseFloat(row.conversion_rate)
      })),
      insights: generateScoringInsights(scoringAnalysis, serviceTypeAnalysis)
    };

  } catch (error) {
    logger.error('Lead scoring analysis failed:', {
      jobId: job.id,
      error: error.message
    });

    throw error;
  }
}

/**
 * Calculate performance grade based on achievement rate
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
 * Generate insights from scoring analysis
 */
function generateScoringInsights(scoringData, serviceData) {
  const insights = [];

  // Analyze scoring effectiveness
  const highScoreRange = scoringData.find(s => s.score_range === '80-100');
  const lowScoreRange = scoringData.find(s => s.score_range === '0-19');

  if (highScoreRange && lowScoreRange) {
    const scoringEffectiveness = highScoreRange.conversion_rate - lowScoreRange.conversion_rate;
    if (scoringEffectiveness > 20) {
      insights.push({
        type: 'scoring_effective',
        message: `Lead scoring is highly effective: ${scoringEffectiveness.toFixed(1)}% difference between high and low scores`
      });
    } else if (scoringEffectiveness < 10) {
      insights.push({
        type: 'scoring_needs_improvement',
        message: `Lead scoring may need refinement: only ${scoringEffectiveness.toFixed(1)}% difference between high and low scores`
      });
    }
  }

  // Analyze service type performance
  const bestPerformingService = serviceData.reduce((max, service) =>
    service.conversion_rate > max.conversion_rate ? service : max
  );

  const worstPerformingService = serviceData.reduce((min, service) =>
    service.conversion_rate < min.conversion_rate ? service : min
  );

  insights.push({
    type: 'service_performance',
    message: `${bestPerformingService.service_type} has the highest conversion rate (${bestPerformingService.conversion_rate}%), while ${worstPerformingService.service_type} has the lowest (${worstPerformingService.conversion_rate}%)`
  });

  return insights;
}

module.exports = {
  processDailyMetrics,
  processResponseTimeMetrics,
  processLeadScoringAnalysis
};