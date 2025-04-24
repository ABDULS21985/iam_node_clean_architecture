// shared/models/provisioningtask.js
'use strict';
const {
  Model,
  Sequelize // Import Sequelize object here
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ProvisioningTask extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here

      // A ProvisioningTask belongs to one User
      ProvisioningTask.belongsTo(models.User, {
        foreignKey: 'userId', // The foreign key in the ProvisioningTasks table
        as: 'user' // Alias to access the user from a task instance
        // onDelete: 'CASCADE' is defined in the migration for DB integrity
      });
    }
  }
  ProvisioningTask.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false, // Matches migration
      // --- Add references here in model for association definition ---
      references: { // This is for Sequelize association, DB constraint is in migration
        model: 'User', // Model name (singular)
        key: 'id'
      }
      // --- End references ---
    },
    desiredState: {
      type: DataTypes.JSONB,
      allowNull: false // Matches migration
    },
    status: {
      type: DataTypes.STRING, // 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'retrying'
      allowNull: false, // Matches migration
      defaultValue: 'pending' // Matches migration
    },
    startTime: {
      type: DataTypes.DATE,
      allowNull: false, // Matches migration
      defaultValue: Sequelize.NOW // Matches migration
    },
    endTime: {
      type: DataTypes.DATE,
      allowNull: true // Matches migration
    },
    results: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    },
    errorDetails: {
      type: DataTypes.JSONB,
      allowNull: true // Matches migration
    }
  }, {
    sequelize,
    modelName: 'ProvisioningTask',
    tableName: 'ProvisioningTasks', // Explicitly define table name
    timestamps: true // Handles createdAt and updatedAt
  });
  return ProvisioningTask;
};