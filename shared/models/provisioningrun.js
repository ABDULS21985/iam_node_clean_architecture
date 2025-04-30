'use strict';
const { Model, Sequelize } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ProvisioningRun extends Model {}
  ProvisioningRun.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    task_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    routing_key: DataTypes.STRING,
    payload: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()')
    }
  }, {
    sequelize,
    modelName: 'ProvisioningRun',
    tableName: 'ProvisioningRuns',
    timestamps: false
  });
  return ProvisioningRun;
};
