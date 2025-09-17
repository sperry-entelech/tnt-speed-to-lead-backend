/**
 * TNT Corporate Lead System - Error Handling Middleware
 *
 * Comprehensive error handling and logging for production systems
 */

const logger = require('../utils/logger');
const { ValidationError, UniqueConstraintError, ForeignKeyConstraintError } = require('sequelize');

/**
 * Custom error classes
 */
class BusinessLogicError extends Error {
  constructor(message, code = 'BUSINESS_LOGIC_ERROR', statusCode = 400) {
    super(message);
    this.name = 'BusinessLogicError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class ExternalServiceError extends Error {
  constructor(message, service, originalError = null) {
    super(message);
    this.name = 'ExternalServiceError';
    this.code = 'EXTERNAL_SERVICE_ERROR';
    this.statusCode = 503;
    this.service = service;
    this.originalError = originalError;
  }
}

class LeadProcessingError extends Error {
  constructor(message, leadId, stage) {
    super(message);
    this.name = 'LeadProcessingError';
    this.code = 'LEAD_PROCESSING_ERROR';
    this.statusCode = 422;
    this.leadId = leadId;
    this.stage = stage;
  }
}

/**
 * Main error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  // Generate unique request ID for tracking
  const requestId = req.id || require('uuid').v4();

  // Default error response
  let errorResponse = {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
      request_id: requestId
    }
  };

  let statusCode = 500;

  // Handle different error types
  if (err instanceof ValidationError) {
    // Sequelize validation errors
    statusCode = 400;
    errorResponse.error = {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.errors.map(error => ({
        field: error.path,
        message: error.message,
        value: error.value
      })),
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('Validation error:', {
      requestId,
      url: req.url,
      method: req.method,
      errors: err.errors,
      userId: req.auth?.userId
    });

  } else if (err instanceof UniqueConstraintError) {
    // Duplicate entry errors
    statusCode = 409;
    const duplicateField = err.errors[0]?.path || 'unknown';

    errorResponse.error = {
      code: 'DUPLICATE_ENTRY',
      message: `A record with this ${duplicateField} already exists`,
      field: duplicateField,
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('Duplicate entry error:', {
      requestId,
      field: duplicateField,
      url: req.url,
      userId: req.auth?.userId
    });

  } else if (err instanceof ForeignKeyConstraintError) {
    // Foreign key constraint errors
    statusCode = 400;
    errorResponse.error = {
      code: 'INVALID_REFERENCE',
      message: 'Referenced record does not exist',
      details: ['Check that all referenced IDs are valid and exist'],
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('Foreign key constraint error:', {
      requestId,
      constraint: err.constraint,
      url: req.url,
      userId: req.auth?.userId
    });

  } else if (err instanceof BusinessLogicError) {
    // Custom business logic errors
    statusCode = err.statusCode;
    errorResponse.error = {
      code: err.code,
      message: err.message,
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('Business logic error:', {
      requestId,
      code: err.code,
      message: err.message,
      url: req.url,
      userId: req.auth?.userId
    });

  } else if (err instanceof ExternalServiceError) {
    // External service errors
    statusCode = err.statusCode;
    errorResponse.error = {
      code: err.code,
      message: err.message,
      service: err.service,
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.error('External service error:', {
      requestId,
      service: err.service,
      message: err.message,
      originalError: err.originalError?.message,
      url: req.url,
      userId: req.auth?.userId
    });

  } else if (err instanceof LeadProcessingError) {
    // Lead processing specific errors
    statusCode = err.statusCode;
    errorResponse.error = {
      code: err.code,
      message: err.message,
      lead_id: err.leadId,
      stage: err.stage,
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.error('Lead processing error:', {
      requestId,
      leadId: err.leadId,
      stage: err.stage,
      message: err.message,
      url: req.url,
      userId: req.auth?.userId
    });

  } else if (err.name === 'JsonWebTokenError') {
    // JWT errors
    statusCode = 401;
    errorResponse.error = {
      code: 'INVALID_TOKEN',
      message: 'Invalid authentication token',
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('JWT error:', {
      requestId,
      message: err.message,
      url: req.url
    });

  } else if (err.name === 'TokenExpiredError') {
    // Expired JWT
    statusCode = 401;
    errorResponse.error = {
      code: 'TOKEN_EXPIRED',
      message: 'Authentication token has expired',
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('JWT expired:', {
      requestId,
      expiredAt: err.expiredAt,
      url: req.url
    });

  } else if (err.type === 'entity.parse.failed') {
    // JSON parsing errors
    statusCode = 400;
    errorResponse.error = {
      code: 'INVALID_JSON',
      message: 'Invalid JSON in request body',
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('JSON parse error:', {
      requestId,
      url: req.url,
      method: req.method
    });

  } else if (err.code === 'LIMIT_FILE_SIZE') {
    // File upload size errors
    statusCode = 413;
    errorResponse.error = {
      code: 'FILE_TOO_LARGE',
      message: 'Uploaded file exceeds size limit',
      timestamp: new Date().toISOString(),
      request_id: requestId
    };

    logger.warn('File size limit error:', {
      requestId,
      url: req.url,
      userId: req.auth?.userId
    });

  } else {
    // Unhandled errors
    logger.error('Unhandled error:', {
      requestId,
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      userId: req.auth?.userId,
      body: req.body,
      params: req.params,
      query: req.query
    });

    // Don't expose internal error details in production
    if (process.env.NODE_ENV === 'production') {
      errorResponse.error.message = 'An unexpected error occurred';
    } else {
      errorResponse.error.message = err.message;
      errorResponse.error.stack = err.stack;
    }
  }

  // Add additional context in development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.debug = {
      url: req.url,
      method: req.method,
      params: req.params,
      query: req.query,
      body: req.body,
      user: req.auth?.userId
    };
  }

  res.status(statusCode).json(errorResponse);
};

/**
 * 404 Not Found handler
 */
const notFoundHandler = (req, res) => {
  const requestId = req.id || require('uuid').v4();

  logger.warn('Route not found:', {
    requestId,
    url: req.url,
    method: req.method,
    userId: req.auth?.userId
  });

  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Route ${req.method} ${req.url} not found`,
      timestamp: new Date().toISOString(),
      request_id: requestId
    }
  });
};

/**
 * Async error wrapper for route handlers
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Validation error helper
 */
const createValidationError = (message, details = []) => {
  const error = new BusinessLogicError(message, 'VALIDATION_ERROR', 400);
  error.details = details;
  return error;
};

/**
 * TNT-specific business error helpers
 */
const createLeadError = (message, leadId, stage) => {
  return new LeadProcessingError(message, leadId, stage);
};

const createExternalServiceError = (message, service, originalError = null) => {
  return new ExternalServiceError(message, service, originalError);
};

const createResponseTimeError = (leadId, minutesElapsed) => {
  return new LeadProcessingError(
    `Lead response time exceeded TNT's 5-minute commitment (${minutesElapsed} minutes)`,
    leadId,
    'response_time_violation'
  );
};

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  BusinessLogicError,
  ExternalServiceError,
  LeadProcessingError,
  createValidationError,
  createLeadError,
  createExternalServiceError,
  createResponseTimeError
};