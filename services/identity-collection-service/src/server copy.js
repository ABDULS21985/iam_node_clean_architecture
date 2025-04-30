// // services/identity-collection-service/src/server.js
require('dotenv').config({ path: '../../../.env' }); // Adjust path if .env is elsewhere

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
const port = process.env.IDCS_PORT || 4001; // Use the port defined in .env, default to 4001
let server = null; // Keep track of the HTTP server instance



// --- Third-Party Libraries ---
const cron = require('node-cron'); // For scheduling tasks
const axios = require('axios'); // For potentially making external API calls

// --- Updated axios-retry import ---
const axiosRetryModule = require('axios-retry'); // Import the module
// Safely get the main function, accounting for .default export
const axiosRetry = axiosRetryModule.default || axiosRetryModule;
// --- End Updated axios-retry import ---


// --- Internal Modules ---
// Import the main collection logic orchestrator module
const CollectionLogic = require('./collectionLogic'); 
// Import the temporary storage implementation module
const TemporaryStorage = require('./temporaryStorage'); 


// --- Shared Services and Models ---
// Import shared infrastructure services
const ConfigService = require('../../../shared/configService'); 
const MqService = require('../../../shared/mqService');  
// Import ALL models needed by collectionLogic or other parts of this service
// Accessing models via ConfigService.sequelize.models is preferred after ConfigService.init
// but importing the module here is needed for static properties/types or if not using ConfigService's sequelize instance
const models = require('../../../shared/models');
// Destructure specific models for clarity if you use them directly in this file (optional)
const { CollectionRun, ConnectorConfig, MappingConfig, User, Application, Entitlement, Role, UserRole, RoleEntitlementMapping } = models;


// --- Service Configuration ---
// Define the service name for config loading and logging
const serviceName = 'identity-collection-service';
// Object to hold loaded service-specific configurations (like polling interval, connector names)
let serviceConfigs = {};

// --- Scheduling ---
let scheduledTask = null; // Variable to hold the scheduled cron task instance

