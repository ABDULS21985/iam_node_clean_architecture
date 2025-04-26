// In your YYYYMMDDHHMMSS-create-collection-run.js migration file
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CollectionRuns', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      connectorConfigId: { // Link to the ConnectorConfig used for this run
        type: Sequelize.UUID,
        allowNull: true, // Allow null if the run isn't tied to a specific connector (e.g., manual trigger)
        // --- Foreign Key Constraint (add this) ---
        references: {
          model: 'ConnectorConfigs', // References the ConnectorConfigs table
          key: 'id',
        },
        onUpdate: 'CASCADE', // Update foreign key if referenced connector id changes
        onDelete: 'SET NULL' // Set to NULL if the connector config is deleted
        // --- End Foreign Key Constraint ---
      },
      status: { // e.g., 'started', 'completed', 'failed'
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'started' // Default status
      },
      // --- Add startTime field definition ---
      startTime: {
        type: Sequelize.DATE,
        allowNull: true, // Can be null if run didn't start properly
        defaultValue: Sequelize.NOW // Default to current timestamp when row is created
      },
      // --- End Add startTime field definition ---
      endTime: { // Timestamp when the run finished
        type: Sequelize.DATE,
        allowNull: true
      },
      metrics: { // Store metrics (e.g., { recordsPulled: X, joiners: Y, movers: Z, leavers: W, errors: E })
        type: Sequelize.JSONB,
        allowNull: true
      },
      errorDetails: { // Store details about errors encountered during the run
        type: Sequelize.JSONB,
        allowNull: true
      },
      metadata: { // Store any other relevant data (e.g., config snapshot)
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
     // Remove foreign key constraint first before dropping the table
     try {
       await queryInterface.removeConstraint('CollectionRuns', 'CollectionRuns_connectorConfigId_fkey');
     } catch (error) { console.warn(`Failed to remove constraint 'CollectionRuns_connectorConfigId_fkey':`, error.message); }

    await queryInterface.dropTable('CollectionRuns');
  }
};