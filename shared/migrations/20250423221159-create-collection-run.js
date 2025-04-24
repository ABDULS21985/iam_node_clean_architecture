// In your YYYYMMDDHHMMSS-create-collection-run.js file
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CollectionRuns', {
      // --- Corrected 'id' field definition ---
      id: {
        allowNull: false, // ID cannot be null
        primaryKey: true, // This is the primary key
        type: Sequelize.UUID, // Data type is UUID
        defaultValue: Sequelize.literal('uuid_generate_v4()') // Use PostgreSQL's uuid_generate_v4() function
      },
      // --- End Corrected 'id' field definition ---

      connectorConfigId: {
        type: Sequelize.UUID,
        allowNull: true, // Connector config might be null if the run fails before linking, or config is deleted
        // --- Foreign Key Constraint (add this) ---
        references: {
          model: 'ConnectorConfigs', // References the ConnectorConfigs table
          key: 'id',
        },
        onUpdate: 'CASCADE', // Update foreign key if referenced config id changes
        onDelete: 'SET NULL' // Set connectorConfigId to NULL if the connector config is deleted
        // --- End Foreign Key Constraint ---
      },
      status: {
        type: Sequelize.STRING, // 'started', 'in_progress', 'completed', 'failed', 'cancelled'
        allowNull: false, // Status is required
        defaultValue: 'started' // Default status when created
      },
      startTime: {
        type: Sequelize.DATE,
        allowNull: false, // Start time is required
        defaultValue: Sequelize.NOW // Default to current time
      },
      endTime: {
        type: Sequelize.DATE,
        allowNull: true // End time is nullable
      },
      metrics: {
        type: Sequelize.JSONB,
        allowNull: true // Metrics are optional/added later
      },
      errorDetails: {
        type: Sequelize.JSONB,
        allowNull: true // Error details are optional/added later
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true // Metadata is optional
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
    // If you added foreign keys, you might need to drop them first
    // await queryInterface.removeConstraint('CollectionRuns', 'CollectionRuns_connectorConfigId_fkey'); // Example constraint name
    await queryInterface.dropTable('CollectionRuns');
  }
};