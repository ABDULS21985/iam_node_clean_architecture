// shared/configService.js
const { Sequelize, DataTypes, Op } = require('sequelize'); // Import Sequelize components

// Import database configuration based on the current environment (defaulting to 'development')
const dbConfigSettings = require('./config/config')[process.env.NODE_ENV || 'development'];

// --- Import Models Required by ConfigService ---
// ConfigService needs access to models it directly queries for configurations.
// These models are assumed to be defined in the ./models directory.
const MappingConfigModel = require('./models/mappingconfig');
const ConnectorConfigModel = require('./models/connectorconfig');
const ApplicationModel = require('./models/application');

// --- Sequelize Setup ---
// Initialize Sequelize for connecting to the *configuration* database.
// This database holds settings, mappings, connector details, etc.
const sequelize = new Sequelize(dbConfigSettings.database, dbConfigSettings.username, dbConfigSettings.password, {
  host: dbConfigSettings.host,
  port: dbConfigSettings.port,
  dialect: dbConfigSettings.dialect,
  logging: dbConfigSettings.logging, // Control SQL logging via config/db.js setting
  dialectOptions: dbConfigSettings.dialectOptions // Pass additional dialect options (e.g., SSL)
  // Pool settings or other Sequelize options can be added here if needed
});

// --- Model Initialization ---
// Initialize the Sequelize models that this service directly interacts with.
// This allows ConfigService to perform DB queries using these models.
const MappingConfig = MappingConfigModel(sequelize, DataTypes);
const ConnectorConfig = ConnectorConfigModel(sequelize, DataTypes);
const Application = ApplicationModel(sequelize, DataTypes);
// If ConfigService needs other models (e.g., Tenant), initialize them here too.


// --- In-Memory Cache ---
// Simple in-memory cache using a Map to store frequently accessed configurations.
// This reduces database load for repeated requests for the same config.
const configCache = new Map();

// --- Cache Management Functions ---

/**
 * Generates a unique cache key for service-specific configurations.
 * @param {string} serviceName - Name of the service (e.g., 'discovery-service').
 * @returns {string} The cache key.
 */
const serviceCacheKey = (serviceName) => `service:${serviceName}`;

/**
 * Generates a unique cache key for MappingConfig entries.
 * Uses a composite key based on all unique identifiers.
 * @param {string} name - Mapping name.
 * @param {string} sourceType - Mapping source type.
 * @param {string} targetType - Mapping target type.
 * @param {string | null} [serviceName=null] - Optional service name association.
 * @param {string | null} [sourceId=null] - Optional source entity ID (Application or ConnectorConfig).
 * @returns {string} The cache key.
 */
const mappingCacheKey = (name, sourceType, targetType, serviceName = null, sourceId = null) =>
    `mapping:${name}|${sourceType}|${targetType}|${serviceName}|${sourceId}`;

/**
 * Generates a unique cache key for ConnectorConfig entries.
 * @param {string} name - Connector name.
 * @param {string} serviceType - Service type supported by the connector.
 * @param {string} type - Technical type of the connector.
 * @returns {string} The cache key.
 */
const connectorCacheKey = (name, serviceType, type) => `connector:${name}|${serviceType}|${type}`;

/**
 * Stores a value in the configuration cache.
 * @param {string} key - The cache key.
 * @param {*} value - The value to store (can be an object, model instance, null, etc.).
 */
const setCache = (key, value) => {
  configCache.set(key, value);
  // console.log(`[ConfigService] Cache set for key: ${key}`); // Optional: verbose logging
};

/**
 * Retrieves a value from the configuration cache.
 * @param {string} key - The cache key.
 * @returns {*} The cached value, or undefined if not found.
 */
const getCache = (key) => {
  return configCache.get(key);
};

/**
 * Removes a specific key from the cache.
 * (Note: 'this.cache' was used in the original, corrected to use 'configCache')
 * @param {string} key - The cache key to remove.
 */
const clearCache = (key) => {
   configCache.delete(key); // Corrected from 'this.cache'
   console.log(`[ConfigService] Cache cleared for key: ${key}`);
}

/**
 * Clears the entire configuration cache. Useful for testing or forcing reloads.
 */
const clearAllCache = () => {
    configCache.clear();
    console.log('[ConfigService] All config cache cleared.');
}


// --- Configuration Loading Functions ---

/**
 * Loads configuration specific to a service (e.g., intervals, API keys).
 * These configurations are stored as a JSONB object ('mappingRules') within a
 * specific MappingConfig entry identified by serviceName, sourceType='Service', targetType='Service'.
 * @param {string} serviceName - The name of the service (e.g., 'discovery-service').
 * @returns {Promise<object>} The 'mappingRules' JSONB object, or an empty object {} if not found.
 */
const loadServiceConfigs = async (serviceName) => {
  const cacheKey = serviceCacheKey(serviceName);
  const cachedValue = getCache(cacheKey);
  // Check cache first
  if (cachedValue !== undefined) {
    console.log(`[ConfigService] Cache hit for service config: ${serviceName}`);
    return cachedValue; // Return cached config object
  }

  // If not cached, load from DB
  console.log(`[ConfigService] Cache miss for service config: ${serviceName}. Loading from DB.`);
  try {
    // Find the specific MappingConfig entry used for service settings
    const configEntry = await MappingConfig.findOne({
      where: {
        serviceName: serviceName, // Filter by the service requesting config
        sourceType: 'Service',    // Predefined type indicating service-level config
        targetType: 'Service',    // Predefined type indicating service-level config
        // Assumption: Environment is handled by DB connection details or serviceName uniqueness
      },
    });

    // Extract the 'mappingRules' JSONB field, default to empty object if no entry or no rules defined
    const serviceConfigs = configEntry ? (configEntry.mappingRules || {}) : {};

    // Store the loaded config (even if empty) in cache before returning
    setCache(cacheKey, serviceConfigs);
    console.log(`[ConfigService] Loaded service config for ${serviceName}.`);
    return serviceConfigs;

  } catch (error) {
    console.error(`[ConfigService] Error loading service configs for ${serviceName}:`, error);
    // Throw error on failure, as services often need these configs to start
    throw new Error(`Failed to load configuration for service "${serviceName}"`);
  }
};

