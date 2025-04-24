// shared/models/roleentitlementmapping.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class RoleEntitlementMapping extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A RoleEntitlementMapping entry belongs to a Role
      RoleEntitlementMapping.belongsTo(models.Role, {
        foreignKey: 'roleId', // The foreign key in this table
        as: 'role' // Alias to access the role from a mapping instance
        // onDelete: 'CASCADE' is defined in the migration for DB integrity
      });

      // A RoleEntitlementMapping entry belongs to an Entitlement
      RoleEntitlementMapping.belongsTo(models.Entitlement, {
        foreignKey: 'entitlementId', // The foreign key in this table
        as: 'entitlement' // Alias to access the entitlement from a mapping instance
        // onDelete: 'CASCADE' is defined in the migration for DB integrity
      });
    }
  }
  RoleEntitlementMapping.init({
    roleId: {
      type: DataTypes.UUID,
      allowNull: false, // Cannot be null (mirrors migration)
      primaryKey: true, // Part of the composite primary key
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
          model: 'Role', // Model name (singular)
          key: 'id'
      }
      // --- End references ---
    },
    entitlementId: {
      type: DataTypes.UUID,
      allowNull: false, // Cannot be null (mirrors migration)
      primaryKey: true, // Part of the composite primary key
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
          model: 'Entitlement', // Model name (singular)
          key: 'id'
      }
      // --- End references ---
    },
    assignmentType: {
      type: DataTypes.STRING, // e.g., 'automatic', 'optional'
      allowNull: false // Assignment type is required (mirrors migration)
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true // Metadata is optional (mirrors migration)
    }
    // Note: We don't define a standard 'id' field here as it's a junction table
  }, {
    sequelize,
    modelName: 'RoleEntitlementMapping',
    tableName: 'RoleEntitlementMappings', // Explicitly define table name
    timestamps: true, // Handles createdAt and updatedAt
    // --- Optional: Define composite primary key explicitly in model options for clarity ---
    // primaryKey: ['roleId', 'entitlementId']
    // --- Optional: Define composite unique index explicitly in model options for clarity (matches migration) ---
    indexes: [
      {
        unique: true,
        fields: ['roleId', 'entitlementId'], // Should match the composite primary key fields
        name: 'role_entitlement_mapping_unique_composite' // Give it a descriptive name
      }
    ]
    // Note: Defining primaryKey: true on the attributes is usually sufficient for Sequelize to handle it.
  });
  return RoleEntitlementMapping;
};