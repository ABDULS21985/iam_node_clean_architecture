// shared/models/user.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A User belongs to many Roles through the UserRole junction table
      User.belongsToMany(models.Role, {
        through: models.UserRole, // The junction model
        as: 'roles', // Alias to access roles from a user instance (user.getRoles())
        foreignKey: 'userId', // The foreign key in the UserRole table that points to the User
        otherKey: 'roleId' // The foreign key in the UserRole table that points to the Role
      });

      // Note: While not strictly necessary for associations, you might also define:
      // User.hasMany(models.UserRole, { foreignKey: 'userId', as: 'userRoles' });
      // This is useful if you need to directly query the UserRole entries themselves.
    }
  }
  User.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true, // Define as primary key
      allowNull: false, // Not nullable
      defaultValue: Sequelize.literal('uuid_generate_v4()') // Set default value (mirrors migration)
    },
    hrmsId: {
      type: DataTypes.STRING,
      allowNull: false, // Should not be nullable (mirrors migration)
      unique: true // Should be unique (mirrors migration)
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: true // Assuming first name might be optional initially
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: true // Assuming last name might be optional initially
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false, // Should not be nullable (mirrors migration)
      unique: true // Should be unique (mirrors migration)
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false, // Status is required
      defaultValue: 'pending_joiner' // Set a default status
    },
    hireDate: {
      type: DataTypes.DATE,
      allowNull: false // Hire date is required
    },
    exitDate: {
      type: DataTypes.DATE,
      allowNull: true // Exit date is nullable
    },
    department: {
      type: DataTypes.STRING,
      allowNull: true // Assuming department might be optional
    },
    title: {
      type: DataTypes.STRING,
      allowNull: true // Assuming title might be optional
    },
    location: {
      type: DataTypes.STRING,
      allowNull: true // Assuming location might be optional
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true // Metadata is optional
    }
  }, {
    sequelize,
    modelName: 'User',
    tableName: 'Users', // Explicitly define table name (optional but good practice)
    timestamps: true, // Ensure createdAt and updatedAt are handled
    underscored: false, // Use snake_case for column names
    // By default Sequelize pluralizes model name for table name, which is 'Users'
  });
  return User;
};