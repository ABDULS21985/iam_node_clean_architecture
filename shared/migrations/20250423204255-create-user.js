// In your YYYYMMDDHHMMSS-create-user.js migration file
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await queryInterface.createTable('Users', {
      id: {
        allowNull: false, // ID cannot be null
        primaryKey: true, // This is the primary key
        type: Sequelize.UUID, // Data type is UUID
        defaultValue: Sequelize.literal('uuid_generate_v4()') // Use PostgreSQL's uuid_generate_v4() function
      },
      hrmsId: { // Unique identifier from the HRMS
        type: Sequelize.STRING,
        allowNull: false, // HRMS ID should be required for users created from HRMS
        unique: true // Ensure uniqueness at the DB level
      },
      firstName: {
        type: Sequelize.STRING, // Corrected type to Sequelize.STRING
        allowNull: false
      },
      middleName: { // Added as it appears in HRMS data
        type: Sequelize.STRING, // Corrected type
        allowNull: true // Allow null for middle name
      },
      lastName: {
        type: Sequelize.STRING, // Corrected type
        allowNull: false
      },
      email: {
        type: Sequelize.STRING, // Corrected type
        allowNull: true, // Email might not be mandatory for all users
        unique: true // Email should be unique if present
      },
      mobileNumber: { // Added as it appears in HRMS data
        type: Sequelize.STRING, // Corrected type
        allowNull: true // Mobile number might be optional
      },
      status: { // Current status in the IGLM system ('pending_joiner', 'active', 'inactive', 'exited')
        type: Sequelize.STRING, // Corrected type
        allowNull: false, // Matches model
        defaultValue: 'pending_joiner' // Default status for new users
      },
      hireDate: {
        type: Sequelize.DATE, // Corrected type
        allowNull: true // Hire date might not be strictly mandatory depending on HR data
      },
      exitDate: {
        type: Sequelize.DATE, // Corrected type
        allowNull: true // Exit date is null until termination
      },
      supervisorId: { // Supervisor HRMS ID
        type: Sequelize.STRING, // Corrected type
        allowNull: true // Supervisor ID might not be mandatory or available for all
      },
      headOfOfficeId: { // Head of Office HRMS ID
        type: Sequelize.STRING, // Corrected type
        allowNull: true // Head of Office ID might not be mandatory or available
      },
      jobTitle: { // Mapping of HRMS job_title field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      departmentId: { // Mapping of HRMS department_id field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      departmentName: { // Mapping of HRMS department_name field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      divisionId: { // Mapping of HRMS division_id field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      divisionName: { // Mapping of HRMS division_name field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      officeId: { // Mapping of HRMS office_id field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      officeName: { // Mapping of HRMS office_name field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      gradeId: { // Mapping of HRMS grade_id field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      grade: { // Mapping of HRMS grade field (grade level)
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      partyId: { // Mapping of HRMS party_id field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },

      terminationDate: {
        type: Sequelize.DATE,
        allowNull: true
      },

      jobStatus: { // Mapping of HRMS job_status field (raw status)
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
       jobLocationId: { // Mapping of HRMS job_location_id field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
       jobLocation: { // Mapping of HRMS job_location field
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
       location: { // Mapping of HRMS location field (perhaps simplified)
        type: Sequelize.STRING, // Corrected type
        allowNull: true
      },
      metadata: { // JSONB field for storing additional, less structured attributes from HRMS
        type: Sequelize.JSONB, // Corrected type
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
      // Note: The connectorConfigId field was moved to the CollectionRuns table, not here on Users.
      // Note: The original 'user_id' field (which was also a problem) is removed here, as 'id' is the primary key UUID.
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Users');
  }
};