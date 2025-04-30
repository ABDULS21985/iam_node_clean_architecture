// services/identity-collection-service/src/server.js

// Load environment variables from the root .env file
// Adjust path if .env is elsewhere relative to this file's location
require('dotenv').config({ path: '../../../.env' });

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env (IDCS_PORT), default to 4001 if not set
const port = process.env.IDCS_PORT || 4001;
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const cron = require('node-cron'); // For scheduling tasks
const axios = require('axios'); // For making external API calls (e.g., to source systems)

// --- Updated axios-retry import ---
const axiosRetryModule = require('axios-retry'); // Import the module
// Safely get the main function, accounting for .default export
const axiosRetry = axiosRetryModule.default || axiosRetryModule;
// --- End Updated axios-retry import ---

const winston = require('winston'); // Added for structured logging


// --- Internal Modules ---
// Import the main collection logic orchestrator module
const CollectionLogic = require('./collectionLogic');
// Import the temporary storage implementation module (e.g., Redis client)
// Assuming TemporaryStorage is in a shared location, but the original code imported it locally.
// If it's a local implementation unique to IDCS, the path is correct.
// If it's intended to be shared, adjust the path: '../../../shared/temporaryStorage'
const TemporaryStorage = require('./temporaryStorage'); // Keeping original path based on provided code structure


// --- Shared Services and Models ---
// Import shared infrastructure services
const ConfigService = require('../../../shared/configService');
const MqService = require('../../../shared/mqService'); // Using the updated MqService

// Import ALL models needed by collectionLogic or other parts of this service.
// Accessing models via ConfigService.sequelize.models is preferred after ConfigService.init,
// but importing the module here is needed for static properties/types or if not using ConfigService's sequelize instance directly.
// Note: If your Core Data Model DB is separate from the Config DB, you'd need a separate service/initialization for it.
// Assuming here that ConfigService initializes the primary Sequelize instance that includes all models.
const models = require('../../../shared/models'); // Assumed to include models from your core data model DB


// --- Service Configuration ---
// Define the service name for config loading and logging
const serviceName = 'identity-collection-service';
// Object to hold loaded service-specific configurations (like polling interval, connector names)
let serviceConfigs = {};

// --- Scheduling ---
let scheduledTask = null; // Variable to hold the scheduled cron task instance


// --- State Flags ---
let isShuttingDown = false; // Flag to indicate if the service is currently shutting down


// --- Winston Logger Setup ---
// Initialize logger immediately so it's available for axiosRetry and early errors
const logger = winston.createLogger({ // <-- Initialize as const outside async startService
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH-mm-ss' }), // Use hyphens for filename compatibility if logging to files
          winston.format.errors({ stack: true }),
          winston.format.splat(), // Handles interpolation like logger.info('User %s', userId)
          winston.format.json() // Use JSON format for structured logging (recommended for production)
          // Or use a custom printf format for console readability:
          /*
          winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
             const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : ''; // Nicer JSON for console
             return `${timestamp} [${serviceName}] ${level.toUpperCase()}: ${message}${metaString ? '\n' + metaString : ''}${stack ? '\n' + stack : ''}`; // Use serviceName constant
          })
          */
      ),
      defaultMeta: { service: serviceName }, // Use serviceName constant
      transports: [
          new winston.transports.Console({
              format: winston.format.combine(
                  winston.format.colorize(), // Add color to console output
                  // Use custom printf format for console readability and meta data
                  winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
                       const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : ''; // Nicer JSON for console
                       return `${timestamp} [${serviceName}] ${level.toUpperCase()}: ${message}${metaString ? '\n' + metaString : ''}${stack ? '\n' + stack : ''}`; // Use serviceName constant
                  })
              )
          })
          // TODO: Add transports for centralized logging (e.g., File, DailyRotateFile, Syslog, HTTP, dedicated logging service transport)
          // new winston.transports.File({
          //     filename: path.join(__dirname, '../../../../logs/error.log'),
          //     level: 'error',
             // If you want a different file format (e.g., not JSON), define printf here too
             // format: winston.format.combine(
             //     winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
             //     winston.format.errors({ stack: true }),
             //     winston.format.splat(),
             //     winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
             //         const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
             //         return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
             // })
             // )
          // }),
      ],
    });
// Removed the declaration `let logger;` above, as it's now a const initialized immediately.


