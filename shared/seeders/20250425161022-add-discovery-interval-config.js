"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // Seed the critical discoveryIntervalMinutes config for development
    await queryInterface.bulkInsert('Configurations', [{
      serviceName: 'discovery-service',
      environment: 'development',
      key: 'discoveryIntervalMinutes',
      value: '15',
      createdAt: new Date(),
      updatedAt: new Date()
    }], {});
  },

  async down (queryInterface, Sequelize) {
    // Remove the seeded discoveryIntervalMinutes config
    await queryInterface.bulkDelete('Configurations', {
      serviceName: 'discovery-service',
      environment: 'development',
      key: 'discoveryIntervalMinutes'
    }, {});
  }
};
