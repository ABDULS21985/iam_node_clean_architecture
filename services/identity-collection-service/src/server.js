// services/identity-collection-service/src/server.js

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
const port = process.env.IDCS_PORT || 4001; // Use the port defined in .env, default to 4001

// --- Third-Party Libraries ---
const cron = require('node-cron'); // For scheduling tasks

// --- Internal Modules ---
// Import the main collection logic orchestrator module
const CollectionLogic = require('./collectionLogic'); // Adjust path if needed
// Import the temporary storage implementation module
const TemporaryStorage = require('./temporaryStorage'); // Adjust path if needed


// --- Shared Services and Models ---
// Import shared infrastructure services
const ConfigService = require('../../shared/configService'); // Adjust the relative path as needed
const MqService = require('../../shared/mqService');       // Adjust the relative path as needed
// Import ALL models needed by collectionLogic or other parts of this service
// Accessing models via ConfigService.sequelize.models is preferred after ConfigService.init
// but importing the module here is needed for static properties/types or if not using ConfigService's sequelize instance
const models = require('../../shared/models');
// Destructure specific models for clarity if you use them directly in this file (optional)
const { CollectionRun, ConnectorConfig, MappingConfig, User, Application, Entitlement, Role, UserRole, RoleEntitlementMapping } = models;


// --- Service Configuration ---
// Define the service name for config loading and logging
const serviceName = 'identity-collection-service';
// Object to hold loaded service-specific configurations (like polling interval, connector names)
let serviceConfigs = {};


// --- Core Collection Run Orchestration ---
/**
 * Orchestrates a single data collection run by calling the core logic module.
 * This function exists mainly to setup options and handle top-level logging/error reporting
 * before handing off to the detailed logic in CollectionLogic.
 */
async function performDataCollectionRun() {
    console.log(`[${serviceName}] Starting scheduled data collection task.`);

    // Prepare the options object containing all necessary dependencies for CollectionLogic.performRun
    const runOptions = {
        serviceConfigs: serviceConfigs, // Service specific configs loaded at startup
        configService: ConfigService,     // The initialized ConfigService instance (for accessing Config DB)
        mqService: MqService,           // The initialized MqService instance (for publishing events)
        models: models,                   // All Sequelize models (Core Data Model, Config Models, Run Log Models)
        temporaryStorage: TemporaryStorage // The initialized TemporaryStorage implementation module
        // TODO: Add other dependencies like logger, health check reporter, etc.
    };

    try {
        // Call the core collection logic function from the separate module
        // CollectionLogic.performRun will handle creating and updating the CollectionRun log entry itself.
        const runResult = await CollectionLogic.performRun(runOptions);

        console.log(`[${serviceName}] Data collection run finished with status: ${runResult.status}. Metrics:`, runResult.metrics);
        // Note: Detailed error logging for the run is handled within CollectionLogic's finally block updating the log.
        // This block is for logging *that the orchestration completed*.

    } catch (error) {
        // This catch block is mainly for unexpected errors *outside* of performRun's internal handling,
        // e.g., if performRun itself threw an unhandled error before updating the log.
        console.error(`[${serviceName}] Uncaught error during scheduled data collection task orchestration:`, error);
        // TODO: Log this critical failure to a centralized logging system
    }
}


// --- Scheduling ---
/**
 * Schedules the data collection task using cron based on configurable interval.
 */
async function scheduleDataCollection() {
    // Attempt to parse polling interval from serviceConfigs.
    // Config key name 'pollingIntervalMinutes' should be added to the Config Database for this service,
    // associated with serviceName: 'identity-collection-service'.
    const pollingIntervalMinutes = parseInt(serviceConfigs.pollingIntervalMinutes) || 60; // Default to 60 minutes if config is missing or invalid

    if (pollingIntervalMinutes <= 0) {
         console.warn(`[${serviceName}] Configured polling interval is ${pollingIntervalMinutes} minutes (<= 0). Skipping scheduler setup.`);
         return; // Don't schedule if interval is zero or negative
    }

    // Use node-cron to schedule the task
    // Cron syntax: '*/${minutes} * * * *' means "at minute 0, N, 2N, etc., every hour, every day"
    const cronSchedule = `*/${pollingIntervalMinutes} * * * *`;
    console.log(`[${serviceName}] Scheduling data collection to run every ${pollingIntervalMinutes} minutes (Cron schedule: "${cronSchedule}")`);

    cron.schedule(cronSchedule, async () => {
        // The function that gets called by cron on schedule
        console.log(`[${serviceName}] Cron schedule triggered.`);
        await performDataCollectionRun(); // Call the orchestrator function
    });

    console.log(`[${serviceName}] Data collection scheduler started.`);
}


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Identity Collection Service.
 */