// --- Configure axios-retry ---
// Apply retry logic to the axios instance for API calls made by this service or modules it uses (like adapters).
// This assumes that external HTTP calls within collectionLogic or its adapters use this shared axios instance.
axiosRetry(axios, {
    retries: 3, // Number of retry attempts
    retryDelay: axiosRetry.ExponentialBackoff, // Use exponential backoff for delays between retries (e.g., 1s, 2s, 4s, ...)
    // Define the condition for retrying a failed request.
    // Retry on network errors or standard retryable errors (typically 5xx status codes).
    retryCondition: (error) => {
        // Only retry if not shutting down
        return !isShuttingDown && (axiosRetry.isNetworkError(error) || axiosRetry.isRetryableError(error) || (error.response && error.response.status === 429)); // Added 429 retry
    },
    onRetry: (retryCount, error, requestConfig) => {
        // Use the initialized logger here
        logger.warn(`Axios Retry: Attempt ${retryCount} failed for ${requestConfig.method?.toUpperCase()} ${requestConfig.url}. Error: ${error.message}`, {
            url: requestConfig.url,
            method: requestConfig.method,
            retryCount: retryCount,
            errorMessage: error.message,
            errorCode: error.code,
            status: error.response?.status
        });
    }
});
logger.info(`Configured axios with retry logic for outgoing HTTP requests.`);


// --- Core Collection Run Orchestration ---
/**
 * Orchestrates a single data collection run by calling the core logic module.
 * This function exists mainly to setup options and handle top-level logging/error reporting
 * before handing off to the detailed logic in CollectionLogic.
 * @param {object} dependencies - Object containing necessary service dependencies.
 * @param {object} dependencies.logger - Logger instance.
 * @param {object} dependencies.serviceConfigs - Service configurations.
 * @param {object} dependencies.configService - ConfigService instance.
 * @param {object} dependencies.mqService - MqService instance.
 * @param {object} dependencies.models - Sequelize models object.
 * @param {object} dependencies.temporaryStorage - TemporaryStorage instance.
 * @param {Set<Promise>} dependencies.activeCollectionRuns - Set to track active run promises.
 */
async function performDataCollectionRun(dependencies) { // Accept dependencies
    const { logger, serviceConfigs, configService, mqService, models, temporaryStorage, activeCollectionRuns } = dependencies; // Destructure dependencies

    // Ensure we don't start a new run if we're trying to shut down
    if (isShuttingDown) {
        logger.warn(`Skipping data collection run because service is shutting down.`);
        return;
    }

    logger.info(`Starting data collection run.`); // Use logger

    // Prepare the options object containing all necessary dependencies for CollectionLogic.performRun
    const runOptions = {
        serviceConfigs: serviceConfigs,    // Service specific configs loaded at startup
        configService: configService,       // The initialized ConfigService instance (for accessing Config DB)
        mqService: mqService,             // The initialized MqService instance (for publishing events)
        models: models,                   // All Sequelize models
        temporaryStorage: temporaryStorage, // The initialized TemporaryStorage implementation module
        logger: logger,                   // Pass logger to CollectionLogic
        // Pass the active collection runs Set so CollectionLogic can add its promise
        // Note: CollectionLogic.performRun *should* add its promise to this Set.
        activeCollectionRunsSet: activeCollectionRuns // Changed name to clarify it's a Set
    };

    let runPromise;
    try {
        // Call the core collection logic function from the separate module.
        // CollectionLogic.performRun *must* return a Promise and ideally add that Promise
        // onto the `runOptions.activeCollectionRunsSet` Set BEFORE yielding/awaiting internally.
        // This allows the shutdown handler to wait for it.
        runPromise = CollectionLogic.performRun(runOptions);

        // Add the run promise to the tracking set *immediately*.
        // This is a safeguard if CollectionLogic doesn't add it internally.
        // If done here, ensure CollectionLogic's promise includes its setup phase.
        // BEST PRACTICE: CollectionLogic.performRun adds its promise to the passed Set *before* any `await`.
        activeCollectionRuns.add(runPromise); // Use Set.add()
        logger.debug(`Added run promise to active tasks set. ${activeCollectionRuns.size} active.`);


        // Wait for the run to complete
        const runResult = await runPromise;

        logger.info(`Data collection run finished with status: ${runResult.status}. Metrics:`, runResult.metrics); // Use logger
        // Note: Detailed error logging for the run is handled within CollectionLogic's finally block updating the log.
        // This block is for logging *that the orchestration completed*.

    } catch (error) {
        // This catch block is mainly for unexpected errors *outside* of performRun's internal handling,
        // e.g., if performRun itself threw an unhandled error before its internal log update,
        // or if an error occurred *before* the promise could be captured/added to the set.
        // If the promise was captured and added, CollectionLogic's internal finally block
        // should handle updating the log and potentially logging the error before rejecting the promise.
        logger.error(`Uncaught error during data collection run orchestration:`, error); // Use logger, log error object
        // TODO: Log this critical failure to a centralized logging system
    } finally {
        // Remove the promise from the activeCollectionRuns Set once it's settled.
        // This assumes CollectionLogic added the promise correctly, or we added it above.
        if (runPromise) {
            activeCollectionRuns.delete(runPromise); // Use Set.delete()
            logger.debug(`Removed completed run promise from active tasks set. ${activeCollectionRuns.size} remaining.`);
        }
    }
}


