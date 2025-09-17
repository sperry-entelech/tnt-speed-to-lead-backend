/**
 * TNT Corporate Lead System - Notification Queue Processor
 *
 * Processes high-value lead alerts and manager notifications
 */

const { Lead, Notification, User } = require('../../models');
const logger = require('../../utils/logger');
const emailService = require('../../services/emailService');
const slackService = require('../../services/slackService');
const smsService = require('../../services/smsService');

/**
 * Process high-value lead alert
 */
async function processHighValueAlert(job) {
  const { leadId, estimatedValue, timestamp } = job.data;

  try {
    logger.info('Processing high-value lead alert:', {
      jobId: job.id,
      leadId,
      estimatedValue,
      timestamp
    });

    const lead = await Lead.findByPk(leadId);
    if (!lead) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    // Create notification record
    const notification = await Notification.createHighValueLeadAlert(lead);

    // Get managers and dispatchers who should receive notifications
    const recipients = await User.findAll({
      where: {
        active: true,
        notification_preferences: {
          high_value_leads: true
        }
      }
    });

    const results = {
      notificationId: notification.id,
      recipients: recipients.length,
      channels: {
        email: { sent: 0, failed: 0 },
        slack: { sent: 0, failed: 0 },
        sms: { sent: 0, failed: 0 }
      }
    };

    // Send email notifications
    if (notification.send_email) {
      for (const user of recipients) {
        if (user.shouldReceiveNotification('email')) {
          try {
            await emailService.sendNotificationEmail(user, notification, lead);
            results.channels.email.sent++;
          } catch (error) {
            logger.error('Failed to send notification email:', {
              userId: user.id,
              email: user.email,
              error: error.message
            });
            results.channels.email.failed++;
          }
        }
      }
    }

    // Send Slack notification
    if (notification.send_slack) {
      try {
        const slackMessage = formatSlackMessage(lead, notification);
        await slackService.sendHighValueLeadAlert(slackMessage);
        results.channels.slack.sent++;
      } catch (error) {
        logger.error('Failed to send Slack notification:', error);
        results.channels.slack.failed++;
      }
    }

    // Send SMS for critical leads (>$2000 or score >90)
    if (lead.estimated_value >= 2000 || lead.lead_score >= 90) {
      const smsRecipients = recipients.filter(user =>
        user.shouldReceiveNotification('sms') && user.phone
      );

      for (const user of smsRecipients) {
        try {
          const smsMessage = `TNT URGENT: High-value lead ($${lead.estimated_value}) from ${lead.contact_name} at ${lead.company_name}. Score: ${lead.lead_score}. Respond within 5 min. View: ${process.env.DASHBOARD_URL}/leads/${lead.id}`;

          await smsService.sendSMS(user.phone, smsMessage);
          results.channels.sms.sent++;
        } catch (error) {
          logger.error('Failed to send SMS notification:', {
            userId: user.id,
            phone: user.phone,
            error: error.message
          });
          results.channels.sms.failed++;
        }
      }
    }

    // Mark notification as sent
    await notification.markSent('multi_channel');

    logger.info('High-value lead alert processed:', {
      leadId,
      notificationId: notification.id,
      results
    });

    return results;

  } catch (error) {
    logger.error('Failed to process high-value lead alert:', {
      jobId: job.id,
      leadId,
      error: error.message
    });

    throw error;
  }
}

/**
 * Process response time alert
 */
