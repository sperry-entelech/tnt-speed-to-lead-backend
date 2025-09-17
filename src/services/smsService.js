/**
 * TNT Corporate Lead System - SMS Service
 *
 * Handles SMS notifications for critical alerts
 */

const logger = require('../utils/logger');
const { createExternalServiceError } = require('../middleware/errorHandler');

class SMSService {
  constructor() {
    this.enabled = process.env.SMS_ENABLED === 'true';
    this.provider = process.env.SMS_PROVIDER || 'twilio'; // twilio, aws_sns, etc.
    this.fromNumber = process.env.SMS_FROM_NUMBER;

    if (this.enabled) {
      this.initializeProvider();
    }
  }

  /**
   * Initialize SMS provider
   */
  initializeProvider() {
    try {
      switch (this.provider) {
        case 'twilio':
          this.client = require('twilio')(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
          );
          break;

        case 'aws_sns':
          const AWS = require('aws-sdk');
          this.client = new AWS.SNS({
            region: process.env.AWS_REGION || 'us-east-1',
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
          });
          break;

        default:
          logger.warn(`Unsupported SMS provider: ${this.provider}`);
          this.enabled = false;
      }

      if (this.enabled) {
        logger.info(`SMS service initialized with provider: ${this.provider}`);
      }
    } catch (error) {
      logger.error('Failed to initialize SMS provider:', error);
      this.enabled = false;
    }
  }

  /**
   * Send SMS message
   */
  async sendSMS(to, message, options = {}) {
    if (!this.enabled) {
      logger.warn('SMS service disabled - message not sent:', { to, message: message.substring(0, 50) });
      return { status: 'disabled' };
    }

    try {
      let result;

      switch (this.provider) {
        case 'twilio':
          result = await this.sendTwilioSMS(to, message, options);
          break;

        case 'aws_sns':
          result = await this.sendAWSSMS(to, message, options);
          break;

        default:
          throw new Error(`SMS provider not implemented: ${this.provider}`);
      }

      logger.info('SMS sent successfully:', {
        to: this.maskPhoneNumber(to),
        messageLength: message.length,
        provider: this.provider,
        messageId: result.messageId
      });

      return result;

    } catch (error) {
      logger.error('Failed to send SMS:', {
        to: this.maskPhoneNumber(to),
        error: error.message,
        provider: this.provider
      });

      throw createExternalServiceError(
        `Failed to send SMS: ${error.message}`,
        'sms_service',
        error
      );
    }
  }

  /**
   * Send SMS via Twilio
   */
  async sendTwilioSMS(to, message, options) {
    const messageOptions = {
      body: message,
      from: this.fromNumber,
      to: this.formatPhoneNumber(to)
    };

    if (options.mediaUrl) {
      messageOptions.mediaUrl = options.mediaUrl;
    }

    const twilioMessage = await this.client.messages.create(messageOptions);

    return {
      status: 'sent',
      messageId: twilioMessage.sid,
      provider: 'twilio',
      to: this.maskPhoneNumber(to)
    };
  }

  /**
   * Send SMS via AWS SNS
   */
  async sendAWSSMS(to, message, options) {
    const params = {
      Message: message,
      PhoneNumber: this.formatPhoneNumber(to),
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: options.urgent ? 'Transactional' : 'Promotional'
        }
      }
    };

    const result = await this.client.publish(params).promise();

    return {
      status: 'sent',
      messageId: result.MessageId,
      provider: 'aws_sns',
      to: this.maskPhoneNumber(to)
    };
  }

  /**
   * Send critical lead alert via SMS
   */
  async sendCriticalLeadAlert(phoneNumber, leadInfo) {
    const message = `TNT CRITICAL: High-value lead ($${leadInfo.estimated_value}) from ${leadInfo.contact_name}. Score: ${leadInfo.lead_score}. RESPOND NOW within 5min commitment. View: ${process.env.DASHBOARD_URL}/leads/${leadInfo.id}`;

    return this.sendSMS(phoneNumber, message, { urgent: true });
  }

  /**
   * Send response time violation alert
   */
  async sendResponseTimeAlert(phoneNumber, leadInfo, minutesElapsed) {
    const urgency = minutesElapsed >= 10 ? 'CRITICAL' : 'URGENT';
    const message = `TNT ${urgency}: Lead from ${leadInfo.contact_name} waiting ${minutesElapsed}min. 5-min commitment at risk! Call ${leadInfo.phone || 'now'} or view ${process.env.DASHBOARD_URL}/leads/${leadInfo.id}`;

    return this.sendSMS(phoneNumber, message, { urgent: true });
  }

  /**
   * Send system error alert
   */
  async sendSystemAlert(phoneNumber, alertTitle, alertMessage) {
    const message = `TNT SYSTEM ALERT: ${alertTitle}. ${alertMessage}. Check dashboard immediately.`;

    return this.sendSMS(phoneNumber, message, { urgent: true });
  }

  /**
   * Format phone number for SMS providers
   */
  formatPhoneNumber(phoneNumber) {
    // Remove all non-numeric characters
    const cleaned = phoneNumber.replace(/\D/g, '');

    // Add country code if missing (assume US +1)
    if (cleaned.length === 10) {
      return `+1${cleaned}`;
    } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `+${cleaned}`;
    }

    return phoneNumber; // Return as-is if already formatted
  }

  /**
   * Mask phone number for logging (privacy)
   */
  maskPhoneNumber(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.length >= 10) {
      return `***-***-${cleaned.slice(-4)}`;
    }
    return '***-***-****';
  }

  /**
   * Validate phone number format
   */
  isValidPhoneNumber(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15;
  }

  /**
   * Test SMS configuration
   */
  async testConfiguration(testPhoneNumber) {
    if (!this.enabled) {
      return {
        status: 'disabled',
        message: 'SMS service is disabled'
      };
    }

    if (!testPhoneNumber) {
      return {
        status: 'failed',
        message: 'Test phone number required'
      };
    }

    if (!this.isValidPhoneNumber(testPhoneNumber)) {
      return {
        status: 'failed',
        message: 'Invalid test phone number format'
      };
    }

    try {
      const testMessage = `TNT Lead System: SMS configuration test successful. Sent at ${new Date().toLocaleString()}`;

      const result = await this.sendSMS(testPhoneNumber, testMessage);

      return {
        status: 'success',
        message: 'Test SMS sent successfully',
        provider: this.provider,
        messageId: result.messageId
      };

    } catch (error) {
      return {
        status: 'failed',
        message: error.message,
        provider: this.provider
      };
    }
  }

  /**
   * Get service health status
   */
  getHealthStatus() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      from_number_configured: !!this.fromNumber,
      credentials_configured: this.getCredentialsStatus(),
      last_check: new Date().toISOString()
    };
  }

  /**
   * Check if credentials are configured (without exposing them)
   */
  getCredentialsStatus() {
    switch (this.provider) {
      case 'twilio':
        return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
      case 'aws_sns':
        return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
      default:
        return false;
    }
  }
}

// Create singleton instance
const smsService = new SMSService();

module.exports = smsService;