'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
// In your YYYYMMDDHHMMSS-create-connector-config.js file

async up(queryInterface, Sequelize) {
  await queryInterface.createTable('ConnectorConfigs', {
    // --- Corrected 'id' field definition ---
    id: {
      allowNull: false, // ID cannot be null
      primaryKey: true, // This is the primary key
      type: Sequelize.UUID, // Data type is UUID
      defaultValue: Sequelize.literal('uuid_generate_v4()') // Use PostgreSQL's uuid_generate_v4() function
    },
    // --- End Corrected 'id' field definition ---

    name: {
      type: Sequelize.STRING,
      allowNull: false, // Name is required
      unique: true // Connector config names must be unique
    },
    serviceType: {
      type: Sequelize.STRING, // 'IdentityCollection' or 'Provisioning'
      allowNull: false // Service type is required
    },
    type: {
      type: Sequelize.STRING, // e.g., 'hrms-api-v1', 't24-soap', 'ad-ldap'
      allowNull: false // Connector adapter type is required
    },
    configuration: {
      type: Sequelize.JSONB,
      allowNull: false // The actual connection configuration details are required
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
// The 'down' function is already correct for dropping the table
async down(queryInterface, Sequelize) {
  await queryInterface.dropTable('ConnectorConfigs');
}
};