// --- Scheduling ---
/**
 * Schedules the data collection task using cron based on configurable interval.
 * @param {object} dependencies - Object containing necessary service dependencies for performDataCollectionRun.
 */
async function scheduleDataCollection(dependencies) { // Accept dependencies
    const { logger, serviceConfigs } = dependencies; // Destructure logger and configs

    // Attempt to parse polling interval from serviceConfigs.
    // Config key name 'pollingIntervalMinutes' should be added to the Config Database for this service,
    // associated with serviceName: 'identity-collection-service'.
    const pollingIntervalMinutes = parseInt(serviceConfigs.pollingIntervalMinutes, 10);

    // Validate the polling interval
    if (isNaN(pollingIntervalMinutes) || pollingIntervalMinutes <= 0) {
        logger.warn(`Configured polling interval "${serviceConfigs.pollingIntervalMinutes}" is invalid or <= 0. Skipping scheduler setup.`); // Use logger
        return; // Don't schedule if interval is missing, zero, or negative
    }

    // Use node-cron to schedule the task
    // Cron syntax: '*/${minutes} * * * *' means "at minute 0, N, 2N, etc., every hour, every day"
    const cronSchedule = `*/${pollingIntervalMinutes} * * * *`;
    logger.info(`Scheduling data collection to run every ${pollingIntervalMinutes} minutes (Cron schedule: "${cronSchedule}")`); // Use logger

    // Schedule the task and store the scheduled task instance
    scheduledTask = cron.schedule(cronSchedule, async () => {
        // The function that gets called by cron on schedule
        logger.info(`Cron schedule triggered.`); // Use logger
        // Pass the dependencies needed by performDataCollectionRun
        // We don't await here so that the cron handler itself finishes quickly,
        // allowing the next scheduled time to be calculated correctly,
        // but the actual run logic proceeds in the background.
        // The graceful shutdown handles waiting for the actual run promise via `activeCollectionRuns`.
        performDataCollectionRun(dependencies).catch(err => {
            // Log errors from scheduled runs that might not be caught internally by performRun
            logger.error('Error during scheduled collection run:', err);
        });
    });

    logger.info(`Data collection scheduler started.`); // Use logger
}


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Identity Collection Service.
 */
