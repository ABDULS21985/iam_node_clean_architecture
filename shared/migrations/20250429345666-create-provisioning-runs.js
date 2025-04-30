'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    await queryInterface.createTable('ProvisioningRuns', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      task_id: {
        type: Sequelize.UUID,
        allowNull: false
      },
      routing_key: {
        type: Sequelize.STRING,
        allowNull: true
      },
      payload: {
        type: Sequelize.JSONB,
        allowNull: false
      },
      processed_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('ProvisioningRuns');
  }
};
