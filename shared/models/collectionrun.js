// shared/models/collectionrun.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class CollectionRun extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A CollectionRun belongs to a ConnectorConfig
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
    connectorConfigId: {
      type: DataTypes.UUID,
      allowNull: true, // Matches migration
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'ConnectorConfig', // Model name (singular)
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
    modelName: 'CollectionRun',
    tableName: 'CollectionRuns', // Explicitly define table name
    timestamps: true
  });
  return CollectionRun;
};