/**
 * Loads a specific MappingConfig database entry based on its unique identifiers.
 * Returns the full Sequelize model instance.
 * @param {string} name - The name of the mapping.
 * @param {string} sourceType - The source type (e.g., 'UserAttributes', 'Provisioning').
 * @param {string} targetType - The target type (e.g., 'Roles', 'ApplicationEntitlements').
 * @param {string | null} [serviceName=null] - Optional associated service name.
 * @param {string | null} [sourceId=null] - Optional associated source entity ID (Application/ConnectorConfig).
 * @returns {Promise<object | null>} The MappingConfig Sequelize model instance, or null if not found.
 */
const loadMappingConfig = async (name, sourceType, targetType, serviceName = null, sourceId = null) => {
  const cacheKey = mappingCacheKey(name, sourceType, targetType, serviceName, sourceId);
  const cachedValue = getCache(cacheKey);
  // Check cache first
  if (cachedValue !== undefined) {
    console.log(`[ConfigService] Cache hit for mapping config: ${cacheKey}`);
    return cachedValue; // Return cached model instance or null
  }

  // If not cached, load from DB
  console.log(`[ConfigService] Cache miss for mapping config: ${cacheKey}. Loading from DB.`);
  try {
    // Find the mapping configuration entry
    const mappingConfig = await MappingConfig.findOne({
      where: { name, sourceType, targetType, serviceName, sourceId }, // Use all provided filters
    });

    // Cache the result (including null if not found) to prevent repeated DB queries for non-existent configs
    setCache(cacheKey, mappingConfig);
    console.log(`[ConfigService] Loaded mapping config ${name}. Found: ${!!mappingConfig}`);
    return mappingConfig; // Return the Sequelize instance or null

  } catch (error) {
    console.error(`[ConfigService] Error loading mapping config ${cacheKey}:`, error);
    throw new Error(`Failed to load mapping config "${name}" (${sourceType} -> ${targetType})`);
  }
};

/**
 * Loads a specific ConnectorConfig database entry based on its unique identifiers.
 * Returns the full Sequelize model instance.
 * @param {string} name - The name of the connector configuration.
 * @param {string} serviceType - The service it supports ('IdentityCollection', 'Provisioning', 'Discovery').
 * @param {string} type - The technical connector type (e.g., 'hrms-db-postgres', 'ad-ldap').
 * @returns {Promise<object | null>} The ConnectorConfig Sequelize model instance, or null if not found.
 */
const loadConnectorConfig = async (name, serviceType, type) => {
  const cacheKey = connectorCacheKey(name, serviceType, type);
  const cachedValue = getCache(cacheKey);
  // Check cache first
  if (cachedValue !== undefined) {
    console.log(`[ConfigService] Cache hit for connector config: ${name}`);
    return cachedValue; // Return cached model instance or null
  }

  // If not cached, load from DB
  console.log(`[ConfigService] Cache miss for connector config: ${cacheKey}. Loading from DB.`);
  try {
    // Find the connector configuration entry
    const connectorConfig = await ConnectorConfig.findOne({
      where: { name, serviceType, type }, // Filter by unique identifiers
    });

    // Cache the result (including null)
    setCache(cacheKey, connectorConfig);
    console.log(`[ConfigService] Loaded connector config ${name}. Found: ${!!connectorConfig}`);
    return connectorConfig; // Return the Sequelize instance or null

  } catch (error) {
    console.error(`[ConfigService] Error loading connector config ${cacheKey}:`, error);
    throw new Error(`Failed to load connector config "${name}" (${serviceType}/${type})`);
  }
};


/**
 * Initializes the configuration service.
 * Primarily tests the database connection upon service startup.
 * @returns {Promise<void>} Resolves if connection is successful, rejects otherwise.
 */
const init = async () => {
  try {
    // Attempt to connect to the database
    await sequelize.authenticate();
    console.log('[ConfigService] Database connection has been established successfully.');
    // Optionally pre-load and cache critical shared/global configurations here if needed
    // Example: await loadMappingConfig("Default Attribute To Role Mapping", "UserAttributes", "Roles");
  } catch (error) {
    console.error('[ConfigService] Unable to connect to the database:', error);
    // Re-throw the error to prevent the service from starting if the config DB is unavailable
    throw new Error('Failed to connect to the Configuration Database');
  }
};

// --- Exports ---
// Export the functions needed by other services and the Sequelize instance
// which is required by the central model index (`shared/models/index.js`) for initialization.
module.exports = {
  init,                 // Initialization function (tests DB connection)
  loadServiceConfigs,   // Loads service-specific JSON config
  loadMappingConfig,    // Loads full MappingConfig model instances
  loadConnectorConfig,  // Loads full ConnectorConfig model instances
  sequelize,            // Export the Sequelize instance for model setup elsewhere
  clearAllCache,        // Export cache clearing function (useful for testing)
  // Models (MappingConfig, ConnectorConfig, Application) are typically accessed via 'shared/models'
  // unless direct use within ConfigService is extensive or specific methods are needed here.
};