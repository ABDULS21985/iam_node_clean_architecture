'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Applications', {
      // --- Corrected 'id' field definition ---
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      // --- End Corrected 'id' field definition ---

      name: {
        type: Sequelize.STRING,
        allowNull: false, // Name is required
        unique: true // Application names must be unique
      },
      description: {
        type: Sequelize.STRING, // Or Sequelize.TEXT for longer descriptions
        allowNull: true // Description is optional
      },
      type: {
        type: Sequelize.STRING,
        allowNull: true // Type might be optional or have a default
      },
      connectorId: {
        type: Sequelize.UUID,
        allowNull: true, // A new application might not have a connector defined immediately
        // --- Foreign Key Constraint (UNCOMMENTED) ---
        // references: {
        //   model: 'ConnectorConfigs', // This is the table name where connector configurations will be stored
        //   key: 'id',
        // },
        // onUpdate: 'CASCADE', // Update foreign key if referenced id changes (rare for UUIDs)
        // onDelete: 'SET NULL' // Set connectorId to NULL if the connector config is deleted
        // // --- End Foreign Key Constraint ---
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
  // The 'down' function is already correct for dropping the table
  async down(queryInterface, Sequelize) {
    // If adding foreign keys, you might need to drop them first if Sequelize doesn't do it automatically
    // await queryInterface.removeConstraint('Applications', 'Applications_connectorId_fkey'); // Example constraint name
    await queryInterface.dropTable('Applications');
  }
};