async function processResponseTimeAlert(job) {
  const { leadId, minutesElapsed, timestamp } = job.data;

  try {
    logger.info('Processing response time alert:', {
      jobId: job.id,
      leadId,
      minutesElapsed,
      timestamp
    });

    const lead = await Lead.findByPk(leadId);
    if (!lead) {
      throw new Error(`Lead not found: ${leadId}`);
    }

    // Only alert if still no response and lead is still new
    if (lead.status !== 'new') {
      return { status: 'skipped', reason: 'lead_already_contacted' };
    }

    // Create notification
    const notification = await Notification.createResponseNeededAlert(lead, minutesElapsed);

    // Get managers who should receive escalation
    const managers = await User.findByRole('manager');
    const admins = await User.findByRole('admin');
    const recipients = [...managers, ...admins].filter(user =>
      user.shouldReceiveNotification('response_time_alerts')
    );

    const results = {
      notificationId: notification.id,
      recipients: recipients.length,
      minutesElapsed,
      urgency: minutesElapsed >= 10 ? 'critical' : 'high'
    };

    // Send immediate Slack alert
    const urgencyLevel = minutesElapsed >= 10 ? '🚨 CRITICAL' : '⚠️ URGENT';
    const slackMessage = {
      text: `${urgencyLevel}: TNT 5-Minute Response Commitment at Risk`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${urgencyLevel}: Response Time Alert*\n\n` +
                  `Lead from *${lead.contact_name}* at *${lead.company_name}* has been waiting for *${minutesElapsed} minutes*.\n\n` +
                  `TNT's 5-minute response commitment is at risk.`
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Service Type:*\n${lead.service_type}` },
            { type: 'mrkdwn', text: `*Est. Value:*\n$${lead.estimated_value || 'N/A'}` },
            { type: 'mrkdwn', text: `*Lead Score:*\n${lead.lead_score}/100` },
            { type: 'mrkdwn', text: `*Email:*\n${lead.email}` }
          ]
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View Lead' },
              url: `${process.env.DASHBOARD_URL}/leads/${lead.id}`,
              style: 'danger'
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Call Now' },
              url: `tel:${lead.phone || ''}`,
              style: 'primary'
            }
          ]
        }
      ]
    };

    await slackService.sendUrgentAlert(slackMessage);

    // Send email alerts to managers
    for (const user of recipients) {
      try {
        await emailService.sendResponseTimeAlert(user, lead, minutesElapsed);
      } catch (error) {
        logger.error('Failed to send response time email alert:', {
          userId: user.id,
          error: error.message
        });
      }
    }

    // Mark notification as sent
    await notification.markSent('slack_email');

    return results;

  } catch (error) {
    logger.error('Failed to process response time alert:', {
      jobId: job.id,
      leadId,
      error: error.message
    });

    throw error;
  }
}

/**
 * Process Slack notification
 */
async function processSlackNotification(job) {
  const { message, channel, timestamp } = job.data;

  try {
    logger.info('Processing Slack notification:', {
      jobId: job.id,
      channel,
      timestamp
    });

    const result = await slackService.sendMessage(message, channel);

    return {
      status: 'sent',
      channel,
      messageTs: result.ts
    };

  } catch (error) {
    logger.error('Failed to process Slack notification:', {
      jobId: job.id,
      error: error.message
    });

    throw error;
  }
}

/**
 * Format Slack message for high-value leads
 */
function formatSlackMessage(lead, notification) {
  const urgencyEmoji = lead.lead_score >= 90 ? '🚨' :
                      lead.lead_score >= 70 ? '⚡' : '📢';

  return {
    text: `${urgencyEmoji} High-Value Lead Alert: ${lead.company_name || lead.contact_name}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${urgencyEmoji} High-Value Lead Alert`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${lead.contact_name}* from *${lead.company_name || 'Individual Customer'}*\n` +
                `${notification.message}`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Service Type:*\n${lead.service_type}`
          },
          {
            type: 'mrkdwn',
            text: `*Estimated Value:*\n$${lead.estimated_value || 'N/A'}`
          },
          {
            type: 'mrkdwn',
            text: `*Lead Score:*\n${lead.lead_score}/100`
          },
          {
            type: 'mrkdwn',
            text: `*Contact:*\n${lead.email}\n${lead.phone || 'No phone'}`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Service Details:*\n` +
                `${lead.service_date ? `Date: ${new Date(lead.service_date).toLocaleDateString()}` : 'Date: TBD'}\n` +
                `${lead.pickup_location ? `Pickup: ${lead.pickup_location}` : ''}\n` +
                `${lead.destination ? `Destination: ${lead.destination}` : ''}\n` +
                `${lead.passenger_count ? `Passengers: ${lead.passenger_count}` : ''}`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '👀 View Lead'
            },
            url: `${process.env.DASHBOARD_URL}/leads/${lead.id}`,
            style: 'primary'
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '📞 Call Customer'
            },
            url: `tel:${lead.phone || lead.email}`,
            style: 'danger'
          }
        ]
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `⏰ Lead created: ${new Date(lead.created_at).toLocaleString()} | Priority: ${lead.priority_level}/5`
          }
        ]
      }
    ]
  };
}

module.exports = {
  processHighValueAlert,
  processResponseTimeAlert,
  processSlackNotification
};