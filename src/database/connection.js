/**
 * TNT Corporate Lead System - Database Connection Configuration
 */

const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');

// Database configuration
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'tnt_lead_system',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  dialect: 'postgres',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  logging: process.env.ENABLE_DEBUG_LOGS === 'true' ?
    (msg) => logger.debug(msg) : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  define: {
    timestamps: true,
    underscored: true,
    freezeTableName: true
  }
};

// Use DATABASE_URL if provided (for Railway/Heroku deployment)
let sequelize;
if (process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: process.env.NODE_ENV === 'production' ? {
        require: true,
        rejectUnauthorized: false
      } : false
    },
    logging: config.logging,
    pool: config.pool,
    define: config.define
  });
} else {
  sequelize = new Sequelize(
    config.database,
    config.username,
    config.password,
    config
  );
}

/**
 * Test database connection
 */
async function testConnection() {
  try {
    await sequelize.authenticate();
    logger.info('✅ Database connection has been established successfully');
    return true;
  } catch (error) {
    logger.error('❌ Unable to connect to the database:', error);
    return false;
  }
}

/**
 * Close database connection
 */
async function closeConnection() {
  try {
    await sequelize.close();
    logger.info('✅ Database connection closed');
  } catch (error) {
    logger.error('❌ Error closing database connection:', error);
  }
}

module.exports = {
  sequelize,
  testConnection,
  closeConnection
};