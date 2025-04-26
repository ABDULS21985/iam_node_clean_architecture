// shared/models/currentappstate.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class CurrentAppState extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A discovered state entry can belong to a User (if mapped)
      CurrentAppState.belongsTo(models.User, {
        foreignKey: 'userId', // The foreign key in this table
        as: 'user', // Alias for association
        allowNull: true, // Matches migration
        // onDelete: 'SET NULL' is defined in migration
      });

      // A discovered state entry belongs to an Application
      CurrentAppState.belongsTo(models.Application, {
        foreignKey: 'applicationId', // The foreign key in this table
        as: 'application', // Alias for association
        allowNull: false, // Matches migration
        // onDelete: 'CASCADE' is defined in migration
      });

      // A discovered state entry can belong to a DiscoveryRun
      CurrentAppState.belongsTo(models.DiscoveryRun, {
        foreignKey: 'runId', // The foreign key in this table
        as: 'discoveryRun', // Alias for association
        allowNull: true, // Matches migration
        // onDelete: 'SET NULL' is defined in migration
      });
    }
  }
  CurrentAppState.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true, // Matches migration
       // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'User', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
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
    appSpecificUserId: {
      type: DataTypes.STRING,
      allowNull: false // Matches migration
    },
    appSpecificEntitlementId: {
      type: DataTypes.STRING,
      allowNull: false // Matches migration
    },
    discoveredAt: {
      type: DataTypes.DATE,
      allowNull: false, // Matches migration
      defaultValue: Sequelize.NOW // Matches migration
    },
    runId: {
      type: DataTypes.UUID,
      allowNull: true, // Matches migration
       // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'DiscoveryRun', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    }
  }, {
    sequelize,
    modelName: 'CurrentAppState',
    tableName: 'CurrentAppStates', // Explicitly define table name
    timestamps: true, // Handles createdAt and updatedAt
    underscored: false, // Ensure column names match attribute names
    // --- Define composite unique index in the model for clarity ---
    indexes: [
      {
        unique: true,
        fields: ['applicationId', 'appSpecificUserId', 'appSpecificEntitlementId'],
        name: 'current_app_states_app_user_entitlement_unique_composite' // Match name from migration
      }
    ]
    // --- End Composite Unique Index Definition ---
  });
  return CurrentAppState;
};