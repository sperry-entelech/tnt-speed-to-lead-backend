/**
 * TNT Corporate Lead System - Express Application Configuration
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const logger = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { validateApiKey } = require('./middleware/auth');

// Import route modules
const healthRoutes = require('./routes/health');
const leadRoutes = require('./routes/leads');
const automationRoutes = require('./routes/automation');
const analyticsRoutes = require('./routes/analytics');
const integrationRoutes = require('./routes/integrations');
const webhookRoutes = require('./routes/webhooks');

const app = express();

// =====================================================
// SECURITY & MIDDLEWARE CONFIGURATION
// =====================================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'https://tnt-dashboard.vercel.app',
      'https://www.tntlimousine.com',
      process.env.CORS_ORIGIN
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
};

if (process.env.ENABLE_CORS === 'true') {
  app.use(cors(corsOptions));
}

// Rate limiting for API protection
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP, please try again later.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Request parsing middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: {
      write: (message) => logger.info(message.trim())
    }
  }));
}

// Request ID middleware for tracking
app.use((req, res, next) => {
  req.id = require('uuid').v4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// =====================================================
// ROUTE CONFIGURATION
// =====================================================

// Health check (no authentication required)
app.use('/health', healthRoutes);

// API routes with authentication
const API_PREFIX = `/api/${process.env.API_VERSION || 'v2'}`;

// Webhook routes (special authentication)
app.use(`${API_PREFIX}/webhooks`, webhookRoutes);

// Protected API routes
app.use(`${API_PREFIX}/leads`, validateApiKey, leadRoutes);
app.use(`${API_PREFIX}/automation`, validateApiKey, automationRoutes);
app.use(`${API_PREFIX}/analytics`, validateApiKey, analyticsRoutes);
app.use(`${API_PREFIX}/integrations`, validateApiKey, integrationRoutes);

// API documentation (development only)
if (process.env.ENABLE_SWAGGER_DOCS === 'true') {
  const swaggerUi = require('swagger-ui-express');
  const YAML = require('yamljs');
  const path = require('path');

  try {
    const swaggerDocument = YAML.load(
      path.join(__dirname, '../../../phase2-architecture/api-specifications.yml')
    );
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
      customSiteTitle: 'TNT Corporate Lead System API',
      customCss: '.swagger-ui .topbar { background-color: #dc2626; }'
    }));
  } catch (error) {
    logger.warn('⚠️ Could not load Swagger documentation:', error.message);
  }
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'TNT Corporate Lead Automation System',
    version: process.env.API_VERSION || 'v2',
    status: 'operational',
    business_goal: 'Sub-5-minute lead response time',
    revenue_target: '$15K+ monthly recovery',
    documentation: process.env.ENABLE_SWAGGER_DOCS === 'true' ? '/api-docs' : 'Contact admin@tntlimousine.com',
    endpoints: {
      health: '/health',
      leads: `${API_PREFIX}/leads`,
      automation: `${API_PREFIX}/automation`,
      analytics: `${API_PREFIX}/analytics`,
      integrations: `${API_PREFIX}/integrations`,
      webhooks: `${API_PREFIX}/webhooks`
    }
  });
});

// =====================================================
// ERROR HANDLING
// =====================================================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

module.exports = app;