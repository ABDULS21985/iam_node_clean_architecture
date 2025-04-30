/* YYYYMMDDHHMMSS-create-leave-requests.js */
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1️⃣ Ensure pgcrypto
    await queryInterface.sequelize.query(
      `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`
    );

    // 2️⃣ Guarantee schema
    await queryInterface.sequelize.query(
      `CREATE SCHEMA IF NOT EXISTS leaver_service;`
    );

    // 3️⃣ Create table with snake_case column names
    await queryInterface.createTable(
      { schema: 'leaver_service', tableName: 'leave_requests' },
      {
        id: {
          type: Sequelize.UUID,
          allowNull: false,
          primaryKey: true,
          defaultValue: Sequelize.literal('gen_random_uuid()')
        },
        user_id: {
          type: Sequelize.UUID,
          allowNull: false,
          comment: 'IGLM user UUID',
          references: {
            model: { schema: 'public', tableName: 'Users' },
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        hrms_id: {
          type: Sequelize.STRING,
          allowNull: false,
          comment: 'HRMS identifier string'
        },
        status: {
          type: Sequelize.STRING,
          allowNull: false,
          defaultValue: 'pending',
          comment: 'pending | completed | failed'
        },
        requested_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          comment: 'When the leaver event was received'
        },
        processed_at: {
          type: Sequelize.DATE,
          allowNull: true,
          comment: 'When the Provisioning API call succeeded'
        },
        error_message: {
          type: Sequelize.TEXT,
          allowNull: true,
          comment: 'Error details if de-provisioning failed'
        },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        deleted_at: {
          type: Sequelize.DATE,
          allowNull: true
        }
      }
    );

    // 4️⃣ Enforce allowed status values (idempotent)
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conname = 'leave_requests_status_chk'
             AND conrelid = 'leaver_service.leave_requests'::regclass
        ) THEN
          ALTER TABLE leaver_service.leave_requests
            ADD CONSTRAINT leave_requests_status_chk
            CHECK (status IN ('pending','completed','failed'));
        END IF;
      END
      $$;
    `);

    // 5️⃣ Add indexes on snake_case columns (idempotent)
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_lr_status
      ON leaver_service.leave_requests(status);
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_lr_user
      ON leaver_service.leave_requests(user_id);
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(
      { schema: 'leaver_service', tableName: 'leave_requests' }
    );
    await queryInterface.sequelize.query(
      `DROP SCHEMA IF EXISTS leaver_service CASCADE;`
    );
  }
};
