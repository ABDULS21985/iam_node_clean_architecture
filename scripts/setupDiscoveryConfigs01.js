// scripts/setupDiscoveryConfigs.js
require('dotenv').config(); // Load environment variables from .env at project root

// Import shared services and models
const ConfigService = require('../shared/configService'); // Adjust path as needed
const models = require('../shared/models'); // Adjust path as needed

const serviceName = 'setup-discovery-config'; // Identifier for logging

// Use process.stdout.write and process.stderr.write instead of console.log/error/warn
function logInfo(message) {
    process.stdout.write(`[${serviceName}] ${message}\n`);
}
function logWarn(message) {
    process.stderr.write(`[${serviceName}] WARNING: ${message}\n`);
}
function logError(message, error) {
    process.stderr.write(`[${serviceName}] ERROR: ${message}\n`);
    if (error) {
        process.stderr.write(error.stack + '\n');
    }
}


async function runSetup() {
    logInfo(`Starting Discovery configuration setup script...`);

    try {
        // 1. Initialize Configuration Service (connects to the Config DB)
        await ConfigService.init();
        logInfo(`ConfigService initialized.`);

        // Access models after ConfigService is initialized
        const { MappingConfig } = models;

        // --- Define Configuration Data for Discovery Service ---

        // Data for the Discovery Service Configuration
        const discoveryServiceConfigData = {
            name: "Discovery Service Configuration", // Name used by the Discovery service
            serviceName: "discovery-service", // Match serviceName constant
            sourceType: "Service", // Indicates this config is for a service
            targetType: "Service", // Indicates this config is for a service
            mappingRules: { // Configuration values for the Discovery service itself
                discoveryIntervalMinutes: 60, // Set to 60 minutes initially
                // applicationsToDiscover: [ // List the names or IDs of Applications Discovery should target
                //   "Finance App (Postgres)",
                //   "T24 Core Banking (Oracle DB)",
                //   "Active Directory / LDAP",
                //   // Add names of other Applications here
                // ],
                // Add other Discovery specific settings here (e.g., concurrency limits, error thresholds)
            },
            metadata: {
                description: "Configuration for the Discovery Service."
            }
        };


        // --- Insert or Find Configuration ---
        logInfo(`Inserting/finding Discovery configuration...`);

        // Find or create the Discovery Service Config entry
        const [discoveryServiceConfigEntry, createdDiscoveryServiceConfig] = await MappingConfig.findOrCreate({
            where: { name: discoveryServiceConfigData.name, serviceName: discoveryServiceConfigData.serviceName }, // name and serviceName are key for service configs
            defaults: discoveryServiceConfigData
        });

        if (createdDiscoveryServiceConfig) {
             logInfo(`Created Discovery Service Config: ${discoveryServiceConfigEntry.name}`);
        } else {
             // If found, update its mappingRules to ensure it has the latest structure and default values
             // This makes the script idempotent for updates as well as creation
             const currentRules = discoveryServiceConfigEntry.mappingRules || {};
             // Deep merge current rules with default rules, prioritizing current rules
             const mergedRules = {
                  ...discoveryServiceConfigData.mappingRules, // Default rules
                  ...currentRules, // Overwrite defaults with current rules
                  // For nested objects like applicationsToDiscover, you might need a deep merge
                  applicationsToDiscover: discoveryServiceConfigData.mappingRules.applicationsToDiscover || currentRules.applicationsToDiscover || []
             };

             if (JSON.stringify(discoveryServiceConfigEntry.mappingRules) !== JSON.stringify(mergedRules)) {
                 // Only update if mappingRules have actually changed
                  await discoveryServiceConfigEntry.update({ mappingRules: mergedRules });
                  logInfo(`Found and updated Discovery Service Config: ${discoveryServiceConfigEntry.name} with latest default rules.`);
             } else {
                  logInfo(`Found existing Discovery Service Config: ${discoveryServiceConfigEntry.name}. MappingRules are up to date.`);
             }
        }


        logInfo(`Discovery configuration setup script finished.`);

    } catch (error) {
        logError(`Error running Discovery configuration setup script:`, error);
        // Don't re-throw, let the finally block run
    } finally {
        // Ensure the database connection is closed
        if (ConfigService.sequelize) {
             logInfo(`Closing Config DB connection...`);
             await ConfigService.sequelize.close().catch(err => logError(`Error closing Config DB connection:`, err));
             logInfo(`Config DB connection closed.`);
         } else {
             logInfo(`ConfigService.sequelize was not initialized.`);
         }
         // Also ensure other potential connections from models init are closed if necessary
         if (models.sequelize) {
             logInfo(`Closing Core DB connection...`);
             await models.sequelize.close().catch(err => logError(`Error closing Core DB connection:`, err));
             logInfo(`Core DB connection closed.`);
         } else {
              logInfo(`models.sequelize was not initialized.`);
         }
    }
}

// Execute the setup function
runSetup();