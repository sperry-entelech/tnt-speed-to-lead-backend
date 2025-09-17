/**
 * TNT Corporate Lead System - Slack Integration Service
 *
 * Handles Slack notifications for high-value leads and alerts
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { createExternalServiceError } = require('../middleware/errorHandler');

class SlackService {
  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL;
    this.channelMap = {
      general: process.env.SLACK_CHANNEL_GENERAL || '#general',
      alerts: process.env.SLACK_CHANNEL_ALERTS || '#alerts',
      leads: process.env.SLACK_CHANNEL_LEADS || '#leads',
      urgent: process.env.SLACK_CHANNEL_URGENT || '#urgent'
    };
    this.enabled = !!this.webhookUrl;
  }

  /**
   * Send basic message to Slack
   */
  async sendMessage(message, channel = 'general') {
    if (!this.enabled) {
      logger.warn('Slack integration disabled - no webhook URL configured');
      return { status: 'disabled' };
    }

    try {
      const payload = {
        channel: this.channelMap[channel] || channel,
        username: 'TNT Lead System',
        icon_emoji: ':limousine:',
        ...message
      };

      const response = await axios.post(this.webhookUrl, payload, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 200) {
        logger.info('Slack message sent successfully:', {
          channel: payload.channel,
          messageType: typeof message
        });

        return {
          status: 'sent',
          channel: payload.channel,
          ts: response.data?.ts
        };
      } else {
        throw new Error(`Slack API returned status ${response.status}`);
      }

    } catch (error) {
      logger.error('Failed to send Slack message:', {
        error: error.message,
        channel,
        url: this.webhookUrl ? 'configured' : 'not configured'
      });

      throw createExternalServiceError(
        `Failed to send Slack message: ${error.message}`,
        'slack',
        error
      );
    }
  }

  /**
   * Send high-value lead alert to leads channel
   */
  async sendHighValueLeadAlert(messageBlocks) {
    return this.sendMessage(messageBlocks, 'leads');
  }

  /**
   * Send urgent alert to urgent channel
   */
  async sendUrgentAlert(messageBlocks) {
    return this.sendMessage(messageBlocks, 'urgent');
  }

  /**
   * Send system alert to alerts channel
   */
  async sendSystemAlert(title, description, level = 'warning') {
    const color = {
      info: '#36a64f',      // Green
      warning: '#ff9900',   // Orange
      error: '#ff0000',     // Red
      critical: '#8B0000'   // Dark Red
    }[level] || '#ff9900';

    const emoji = {
      info: ':information_source:',
      warning: ':warning:',
      error: ':x:',
      critical: ':rotating_light:'
    }[level] || ':warning:';

    const message = {
      text: `${emoji} TNT System Alert: ${title}`,
      attachments: [
        {
          color,
          title: `${emoji} ${title}`,
          text: description,
          footer: 'TNT Lead Management System',
          ts: Math.floor(Date.now() / 1000)
        }
      ]
    };

    return this.sendMessage(message, 'alerts');
  }

  /**
   * Send daily summary to general channel
   */
  async sendDailySummary(metrics) {
    const { leads_today, conversions_today, avg_response_time, under_5min_rate } = metrics;

    const responseTimeEmoji = avg_response_time <= 5 ? ':white_check_mark:' :
                             avg_response_time <= 10 ? ':warning:' : ':x:';

    const message = {
      text: ':chart_with_upwards_trend: TNT Daily Lead Summary',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: ':chart_with_upwards_trend: TNT Daily Lead Summary'
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Leads Today:*\n${leads_today}`
            },
            {
              type: 'mrkdwn',
              text: `*Conversions:*\n${conversions_today}`
            },
            {
              type: 'mrkdwn',
              text: `*Conversion Rate:*\n${leads_today > 0 ? ((conversions_today / leads_today) * 100).toFixed(1) : '0'}%`
            },
            {
              type: 'mrkdwn',
              text: `*Avg Response Time:*\n${responseTimeEmoji} ${avg_response_time ? avg_response_time.toFixed(1) : 'N/A'} min`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*5-Minute Target Performance:* ${under_5min_rate ? under_5min_rate.toFixed(1) : '0'}% of leads responded to within 5 minutes`
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `:calendar: ${new Date().toLocaleDateString()} | :limousine: TNT Lead Management System`
            }
          ]
        }
      ]
    };

    return this.sendMessage(message, 'general');
  }

  /**
   * Send response time warning
   */
  async sendResponseTimeWarning(leadId, minutesElapsed, leadInfo) {
    const urgencyLevel = minutesElapsed >= 10 ? ':rotating_light: CRITICAL' : ':warning: URGENT';

    const message = {
      text: `${urgencyLevel}: TNT Response Time Alert`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${urgencyLevel}: Response Time Alert`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Lead from *${leadInfo.contact_name}* has been waiting for *${minutesElapsed} minutes*.\n\nTNT's 5-minute response commitment is at risk!`
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Company:*\n${leadInfo.company_name || 'Individual'}`
            },
            {
              type: 'mrkdwn',
              text: `*Service:*\n${leadInfo.service_type}`
            },
            {
              type: 'mrkdwn',
              text: `*Value:*\n$${leadInfo.estimated_value || 'N/A'}`
            },
            {
              type: 'mrkdwn',
              text: `*Contact:*\n${leadInfo.email}`
            }
          ]
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: ':phone: Call Now'
              },
              url: `tel:${leadInfo.phone || ''}`,
              style: 'danger'
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: ':eyes: View Lead'
              },
              url: `${process.env.DASHBOARD_URL}/leads/${leadId}`,
              style: 'primary'
            }
          ]
        }
      ]
    };

    return this.sendMessage(message, 'urgent');
  }

  /**
   * Send integration error alert
   */
  async sendIntegrationError(serviceName, errorMessage) {
    const message = {
      text: `:x: TNT Integration Error: ${serviceName}`,
      attachments: [
        {
          color: '#ff0000',
          title: `:x: Integration Error: ${serviceName}`,
          text: `Service: ${serviceName}\nError: ${errorMessage}`,
          fields: [
            {
              title: 'Service',
              value: serviceName,
              short: true
            },
            {
              title: 'Status',
              value: 'Failed',
              short: true
            },
            {
              title: 'Error',
              value: errorMessage,
              short: false
            }
          ],
          footer: 'TNT Integration Monitor',
          ts: Math.floor(Date.now() / 1000)
        }
      ]
    };

    return this.sendMessage(message, 'alerts');
  }

  /**
   * Test Slack configuration
   */
  async testConfiguration() {
    if (!this.enabled) {
      return {
        status: 'disabled',
        message: 'Slack webhook URL not configured'
      };
    }

    try {
      const testMessage = {
        text: ':white_check_mark: TNT Lead System - Slack Integration Test',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':white_check_mark: *TNT Lead System - Configuration Test*\n\nSlack integration is working correctly!'
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Test sent at ${new Date().toLocaleString()}`
              }
            ]
          }
        ]
      };

      const result = await this.sendMessage(testMessage, 'general');

      return {
        status: 'success',
        message: 'Test message sent successfully',
        result
      };

    } catch (error) {
      return {
        status: 'failed',
        message: error.message
      };
    }
  }

  /**
   * Get service health status
   */
  getHealthStatus() {
    return {
      enabled: this.enabled,
      webhook_configured: !!this.webhookUrl,
      channels: this.channelMap,
      last_check: new Date().toISOString()
    };
  }
}

// Create singleton instance
const slackService = new SlackService();

module.exports = slackService;