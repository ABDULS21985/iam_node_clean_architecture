// In your YYYYMMDDHHMMSS-create-mapping-config.js file
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MappingConfigs', {
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
        unique: true // Mapping names must be unique
      },
      sourceType: {
        type: Sequelize.STRING, // 'HRMS' or 'Application'
        allowNull: false // Source type is required
      },
      sourceId: {
        // This column will store the ID of the source (ConnectorConfig or Application)
        // We won't add a foreign key constraint here in the migration
        // because it can reference different tables based on sourceType.
        // The relationship will be managed in the model definitions.
        type: Sequelize.UUID,
        allowNull: true // sourceId is optional (e.g., for global mappings) or nullable FK
      },
      targetType: {
        type: Sequelize.STRING, // 'User', 'Role', 'Entitlement', 'Account'
        allowNull: false // Target type is required
      },
      mappingRules: {
        type: Sequelize.JSONB,
        allowNull: false // The actual mapping rules are required
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
    await queryInterface.dropTable('MappingConfigs');
  }
};