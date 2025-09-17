/**
 * TNT Corporate Lead System - Integration Queue Processor
 *
 * Processes external system integration sync jobs
 */

const { Lead, ExternalIntegration, WebhookLog } = require('../../models');
const logger = require('../../utils/logger');
const axios = require('axios');

/**
 * Process Zoho CRM sync
 */
async function processZohoSync(job) {
  const { serviceName, leadId, syncType, timestamp } = job.data;

  try {
    logger.info('Processing Zoho CRM sync:', {
      jobId: job.id,
      leadId,
      syncType,
      timestamp
    });

    const integration = await ExternalIntegration.findOne({
      where: { service_name: 'zoho_crm' }
    });

    if (!integration || !integration.active) {
      throw new Error('Zoho CRM integration not configured or inactive');
    }

    let result;
    let recordsProcessed = 0;

    if (leadId) {
      // Sync specific lead
      const lead = await Lead.findByPk(leadId);
      if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
      }

      result = await syncLeadToZoho(lead, integration);
      recordsProcessed = 1;
    } else {
      // Bulk sync based on type
      result = await performBulkZohoSync(syncType, integration);
      recordsProcessed = result.recordsProcessed || 0;
    }

    // Update integration status
    await integration.recordSuccessfulSync(recordsProcessed);

    logger.integrationSync('zoho_crm', 'success', recordsProcessed);

    return {
      status: 'completed',
      service: 'zoho_crm',
      records_processed: recordsProcessed,
      sync_type: syncType,
      result
    };

  } catch (error) {
    logger.error('Zoho CRM sync failed:', {
      jobId: job.id,
      leadId,
      error: error.message
    });

    // Update integration failure status
    const integration = await ExternalIntegration.findOne({
      where: { service_name: 'zoho_crm' }
    });

    if (integration) {
      await integration.recordFailedSync(error.message);
    }

    throw error;
  }
}

/**
 * Process FastTrack InVision sync
 */
async function processFasttrackSync(job) {
  const { serviceName, leadId, syncType, timestamp } = job.data;

  try {
    logger.info('Processing FastTrack sync:', {
      jobId: job.id,
      leadId,
      syncType,
      timestamp
    });

    const integration = await ExternalIntegration.findOne({
      where: { service_name: 'fasttrack_invision' }
    });

    if (!integration || !integration.active) {
      throw new Error('FastTrack InVision integration not configured or inactive');
    }

    let result;
    let recordsProcessed = 0;

    if (leadId) {
      // Sync specific lead
      const lead = await Lead.findByPk(leadId);
      if (!lead) {
        throw new Error(`Lead not found: ${leadId}`);
      }

      result = await syncLeadToFasttrack(lead, integration);
      recordsProcessed = 1;
    } else {
      // Bulk sync
      result = await performBulkFasttrackSync(syncType, integration);
      recordsProcessed = result.recordsProcessed || 0;
    }

    // Update integration status
    await integration.recordSuccessfulSync(recordsProcessed);

    logger.integrationSync('fasttrack_invision', 'success', recordsProcessed);

    return {
      status: 'completed',
      service: 'fasttrack_invision',
      records_processed: recordsProcessed,
      sync_type: syncType,
      result
    };

  } catch (error) {
    logger.error('FastTrack sync failed:', {
      jobId: job.id,
      leadId,
      error: error.message
    });

    // Update integration failure status
    const integration = await ExternalIntegration.findOne({
      where: { service_name: 'fasttrack_invision' }
    });

    if (integration) {
      await integration.recordFailedSync(error.message);
    }

    throw error;
  }
}

/**
 * Process webhook replay for failed webhooks
 */
async function processWebhookReplay(job) {
  const { webhookId, maxRetries = 3 } = job.data;

  try {
    logger.info('Processing webhook replay:', {
      jobId: job.id,
      webhookId
    });

    const webhookLog = await WebhookLog.findByPk(webhookId);

    if (!webhookLog) {
      throw new Error(`Webhook log not found: ${webhookId}`);
    }

    if (webhookLog.processed) {
      return {
        status: 'skipped',
        reason: 'already_processed',
        webhook_id: webhookId
      };
    }

    if (webhookLog.retry_count >= maxRetries) {
      return {
        status: 'abandoned',
        reason: 'max_retries_exceeded',
        webhook_id: webhookId,
        retry_count: webhookLog.retry_count
      };
    }

    // Process webhook based on source
    let result;
    switch (webhookLog.source) {
      case 'website_form':
        result = await replayFormSubmissionWebhook(webhookLog);
        break;
      case 'zoho_crm':
        result = await replayCrmWebhook(webhookLog);
        break;
      case 'email_provider':
        result = await replayEmailWebhook(webhookLog);
        break;
      default:
        throw new Error(`Unsupported webhook source: ${webhookLog.source}`);
    }

    if (result.success) {
      await webhookLog.markProcessed(result.leadId, result.interactionId);
    } else {
      await webhookLog.markFailed(result.error);
    }

    return {
      status: result.success ? 'completed' : 'failed',
      webhook_id: webhookId,
      retry_count: webhookLog.retry_count + 1,
      result
    };

  } catch (error) {
    logger.error('Webhook replay failed:', {
      jobId: job.id,
      webhookId,
      error: error.message
    });

    // Increment retry count
    const webhookLog = await WebhookLog.findByPk(webhookId);
    if (webhookLog) {
      await webhookLog.markFailed(error.message);
    }

    throw error;
  }
}

