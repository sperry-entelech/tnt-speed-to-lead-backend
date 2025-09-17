/**
 * TNT Corporate Lead System - User Model
 *
 * System users including managers, dispatchers, and administrators
 */

const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    // Basic Information
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
        notEmpty: true
      }
    },
    password_hash: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    first_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 100]
      }
    },
    last_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 100]
      }
    },
    phone: {
      type: DataTypes.STRING(50),
      allowNull: true,
      validate: {
        is: /^\+?[1-9]\d{1,14}$/
      }
    },

    // Role & Permissions
    role: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'dispatcher',
      validate: {
        isIn: [['admin', 'manager', 'dispatcher']]
      }
    },
    permissions: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      comment: 'Detailed permissions object'
    },

    // Settings
    timezone: {
      type: DataTypes.STRING(50),
      defaultValue: 'America/New_York'
    },
    notification_preferences: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {
        email: true,
        sms: false,
        slack: false,
        high_value_leads: true,
        response_time_alerts: true
      }
    },
    dashboard_config: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },

    // Status
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    email_verified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    last_login: {
      type: DataTypes.DATE,
      allowNull: true
    },

    // Security
    failed_login_attempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    locked_until: {
      type: DataTypes.DATE,
      allowNull: true
    },
    password_reset_token: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    password_reset_expires: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    tableName: 'users',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['email'], unique: true },
      { fields: ['role'] },
      { fields: ['active'] },
      { fields: ['password_reset_token'], where: { password_reset_token: { [sequelize.Sequelize.Op.ne]: null } } }
    ]
  });

  // Instance methods
  User.prototype.validatePassword = async function(password) {
    return bcrypt.compare(password, this.password_hash);
  };

  User.prototype.hashPassword = async function(password) {
    this.password_hash = await bcrypt.hash(password, 12);
  };

  User.prototype.recordLogin = function() {
    this.last_login = new Date();
    this.failed_login_attempts = 0;
    this.locked_until = null;
    return this.save();
  };

  User.prototype.recordFailedLogin = function() {
    this.failed_login_attempts += 1;

    // Lock account after 5 failed attempts
    if (this.failed_login_attempts >= 5) {
      this.locked_until = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    }

    return this.save();
  };

  User.prototype.isLocked = function() {
    return this.locked_until && new Date() < new Date(this.locked_until);
  };

  User.prototype.unlock = function() {
    this.locked_until = null;
    this.failed_login_attempts = 0;
    return this.save();
  };

  User.prototype.hasPermission = function(resource, action) {
    if (this.role === 'admin') return true;

    const permissions = this.permissions || {};
    const resourcePerms = permissions[resource];

    if (!resourcePerms) return false;

    return resourcePerms[action] === true;
  };

  User.prototype.canAccessLeads = function() {
    return this.hasPermission('leads', 'read');
  };

  User.prototype.canManageSettings = function() {
    return this.role === 'admin' || this.hasPermission('settings', 'manage');
  };

  User.prototype.getFullName = function() {
    return `${this.first_name} ${this.last_name}`;
  };

  User.prototype.shouldReceiveNotification = function(notificationType) {
    const prefs = this.notification_preferences || {};
    return prefs[notificationType] === true;
  };

  // Hooks
  User.beforeCreate(async (user) => {
    if (user.password_hash && !user.password_hash.startsWith('$2b$')) {
      await user.hashPassword(user.password_hash);
    }
  });

  User.beforeUpdate(async (user) => {
    if (user.changed('password_hash') && !user.password_hash.startsWith('$2b$')) {
      await user.hashPassword(user.password_hash);
    }
  });

  // Define associations
  User.associate = (models) => {
    User.hasMany(models.LeadInteraction, {
      foreignKey: 'user_id',
      as: 'interactions'
    });

    User.hasMany(models.AutomatedResponse, {
      foreignKey: 'created_by',
      as: 'created_templates'
    });

    User.hasMany(models.Notification, {
      foreignKey: 'recipient_user_ids',
      as: 'notifications'
    });
  };

  // Class methods
  User.findByEmail = function(email) {
    return this.findOne({
      where: { email: email.toLowerCase() }
    });
  };

  User.findActive = function() {
    return this.findAll({
      where: { active: true },
      order: [['first_name', 'ASC'], ['last_name', 'ASC']]
    });
  };

  User.findByRole = function(role) {
    return this.findAll({
      where: { role, active: true },
      order: [['first_name', 'ASC'], ['last_name', 'ASC']]
    });
  };

  User.findNotificationRecipients = function(notificationType) {
    return this.findAll({
      where: {
        active: true,
        notification_preferences: {
          [notificationType]: true
        }
      }
    });
  };

  return User;
};