// In your YYYYMMDDHHMMSS-create-current-app-state.js file
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CurrentAppStates', {
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
        allowNull: true, // Allow null for discovered accounts that don't map to an IGLM user yet (orphans)
        // --- Foreign Key Constraint (add this) ---
        references: {
          model: 'Users', // References the Users table
          key: 'id',
        },
        onUpdate: 'CASCADE', // Update foreign key if referenced user id changes
        onDelete: 'SET NULL' // Set to NULL if the user is deleted (keep the discovered state history)
        // --- End Foreign Key Constraint ---
      },
      applicationId: {
        type: Sequelize.UUID,
        allowNull: false, // Discovered state must belong to an application
        // --- Foreign Key Constraint (add this) ---
        references: {
          model: 'Applications', // References the Applications table
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE' // If an application is deleted, remove its discovered state
        // --- End Foreign Key Constraint ---
      },
      appSpecificUserId: {
        type: Sequelize.STRING,
        allowNull: false // The user identifier in the target application is required
      },
      appSpecificEntitlementId: {
        type: Sequelize.STRING,
        allowNull: false // The entitlement identifier in the target application is required
      },
      discoveredAt: {
        type: Sequelize.DATE,
        allowNull: false, // Timestamp of discovery is required
        defaultValue: Sequelize.NOW // Default to current time
      },
      runId: {
        type: Sequelize.UUID,
        allowNull: true, // Can be null if state is added manually or not linked to a run
        // --- Foreign Key Constraint (add this) ---
        references: {
          model: 'DiscoveryRuns', // References the DiscoveryRuns table
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL' // Set to NULL if the discovery run log is deleted (keep the discovered state)
        // --- End Foreign Key Constraint ---
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

    // --- Add Composite Unique Constraint (add this AFTER createTable) ---
    // Ensures that a specific user has a specific entitlement only once within an application
    await queryInterface.addConstraint('CurrentAppStates', {
      fields: ['applicationId', 'appSpecificUserId', 'appSpecificEntitlementId'],
      type: 'unique',
      name: 'current_app_states_app_user_entitlement_unique_composite' // A descriptive name for the constraint
    });
    // --- End Composite Unique Constraint ---

  },
  async down(queryInterface, Sequelize) {
    // If you added foreign keys and constraints, you might need to drop them first
    // await queryInterface.removeConstraint('CurrentAppStates', 'current_app_states_app_user_entitlement_unique_composite');
    // await queryInterface.removeConstraint('CurrentAppStates', 'CurrentAppStates_userId_fkey');
    // await queryInterface.removeConstraint('CurrentAppStates', 'CurrentAppStates_applicationId_fkey');
    // await queryInterface.removeConstraint('CurrentAppStates', 'CurrentAppStates_runId_fkey');
    await queryInterface.dropTable('CurrentAppStates');
  }
};