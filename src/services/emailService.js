/**
 * TNT Corporate Lead System - Email Service
 *
 * Handles all email sending via richweb.net SMTP with TNT branding
 */

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { createExternalServiceError } = require('../middleware/errorHandler');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConnected = false;
    this.initializeTransporter();
  }

  /**
   * Initialize SMTP transporter
   */
  initializeTransporter() {
    try {
      this.transporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST || 'mail.richweb.net',
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        rateLimit: 14, // messages per second
        debug: process.env.NODE_ENV === 'development'
      });

      // Verify connection
      this.verifyConnection();

    } catch (error) {
      logger.error('Failed to initialize email transporter:', error);
      throw createExternalServiceError('Email service initialization failed', 'smtp', error);
    }
  }

  /**
   * Verify SMTP connection
   */
  async verifyConnection() {
    try {
      await this.transporter.verify();
      this.isConnected = true;
      logger.info('✅ SMTP connection verified successfully');
    } catch (error) {
      this.isConnected = false;
      logger.error('❌ SMTP connection verification failed:', error);
      throw createExternalServiceError('SMTP connection failed', 'smtp', error);
    }
  }

  /**
   * Send email with TNT branding
   */
  async sendEmail(options) {
    if (!this.isConnected) {
      await this.verifyConnection();
    }

    const {
      to,
      subject,
      text,
      html,
      leadId,
      templateName,
      cc,
      bcc,
      attachments
    } = options;

    try {
      const mailOptions = {
        from: {
          name: 'TNT Limousine Service',
          address: process.env.SMTP_FROM || 'dispatch@tntlimousine.com'
        },
        to,
        cc,
        bcc,
        subject,
        text: this.addEmailFooter(text),
        html: html ? this.addHtmlFooter(html) : undefined,
        attachments,
        headers: {
          'X-TNT-Lead-ID': leadId,
          'X-TNT-Template': templateName,
          'X-Mailer': 'TNT Lead System v2.0'
        }
      };

      const result = await this.transporter.sendMail(mailOptions);

      logger.info('Email sent successfully:', {
        messageId: result.messageId,
        to,
        subject: subject.substring(0, 50),
        leadId,
        templateName
      });

      return {
        messageId: result.messageId,
        accepted: result.accepted,
        rejected: result.rejected,
        status: 'sent'
      };

    } catch (error) {
      logger.error('Failed to send email:', {
        to,
        subject,
        leadId,
        templateName,
        error: error.message
      });

      throw createExternalServiceError(
        `Failed to send email to ${to}: ${error.message}`,
        'smtp',
        error
      );
    }
  }

  /**
   * Send notification email to managers
   */
  async sendNotificationEmail(user, notification, lead) {
    const subject = `TNT Alert: ${notification.title}`;

    const text = `
Dear ${user.getFullName()},

${notification.message}

LEAD DETAILS:
- Company: ${lead.company_name || 'Individual Customer'}
- Contact: ${lead.contact_name}
- Email: ${lead.email}
- Phone: ${lead.phone || 'Not provided'}
- Service Type: ${lead.service_type}
- Estimated Value: $${lead.estimated_value || 'N/A'}
- Lead Score: ${lead.lead_score}/100
- Created: ${new Date(lead.created_at).toLocaleString()}

${notification.action_required ? `ACTION REQUIRED: ${notification.action_url}` : ''}

View full lead details: ${process.env.DASHBOARD_URL}/leads/${lead.id}

This alert was generated automatically by the TNT Lead Management System.
`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #dc2626; color: white; padding: 20px; text-align: center;">
        <h1 style="margin: 0;">TNT Limousine</h1>
        <p style="margin: 5px 0 0 0;">Lead Management Alert</p>
      </div>

      <div style="padding: 20px; background: #f9f9f9;">
        <h2 style="color: #dc2626;">${notification.title}</h2>

        <p style="font-size: 16px; line-height: 1.6;">
          Dear ${user.getFullName()},
        </p>

        <p style="font-size: 16px; line-height: 1.6;">
          ${notification.message}
        </p>

        <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="color: #dc2626; margin-top: 0;">Lead Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 5px 0; font-weight: bold;">Company:</td><td>${lead.company_name || 'Individual Customer'}</td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Contact:</td><td>${lead.contact_name}</td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Email:</td><td><a href="mailto:${lead.email}">${lead.email}</a></td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Phone:</td><td><a href="tel:${lead.phone || ''}">${lead.phone || 'Not provided'}</a></td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Service Type:</td><td>${lead.service_type}</td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Estimated Value:</td><td>$${lead.estimated_value || 'N/A'}</td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Lead Score:</td><td>${lead.lead_score}/100</td></tr>
            <tr><td style="padding: 5px 0; font-weight: bold;">Created:</td><td>${new Date(lead.created_at).toLocaleString()}</td></tr>
          </table>
        </div>

        ${notification.action_required ? `
        <div style="text-align: center; margin: 30px 0;">
          <a href="${notification.action_url || `${process.env.DASHBOARD_URL}/leads/${lead.id}`}"
             style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">
            Take Action Now
          </a>
        </div>
        ` : ''}

        <p style="text-align: center;">
          <a href="${process.env.DASHBOARD_URL}/leads/${lead.id}" style="color: #dc2626;">
            View Full Lead Details →
          </a>
        </p>
      </div>
    </div>
    `;

    return this.sendEmail({
      to: user.email,
      subject,
      text,
      html,
      leadId: lead.id,
      templateName: 'notification_alert'
    });
  }

  /**
   * Send response time alert to managers
   */
  async sendResponseTimeAlert(user, lead, minutesElapsed) {
    const urgency = minutesElapsed >= 10 ? 'CRITICAL' : 'URGENT';
    const subject = `TNT ${urgency}: 5-Minute Response Time Alert - ${lead.contact_name}`;

    const text = `
${urgency} ALERT: TNT 5-Minute Response Commitment at Risk

Dear ${user.getFullName()},

A lead from ${lead.contact_name} at ${lead.company_name || 'Individual Customer'} has been waiting for ${minutesElapsed} minutes without a response.

TNT's 5-minute response commitment is at risk.

IMMEDIATE ACTION REQUIRED:
- Contact the customer immediately at ${lead.phone || lead.email}
- Send immediate response confirming receipt of inquiry
- Update lead status in the system

LEAD DETAILS:
- Contact: ${lead.contact_name}
- Company: ${lead.company_name || 'Individual Customer'}
- Email: ${lead.email}
- Phone: ${lead.phone || 'Not provided'}
- Service Type: ${lead.service_type}
- Estimated Value: $${lead.estimated_value || 'N/A'}
- Lead Score: ${lead.lead_score}/100
- Minutes Elapsed: ${minutesElapsed}

View lead: ${process.env.DASHBOARD_URL}/leads/${lead.id}

Time is critical - please respond immediately.
`;

    return this.sendEmail({
      to: user.email,
      subject,
      text,
      leadId: lead.id,
      templateName: 'response_time_alert'
    });
  }

  /**
   * Add TNT footer to plain text emails
   */
  addEmailFooter(text) {
    return `${text}

---
TNT Limousine Service
Richmond, Virginia's Premier Transportation Provider
Phone: (804) 353-8080
Email: dispatch@tntlimousine.com
Website: https://www.tntlimousine.com

"Driven by Service, Defined by Excellence"

Licensed & Insured | National Limousine Association Member
Serving Richmond, VA Metro Area Since 1992`;
  }

  /**
   * Add TNT footer to HTML emails
   */
  addHtmlFooter(html) {
    const footer = `
    <div style="margin-top: 30px; padding: 20px; background: #f5f5f5; border-top: 3px solid #dc2626; text-align: center; font-size: 12px; color: #666;">
      <div style="font-weight: bold; color: #dc2626; margin-bottom: 10px;">TNT Limousine Service</div>
      <div>Richmond, Virginia's Premier Transportation Provider</div>
      <div style="margin: 10px 0;">
        Phone: <a href="tel:+18043538080" style="color: #dc2626;">(804) 353-8080</a> |
        Email: <a href="mailto:dispatch@tntlimousine.com" style="color: #dc2626;">dispatch@tntlimousine.com</a>
      </div>
      <div><a href="https://www.tntlimousine.com" style="color: #dc2626;">www.tntlimousine.com</a></div>
      <div style="margin: 10px 0; font-style: italic;">"Driven by Service, Defined by Excellence"</div>
      <div style="font-size: 10px;">Licensed & Insured | National Limousine Association Member | Serving Richmond, VA Metro Area Since 1992</div>
    </div>
    `;

    return html + footer;
  }

  /**
   * Test email configuration
   */
  async testEmailConfiguration() {
    try {
      const testResult = await this.sendEmail({
        to: process.env.TEST_EMAIL || 'admin@tntlimousine.com',
        subject: 'TNT Lead System - Email Configuration Test',
        text: 'This is a test email to verify TNT Lead System email configuration is working correctly.',
        templateName: 'configuration_test'
      });

      return {
        status: 'success',
        messageId: testResult.messageId
      };

    } catch (error) {
      return {
        status: 'failed',
        error: error.message
      };
    }
  }

  /**
   * Get email service health status
   */
  async getHealthStatus() {
    try {
      if (!this.isConnected) {
        await this.verifyConnection();
      }

      return {
        status: 'healthy',
        connected: this.isConnected,
        lastCheck: new Date().toISOString()
      };

    } catch (error) {
      return {
        status: 'unhealthy',
        connected: false,
        error: error.message,
        lastCheck: new Date().toISOString()
      };
    }
  }
}

// Create singleton instance
const emailService = new EmailService();

module.exports = emailService;