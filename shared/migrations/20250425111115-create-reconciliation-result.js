'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CurrentAppStates', {
      id: {
        type: Sequelize.UUID,
        allowNull: false,
        primaryKey: true,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      applicationId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Applications',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      appSpecificUserId: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'User ID as represented in the external application.'
      },
      appSpecificEntitlementId: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Entitlement ID as recognized by the external application.'
      },
      discoveredAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: 'Timestamp when this state was discovered.'
      },
      runId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'DiscoveryRuns',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: 'Flexible metadata to store additional attributes as needed.'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Safely create a composite unique constraint
    try {
      await queryInterface.addConstraint('CurrentAppStates', {
        fields: ['applicationId', 'appSpecificUserId', 'appSpecificEntitlementId'],
        type: 'unique',
        name: 'current_app_states_app_user_entitlement_unique_composite'
      });
    } catch (error) {
      console.warn(`[CurrentAppStates Migration] Warning: Could not create composite unique constraint.`, error.message);
    }
  },

  async down(queryInterface, Sequelize) {
    // Defensive constraint removal
    const constraints = [
      'current_app_states_app_user_entitlement_unique_composite',
      'CurrentAppStates_userId_fkey',
      'CurrentAppStates_applicationId_fkey',
      'CurrentAppStates_runId_fkey'
    ];

    for (const constraint of constraints) {
      try {
        await queryInterface.removeConstraint('CurrentAppStates', constraint);
      } catch (error) {
        console.warn(`[CurrentAppStates Migration] Warning: Failed to remove constraint '${constraint}'.`, error.message);
      }
    }

    await queryInterface.dropTable('CurrentAppStates');
  }
};
