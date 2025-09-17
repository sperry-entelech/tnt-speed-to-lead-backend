#!/usr/bin/env node

/**
 * TNT Corporate Lead System - Main Server
 *
 * Business Goals:
 * - Sub-5-minute lead response time (vs current 48-72 hours)
 * - 25%+ inquiry-to-booking conversion rate
 * - $15K+ monthly revenue recovery through automation
 * - 24/7 corporate lead capture and processing
 */

require('dotenv').config();
const app = require('./app');
const { sequelize } = require('./database/connection');
const logger = require('./utils/logger');
const { initializeQueues } = require('./queues');

const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Start the TNT Lead System server
 */
async function startServer() {
  try {
    // Test database connection
    logger.info('🔍 Testing database connection...');
    await sequelize.authenticate();
    logger.info('✅ Database connection established successfully');

    // Sync database models (only in development)
    if (NODE_ENV === 'development') {
      logger.info('🔄 Synchronizing database models...');
      await sequelize.sync({ alter: true });
      logger.info('✅ Database models synchronized');
    }

    // Initialize background job queues
    logger.info('🚀 Initializing background job queues...');
    await initializeQueues();
    logger.info('✅ Background queues initialized');

    // Start the Express server
    const server = app.listen(PORT, () => {
      logger.info(`🎯 TNT Corporate Lead System API Server started`);
      logger.info(`📍 Environment: ${NODE_ENV}`);
      logger.info(`🌐 Server running on port ${PORT}`);
      logger.info(`📊 API Documentation: http://localhost:${PORT}/api-docs`);
      logger.info(`⚡ Health Check: http://localhost:${PORT}/health`);
      logger.info(`🎯 Business Goal: <5-minute lead response time`);
      logger.info(`💰 Revenue Target: $15K+ monthly recovery`);
    });

    // Graceful shutdown handling
    process.on('SIGTERM', () => {
      logger.info('🛑 SIGTERM received, shutting down gracefully');
      server.close(() => {
        logger.info('✅ HTTP server closed');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.info('🛑 SIGINT received, shutting down gracefully');
      server.close(() => {
        logger.info('✅ HTTP server closed');
        process.exit(0);
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (err) => {
      logger.error('❌ Unhandled Promise Rejection:', err);
      server.close(() => {
        process.exit(1);
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      logger.error('❌ Uncaught Exception:', err);
      process.exit(1);
    });

  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();