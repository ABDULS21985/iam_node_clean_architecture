// File: Enterprise/shared/models/mappingconfig.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');

/**
 * MappingConfig model defines flexible mapping configurations
 * for different source and target entities within the Enterprise domain.
 */
module.exports = (sequelize, DataTypes) => {
  class MappingConfig extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // --- Flexible Associations for sourceId (Model level only) ---
      // This approach handles the flexible sourceId (ConnectorConfig or Application)
      // by defining potential associations here. Application logic will need
      // to check 'sourceType' to know which one to use.
      MappingConfig.belongsTo(models.ConnectorConfig, {
        foreignKey: 'sourceId',
        as: 'sourceConnectorConfig', // Alias when source is a ConnectorConfig
        constraints: false, // Do NOT enforce FK constraint at DB level via model
        scope: { sourceType: 'IdentityCollection' } // Optional: Hint for scoping queries
      });

      MappingConfig.belongsTo(models.Application, {
        foreignKey: 'sourceId',
        as: 'sourceApplication', // Alias when source is an Application
        constraints: false, // Do NOT enforce FK constraint at DB level via model
        scope: { sourceType: 'Provisioning' } // Optional: Hint for scoping queries
      });
      // --- End Flexible Associations ---

      // MappingConfig doesn't typically "belong to" a target, it defines the mapping *for* a target type.
    }
  }
  MappingConfig.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true // This uniqueness in the model often corresponds to a DB constraint
    },
    // --- Add this attribute definition ---
    serviceName: {
      type: DataTypes.STRING,
      allowNull: true // Matches migration (allowing null for non-service configs)
    },
    // --- End Add this attribute definition ---
    sourceType: {
      type: DataTypes.STRING,
      allowNull: false
    },
    sourceId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    targetType: {
      type: DataTypes.STRING,
      allowNull: false
    },
    mappingRules: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'MappingConfig',
    tableName: 'MappingConfigs', // Explicitly define table name
    timestamps: true,
    underscored: false
    // --- We will update the unique index/constraint via a NEW migration ---
    // Remove the 'unique: true' from the 'name' attribute above,
    // and add a composite index here after the migration is fixed.
    // indexes: [{ unique: true, fields: ['name', 'serviceName'] }] // Example composite unique index
  });
  return MappingConfig;
};