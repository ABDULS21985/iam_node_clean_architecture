// shared/models/joinerrun.js
'use strict';
const { Model, Sequelize } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class JoinerRun extends Model {
    static associate(models) {
      // A JoinerRun belongs to one User
      JoinerRun.belongsTo(models.User, {
        foreignKey: 'userId',
        as: 'user'
      });
    }
  }

  JoinerRun.init({
    id: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      defaultValue: Sequelize.literal('uuid_generate_v4()')
    },
    hrmsId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    routingKey: {
      type: DataTypes.STRING,
      allowNull: true
    },
    payload: {
      type: DataTypes.JSONB,
      allowNull: false
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
    }
  }, {
    sequelize,
    modelName: 'JoinerRun',
    tableName: 'JoinerRuns',
    timestamps: true
  });

  return JoinerRun;
};
