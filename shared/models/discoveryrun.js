// shared/models/discoveryrun.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class DiscoveryRun extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A DiscoveryRun belongs to an Application
      DiscoveryRun.belongsTo(models.Application, {
        foreignKey: 'applicationId', // The foreign key in the DiscoveryRuns table
        as: 'application' // Alias to access the application from a run instance
        // onDelete: 'CASCADE' is defined in the migration for DB integrity
      });
    }
  }
  DiscoveryRun.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    applicationId: {
      type: DataTypes.UUID,
      allowNull: false, // Matches migration
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'Application', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
    },
    status: {
      type: DataTypes.STRING, // 'started', 'in_progress', 'completed', 'failed', 'cancelled'
      allowNull: false, // Matches migration
      defaultValue: 'started' // Matches migration
    },
    startTime: {
      type: DataTypes.DATE,
      allowNull: false, // Matches migration
      defaultValue: Sequelize.NOW // Matches migration
    },
    endTime: {
      type: DataTypes.DATE,
      allowNull: true // Matches migration
    },
    metrics: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    },
    errorDetails: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    }
  }, {
    sequelize,
    modelName: 'DiscoveryRun',
    tableName: 'DiscoveryRuns', // Explicitly define table name
    timestamps: true
  });
  return DiscoveryRun;
};