'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
// In your YYYYMMDDHHMMSS-create-role.js file

async up(queryInterface, Sequelize) {
  await queryInterface.createTable('Roles', {
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
      allowNull: false, // Role name is required
      unique: true // Role names must be unique
    },
    description: {
      type: Sequelize.STRING, // Or Sequelize.TEXT
      allowNull: true
    },
    type: {
      type: Sequelize.STRING, // e.g., 'job_role', 'system_role', 'application_role'
      allowNull: true // Type might be optional or have a default
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
},
// The 'down' function is already correct for dropping the table
async down(queryInterface, Sequelize) {
  await queryInterface.dropTable('Roles');
}
};