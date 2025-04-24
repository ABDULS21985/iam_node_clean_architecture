'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
// In your YYYYMMDDHHMMSS-create-user-role.js file

async up(queryInterface, Sequelize) {
  await queryInterface.createTable('UserRoles', {
    // --- Removed the auto-increment integer 'id' field ---

    userId: {
      type: Sequelize.UUID,
      allowNull: false, // Must link to a User
      primaryKey: true, // Part of the composite primary key
      // --- Foreign Key Constraint (add this) ---
      references: {
        model: 'Users', // References the Users table
        key: 'id',
      },
      onUpdate: 'CASCADE', // Update foreign key if referenced user id changes
      onDelete: 'CASCADE' // Delete this entry if the user is deleted
      // --- End Foreign Key Constraint ---
    },
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
    assignmentDate: {
      type: Sequelize.DATE,
      allowNull: false, // Assignment date is required
      defaultValue: Sequelize.NOW // Default to the current timestamp
    },
    unassignmentDate: {
      type: Sequelize.DATE,
      allowNull: true // Unassignment date is nullable
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
  // await queryInterface.removeConstraint('UserRoles', 'UserRoles_userId_fkey');
  // await queryInterface.removeConstraint('UserRoles', 'UserRoles_roleId_fkey');
  await queryInterface.dropTable('UserRoles');
}
};