async function startService() {
    // Logger is already initialized as a const outside this function.

    try {
        logger.info(`Starting service initialization...`);

        // 1. Initialize Configuration Service and load configs for this service
        // This also connects to the Config Database where ConnectorConfigs, MappingConfigs, and Run logs live.
        // ConfigService is expected to initialize its Sequelize instance and potentially sync models needed for config/logging.
        await ConfigService.init();
        logger.info(`ConfigService initialized successfully.`);

        // Load configurations specific to this service (like polling interval, connector names, mapping names)
        // Ensure these configs exist in the Config Database for serviceName: 'identity-collection-service'
        serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);

        // Basic check to ensure critical configs are loaded
        const requiredConfigs = ['identitySourceConnectorName', 'userMappingName', 'pollingIntervalMinutes'];
        const missingConfigs = requiredConfigs.filter(key => serviceConfigs[key] === undefined || serviceConfigs[key] === null);

        if (missingConfigs.length > 0) {
            logger.error(`Missing critical service configurations. Required: ${requiredConfigs.join(', ')}. Missing: ${missingConfigs.join(', ')}. Loaded:`, { serviceConfigs });
            throw new Error(`Missing critical service configurations: ${missingConfigs.join(', ')}`);
        }
        logger.info(`Loaded service configurations.`, { configKeys: Object.keys(serviceConfigs), serviceConfigs }); // Log loaded configs for debugging


        // 2. Initialize Message Queue Service
        // MqService is expected to connect to the broker and create necessary channels/exchanges/queues.
        // MqService should handle its own internal error/close listeners using the logger passed to it.
        await MqService.init(logger); // Pass logger to MqService for its internal logging
        // Wait for MQ channel to be ready before proceeding
        await MqService.waitForChannel();
        logger.info(`Message Queue connected and channel ready.`);


        // 3. Initialize Temporary Storage (e.g., Redis)
        // TemporaryStorage is expected to initialize its client and connect.
        await TemporaryStorage.init(); // Assuming init doesn't need logger or logs internally after init
        logger.info(`Temporary Storage initialized.`);


        // 4. Set up Express server basic routes (e.g., health check)
        // Note: Error routes/middleware can be added here as well
        app.get('/health', (req, res) => {
            // Basic health check - check Config DB connection, MQ status, Temporary Storage status
            const health = {
                status: 'UP', // Assume UP unless critical component is DOWN
                // Check config DB connection state if possible
                configDb: ConfigService.sequelize && ConfigService.isDbConnected ? 'CONNECTED' : 'DISCONNECTED', // Assuming ConfigService has isDbConnected or checks sequelize state
                // Use MqService.isReady getter for MQ status
                mqService: MqService.isReady ? 'CONNECTED' : 'DISCONNECTED',
                // Check Redis status - Assuming TemporaryStorage exposes a ready state or client status
                temporaryStorage: TemporaryStorage.isReady ? 'CONNECTED' : 'DISCONNECTED', // Use isReady getter if available
                // TODO: Add checks for individual service DB if IDCS gets one later (using models.sequelize)
                // coreDb: models.sequelize && models.isDbConnected ? 'CONNECTED' : 'DISCONNECTED', // If models.sequelize is a separate connection
            };

            // Determine overall HTTP status based on component health
            const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.temporaryStorage === 'CONNECTED') ? 200 : 503; // Use 503 Service Unavailable for degraded state

            if (overallStatus !== 200) {
                // Log degraded health status as a warning or error
                logger.warn('Health check reported degraded status.', health);
            } else {
                 // Log successful health status at debug or info level depending on verbosity
                 logger.debug('Health check reported healthy status.', health);
            }

            res.status(overallStatus).json(health);
        });

        // TODO: Add other API endpoints later (e.g., for triggering manual runs, viewing run status - although this might be better handled by a separate API Gateway or Admin Service)


        // 5. Start the Express server listening for incoming requests (like health checks)
        server = app.listen(port, () => { // Capture server instance for graceful shutdown
            logger.info(`Service listening on port ${port}`);
        });


        // 6. Schedule the core data collection process
        // This will read the interval from serviceConfigs and set up the cron job that calls performDataCollectionRun
        // Pass the dependencies needed by performDataCollectionRun, including the activeCollectionRuns Set
        const runDependencies = {
            logger, // Pass the initialized logger
            serviceConfigs,
            configService: ConfigService, // Pass the initialized ConfigService module
            mqService: MqService,       // Pass the initialized MqService module
            models: models,            // Pass the models object
            temporaryStorage: TemporaryStorage, // Pass the initialized TemporaryStorage module
            activeCollectionRuns: activeCollectionRuns // Pass the Set for tracking
        };
        await scheduleDataCollection(runDependencies); // Pass dependencies to scheduler


        // 7. Optionally, trigger an immediate run on startup for testing/initial sync
        // This runs in the background and doesn't block startup completion.
        if (process.env.RUN_ON_STARTUP !== 'false') { // Allow disabling immediate run via env var
             logger.info(`Triggering immediate collection run on startup.`);
             // Call performDataCollectionRun directly, passing dependencies
             performDataCollectionRun(runDependencies).catch(err => {
                 // Log errors from the immediate startup run specifically if not caught internally
                 logger.error('Error during immediate startup collection run:', err);
             });
        } else {
            logger.info(`Immediate collection run on startup disabled via environment variable.`);
        }


        logger.info(`Service initialization complete. Service is ready.`);

    } catch (error) {
        // Catch any errors during the service initialization phase
        // Use the logger if initialized, otherwise fallback to console.error
        const log = logger || console;
        log.error(`Failed to start service.`, error);
        // TODO: Log startup failure to a centralized logging system before exiting
        // Exit process immediately if startup fails
        process.exit(1);
    }
}

// --- Graceful Shutdown Handling ---
// Set to hold promises of active collection runs that need to complete during shutdown.
// CollectionLogic.performRun MUST add its promise to this Set BEFORE any awaits.
const activeCollectionRuns = new Set(); // Changed from Array to Set for better add/delete performance


