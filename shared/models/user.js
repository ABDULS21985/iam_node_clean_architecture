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

      // Associations to other tables that reference Users (e.g., CurrentAppState, ReconciliationResult, ProvisioningTask)
      User.hasMany(models.CurrentAppState, {
         foreignKey: 'userId', // Foreign key in CurrentAppStates table
         as: 'appStates', // Alias
         onDelete: 'SET NULL' // Policy if a User is deleted (matches migration policy)
      });

      User.hasMany(models.ReconciliationResult, {
         foreignKey: 'userId', // Foreign key in ReconciliationResults table
         as: 'reconciliationResults', // Alias
         onDelete: 'SET NULL' // Policy if a User is deleted (matches migration policy)
      });

       User.hasMany(models.ProvisioningTask, {
          foreignKey: 'userId', // Foreign key in ProvisioningTasks table
          as: 'provisioningTasks', // Alias
          onDelete: 'CASCADE' // Or SET NULL depending on desired policy
       });

      // Note: While not strictly necessary for associations, you might also define:
      // User.hasMany(models.UserRole, { foreignKey: 'userId', as: 'userRoles' }); // Direct association to the join table
    }
  }
  User.init({
    id: {
      allowNull: false, // ID cannot be null
      primaryKey: true, // This is the primary key
      type: DataTypes.UUID, // Data type is UUID
      defaultValue: Sequelize.literal('uuid_generate_v4()') // Use PostgreSQL's uuid_generate_v4() function
    },
    hrmsId: { // Unique identifier from the HRMS
      type: DataTypes.STRING,
      allowNull: false, // HRMS ID should be required for users created from HRMS (matches migration)
      unique: true // Ensure uniqueness at the DB level (matches migration)
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: false // Assuming first name is required (matches migration)
    },
    middleName: { // Added as it appears in HRMS data
      type: DataTypes.STRING,
      allowNull: true // Allow null for middle name (matches migration)
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: false // Last name is required (matches migration)
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true, // Email might not be mandatory for all users (matches migration)
      unique: true // Email should be unique if present (matches migration)
    },
    mobileNumber: { // Added as it appears in HRMS data
      type: DataTypes.STRING,
      allowNull: true // Mobile number might be optional (matches migration)
    },
    status: { // Current status in the IGLM system ('pending_joiner', 'active', 'inactive', 'exited')
      type: DataTypes.STRING,
      allowNull: false, // Matches model (matches migration)
      defaultValue: 'pending_joiner' // Default status for new users (matches migration)
    },
    hireDate: {
      type: DataTypes.DATE, // Corrected type to DATE
      allowNull: true // Hire date might not be strictly mandatory depending on HR data (matches migration)
    },
    exitDate: {
      type: DataTypes.DATE, // Corrected type to DATE
      allowNull: true // Exit date is null until termination (matches migration)
    },
    supervisorId: { // Supervisor HRMS ID (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Supervisor ID might not be mandatory or available for all (matches migration)
    },
    headOfOfficeId: { // Head of Office HRMS ID (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Head of Office ID might not be mandatory or available (matches migration)
    },
    jobTitle: { // Mapping of HRMS job_title field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    departmentId: { // Mapping of HRMS department_id field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    departmentName: { // Mapping of HRMS department_name field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    divisionId: { // Mapping of HRMS division_id field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    divisionName: { // Mapping of HRMS division_name field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    officeId: { // Mapping of HRMS office_id field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    officeName: { // Mapping of HRMS office_name field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    gradeId: { // Mapping of HRMS grade_id field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    grade: { // Mapping of HRMS grade field (grade level) (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    partyId: { // Mapping of HRMS party_id field (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    jobStatus: { // Mapping of HRMS job_status field (raw status) (matches migration column name)
      type: DataTypes.STRING,
      allowNull: true // Matches migration
    },
    jobLocationId: { // Mapping of HRMS job_location_id field (matches migration column name)
       type: DataTypes.STRING,
       allowNull: true // Matches migration
    },
    jobLocation: { // Mapping of HRMS job_location field (matches migration column name)
       type: DataTypes.STRING,
       allowNull: true // Matches migration
    },
    location: { // Mapping of HRMS location field (perhaps simplified) (matches migration column name)
       type: DataTypes.STRING,
       allowNull: true // Matches migration
    },
    metadata: { // JSONB field for storing additional, less structured attributes from HRMS
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    }
  }, {
    sequelize,
    modelName: 'User', // Singular model name
    tableName: 'Users', // Explicitly define table name (plural)
    timestamps: true, // Handles createdAt and updatedAt (matches migration)
    underscored: false // Enforce snake_case for column names (matches migration)
    // Indexes, constraints can also be defined here for models, but migrations are primary source for DB schema
  });
  return User;
};