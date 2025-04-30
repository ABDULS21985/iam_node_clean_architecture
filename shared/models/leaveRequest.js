'use strict';

const { Model, DataTypes, Sequelize } = require('sequelize');

module.exports = (sequelize) => {
  class LeaveRequest extends Model {
    static associate(models) {
      // If you ever want to join back to User:
      // LeaveRequest.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    }
  }

  LeaveRequest.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()')
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    hrmsId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending'
    },
    requestedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'LeaveRequest',
    tableName: 'leave_requests',
    schema: 'leaver_service',
    timestamps: true,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  });

  return LeaveRequest;
};
