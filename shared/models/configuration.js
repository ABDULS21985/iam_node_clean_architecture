'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Configuration extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  Configuration.init({
    key: DataTypes.STRING,
    value: DataTypes.JSONB,
    serviceName: DataTypes.STRING,
    environment: DataTypes.STRING
  }, {
    sequelize,
    modelName: 'Configuration',
  });
  return Configuration;
};