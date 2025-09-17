/**
 * TNT Corporate Lead System - Scoring Factor Model
 *
 * Configurable lead scoring factors and weights
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const ScoringFactor = sequelize.define('ScoringFactor', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },

    // Factor Definition
    factor_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: true,
        len: [1, 100]
      }
    },
    factor_category: {
      type: DataTypes.STRING(50),
      allowNull: false,
      validate: {
        isIn: [['company', 'service', 'timing', 'geographic', 'behavioral']]
      }
    },

    // Scoring Configuration
    weight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        min: 0,
        max: 100
      }
    },
    calculation_method: {
      type: DataTypes.STRING(50),
      allowNull: false,
      validate: {
        isIn: [['exact_match', 'range', 'calculation', 'boolean']]
      }
    },

    // Value Mappings (JSON)
    value_mappings: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: 'Maps input values to scores'
    },

    // Status
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },

    // Description and usage
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    // User tracking
    updated_by: {
      type: DataTypes.UUID,
      allowNull: true
    }
  }, {
    tableName: 'scoring_factors',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['factor_name'], unique: true },
      { fields: ['factor_category'] },
      { fields: ['active'] },
      { fields: ['weight'] }
    ]
  });

  // Instance methods
  ScoringFactor.prototype.calculateScore = function(lead) {
    if (!this.active) return 0;

    const mappings = this.value_mappings || {};

    switch (this.calculation_method) {
      case 'exact_match':
        return this.calculateExactMatch(lead, mappings);

      case 'range':
        return this.calculateRange(lead, mappings);

      case 'calculation':
        return this.calculateDynamic(lead, mappings);

      case 'boolean':
        return this.calculateBoolean(lead, mappings);

      default:
        return 0;
    }
  };

  ScoringFactor.prototype.calculateExactMatch = function(lead, mappings) {
    let value = null;

    switch (this.factor_name) {
      case 'company_name_present':
        value = lead.company_name && lead.company_name.length > 0 ? 'present' : 'absent';
        break;

      case 'service_type_priority':
        value = lead.service_type;
        break;

      case 'budget_tier':
        value = lead.budget_tier;
        break;

      default:
        return 0;
    }

    return mappings[value] || 0;
  };

  ScoringFactor.prototype.calculateRange = function(lead, mappings) {
    let value = null;

    switch (this.factor_name) {
      case 'estimated_value_tier':
        value = lead.estimated_value || 0;
        break;

      case 'geographic_proximity':
        value = lead.distance_from_base || 999;
        break;

      case 'group_size_factor':
        value = lead.passenger_count || 1;
        break;

      case 'company_size_estimate':
        value = lead.company_size_estimate || 0;
        break;

      default:
        return 0;
    }

    // Find matching range
    for (const [range, score] of Object.entries(mappings)) {
      if (this.valueInRange(value, range)) {
        return score;
      }
    }

    return 0;
  };

  ScoringFactor.prototype.calculateDynamic = function(lead, mappings) {
    switch (this.factor_name) {
      case 'timing_urgency':
        const serviceDate = lead.service_date ? new Date(lead.service_date) : null;
        if (!serviceDate) return mappings.future || 0;

        const now = new Date();
        const hoursUntilService = (serviceDate - now) / (1000 * 60 * 60);

        if (hoursUntilService <= 24) return mappings.same_day || 0;
        if (hoursUntilService <= 48) return mappings.next_day || 0;
        return mappings.future || 0;

      case 'contact_completeness':
        let completeness = 0;
        if (lead.email) completeness += 25;
        if (lead.phone) completeness += 25;
        if (lead.company_name) completeness += 25;
        if (lead.pickup_location || lead.destination) completeness += 25;

        if (completeness >= 100) return mappings.complete || 0;
        if (completeness >= 75) return mappings.mostly_complete || 0;
        if (completeness >= 50) return mappings.partial || 0;
        return mappings.minimal || 0;

      default:
        return 0;
    }
  };

  ScoringFactor.prototype.calculateBoolean = function(lead, mappings) {
    let condition = false;

    switch (this.factor_name) {
      case 'has_website':
        condition = lead.website && lead.website.length > 0;
        break;

      case 'repeat_customer':
        // This would need to be determined by checking if email exists in previous leads
        condition = false; // Placeholder
        break;

      case 'weekend_submission':
        const submissionDate = new Date(lead.created_at);
        const dayOfWeek = submissionDate.getDay();
        condition = dayOfWeek === 0 || dayOfWeek === 6; // Sunday = 0, Saturday = 6
        break;

      default:
        condition = false;
    }

    return condition ? (mappings.true || 0) : (mappings.false || 0);
  };

  ScoringFactor.prototype.valueInRange = function(value, range) {
    if (range.includes('+')) {
      // Handle ranges like "1000+" or "8+"
      const minValue = parseInt(range.replace('+', ''));
      return value >= minValue;
    }

    if (range.includes('-')) {
      // Handle ranges like "500-999" or "0-25"
      const [min, max] = range.split('-').map(Number);
      return value >= min && value <= max;
    }

    // Handle exact values
    return value === parseInt(range);
  };

  // Define associations
  ScoringFactor.associate = (models) => {
    ScoringFactor.belongsTo(models.User, {
      foreignKey: 'updated_by',
      as: 'updater'
    });
  };

  // Class methods
  ScoringFactor.findActive = function() {
    return this.findAll({
      where: { active: true },
      order: [['weight', 'DESC'], ['factor_name', 'ASC']]
    });
  };

  ScoringFactor.findByCategory = function(category) {
    return this.findAll({
      where: {
        factor_category: category,
        active: true
      },
      order: [['weight', 'DESC']]
    });
  };

  ScoringFactor.calculateLeadScore = async function(lead) {
    const factors = await this.findActive();
    let totalScore = 0;

    for (const factor of factors) {
      const score = factor.calculateScore(lead);
      totalScore += score;
    }

    // Cap at 100
    return Math.min(totalScore, 100);
  };

  ScoringFactor.getScoreBreakdown = async function(lead) {
    const factors = await this.findActive();
    const breakdown = {
      total_score: 0,
      factors: []
    };

    for (const factor of factors) {
      const score = factor.calculateScore(lead);
      breakdown.total_score += score;
      breakdown.factors.push({
        name: factor.factor_name,
        category: factor.factor_category,
        weight: factor.weight,
        score: score,
        description: factor.description
      });
    }

    breakdown.total_score = Math.min(breakdown.total_score, 100);
    return breakdown;
  };

  ScoringFactor.createDefaultFactors = async function() {
    const defaultFactors = [
      {
        factor_name: 'company_name_present',
        factor_category: 'company',
        weight: 10,
        calculation_method: 'exact_match',
        value_mappings: { present: 10, absent: 0 },
        description: 'Adds points if company name is provided',
        active: true
      },
      {
        factor_name: 'estimated_value_tier',
        factor_category: 'service',
        weight: 30,
        calculation_method: 'range',
        value_mappings: { '1000+': 30, '500-999': 20, '100-499': 10, '0-99': 5 },
        description: 'Higher estimated values get more points',
        active: true
      },
      {
        factor_name: 'service_type_priority',
        factor_category: 'service',
        weight: 25,
        calculation_method: 'exact_match',
        value_mappings: {
          corporate: 25,
          airport: 20,
          events: 15,
          wedding: 15,
          hourly: 10
        },
        description: 'Corporate bookings have highest priority',
        active: true
      },
      {
        factor_name: 'geographic_proximity',
        factor_category: 'geographic',
        weight: 15,
        calculation_method: 'range',
        value_mappings: { '0-25': 15, '26-50': 10, '51-100': 5, '100+': 0 },
        description: 'Closer locations are prioritized',
        active: true
      },
      {
        factor_name: 'group_size_factor',
        factor_category: 'service',
        weight: 15,
        calculation_method: 'range',
        value_mappings: { '8+': 15, '4-7': 10, '2-3': 5, '1': 0 },
        description: 'Larger groups generate more revenue',
        active: true
      },
      {
        factor_name: 'timing_urgency',
        factor_category: 'timing',
        weight: 5,
        calculation_method: 'calculation',
        value_mappings: { same_day: 5, next_day: 3, future: 1 },
        description: 'Urgent bookings need immediate attention',
        active: true
      }
    ];

    const results = [];
    for (const factor of defaultFactors) {
      const [instance, created] = await this.findOrCreate({
        where: { factor_name: factor.factor_name },
        defaults: factor
      });
      results.push({ instance, created });
    }

    return results;
  };

  return ScoringFactor;
};