async function startService() {
  try {
    console.log(`[${serviceName}] Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    // This also connects to the Config Database where ConnectorConfigs, MappingConfigs, and Run logs live
    await ConfigService.init();
    console.log(`[${serviceName}] ConfigService initialized successfully.`);

    // Load configurations specific to this service (like polling interval, connector names, mapping names)
    // Ensure these configs exist in the Config Database for serviceName: 'identity-collection-service'
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
     // Basic check to ensure critical configs are loaded
    if (!serviceConfigs || !serviceConfigs.hrmsConnectorName || !serviceConfigs.userMappingName) {
         console.error(`[${serviceName}] Missing critical service configurations. Loaded:`, serviceConfigs);
         throw new Error('Missing critical service configurations (hrmsConnectorName and/or userMappingName)');
    }
    console.log(`[${serviceName}] Loaded service configurations:`, serviceConfigs);


    // 2. Initialize Message Queue Service
    await MqService.init();
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);


    // 3. Initialize Temporary Storage (Redis)
    await TemporaryStorage.init();
    console.log(`[${serviceName}] Temporary Storage initialized.`);


    // 4. Set up Express server basic routes (e.g., health check)
    // Note: Error routes/middleware can be added here as well
    app.get('/health', (req, res) => {
      // Basic health check - check Config DB connection, MQ status, Temporary Storage status
      const health = {
        status: 'UP',
        configDb: ConfigService.sequelize && ConfigService.sequelize.connectionManager.hasOwnProperty('getConnection') ? 'CONNECTED' : 'DISCONNECTED', // Check config DB connection status
        mqService: MqService.channel ? 'CONNECTED' : 'DISCONNECTED', // Check MQ channel status
        temporaryStorage: TemporaryStorage.redisClient && TemporaryStorage.redisClient.status === 'ready' ? 'CONNECTED' : 'DISCONNECTED', // Check Redis status
        // TODO: Add checks for individual service DB if IDCS gets one later
      };
      // Determine overall HTTP status based on component health
      const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.temporaryStorage === 'CONNECTED') ? 200 : 503; // Use 503 Service Unavailable for degraded state
      res.status(overallStatus).json(health);
    });

    // TODO: Add other API endpoints later (e.g., for internal connector management - CRUD Connector/Mapping Configs? Or is this via Admin UI calling a dedicated Config Service?)


    // 5. Start the Express server listening for incoming requests (like health checks)
    app.listen(port, () => {
      console.log(`[${serviceName}] Service listening on port ${port}`);
    });


    // 6. Schedule the core data collection process
    // This will read the interval from serviceConfigs and set up the cron job that calls performDataCollectionRun
    await scheduleDataCollection();

    // Optionally, trigger an immediate run on startup for testing/initial sync
    // console.log(`[${serviceName}] Triggering immediate collection run on startup.`);
    // await performDataCollectionRun();


    console.log(`[${serviceName}] Service initialization complete.`);

  } catch (error) {
    // Catch any errors during the service initialization phase
    console.error(`[${serviceName}] Failed to start service:`, error);
    // TODO: Log startup failure to a centralized logging system before exiting
    process.exit(1); // Exit process immediately if startup fails
  }
}

// --- Start the Service ---
// Call the initialization function to start the service
startService();


// --- Graceful Shutdown Handling ---
// Listen for termination signals (e.g., from Docker/Kubernetes stop)
process.on('SIGTERM', async () => {
    console.log(`[${serviceName}] SIGTERM received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown (stop cron scheduler tasks, ensure ongoing runs finish if possible)

    // Close connections to external services
    if (ConfigService.sequelize) {
        await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        console.log(`[${serviceName}] Config DB connection closed.`);
    }
    if (MqService.connection) {
        await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
        console.log(`[${serviceName}] MQ connection closed.`);
    }
    if (TemporaryStorage.redisClient) { // Check if redisClient exists before trying to close
       await TemporaryStorage.close().catch(err => console.error(`[${serviceName}] Error closing Redis client:`, err));
       console.log(`[${serviceName}] Redis client connection closed.`);
    }

    console.log(`[${serviceName}] Graceful shutdown complete.`);
    process.exit(0); // Exit successfully
});

// Listen for interrupt signals (e.g., Ctrl+C)
process.on('SIGINT', async () => {
    console.log(`[${serviceName}] SIGINT received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown (stop cron scheduler tasks, ensure ongoing runs finish if possible)

    // Close connections to external services
    if (ConfigService.sequelize) {
         await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
         console.log(`[${serviceName}] Config DB connection closed.`);
    }
    if (MqService.connection) {
         await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
         console.log(`[${serviceName}] MQ connection closed.`);
    }
    if (TemporaryStorage.redisClient) { // Check if redisClient exists
        await TemporaryStorage.close().catch(err => console.error(`[${serviceName}] Error closing Redis client:`, err));
        console.log(`[${serviceName}] Redis client connection closed.`);
    }

    console.log(`[${serviceName}] Graceful shutdown complete.`);
    process.exit(0); // Exit successfully
});

// Optional: Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error(`[${serviceName}] Uncaught Exception:`, err);
    // TODO: Log this critical error to a centralized logging system
    // Attempt graceful shutdown, or just exit immediately depending on policy
    // process.exit(1); // Exit after logging
});

// Optional: Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${serviceName}] Unhandled Rejection at Promise:`, promise, 'reason:', reason);
     // TODO: Log this critical error
    // Attempt graceful shutdown or exit
    // process.exit(1);
});