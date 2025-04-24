// shared/models/userrole.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class UserRole extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A UserRole entry belongs to a User
      UserRole.belongsTo(models.User, {
        foreignKey: 'userId', // The foreign key in the UserRole table
        as: 'user' // Alias to access the user from a UserRole instance
        // onDelete: 'CASCADE' is defined in the migration for DB integrity
      });

      // A UserRole entry belongs to a Role
      UserRole.belongsTo(models.Role, {
        foreignKey: 'roleId', // The foreign key in the UserRole table
        as: 'role' // Alias to access the role from a UserRole instance
        // onDelete: 'CASCADE' is defined in the migration for DB integrity
      });
    }
  }
  UserRole.init({
    userId: {
      type: DataTypes.UUID,
      allowNull: false, // Cannot be null (mirrors migration)
      primaryKey: true, // Part of the composite primary key
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
          model: 'User', // Model name (singular)
          key: 'id'
      }
      // --- End references ---
    },
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
    assignmentDate: {
      type: DataTypes.DATE,
      allowNull: false, // Assignment date is required (mirrors migration)
      defaultValue: Sequelize.NOW // Default to now (mirrors migration)
    },
    unassignmentDate: {
      type: DataTypes.DATE,
      allowNull: true // Unassignment date is nullable (mirrors migration)
    }
    // Note: We don't define a standard 'id' field here as it's a junction table
  }, {
    sequelize,
    modelName: 'UserRole',
    tableName: 'UserRoles', // Explicitly define table name
    timestamps: true, // Handles createdAt and updatedAt
    // --- Optional: Define composite primary key explicitly in model options for clarity ---
    // The `primaryKey: true` on the attributes is often sufficient, but this is also an option:
    // primaryKey: ['userId', 'roleId']
    // --- End Optional Primary Key Definition ---
  });
  return UserRole;
};