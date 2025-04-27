// shared/config/config.js
'use strict';

const path = require('path'); // to locate the repo root .env
// Load repo-root .env (so CLI and services share the same environment vars)
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env')
}); // npm install dotenv

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Secured3211',
    database: process.env.DB_NAME || 'iglm_config_dev', // This is the default development DB (Config DB)
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false, // toggle to true for verbose SQL during local troubleshooting
    define: {
      underscored: true, // enforce snake_case
      freezeTableName: true // prevent pluralization
    }
  },

  // --- New configuration for the IDCS development database ---
  development_idcs: {
    username: process.env.IDCS_DB_USER || 'idcs_user', // Use IDCS specific user from .env
    password: process.env.IDCS_DB_PASSWORD || 'Secured3211', // Use IDCS specific password from .env
    database: process.env.IDCS_DB_NAME || 'idcs_dev', // Use IDCS specific database name from .env
    host:     process.env.IDCS_DB_HOST || 'localhost', // Use IDCS specific host from .env
    port:     process.env.IDCS_DB_PORT || 5432, // Use IDCS specific port from .env
    dialect:  'postgres',
    logging:  false, // You can set this to true for IDCS DB queries if needed
    define: {
      underscored: true, // enforce snake_case
      freezeTableName: true // prevent pluralization
    }
  },
  // --- End new configuration ---

  test: {
    username: process.env.TEST_DB_USER || 'iglm_config_user_test',
    password: process.env.TEST_DB_PASSWORD || 'Secured3211',
    database: process.env.TEST_DB_NAME || 'iglm_config_test',
    host:     process.env.TEST_DB_HOST || 'localhost',
    port:     process.env.TEST_DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false, // silence logs in CI
    define: {
      underscored: true,
      freezeTableName: true
    },
    pool: {
      max: 5, min: 0, acquire: 30000, idle: 10000 // tune for your CI runners
    }
  },

  production: {
    username: process.env.PROD_DB_USER,
    password: process.env.PROD_DB_PASSWORD,
    database: process.env.PROD_DB_NAME,
    host:     process.env.PROD_DB_HOST,
    port:     process.env.PROD_DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false, // send logs to centralized ELK instead
    define: {
      underscored: true,
      freezeTableName: true
    },
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false // set to true when using CA-signed certs
      }
    },
    pool: {
      max: 10, min: 2, acquire: 60000, idle: 20000 // production connection pool sizing
    }
  }
};