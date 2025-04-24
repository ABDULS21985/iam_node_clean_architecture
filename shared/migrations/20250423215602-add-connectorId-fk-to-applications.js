// In your YYYYMMDDHHMMSS-add-connectorId-fk-to-applications.js file
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add foreign key constraint for connectorId in Applications table
     */
    await queryInterface.addConstraint('Applications', {
      fields: ['connectorId'], // Column in the Applications table
      type: 'foreign key',
      name: 'applications_connectorid_fkey', // Explicitly name the constraint (good practice)
      references: {
        table: 'ConnectorConfigs', // Target table
        field: 'id', // Target column
      },
      onUpdate: 'CASCADE', // What happens on update of ConnectorConfigs.id
      onDelete: 'SET NULL' // What happens on delete of ConnectorConfigs row
    });
  },

  async down (queryInterface, Sequelize) {
    /**
     * Remove foreign key constraint for connectorId in Applications table
     */
    await queryInterface.removeConstraint('Applications', 'applications_connectorid_fkey'); // Use the exact same constraint name
  }
};