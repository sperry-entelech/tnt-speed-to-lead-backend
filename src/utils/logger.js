/**
 * TNT Corporate Lead System - Winston Logger Configuration
 *
 * Enterprise-grade logging for production monitoring and debugging
 */

const winston = require('winston');
const path = require('path');

// Define log levels and colors
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue'
};

winston.addColors(logColors);

// Custom format for consistent logging
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.prettyPrint()
);

// Console format with colors for development
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta, null, 2)}`;
    }
    return log;
  })
);

// Create logger instance
const logger = winston.createLogger({
  levels: logLevels,
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  defaultMeta: {
    service: 'tnt-lead-system',
    version: process.env.API_VERSION || 'v2'
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? customFormat : consoleFormat,
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
    })
  ]
});

// Add file transports for production
if (process.env.NODE_ENV === 'production') {
  // Error log file
  logger.add(new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'error.log'),
    level: 'error',
    maxsize: 5242880, // 5MB
    maxFiles: 5,
    format: customFormat
  }));

  // Combined log file
  logger.add(new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'combined.log'),
    maxsize: 5242880, // 5MB
    maxFiles: 5,
    format: customFormat
  }));
}

// Business-specific logging helpers
logger.leadProcessed = (leadId, action, duration = null) => {
  logger.info('Lead processed', {
    leadId,
    action,
    duration: duration ? `${duration}ms` : null,
    component: 'lead-processing'
  });
};

logger.emailSent = (leadId, templateName, recipient) => {
  logger.info('Email sent', {
    leadId,
    templateName,
    recipient,
    component: 'email-automation'
  });
};

logger.integrationSync = (service, status, recordCount = null) => {
  logger.info('Integration sync', {
    service,
    status,
    recordCount,
    component: 'integrations'
  });
};

logger.performanceMetric = (metric, value, context = {}) => {
  logger.info('Performance metric', {
    metric,
    value,
    ...context,
    component: 'performance'
  });
};

// Handle uncaught exceptions and unhandled rejections
if (process.env.NODE_ENV === 'production') {
  logger.exceptions.handle(
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'exceptions.log')
    })
  );

  process.on('unhandledRejection', (ex) => {
    throw ex;
  });
}

module.exports = logger;