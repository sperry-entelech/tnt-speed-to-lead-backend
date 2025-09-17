/**
 * TNT Corporate Lead System - Authentication Middleware
 *
 * JWT and API key authentication for secure access
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models');
const logger = require('../utils/logger');

/**
 * Validate API Key for external integrations
 */
const validateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey) {
      return res.status(401).json({
        error: {
          code: 'MISSING_API_KEY',
          message: 'API key is required',
          details: ['Provide X-API-Key header or Authorization Bearer token']
        }
      });
    }

    // Check if it's a valid API key format (for external services)
    if (apiKey === process.env.TNT_API_KEY) {
      req.auth = {
        type: 'api_key',
        service: 'external',
        permissions: ['leads:create', 'leads:read', 'webhooks:receive']
      };
      return next();
    }

    // Try to validate as JWT token
    try {
      const decoded = jwt.verify(apiKey, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.userId);

      if (!user || !user.active) {
        return res.status(401).json({
          error: {
            code: 'INVALID_USER',
            message: 'User not found or inactive'
          }
        });
      }

      if (user.isLocked()) {
        return res.status(423).json({
          error: {
            code: 'ACCOUNT_LOCKED',
            message: 'Account is temporarily locked due to failed login attempts'
          }
        });
      }

      req.auth = {
        type: 'jwt',
        user: user,
        userId: user.id,
        role: user.role,
        permissions: user.permissions || {}
      };

      return next();

    } catch (jwtError) {
      // If JWT validation fails, check other API key sources
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired authentication token',
          details: ['Provide a valid API key or JWT token']
        }
      });
    }

  } catch (error) {
    logger.error('Authentication error:', error);
    return res.status(500).json({
      error: {
        code: 'AUTH_ERROR',
        message: 'Authentication system error'
      }
    });
  }
};

/**
 * Require specific user role
 */
const requireRole = (requiredRole) => {
  return (req, res, next) => {
    if (!req.auth || req.auth.type !== 'jwt') {
      return res.status(401).json({
        error: {
          code: 'JWT_REQUIRED',
          message: 'JWT authentication required for this endpoint'
        }
      });
    }

    if (req.auth.role === 'admin') {
      return next(); // Admins can access everything
    }

    if (req.auth.role !== requiredRole) {
      return res.status(403).json({
        error: {
          code: 'INSUFFICIENT_ROLE',
          message: `Role '${requiredRole}' required, but user has role '${req.auth.role}'`
        }
      });
    }

    next();
  };
};

/**
 * Require specific permission
 */
const requirePermission = (resource, action) => {
  return (req, res, next) => {
    if (!req.auth || req.auth.type !== 'jwt') {
      return res.status(401).json({
        error: {
          code: 'JWT_REQUIRED',
          message: 'JWT authentication required for this endpoint'
        }
      });
    }

    // Admin users have all permissions
    if (req.auth.role === 'admin') {
      return next();
    }

    // Check user permissions
    const userPermissions = req.auth.permissions || {};
    const resourcePermissions = userPermissions[resource];

    if (!resourcePermissions || !resourcePermissions[action]) {
      return res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: `Permission '${resource}:${action}' required`
        }
      });
    }

    next();
  };
};

/**
 * Optional authentication - doesn't fail if no auth provided
 */
const optionalAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    req.auth = { type: 'anonymous' };
    return next();
  }

  try {
    // Try to authenticate but don't fail if invalid
    await validateApiKey(req, res, next);
  } catch (error) {
    req.auth = { type: 'anonymous' };
    next();
  }
};

/**
 * Generate JWT token for user
 */
const generateToken = (user) => {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    iat: Math.floor(Date.now() / 1000)
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    issuer: 'tnt-lead-system',
    audience: 'tnt-users'
  });
};

/**
 * Verify token without middleware (for manual verification)
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

/**
 * Rate limiting for authentication endpoints
 */
const authRateLimit = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    error: {
      code: 'AUTH_RATE_LIMIT',
      message: 'Too many authentication attempts, please try again later'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for successful authentications
    return req.auth && req.auth.type === 'jwt';
  }
});

/**
 * Webhook signature validation
 */
const validateWebhookSignature = (expectedSource) => {
  return (req, res, next) => {
    // Skip signature validation in development
    if (process.env.NODE_ENV === 'development') {
      return next();
    }

    const signature = req.headers['x-webhook-signature'] || req.headers['signature'];
    const timestamp = req.headers['x-timestamp'] || req.headers['timestamp'];

    if (!signature || !timestamp) {
      return res.status(401).json({
        error: {
          code: 'MISSING_WEBHOOK_AUTH',
          message: 'Webhook signature and timestamp required'
        }
      });
    }

    // Verify timestamp is recent (within 5 minutes)
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp);

    if (Math.abs(now - requestTime) > 300) { // 5 minutes
      return res.status(401).json({
        error: {
          code: 'WEBHOOK_TIMESTAMP_INVALID',
          message: 'Webhook timestamp is too old or in the future'
        }
      });
    }

    // Verify signature based on source
    const crypto = require('crypto');
    const secret = process.env[`${expectedSource.toUpperCase()}_WEBHOOK_SECRET`];

    if (!secret) {
      logger.warn(`No webhook secret configured for ${expectedSource}`);
      return next(); // Allow in development/testing
    }

    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(timestamp + body)
      .digest('hex');

    const providedSignature = signature.replace('sha256=', '');

    if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature))) {
      return res.status(401).json({
        error: {
          code: 'WEBHOOK_SIGNATURE_INVALID',
          message: 'Webhook signature verification failed'
        }
      });
    }

    next();
  };
};

module.exports = {
  validateApiKey,
  requireRole,
  requirePermission,
  optionalAuth,
  generateToken,
  verifyToken,
  authRateLimit,
  validateWebhookSignature
};