'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
// In your YYYYMMDDHHMMSS-create-entitlement.js file

async up(queryInterface, Sequelize) {
  await queryInterface.createTable('Entitlements', {
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
      allowNull: false // A descriptive name is required
    },
    description: {
      type: Sequelize.STRING, // Or Sequelize.TEXT
      allowNull: true
    },
    applicationId: {
      type: Sequelize.UUID,
      allowNull: false, // An entitlement must belong to an application
      // --- Foreign Key Constraint (add this) ---
      references: {
        model: 'Applications', // References the Applications table
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE' // If an application is deleted, its entitlements should be deleted
      // --- End Foreign Key Constraint ---
    },
    applicationEntitlementId: {
      type: Sequelize.STRING,
      allowNull: false // The internal ID within the application is required
    },
    type: {
      type: Sequelize.STRING, // e.g., 'permission', 'group', 'role', 'license'
      allowNull: false // Type is required
    },
    metadata: {
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

  // --- Add Composite Unique Constraint (add this AFTER createTable) ---
  await queryInterface.addConstraint('Entitlements', {
    fields: ['applicationId', 'applicationEntitlementId'],
    type: 'unique',
    name: 'entitlements_application_id_application_entitlement_id_unique_composite' // A descriptive name for the constraint
  });
  // --- End Composite Unique Constraint ---

},
async down(queryInterface, Sequelize) {
  // If you added foreign keys and constraints, you might need to drop them first
  // await queryInterface.removeConstraint('Entitlements', 'entitlements_application_id_application_entitlement_id_unique_composite');
  // await queryInterface.removeConstraint('Entitlements', 'Entitlements_applicationId_fkey'); // Example constraint name

  await queryInterface.dropTable('Entitlements');
}
};