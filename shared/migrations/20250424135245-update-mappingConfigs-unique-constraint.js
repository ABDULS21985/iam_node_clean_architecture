
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Update unique constraint on 'MappingConfigs' table:
     * 1. Remove the old unique constraint on 'name'.
     * 2. Add a new composite unique constraint on ['name', 'serviceName'].
     */

    // 1. Remove the old unique constraint on 'name'
    // The constraint name is often auto-generated like 'MappingConfigs_name_key' or 'MappingConfigs_name_unique'.
    // Check your database schema if the default name 'MappingConfigs_name_key' doesn't work.
    try {
      await queryInterface.removeConstraint('MappingConfigs', 'MappingConfigs_name_key');
      console.log("Removed old unique constraint 'MappingConfigs_name_key' on MappingConfigs.");
    } catch (error) {
       // If the default name didn't exist, try finding it or skip if already gone/named differently
       console.warn("Could not remove default constraint 'MappingConfigs_name_key'. It may have a different name or not exist. Check schema.", error.message);
       // You might need to manually find the constraint name in your DB if this fails:
       // SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'MappingConfigs' AND constraint_type = 'UNIQUE';
       // Then update the removeConstraint call with the correct name.
    }


    // 2. Add the new composite unique constraint on ['name', 'serviceName']
    await queryInterface.addConstraint('MappingConfigs', {
      fields: ['name', 'serviceName'], // The columns involved in the composite unique constraint
      type: 'unique', // The type of constraint
      name: 'MappingConfigs_name_serviceName_unique_composite' // A descriptive name for the new constraint
    });
    console.log("Added new composite unique constraint 'MappingConfigs_name_serviceName_unique_composite' on MappingConfigs (name, serviceName).");

  },

  async down (queryInterface, Sequelize) {
    /**
     * Revert the unique constraint update on 'MappingConfigs':
     * 1. Remove the new composite unique constraint on ['name', 'serviceName'].
     * 2. Add back the old unique constraint on 'name' (optional, for full rollback).
     */

     // 1. Remove the new composite unique constraint
    try {
      await queryInterface.removeConstraint('MappingConfigs', 'MappingConfigs_name_serviceName_unique_composite');
      console.log("Removed composite unique constraint 'MappingConfigs_name_serviceName_unique_composite' on MappingConfigs.");
    } catch (error) {
       console.warn("Could not remove composite constraint 'MappingConfigs_name_serviceName_unique_composite'. Check schema.", error.message);
    }


     // 2. Add back the old unique constraint on 'name' (Optional for full rollback consistency)
     // Note: This might fail if there are now duplicate names in the table without considering serviceName.
     // Only add back if needed and you can ensure uniqueness on 'name' during rollback.
     // await queryInterface.addConstraint('MappingConfigs', {
     //   fields: ['name'],
     //   type: 'unique',
     //   name: 'MappingConfigs_name_key' // Use the expected original name
     // });
     // console.log("Added back old unique constraint 'MappingConfigs_name_key' on MappingConfigs (name).");

  }
};