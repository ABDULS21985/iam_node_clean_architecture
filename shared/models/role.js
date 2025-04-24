// shared/models/role.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Role extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A Role belongs to many Users through the UserRole junction table
      Role.belongsToMany(models.User, {
        through: models.UserRole, // The junction model
        as: 'users', // Alias to access users from a role instance (role.getUsers())
        foreignKey: 'roleId', // The foreign key in the UserRole table that points to the Role
        otherKey: 'userId' // The foreign key in the UserRole table that points to the User
      });

      // A Role belongs to many Entitlements through the RoleEntitlementMapping junction table
      Role.belongsToMany(models.Entitlement, {
        through: models.RoleEntitlementMapping, // The junction model
        as: 'entitlements', // Alias to access entitlements from a role instance (role.getEntitlements())
        foreignKey: 'roleId', // The foreign key in the junction table that points to the Role
        otherKey: 'entitlementId' // The foreign key in the junction table that points to the Entitlement
      });

      // Note: You might also define:
      // Role.hasMany(models.UserRole, { foreignKey: 'roleId', as: 'userAssignments' });
      // Role.hasMany(models.RoleEntitlementMapping, { foreignKey: 'roleId', as: 'entitlementMappings' });
    }
  }
  Role.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false, // Role name is required
      unique: true // Role names must be unique
    },
    description: {
      type: DataTypes.STRING, // Or DataTypes.TEXT
      allowNull: true
    },
    type: {
      type: DataTypes.STRING, // e.g., 'job_role', 'system_role', 'application_role'
      allowNull: true
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'Role',
    tableName: 'Roles', // Explicitly define table name
    timestamps: true
  });
  return Role;
};