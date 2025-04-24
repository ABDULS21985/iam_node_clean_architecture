'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ProvisioningTasks', {
      // --- Corrected 'id' field definition ---
      id: {
        allowNull: false, // ID cannot be null
        primaryKey: true, // This is the primary key
        type: Sequelize.UUID, // Data type is UUID
        defaultValue: Sequelize.literal('uuid_generate_v4()') // Use PostgreSQL's uuid_generate_v4() function
      },
      // --- End Corrected 'id' field definition ---

      userId: {
        type: Sequelize.UUID,
        allowNull: false, // Must link to a User
        // --- Foreign Key Constraint (add this) ---
        references: {
          model: 'Users', // References the Users table
          key: 'id',
        },
        onUpdate: 'CASCADE', // Update foreign key if referenced user id changes
        onDelete: 'CASCADE' // Delete this entry if the user is deleted (consider policy: maybe SET NULL if keeping historical task logs)
        // --- End Foreign Key Constraint ---
      },
      desiredState: {
        type: Sequelize.JSONB,
        allowNull: false // The requested state is required
      },
      status: {
        type: Sequelize.STRING, // 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'retrying'
        allowNull: false, // Status is required
        defaultValue: 'pending' // Default status when created
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
      results: {
        type: Sequelize.JSONB,
        allowNull: true // Results are optional/added later
      },
      errorDetails: {
        type: Sequelize.JSONB,
        allowNull: true // Error details are optional/added later
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
    await queryInterface.removeConstraint('ProvisioningTasks', 'ProvisioningTasks_userId_fkey'); 
    await queryInterface.dropTable('ProvisioningTasks');
  }
};