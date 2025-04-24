'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
// In yourMMDDHHMMSS-create-role-entitlement-mapping.js file

async up(queryInterface, Sequelize) {
  await queryInterface.createTable('RoleEntitlementMappings', {
    // --- Removed the auto-increment integer 'id' field ---

    roleId: {
      type: Sequelize.UUID,
      allowNull: false, // Must link to a Role
      primaryKey: true, // Part of the composite primary key
      // --- Foreign Key Constraint (add this) ---
      references: {
        model: 'Roles', // References the Roles table
        key: 'id',
      },
      onUpdate: 'CASCADE', // Update foreign key if referenced role id changes
      onDelete: 'CASCADE' // Delete this entry if the role is deleted
      // --- End Foreign Key Constraint ---
    },
    entitlementId: {
      type: Sequelize.UUID,
      allowNull: false, // Must link to an Entitlement
      primaryKey: true, // Part of the composite primary key
       // --- Foreign Key Constraint (add this) ---
      references: {
        model: 'Entitlements', // References the Entitlements table
        key: 'id',
      },
      onUpdate: 'CASCADE', // Update foreign key if referenced entitlement id changes
      onDelete: 'CASCADE' // Delete this entry if the entitlement is deleted
      // --- End Foreign Key Constraint ---
    },
     assignmentType: {
      type: Sequelize.STRING, // e.g., 'automatic', 'optional'
      allowNull: false // Assignment type is required
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
    // Sequelize automatically handles the composite primary key when you set primaryKey: true on multiple columns
  });
},
// The 'down' function is already correct for dropping the table
async down(queryInterface, Sequelize) {
   // Sequelize should automatically drop foreign key constraints when dropping the table,
   // but you can explicitly remove them first if you encounter issues:
   // await queryInterface.removeConstraint('RoleEntitlementMappings', 'RoleEntitlementMappings_roleId_fkey');
   // await queryInterface.removeConstraint('RoleEntitlementMappings', 'RoleEntitlementMappings_entitlementId_fkey');
  await queryInterface.dropTable('RoleEntitlementMappings');
}
};