/**
 * Sync individual lead to Zoho CRM
 */
async function syncLeadToZoho(lead, integration) {
  // This is a placeholder implementation
  // In production, you would use actual Zoho API credentials and endpoints

  if (!process.env.ZOHO_ACCESS_TOKEN) {
    logger.warn('Zoho CRM sync skipped - no access token configured');
    return { status: 'skipped', reason: 'no_credentials' };
  }

  try {
    const zohoLead = {
      First_Name: lead.contact_name.split(' ')[0],
      Last_Name: lead.contact_name.split(' ').slice(1).join(' ') || 'Unknown',
      Email: lead.email,
      Phone: lead.phone,
      Company: lead.company_name || 'Individual Customer',
      Lead_Source: 'TNT Website',
      Lead_Status: mapLeadStatusToZoho(lead.status),
      Annual_Revenue: lead.estimated_value,
      Description: `Service Type: ${lead.service_type}\nPickup: ${lead.pickup_location || 'TBD'}\nDestination: ${lead.destination || 'TBD'}`,
      TNT_Lead_Score: lead.lead_score,
      TNT_Lead_ID: lead.id
    };

    const response = await axios.post(
      `${integration.api_endpoint}Leads`,
      { data: [zohoLead] },
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${process.env.ZOHO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.data.data && response.data.data[0].status === 'success') {
      const zohoId = response.data.data[0].details.id;

      // Update lead with Zoho ID
      await lead.update({ zoho_lead_id: zohoId });

      return {
        status: 'success',
        zoho_id: zohoId,
        action: lead.zoho_lead_id ? 'updated' : 'created'
      };
    } else {
      throw new Error(`Zoho API error: ${JSON.stringify(response.data)}`);
    }

  } catch (error) {
    if (error.response) {
      throw new Error(`Zoho API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * Sync individual lead to FastTrack InVision
 */
async function syncLeadToFasttrack(lead, integration) {
  // Placeholder implementation for FastTrack InVision
  logger.info('FastTrack sync placeholder - would sync lead to FastTrack InVision', {
    leadId: lead.id,
    contactName: lead.contact_name
  });

  return {
    status: 'placeholder',
    message: 'FastTrack InVision sync not yet implemented',
    lead_id: lead.id
  };
}

/**
 * Perform bulk Zoho CRM sync
 */
async function performBulkZohoSync(syncType, integration) {
  const limit = syncType === 'full' ? 1000 : 100;

  // Get leads that need syncing
  const whereClause = {};
  if (syncType === 'incremental') {
    // Only sync leads updated in last 24 hours
    whereClause.updated_at = {
      [require('sequelize').Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
    };
  }

  const leads = await Lead.findAll({
    where: whereClause,
    limit,
    order: [['updated_at', 'DESC']]
  });

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const lead of leads) {
    try {
      await syncLeadToZoho(lead, integration);
      successCount++;
    } catch (error) {
      errorCount++;
      errors.push({
        leadId: lead.id,
        error: error.message
      });

      if (errors.length >= 10) break; // Limit error collection
    }
  }

  return {
    recordsProcessed: successCount,
    totalRecords: leads.length,
    successCount,
    errorCount,
    errors: errors.slice(0, 5) // Return first 5 errors
  };
}

/**
 * Perform bulk FastTrack sync
 */
async function performBulkFasttrackSync(syncType, integration) {
  // Placeholder for FastTrack bulk sync
  logger.info('FastTrack bulk sync placeholder', { syncType });

  return {
    recordsProcessed: 0,
    message: 'FastTrack bulk sync not yet implemented'
  };
}

/**
 * Replay form submission webhook
 */
async function replayFormSubmissionWebhook(webhookLog) {
  try {
    const leadData = webhookLog.extractLeadData();

    // Check if lead already exists
    const existingLead = await Lead.findOne({
      where: { email: leadData.email }
    });

    if (existingLead) {
      return {
        success: true,
        leadId: existingLead.id,
        action: 'found_existing'
      };
    }

    // Create new lead
    const lead = await Lead.create(leadData);

    return {
      success: true,
      leadId: lead.id,
      action: 'created'
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Replay CRM webhook
 */
async function replayCrmWebhook(webhookLog) {
  // Placeholder for CRM webhook replay
  return {
    success: true,
    action: 'placeholder'
  };
}

/**
 * Replay email webhook
 */
async function replayEmailWebhook(webhookLog) {
  // Placeholder for email webhook replay
  return {
    success: true,
    action: 'placeholder'
  };
}

/**
 * Map TNT lead status to Zoho CRM status
 */
function mapLeadStatusToZoho(tntStatus) {
  const statusMap = {
    'new': 'Not Contacted',
    'contacted': 'Contacted',
    'qualified': 'Qualified',
    'converted': 'Converted',
    'lost': 'Lost Lead'
  };

  return statusMap[tntStatus] || 'Not Contacted';
}

module.exports = {
  processZohoSync,
  processFasttrackSync,
  processWebhookReplay
};