// --- Configure axios-retry ---
// Apply retry logic to the axios instance for API calls made by this service or modules it uses (like adapters).
// This assumes that external HTTP calls within collectionLogic or its adapters use this shared axios instance.
axiosRetry(axios, {
    retries: 3, // Number of retry attempts
    retryDelay: axiosRetry.ExponentialBackoff, // Use exponential backoff for delays between retries (e.g., 1s, 2s, 4s, ...)
    // Define the condition for retrying a failed request.
    // Retry on network errors or standard retryable errors (typically 5xx status codes).
    retryCondition: (error) => {
        return axiosRetry.isNetworkError(error) || axiosRetry.isRetryableError(error);
    },
    // TODO: Configure specific status codes to retry on if needed (e.g., add || (error.response && error.response.status === 429))
    onRetry: (retryCount, error, requestConfig) => {
        // Log a warning when a retry attempt is made
        console.warn(`[${serviceName}] Axios Retry: Attempt ${retryCount} failed for ${requestConfig.method.toUpperCase()} ${requestConfig.url}. Error: ${error.message}`);
    }
});
console.log(`[${serviceName}] Configured axios with retry logic for outgoing HTTP requests.`);


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
        models: models,                 // All Sequelize models (Core Data Model, Config Models, Run Log Models)
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
    const pollingIntervalMinutes = parseInt(serviceConfigs.pollingIntervalMinutes, 10) || 60; // Parse as integer, Default to 60 minutes if config is missing or invalid

    if (pollingIntervalMinutes <= 0) {
        console.warn(`[${serviceName}] Configured polling interval is ${pollingIntervalMinutes} minutes (<= 0). Skipping scheduler setup.`);
        return; // Don't schedule if interval is zero or negative
    }

    // Use node-cron to schedule the task
    // Cron syntax: '*/${minutes} * * * *' means "at minute 0, N, 2N, etc., every hour, every day"
    const cronSchedule = `*/${pollingIntervalMinutes} * * * *`;
    console.log(`[${serviceName}] Scheduling data collection to run every ${pollingIntervalMinutes} minutes (Cron schedule: "${cronSchedule}")`);

    // Schedule the task and store the scheduled task instance
    scheduledTask = cron.schedule(cronSchedule, async () => {
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
    if (!serviceConfigs || serviceConfigs.identitySourceConnectorName === undefined || serviceConfigs.userMappingName === undefined || serviceConfigs.pollingIntervalMinutes === undefined) { // Added check for undefined/null
        console.error(`[${serviceName}] Missing critical service configurations. Need 'identitySourceConnectorName', 'userMappingName', and 'pollingIntervalMinutes'. Loaded:`, serviceConfigs);
        throw new Error('Missing critical service configurations (identitySourceConnectorName, userMappingName, or pollingIntervalMinutes)');
    }
    console.log(`[${serviceName}] Loaded service configurations:`, serviceConfigs);


    // 2. Initialize Message Queue Service
    await MqService.init(logger); 
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);

    // Add listeners for critical MQ channel and connection errors
    MqService.channel.on('close', () => console.log(`[${serviceName}] MQ channel closed.`));
    MqService.channel.on('error', (err) => console.error(`[${serviceName}] MQ channel error:`, err));
    MqService.connection.on('close', (err) => console.log(`[${serviceName}] MQ connection closed.`, err));
    MqService.connection.on('error', (err) => console.error(`[${serviceName}] MQ connection error:`, err));
    MqService.connection.on('blocked', (reason) => console.warn(`[${serviceName}] MQ connection blocked:`, reason));
    MqService.connection.on('unblocked', () => console.log(`[${serviceName}] MQ connection unblocked.`));


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
    server = app.listen(port, () => { // Capture server instance for graceful shutdown
      console.log(`[${serviceName}] Service listening on port ${port}`);
    });


    // 6. Schedule the core data collection process
    // This will read the interval from serviceConfigs and set up the cron job that calls performDataCollectionRun
    await scheduleDataCollection();

    // Optionally, trigger an immediate run on startup for testing/initial sync
    // console.log(`[${serviceName}] Triggering immediate collection run on startup.`);
    // performDataCollectionRun(); // Call without await so startup isn't blocked by first run


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
// Array to hold promises of active collection runs that need to complete during shutdown
let activeCollectionRuns = []; // CollectionLogic.performRun should add its promise to this array

// Listen for termination signals (e.g., from Docker/Kubernetes stop)
process.on('SIGTERM', async () => {
    console.log(`[${serviceName}] SIGTERM received, starting graceful shutdown.`);
    await gracefulShutdown();
});

// Listen for interrupt signals (e.g., Ctrl+C)
process.on('SIGINT', async () => {
    console.log(`[${serviceName}] SIGINT received, starting graceful shutdown.`);
    await gracefulShutdown();
});

// Graceful shutdown function
async function gracefulShutdown() {
    console.log(`[${serviceName}] Starting graceful shutdown...`);

    // 1. Stop the cron scheduler from triggering new runs
    if (scheduledTask) {
        scheduledTask.stop(); // Stop the cron task
        console.log(`[${serviceName}] Cron scheduler stopped.`);
    } else {
        console.log(`[${serviceName}] Cron scheduler was not running.`);
    }

    // 2. Stop the Express HTTP server from accepting new connections
    if (server) {
        console.log(`[${serviceName}] Stopping HTTP server...`);
        await new Promise((resolve, reject) => {
            server.close((err) => {
                if (err) {
                    console.error(`[${serviceName}] Error stopping HTTP server:`, err);
                    // Decide if HTTP server close failure is critical or just log and proceed
                    return reject(err); // Treat as failure to stop gracefully
                }
                console.log(`[${serviceName}] HTTP server stopped.`);
                resolve();
            });
        }).catch(err => console.error(`[${serviceName}] Failed to stop HTTP server gracefully:`, err));
    } else {
        console.log(`[${serviceName}] HTTP server was not started.`);
    }


    // 3. Wait for any currently active data collection runs to complete
    // CollectionLogic.performRun should add its promise to the `activeCollectionRuns` array.
    if (activeCollectionRuns.length > 0) {
        console.log(`[${serviceName}] Waiting for ${activeCollectionRuns.length} active collection runs to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        await Promise.allSettled(activeCollectionRuns);
        console.log(`[${serviceName}] All active collection runs have finished.`);
    } else {
        console.log(`[${serviceName}] No active collection runs to wait for.`);
    }


    // 4. Close connections to external services (Databases, Message Queue, Temporary Storage)
    console.log(`[${serviceName}] Closing external service connections...`);
    if (ConfigService.sequelize) {
        console.log(`[${serviceName}] Closing Config DB connection...`);
        await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        console.log(`[${serviceName}] Config DB connection closed.`);
    }
    // Assuming models.sequelize is the Core Data Model DB connection if used directly
    if (models.sequelize) {
        console.log(`[${serviceName}] Closing Core DB connection...`);
        await models.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Core DB connection:`, err));
        console.log(`[${serviceName}] Core DB connection closed.`);
    }
    if (MqService.connection) {
        console.log(`[${serviceName}] Closing MQ connection...`);
        // It's good practice to close channel(s) before the connection, though connection.close() might handle it.
        // In the worker setup, we only created one channel via MqService.channel.
        if (MqService.channel && !MqService.channel.closed) { // Check if channel exists and is not already closed
             try {
                 await MqService.channel.close();
                 console.log(`[${serviceName}] MQ channel closed.`);
             } catch (err) {
                console.error(`[${serviceName}] Error closing MQ channel:`, err);
             }
        }
        // Attempt to close the connection even if channel closing failed or wasn't needed
        await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
        console.log(`[${serviceName}] MQ connection closed.`);
    }
    if (TemporaryStorage.redisClient) { // Check if redisClient exists on the TemporaryStorage module
       console.log(`[${serviceName}] Closing Redis client connection...`);
       // Assuming TemporaryStorage exports a close method
       await TemporaryStorage.close().catch(err => console.error(`[${serviceName}] Error closing Redis client:`, err));
       console.log(`[${serviceName}] Redis client connection closed.`);
    }
    // TODO: If any connector adapters manage pools or persistent connections (e.g., DB connection pools, LDAP pools),
    // implement a way to signal them to shut down their connections gracefully here.
    // This might involve adding a shutdown method to CollectionLogic or the adapter loader.


    console.log(`[${serviceName}] Graceful shutdown complete.`);
    process.exit(0); // Exit successfully
}


// Optional: Handle uncaught exceptions and unhandled promise rejections
// Log critical errors before potentially exiting
process.on('uncaughtException', (err) => {
    console.error(`[${serviceName}] Uncaught Exception:`, err);
    // TODO: Log this critical error to a centralized logging system (e.g., Sentry, Loggly)
    // In production, it's often best to exit after an uncaught exception to
    // allow the process manager (like PM2, Kubernetes) to restart the service in a clean state.
    // Consider performing graceful shutdown before exiting, but sometimes the error
    // indicates a state where graceful shutdown is not possible.
    // gracefulShutdown().then(() => process.exit(1)).catch(() => process.exit(1)); // Example: attempt shutdown then exit
    // process.exit(1); // Exit immediately after logging the error (common safety measure)
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${serviceName}] Unhandled Rejection at Promise:`, promise, 'reason:', reason);
      // TODO: Log this critical error to a centralized logging system
    // Similar to uncaughtException, exiting might be necessary in production.
    // gracefulShutdown().then(() => process.exit(1)).catch(() => process.exit(1)); // Example: attempt shutdown then exit
    // process.exit(1); // Exit immediately after logging
});