// Listen for termination signals (e.g., from Docker/Kubernetes stop)
process.on('SIGTERM', async () => {
    // Use logger if available, otherwise fallback to console
    const log = logger || console;
    log.info(`SIGTERM received, starting graceful shutdown.`);
    await gracefulShutdown();
});

// Listen for interrupt signals (e.g., Ctrl+C)
process.on('SIGINT', async () => {
    // Use logger if available, otherwise fallback to console
    const log = logger || console;
    log.info(`SIGINT received, starting graceful shutdown.`);
    await gracefulShutdown();
});

// Graceful shutdown function
async function gracefulShutdown() {
    if (isShuttingDown) {
        const log = logger || console;
        log.warn('Shutdown already in progress.');
        return;
    }
    isShuttingDown = true; // Set the shutdown flag

    // Use logger if initialized, otherwise fallback to console for initial messages
    const log = logger || console;
    log.info(`Starting graceful shutdown...`);

    const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30000; // Max time to wait (default 30 seconds)
    const shutdownStart = Date.now();
    let forceExitTimer;

    // Set a timer to force exit if graceful shutdown takes too long
    forceExitTimer = setTimeout(() => {
        log.error(`Graceful shutdown timed out after ${shutdownTimeout}ms. Forcing exit.`);
        // TODO: Log timeout failure to centralized system
        process.exit(1); // Exit with error code
    }, shutdownTimeout);


    try {
        // 1. Stop the cron scheduler from triggering new runs
        if (scheduledTask) {
            scheduledTask.stop(); // Stop the cron task
            log.info(`Cron scheduler stopped.`);
        } else {
            log.info(`Cron scheduler was not running.`);
        }

        // 2. Stop the Express HTTP server from accepting new connections
        // Existing connections may be allowed to finish depending on Node version/settings
        if (server) {
            log.info('Stopping HTTP server...');
            await new Promise((resolve) => { // Use resolve only, errors are logged but don't halt shutdown
                // The close method stops the server from accepting new connections.
                // Existing connections might continue until they are closed.
                server.close((err) => {
                    if (err) {
                        // Log but don't necessarily reject here if we want to continue with other shutdowns
                        log.error('Error stopping HTTP server:', err.message);
                    } else {
                         log.info('HTTP server stopped.');
                    }
                    resolve(); // Always resolve to continue shutdown process
                });
            });
        } else {
            log.info(`HTTP server was not started.`);
        }


        // 3. Wait for any currently active data collection runs to complete
        // The activeCollectionRuns Set holds promises from performDataCollectionRun.
        if (activeCollectionRuns.size > 0) {
            log.info(`Waiting for ${activeCollectionRuns.size} active collection runs to finish...`);
            // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
            // Add a timeout for waiting to prevent hanging indefinitely
            const processingTimeout = parseInt(process.env.SHUTDOWN_TASK_TIMEOUT_MS, 10) || 30000; // Configurable timeout, default 30s
            const tasksWait = Promise.allSettled(Array.from(activeCollectionRuns)); // Convert Set to Array for allSettled
            const timeoutPromise = new Promise((resolve) => setTimeout(() => {
                 log.warn(`Timeout waiting for active collection runs after ${processingTimeout}ms.`);
                 // Log remaining tasks if timeout occurs
                 if (activeCollectionRuns.size > 0) {
                     log.warn(`Still ${activeCollectionRuns.size} tasks remaining. They will be interrupted by connection closure.`);
                 }
                 resolve(); // Allow shutdown to proceed after timeout warning
            }, processingTimeout));

            await Promise.race([tasksWait, timeoutPromise]); // Wait for tasks OR timeout

            log.info(`Finished waiting for active collection runs.`);
            // Note: Any tasks that timed out will have their promises left in the Set, but we proceed to close connections.
        } else {
            log.info(`No active collection runs to wait for.`);
        }

        // 4. Shut down Message Queue gracefully
        log.info('Initiating MQ service shutdown...');
        try {
            // Use the dedicated shutdown method from MqService
            // This handles closing the channel and connection and prevents reconnects.
            await MqService.shutdown(); // <-- Using MqService.shutdown()
            log.info('MQ service shut down gracefully.');
        } catch (mqShutdownError) {
            log.error('Error during MQ service shutdown:', { error: mqShutdownError.message, stack: mqShutdownError.stack });
            // Log the error but proceed with other shutdowns.
        }


        // 5. Close connections to other external services (Databases, Temporary Storage)
        log.info(`Closing other external connections...`);

        // Create an array of promises for closing all connections
        const connectionClosePromises = [
            // Close Config DB connection (initialized by ConfigService)
            ConfigService.sequelize && ConfigService.sequelize.close ?
                ConfigService.sequelize.close().then(() => log.info('Config DB connection closed.')).catch(err => log.error(`Error closing Config DB connection:`, err.message)) :
                (log.debug('Config DB connection not initialized.'), Promise.resolve()),

            // Close Core Data Model DB connection (if models.sequelize is a separate instance)
            // Assuming models.sequelize is the connection used by the core data models
            // If ConfigService initializes this connection, this might be redundant or need adjustment.
            models.sequelize && models.sequelize.close ?
                models.sequelize.close().then(() => log.info('Core DB connection closed.')).catch(err => log.error(`Error closing Core DB connection:`, err.message)) :
                 (log.debug('Core DB connection not initialized.'), Promise.resolve()),


            // Close Temporary Storage (Redis) client
            // Assuming TemporaryStorage has a close method and isReady getter
            TemporaryStorage.isReady && TemporaryStorage.close ?
                TemporaryStorage.close().then(() => log.info('Temporary Storage (Redis) client closed.')).catch(err => log.error(`Error closing Redis client gracefully:`, err.message)) :
                (log.debug('Temporary Storage (Redis) client not initialized or not ready.'), Promise.resolve()),

            // TODO: If any connector adapters manage pools or persistent connections (e.g., DB connection pools, LDAP pools),
            // implement a way to signal them to shut down their connections gracefully here.
            // This might involve adding a shutdown method to CollectionLogic itself if it manages adapter lifecycle.
            // CollectionLogic.shutdown ? CollectionLogic.shutdown().then(...).catch(...) : Promise.resolve(),
        ];

        // Wait for all connection closure promises to settle
        await Promise.allSettled(connectionClosePromises);

        log.info(`Other external service connections closed.`);


        // Final success log for shutdown
        const duration = Date.now() - shutdownStart;
        log.info(`Graceful shutdown complete in ${duration}ms.`);
        clearTimeout(forceExitTimer); // Clear the force exit timer
        process.exit(0); // Exit successfully

    } catch (shutdownError) {
        // Catch any unexpected errors *during* the shutdown process
        const log = logger || console;
        log.error('Error during graceful shutdown:', shutdownError);
        // TODO: Log shutdown failure to centralized system
        clearTimeout(forceExitTimer); // Clear the force exit timer
        process.exit(1); // Exit with error code
    }
}


