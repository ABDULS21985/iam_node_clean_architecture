// shared/models/application.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Application extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // An Application has many Entitlements
      Application.hasMany(models.Entitlement, {
        foreignKey: 'applicationId', // The foreign key in the Entitlement table
        as: 'entitlements', // Alias to access entitlements from an application instance
        onDelete: 'CASCADE' // If an application is deleted, delete its associated entitlements
      });

      // An Application belongs to a ConnectorConfig (which we'll define later in the config DB)
      // This assumes the ConnectorConfig model will be available in 'models'
      Application.belongsTo(models.ConnectorConfig, {
        foreignKey: 'connectorId', // The foreign key in the Application table
        as: 'connectorConfig' // Alias to access the connector config
        // No onDelete: CASCADE here usually, SET NULL is often preferred (matches migration)
      });
    }
  }
  Application.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false, // Name is required
      unique: true // Application names must be unique
    },
    description: {
      type: DataTypes.STRING, // Or DataTypes.TEXT
      allowNull: true
    },
    type: {
      type: DataTypes.STRING, // e.g., 'core_banking', 'saas', etc.
      allowNull: true
    },
    connectorId: {
      type: DataTypes.UUID,
      field: 'connectorId', // Explicitly define the field name in the DB
      allowNull: true, // Matches migration
      // --- Add references here in model for association definition ---
      references: { // This is only for Sequelize association setup, not the DB constraint itself (that's in the migration)
          model: 'ConnectorConfig', // Model name (singular)
          key: 'id'
      }
      // --- End references ---
    }
  }, {
    sequelize,
    modelName: 'Application',
    tableName: 'Applications', // Explicitly define table name
    timestamps: true,
    underscored: false, // Use snake_case for DB columns
  });
  return Application;
};