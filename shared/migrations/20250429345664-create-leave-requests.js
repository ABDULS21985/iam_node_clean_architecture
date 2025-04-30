'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // 1️⃣ Ensure pgcrypto extension for UUID generation
    await queryInterface.sequelize.query(
      `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`
    );

    // 2️⃣ Create schema for Leaver Service
    await queryInterface.createSchema('leaver_service');

    // 3️⃣ Create leave_requests table
    await queryInterface.createTable(
      { schema: 'leaver_service', tableName: 'leave_requests' },
      {
        id: {
          type: Sequelize.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()')
        },
        userId: {
          type: Sequelize.UUID,
          allowNull: false,
          comment: 'IGLM user UUID'
        },
        hrmsId: {
          type: Sequelize.STRING,
          allowNull: false,
          comment: 'HRMS identifier string'
        },
        status: {
          type: Sequelize.STRING,
          allowNull: false,
          defaultValue: 'pending',
          comment: 'pending | completed | failed'
        },
        requestedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          comment: 'When the leaver event was received'
        },
        processedAt: {
          type: Sequelize.DATE,
          allowNull: true,
          comment: 'When the Provisioning API call succeeded'
        },
        errorMessage: {
          type: Sequelize.TEXT,
          allowNull: true,
          comment: 'Error details if de-provisioning failed'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }
    );
  },

  async down (queryInterface, Sequelize) {
    // Drop table and schema in reverse order
    await queryInterface.dropTable({ schema: 'leaver_service', tableName: 'leave_requests' });
    await queryInterface.dropSchema('leaver_service');
  }
};
