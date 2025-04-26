// shared/models/reconciliationresult.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ReconciliationResult extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A reconciliation result belongs to a DiscoveryRun (required)
      ReconciliationResult.belongsTo(models.DiscoveryRun, {
        foreignKey: 'runId', // The foreign key in this table
        as: 'discoveryRun', // Alias for association
        allowNull: false, // Matches migration
        // onDelete: 'CASCADE' is defined in migration
      });

      // A reconciliation result can belong to a User (nullable)
      ReconciliationResult.belongsTo(models.User, {
        foreignKey: 'userId', // The foreign key in this table
        as: 'user', // Alias for association
        allowNull: true, // Matches migration (for orphaned accounts)
        // onDelete: 'SET NULL' is defined in migration
      });

      // A reconciliation result can belong to an Application (nullable)
      ReconciliationResult.belongsTo(models.Application, {
        foreignKey: 'applicationId', // The foreign key in this table
        as: 'application', // Alias for association
        allowNull: true, // Matches migration (for global discrepancies)
        // onDelete: 'SET NULL' is defined in migration (or CASCADE depending on policy)
      });

      // Note: appSpecificUserId and appSpecificEntitlementId are not FKs, just data fields.
    }
  }
  ReconciliationResult.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false, // Matches migration
      defaultValue: Sequelize.literal('uuid_generate_v4()') // Matches migration
    },
    runId: {
      type: DataTypes.UUID,
      allowNull: false, // Matches migration
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'DiscoveryRun', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
    },
    discrepancyType: {
      type: DataTypes.STRING, // 'Violation', 'MissingAccess', 'OrphanedAccount'
      allowNull: false // Matches migration
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
      allowNull: true, // Matches migration
       // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'Application', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
    },
    appSpecificUserId: {
      type: DataTypes.STRING,
      allowNull: true // Matches migration (can be null for some discrepancy types like global missing access)
    },
    appSpecificEntitlementId: {
      type: DataTypes.STRING,
      allowNull: true // Matches migration (can be null for some discrepancy types like orphaned accounts not linked to entitlements)
    },
    details: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false, // Matches migration
      defaultValue: Sequelize.NOW // Matches migration
    }
  }, {
    sequelize,
    modelName: 'ReconciliationResult',
    tableName: 'ReconciliationResults', // Explicitly define table name
    timestamps: true, // Handles createdAt and updatedAt
    underscored: false, // Ensure column names match attribute names
    // ReconciliationResult doesn't have a composite unique index spanning all columns,
    // as multiple discrepancies can be related to the same user/app/entitlement over time or from different runs.
    // Uniqueness is typically on a per-run basis implicitly via querying by runId.
  });
  return ReconciliationResult;
};