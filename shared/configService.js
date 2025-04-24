// shared/configService.js
const { Sequelize, DataTypes } = require('sequelize');
const config = require('./config/config'); // Import database config

// Load the Configuration model
const ConfigurationModel = require('./models/configuration');

// Determine the environment (default to 'development' if not set)
const env = process.env.NODE_ENV || 'development';
// Get the database configuration for the current environment
const dbConfig = config[env];

// --- Sequelize Instance ---
// Create a new Sequelize instance using the config DB details
const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
  host: dbConfig.host,
  port: dbConfig.port,
  dialect: dbConfig.dialect,
  logging: dbConfig.logging, // Use config setting for logging SQL
  dialectOptions: dbConfig.dialectOptions // Include dialect options like SSL if present
});

// --- Models ---
// Initialize the Configuration model with the Sequelize instance
const Configuration = ConfigurationModel(sequelize, DataTypes);

// --- In-Memory Cache ---
const configCache = {}; // Cache configurations loaded from the DB

// --- Cache Management ---
const cacheKey = (key, serviceName, environment) =>
  `${serviceName}:${environment}:${key}`;

const setCache = (key, serviceName, environment, value) => {
  const keyStr = cacheKey(key, serviceName, environment);
  configCache[keyStr] = value;
};

const getCache = (key, serviceName, environment) => {
  const keyStr = cacheKey(key, serviceName, environment);
  return configCache[keyStr];
};

const clearCache = (serviceName, environment) => {
    // Basic clear - could be more granular
    for (const key in configCache) {
        if (key.startsWith(`${serviceName}:${environment}:`)) {
            delete configCache[key];
        }
    }
}


// --- Configuration Loading Functions ---

/**
 * Loads a single configuration value from the database or cache.
 * @param {string} key - The configuration key.
 * @param {string} serviceName - The name of the service the config belongs to.
 * @param {string} environment - The environment (e.g., 'development', 'production').
 * @returns {Promise<any | null>} The configuration value, or null if not found.
 */
const loadConfig = async (key, serviceName, environment = env) => {
  const cachedValue = getCache(key, serviceName, environment);
  if (cachedValue !== undefined) { // Check if it's in cache (even if null was cached)
    console.log(`[ConfigService] Cache hit for ${cacheKey(key, serviceName, environment)}`);
    return cachedValue;
  }

  console.log(`[ConfigService] Cache miss for ${cacheKey(key, serviceName, environment)}. Loading from DB.`);
  try {
    const configEntry = await Configuration.findOne({
      where: {
        key: key,
        serviceName: serviceName,
        environment: environment,
      },
    });

    const value = configEntry ? configEntry.value : null;
    setCache(key, serviceName, environment, value); // Cache the result (even null)
    return value;

  } catch (error) {
    console.error(`[ConfigService] Error loading config ${cacheKey(key, serviceName, environment)}:`, error);
    // Depending on requirements, you might re-throw or return null/default
    throw new Error(`Failed to load configuration "${key}" for service "${serviceName}" in environment "${environment}"`);
  }
};

/**
 * Loads all configurations for a specific service and environment.
 * Caches all loaded key-value pairs individually.
 * @param {string} serviceName - The name of the service.
 * @param {string} environment - The environment.
 * @returns {Promise<object>} An object containing all configs for the service.
 */
const loadServiceConfigs = async (serviceName, environment = env) => {
     // Simple check: if we have *any* key for this service/env in cache, assume loaded.
     // More robust check needed for production (e.g., a flag, or count)
     const cachedKeys = Object.keys(configCache).filter(k => k.startsWith(`${serviceName}:${environment}:`));
     if (cachedKeys.length > 0) {
        console.log(`[ConfigService] Service cache hit for ${serviceName}:${environment}.`);
        const serviceConfigs = {};
         cachedKeys.forEach(k => {
             const key = k.substring(`${serviceName}:${environment}:`.length);
             serviceConfigs[key] = configCache[k];
         });
         return serviceConfigs;
     }

    console.log(`[ConfigService] Service cache miss for ${serviceName}:${environment}. Loading all from DB.`);
    try {
        const configEntries = await Configuration.findAll({
            where: {
                serviceName: serviceName,
                environment: environment,
            },
        });

        const serviceConfigs = {};
        configEntries.forEach(entry => {
            serviceConfigs[entry.key] = entry.value;
            setCache(entry.key, serviceName, environment, entry.value); // Cache each individual entry
        });

        return serviceConfigs;

    } catch (error) {
        console.error(`[ConfigService] Error loading all configs for ${serviceName}:${environment}:`, error);
        throw new Error(`Failed to load all configurations for service "${serviceName}" in environment "${environment}"`);
    }
}

/**
 * Initializes the configuration service by testing the database connection.
 * @returns {Promise<void>}
 */
const init = async () => {
  try {
    await sequelize.authenticate();
    console.log('[ConfigService] Database connection has been established successfully.');
    // Optionally load critical shared configs here on startup
    // await loadServiceConfigs('shared', env);
  } catch (error) {
    console.error('[ConfigService] Unable to connect to the database:', error);
    // Depending on your application's resilience, you might want to exit here
    throw new Error('Failed to connect to the Configuration Database');
  }
};

// --- Export Functions ---
module.exports = {
  init,
  loadConfig,
  loadServiceConfigs,
  sequelize, // Export sequelize instance if needed elsewhere (e.g., for models in other shared modules)
  Configuration // Export the model if needed elsewhere
};