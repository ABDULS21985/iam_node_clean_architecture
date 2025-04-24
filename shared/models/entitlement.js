// shared/models/entitlement.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Entitlement extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // An Entitlement belongs to one Application
      Entitlement.belongsTo(models.Application, {
        foreignKey: 'applicationId', // The foreign key in the Entitlement table
        as: 'application', // Alias to access the application from an entitlement instance
        onDelete: 'CASCADE' // If the related application is deleted, this entitlement should be deleted
      });

      // An Entitlement belongs to many Roles through the RoleEntitlementMapping junction table
      Entitlement.belongsToMany(models.Role, {
        through: models.RoleEntitlementMapping, // The junction model
        as: 'roles', // Alias to access roles from an entitlement instance
        foreignKey: 'entitlementId', // The foreign key in the junction table that points to the Entitlement
        otherKey: 'roleId' // The foreign key in the junction table that points to the Role
      });

      // Note: While not strictly necessary for associations, you might also define:
      // Entitlement.hasMany(models.RoleEntitlementMapping, { foreignKey: 'entitlementId', as: 'roleMappings' });
    }
  }
  Entitlement.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false // Descriptive name is required
    },
    description: {
      type: DataTypes.STRING, // Or DataTypes.TEXT
      allowNull: true
    },
    applicationId: {
      type: DataTypes.UUID,
      allowNull: false, // Must belong to an application
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
          model: 'Application', // Model name (singular)
          key: 'id'
      }
      // --- End references ---
    },
    applicationEntitlementId: {
      type: DataTypes.STRING,
      allowNull: false // Internal application ID is required
      // Composite unique index with applicationId is in the migration
    },
    type: {
      type: DataTypes.STRING, // e.g., 'permission', 'group', 'role', 'license'
      allowNull: false // Type is required
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'Entitlement',
    tableName: 'Entitlements', // Explicitly define table name
    timestamps: true,
    // --- Optional: Define composite unique index in the model for clarity ---
    indexes: [
      {
        unique: true,
        fields: ['applicationId', 'applicationEntitlementId'],
        name: 'entitlements_application_id_application_entitlement_id_unique_composite' // Match name from migration
      }
    ]
    // --- End Optional Index Definition ---
  });
  return Entitlement;
};