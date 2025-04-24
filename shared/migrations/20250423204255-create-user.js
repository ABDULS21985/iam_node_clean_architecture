'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Users', {
      // --- Corrected 'id' field definition ---
      id: {
        allowNull: false, // ID cannot be null
        primaryKey: true, // This is the primary key
        type: Sequelize.UUID, // Data type is UUID
        // defaultValue: Sequelize.UUIDV4 // Alternative built-in UUID generation (less standard than uuid_generate_v4)
        defaultValue: Sequelize.literal('uuid_generate_v4()') // Use PostgreSQL's uuid_generate_v4() function
      },
      // --- End Corrected 'id' field definition ---
  
      hrmsId: {
        type: Sequelize.STRING,
        unique: true, // hrmsId should be unique to map back to HRMS
        allowNull: false // Assuming every user must have an HRMS ID
      },
      firstName: {
        type: Sequelize.STRING
        // Consider making this allowNull: false
      },
      lastName: {
        type: Sequelize.STRING
         // Consider making this allowNull: false
      },
      email: {
        type: Sequelize.STRING,
        unique: true, // Email should be unique
        allowNull: false // Assuming every user must have an email
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false, // Status is required
        defaultValue: 'pending_joiner' // Set a default status
      },
      hireDate: {
        type: Sequelize.DATE,
        allowNull: false // Hire date is required for a user
      },
      exitDate: {
        type: Sequelize.DATE,
        allowNull: true // Exit date is nullable
      },
      department: {
        type: Sequelize.STRING
        // Consider allowNull: false depending on if department is always present
      },
      title: {
        type: Sequelize.STRING
         // Consider allowNull: false
      },
      location: {
        type: Sequelize.STRING
         // Consider allowNull: false
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
    await queryInterface.dropTable('Users');
  }
};