// Optional: Handle uncaught exceptions and unhandled promise rejections
// Log critical errors before potentially exiting
process.on('uncaughtException', (err, origin) => {
    // Use logger if initialized, otherwise fallback to console.error
    const log = logger || console;
    log.error('Uncaught Exception.', {
        error: err.message,
        stack: err.stack,
        origin: origin,
        isShuttingDown: isShuttingDown // Add shutdown state to logs
    });

    // In production, it's often best to exit after an uncaught exception,
    // as the application state might be corrupted. Attempt graceful shutdown if possible.
    // Avoid re-triggering shutdown if already in progress.
    if (!isShuttingDown) {
        // Add a slight delay before initiating shutdown to allow logs to flush
        setTimeout(() => gracefulShutdown().catch(() => process.exit(1)), 1000);
    } else {
        // If already shutting down due to another signal/error, just ensure process exits
        log.warn('Uncaught Exception during shutdown. Forcing immediate exit.');
        process.exit(1);
    }
});

// Log unhandled promise rejections and attempt graceful shutdown
process.on('unhandledRejection', (reason, promise) => {
    // Use logger if available, otherwise fallback to console.error
    const log = logger || console;
    log.error('Unhandled Promise Rejection.', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined,
        isShuttingDown: isShuttingDown
        // Optional: log promise details - be careful not to log sensitive info
        // promiseDetails: promise
    });

    // Consider exiting similar to uncaughtException, but depends on application specifics.
    // For a worker service, exiting on unexpected errors is generally safer.
    // Avoid re-triggering shutdown if already in progress.
     if (!isShuttingDown) {
        // Add a slight delay before initiating shutdown to allow logs to flush
        setTimeout(() => gracefulShutdown().catch(() => process.exit(1)), 1000);
    } else {
        log.warn('Unhandled Rejection occurred during shutdown. Forcing immediate exit.');
        process.exit(1);
    }
});


// --- Start the Service ---
// Call the initialization function to start the service
startService();