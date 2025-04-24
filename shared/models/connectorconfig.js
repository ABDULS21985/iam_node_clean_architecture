// shared/models/connectorconfig.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ConnectorConfig extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A ConnectorConfig can be used by many Applications
      ConnectorConfig.hasMany(models.Application, {
        foreignKey: 'connectorId', // The foreign key in the Application table
        as: 'applications', // Alias to access applications from a connector config instance
        onDelete: 'SET NULL' // If a connector config is deleted, set the connectorId in Applications to NULL (matches migration)
      });

      // You might also define associations related to specific configuration types later if needed
      // For example, linking to HRMS configuration details or Provisioning capabilities
    }
  }
  ConnectorConfig.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false, // Name is required
      unique: true // Connector config names must be unique
    },
    serviceType: {
      type: DataTypes.STRING, // 'IdentityCollection' or 'Provisioning'
      allowNull: false // Service type is required
    },
    type: {
      type: DataTypes.STRING, // e.g., 'hrms-api-v1', 't24-soap', 'ad-ldap'
      allowNull: false // Connector adapter type is required
    },
    configuration: {
      type: DataTypes.JSONB,
      allowNull: false // The actual connection configuration details are required
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true // Metadata is optional
    }
  }, {
    sequelize,
    modelName: 'ConnectorConfig',
    tableName: 'ConnectorConfigs', // Explicitly define table name
    timestamps: true,
    underscored: false // <-- Add this line
    // Optional: You could define a composite unique index on [name, serviceType] if names only need to be unique within a service type
  });
  return ConnectorConfig;
};