// In your YYYYMMDDHHMMSS-add-serviceName-to-mappingConfigs.js file
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Add the 'serviceName' column to the 'MappingConfigs' table
     */
    await queryInterface.addColumn('MappingConfigs', 'serviceName', {
      type: Sequelize.STRING, // Define the data type for the column
      allowNull: true, // Allow null initially for existing rows, or false if preferred and handled
      // You could add a default value here if needed for new rows
    });
  },

  async down (queryInterface, Sequelize) {
    /**
     * Remove the 'serviceName' column from the 'MappingConfigs' table
     */
    await queryInterface.removeColumn('MappingConfigs', 'serviceName');
  }
};