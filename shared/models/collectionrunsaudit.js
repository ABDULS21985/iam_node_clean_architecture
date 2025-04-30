'use strict';
const { Model, Sequelize } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class CollectionRunsAudit extends Model {}
  CollectionRunsAudit.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    run_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()')
    },
    finished_at: DataTypes.DATE,
    status: DataTypes.STRING,
    metrics: DataTypes.JSONB,
    error: DataTypes.JSONB
  }, {
    sequelize,
    modelName: 'CollectionRunsAudit',
    tableName: 'CollectionRunsAudit',
    timestamps: false
  });
  return CollectionRunsAudit;
};
