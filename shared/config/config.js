'use strict';

const path = require('path');
// Load repo-root .env so CLI and services share the same env vars
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env')
});

module.exports = {
  development: {
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Secured3211',
    database: process.env.DB_NAME || 'iglm_config_dev',
    host:     process.env.DB_HOST || 'localhost',
    port:     process.env.DB_PORT || 5432,
    dialect:  'postgres',
    logging:  false,
    define: {
      underscored:       true,
      freezeTableName:   true
    }
  },

  development_idcs: {
    username: process.env.IDCS_DB_USER     || 'idcs_user',
    password: process.env.IDCS_DB_PASSWORD || 'Secured3211',
    database: process.env.IDCS_DB_NAME     || 'idcs_dev',
    host:     process.env.IDCS_DB_HOST     || 'localhost',
    port:     process.env.IDCS_DB_PORT     || 5432,
    dialect:  'postgres',
    logging:  false,
    define: {
      underscored:     true,
      freezeTableName: true
    }
  },

  test: {
    username: process.env.TEST_DB_USER     || 'iglm_config_user_test',
    password: process.env.TEST_DB_PASSWORD || 'Secured3211',
    database: process.env.TEST_DB_NAME     || 'iglm_config_test',
    host:     process.env.TEST_DB_HOST     || 'localhost',
    port:     process.env.TEST_DB_PORT     || 5432,
    dialect:  'postgres',
    logging:  false,
    define: {
      underscored:     true,
      freezeTableName: true
    },
    pool: {
      max: 5, min: 0, acquire: 30000, idle: 10000
    }
  },

  production: {
    username: process.env.PROD_DB_USER,
    password: process.env.PROD_DB_PASSWORD,
    database: process.env.PROD_DB_NAME,
    host:     process.env.PROD_DB_HOST,
    port:     process.env.PROD_DB_PORT     || 5432,
    dialect:  'postgres',
    logging:  false,
    define: {
      underscored:     true,
      freezeTableName: true
    },
    dialectOptions: {
      ssl: {
        require:            true,
        rejectUnauthorized: false
      }
    },
    pool: {
      max: 10, min: 2, acquire: 60000, idle: 20000
    }
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Leaver Service database
  // ────────────────────────────────────────────────────────────────────────────
  leaver: {
    username: process.env.LEAVER_DB_USER     || process.env.DB_USER     || 'postgres',
    password: process.env.LEAVER_DB_PASSWORD || process.env.DB_PASSWORD || 'Secured3211',
    database: process.env.LEAVER_DB_NAME     || 'iglm_leaver',
    host:     process.env.LEAVER_DB_HOST     || process.env.DB_HOST     || 'localhost',
    port:     process.env.LEAVER_DB_PORT     || process.env.DB_PORT     || 5432,
    dialect:  'postgres',
    logging:  false,
    define: {
      underscored:     true,
      freezeTableName: true
    }
  },

   // ────────────────────────────────────────────────────────────────────────────
   // Joiner Service database
   // ────────────────────────────────────────────────────────────────────────────
   joiner: {
      username: process.env.JOINER_DB_USER     || process.env.DB_USER     || 'postgres',
      password: process.env.JOINER_DB_PASSWORD || process.env.DB_PASSWORD || 'Secured3211',
      database: process.env.JOINER_DB_NAME     || 'iglm_joiner',
      host:     process.env.JOINER_DB_HOST     || process.env.DB_HOST     || 'localhost',
      port:     process.env.JOINER_DB_PORT     || process.env.DB_PORT     || 5432,
      dialect:  'postgres',
      logging:  false,
      define: {
        underscored:     true,
        freezeTableName: true
      }
    }
   };
