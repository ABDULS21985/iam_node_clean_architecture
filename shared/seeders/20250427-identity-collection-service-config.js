'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();

    await queryInterface.bulkInsert('Configurations', [
      {
        serviceName: 'identity-collection-service',
        environment: 'development',
        key:         'hrmsConnectorName',
        value:       JSON.stringify('Postgres HRMS Identity Source'),
        createdAt:   now,
        updatedAt:   now
      },
      {
        serviceName: 'identity-collection-service',
        environment: 'development',
        key:         'userMappingName',
        value:       JSON.stringify('HRMS → User (core)'),
        createdAt:   now,
        updatedAt:   now
      },
      {
        serviceName: 'identity-collection-service',
        environment: 'development',
        key:         'pollingIntervalMinutes',
        value:       JSON.stringify(5),     // <<< stringify the number too!
        createdAt:   now,
        updatedAt:   now
      }
    ], {});
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('Configurations', {
      serviceName: 'identity-collection-service',
      environment: 'development',
      key: [
        'hrmsConnectorName',
        'userMappingName',
        'pollingIntervalMinutes'
      ]
    }, {});
  }
};
