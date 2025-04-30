// In your migration file (e.g., YYYYMMDDHHMMSS-create-user.js)
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Ensure the uuid-ossp extension is available for uuid_generate_v4()
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    await queryInterface.createTable('Users', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      hrmsId: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true
      },
      firstName: {
        type: Sequelize.STRING,
        allowNull: false
      },
      middleName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      lastName: {
        type: Sequelize.STRING,
        allowNull: false
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true
      },
      mobileNumber: {
        type: Sequelize.STRING,
        allowNull: true
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending_joiner'
      },
      hireDate: {
        type: Sequelize.DATE,
        allowNull: true
      },
      // Corrected column name to match the model field 'exitDate'
      exitDate: {
        type: Sequelize.DATE,
        allowNull: true
      },
      supervisorId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      headOfOfficeId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      jobTitle: {
        type: Sequelize.STRING,
        allowNull: true
      },
      departmentId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      departmentName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      divisionId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      divisionName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      officeId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      officeName: {
        type: Sequelize.STRING,
        allowNull: true
      },
      gradeId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      grade: {
        type: Sequelize.STRING,
        allowNull: true
      },
      partyId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      // terminationDate column removed/renamed above
      jobStatus: {
        type: Sequelize.STRING,
        allowNull: true
      },
      jobLocationId: {
        type: Sequelize.STRING,
        allowNull: true
      },
      jobLocation: {
        type: Sequelize.STRING,
        allowNull: true
      },
      location: { // Corresponds to the 'location' field in the model
        type: Sequelize.STRING,
        allowNull: true
      },
      metadata: {
        type: Sequelize.JSONB,
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
    });
  },

  async down(queryInterface, Sequelize) {
    // Drop the table in the down migration
    await queryInterface.dropTable('Users');
    // Optionally, drop the extension if it's certain nothing else uses it,
    // but generally safer to leave it unless cleaning up entirely.
    // await queryInterface.sequelize.query(`DROP EXTENSION IF EXISTS "uuid-ossp";`);
  }
};