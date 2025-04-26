'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CurrentAppStates', {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      applicationId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Applications',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      appSpecificUserId: {
        type: Sequelize.STRING,
        allowNull: false
      },
      appSpecificEntitlementId: {
        type: Sequelize.STRING,
        allowNull: false
      },
      discoveredAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      runId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'DiscoveryRuns',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // --- Defensive Add Composite Unique Constraint ---
    try {
      await queryInterface.addConstraint('CurrentAppStates', {
        fields: ['applicationId', 'appSpecificUserId', 'appSpecificEntitlementId'],
        type: 'unique',
        name: 'current_app_states_app_user_entitlement_unique_composite',
      });
    } catch (error) {
      console.warn(`Warning: Skipping creation of unique constraint 'current_app_states_app_user_entitlement_unique_composite'. It may already exist.`, error.message);
    }
    // --- End Defensive Composite Constraint Addition ---
  },

  async down(queryInterface, Sequelize) {
    // Defensive cleanup: Remove constraints first
    const constraints = [
      'current_app_states_app_user_entitlement_unique_composite',
      'CurrentAppStates_userId_fkey',
      'CurrentAppStates_applicationId_fkey',
      'CurrentAppStates_runId_fkey'
    ];

    for (const constraintName of constraints) {
      try {
        await queryInterface.removeConstraint('CurrentAppStates', constraintName);
      } catch (error) {
        console.warn(`Warning: Failed to remove constraint '${constraintName}':`, error.message);
      }
    }

    await queryInterface.dropTable('CurrentAppStates');
  }
};
