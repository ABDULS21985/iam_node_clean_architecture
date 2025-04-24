'use strict';

require('dotenv').config(); // npm install dotenv

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Secured3211',        // Use a secure vault-backed secret in real life
    database: process.env.DB_NAME || 'iglm_config_dev',
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false,                                        // toggle to true for verbose SQL during local troubleshooting
    define: {
      underscored: true,                                    // enforce snake_case
      freezeTableName: true                                 // prevent pluralization
    }
  },

  test: {
    username: process.env.TEST_DB_USER || 'iglm_config_user_test',
    password: process.env.TEST_DB_PASSWORD || 'password',   // mirror your dev/test vault strategy
    database: process.env.TEST_DB_NAME || 'iglm_config_test',
    host:     process.env.TEST_DB_HOST || 'localhost',
    port:     process.env.TEST_DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false,                                        // silence logs in CI
    define: {
      underscored: true,
      freezeTableName: true
    },
    pool: {
      max: 5, min: 0, acquire: 30000, idle: 10000           // tune for your CI runners
    }
  },

  production: {
    username: process.env.PROD_DB_USER,
    password: process.env.PROD_DB_PASSWORD,
    database: process.env.PROD_DB_NAME,
    host:     process.env.PROD_DB_HOST,
    port:     process.env.PROD_DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false,                                        // send logs to centralized ELK instead
    define: {
      underscored: true,
      freezeTableName: true
    },
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false                          // set to true when using CA-signed certs
      }
    },
    pool: {
      max: 10, min: 2, acquire: 60000, idle: 20000         // production connection pool sizing
    }
  }
};
