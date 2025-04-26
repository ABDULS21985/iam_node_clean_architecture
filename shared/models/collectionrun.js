// shared/models/collectionrun.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class CollectionRun extends Model {
    static associate(models) {
      // define association here

      // A CollectionRun belongs to a ConnectorConfig (the source it pulled data from)
      CollectionRun.belongsTo(models.ConnectorConfig, {
        foreignKey: 'connectorConfigId', // The foreign key in the CollectionRuns table
        as: 'connectorConfig' // Alias to access the connector config from a run instance
        // onDelete: 'SET NULL' is defined in the migration for DB integrity
      });
    }
  }
  CollectionRun.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    connectorConfigId: { // The source connector used for this run
      type: DataTypes.UUID,
      allowNull: true, // Matches migration
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'ConnectorConfig', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
    },
    status: { // 'started', 'in_progress', 'completed', 'failed', 'cancelled'
      type: DataTypes.STRING,
      allowNull: false, // Matches migration
      defaultValue: 'started' // Matches migration
    },
    startTime: { // Timestamp when the run started
      type: DataTypes.DATE,
      allowNull: false, // Matches migration (should be false if defaultValue is NOW)
      defaultValue: Sequelize.NOW // Matches migration
    },
    endTime: { // Timestamp when the run finished
      type: DataTypes.DATE,
      allowNull: true // Matches migration
    },
    metrics: { // Store metrics (e.g., { recordsPulled: X, joiners: Y, movers: Z, leavers: W, errors: E })
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    },
    errorDetails: { // Store details about errors encountered during the run
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    },
    metadata: { // Store any other relevant data (e.g., config snapshot)
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    }
  }, {
    sequelize,
    modelName: 'CollectionRun',
    tableName: 'CollectionRuns', // Explicitly define table name
    timestamps: true, // Handles createdAt and updatedAt
    underscored: false, // Ensure column names match attribute names
    // No unique indexes spanning multiple fields are typically needed for run logs
  });
  return CollectionRun;
};