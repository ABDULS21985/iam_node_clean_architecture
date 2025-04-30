// services/discovery-service/src/server.js

// Load environment variables from the root .env file
// Adjust path if .env is elsewhere relative to this file's location
require('dotenv').config({ path: '../../../.env' });

// --- Database Setup (for local Audit tracking) ---
const { Sequelize } = require('sequelize');
// Assuming your discovery-DB configuration is in shared/config/config.js under a 'discoveryAudit' key
const auditConfig = require('../../../shared/config/config.js').discoveryAudit; // Make sure to add 'discoveryAudit' config block
// Instantiate Sequelize for the local audit database
const auditSequelize = new Sequelize({ ...auditConfig });
// Import and define the CollectionRunsAudit model using the local sequelize instance
// Pass Sequelize.DataTypes instead of the Sequelize class itself in newer versions
const CollectionRunsAudit = require('../../../shared/models/collectionrunsaudit')(auditSequelize, Sequelize.DataTypes);


// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env (DISCOVERY_PORT), default to 4006 (example port)
const port = process.env.DISCOVERY_PORT || 4006; // Add DISCOVERY_PORT to your .env
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const cron = require('node-cron'); // For scheduling tasks
// Assuming axios is installed and available for API calls if needed by discoveryLogic or reconciliationLogic
const axios = require('axios'); // <-- Uncommented axios
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry'); // Import axios-retry module
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // For structured logging


// --- Import Shared Services and Models ---
const ConfigService = require('../../../shared/configService'); // Adjust path as needed
const MqService = require('../../../shared/mqService');      // Adjust path as needed
// Assuming TemporaryStorage is needed by Discovery/Reconciliation logic
const TemporaryStorage = require('../../../shared/temporaryStorage'); // <-- Corrected path (assuming shared)
const models = require('../../../shared/models'); // Import all models (should include User, Application, etc., and potentially CollectionRun model if not local to DiscoveryLogic)


// --- Import Core Service Logic Modules ---
const DiscoveryLogic = require('./discoveryLogic'); // Adjust path if needed
const ReconciliationLogic = require('./reconciliationLogic'); // Adjust path if needed


// --- Service Configuration ---
// Define the service name for config loading and logging
const serviceName = 'discovery-service';
let serviceConfigs = {}; // Object to hold loaded service configurations


// --- Scheduling ---
let scheduledDiscoveryTask = null; // Variable to hold the scheduled cron task instance

// --- Message Queue Configuration ---
// Define Message Queue names for reconciliation tasks triggered by discovery
const RECONCILIATION_TRIGGERS_EXCHANGE = 'reconciliation.triggers'; // Exchange published to by DiscoveryLogic on run completion
const RECONCILIATION_TASKS_QUEUE = 'reconciliation.tasks.queue'; // Queue for reconciliation tasks consumed by this service's worker
const RECONCILIATION_TRIGGER_ROUTING_KEY = 'run.completed'; // Routing key for new tasks published by DiscoveryLogic

// --- Worker State Management ---
let reconciliationConsumerTag = null; // To store the consumer tag for cancelling consumption
const activeReconciliationTasks = new Set(); // Track promises of ongoing reconciliation tasks triggered by MQ
const activeCollectionRuns = new Set(); // <-- NEW: Track promises of ongoing discovery runs triggered by cron

// --- State Flags ---
let isShuttingDown = false; // <-- NEW: Flag for graceful shutdown state

// --- Winston Logger Setup ---
// Initialize logger immediately so it's available for axiosRetry and early errors
const logger = winston.createLogger({ // <-- Initialize as const
      level: process.env.LOG_LEVEL || 'info', // Default to 'info', configurable via env var
      // Apply base formats at the logger level
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }), // Log stack traces
        winston.format.splat(), // Handle %s, %d, %j string interpolation
        // Use JSON format for structured logging (recommended for production)
        winston.format.json()
      ),
      defaultMeta: { service: serviceName }, // Automatically add service name to each log
      transports: [
        // Console transport with colorization and custom printf
        new winston.transports.Console({
          // Apply colorization and printf specifically to the console transport
          format: winston.format.combine(
            winston.format.colorize(), // Apply colors *before* printing
            // Custom printf to include meta data
            winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
                // Access the formatted timestamp and other properties
                // Include meta data if present (stringify objects nicely)
                const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : ''; // Nicer JSON for console
                return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? '\n' + metaString : ''}${stack ? '\n' + stack : ''}`;
            })
          )
        })
        // TODO: Add transports for centralized logging (e.g., ELK, Datadog, file rotation)
        // new winston.transports.File({ filename: path.join(__dirname, '../../../../logs/discovery-error.log'), level: 'error' }),
      ],
    });


// --- Configure axios-retry ---
// Apply retry logic to the axios instance for API calls made by this service or modules it uses (like adapters or ReconciliationLogic).
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


// --- Core Discovery Run Orchestration (Logic lives in discoveryLogic.js) ---
/**
 * Orchestrates a single discovery run by calling the core logic module.
 * This function is called by the scheduler or on startup.
 * @param {object} dependencies - Object containing necessary service dependencies.
 * @param {object} dependencies.logger - Logger instance.
 * @param {boolean} dependencies.isShuttingDown - Shutdown state flag.
 * @param {object} dependencies.serviceConfigs - Service configurations.
 * @param {object} dependencies.configService - ConfigService instance.
 * @param {object} dependencies.mqService - MqService instance.
 * @param {object} dependencies.models - Sequelize models object.
 * @param {object} [dependencies.temporaryStorage] - Optional TemporaryStorage instance.
 * @param {Set<Promise>} dependencies.activeCollectionRuns - Set to track active run promises.
 */
async function performDiscoveryRun(dependencies) { // <-- Accept dependencies
    const { logger, isShuttingDown, serviceConfigs, configService, mqService, models, temporaryStorage, activeCollectionRuns } = dependencies; // <-- Destructure dependencies

    // Ensure we don't start a new run if we're trying to shut down
    if (isShuttingDown) {
        logger.warn(`Skipping discovery run because service is shutting down.`);
        return;
    }

    logger.info(`Attempting to start scheduled discovery task.`);

    let auditRecord = null; // Variable to hold the audit record instance

    try {
        // Create audit row *before* run starts
        auditRecord = await CollectionRunsAudit.create({
          run_id: null, // Will be filled in by DiscoveryLogic or after it returns
          status: 'started', // Initial status
          started_at: new Date()
        });
        logger.info('CollectionRunsAudit record created for new run.', { auditId: auditRecord.id });


        // Prepare options for the discovery logic module
        // Pass dependencies required by DiscoveryLogic.performRun, including the auditId
        const runOptions = {
            logger: logger, // Pass logger
            isShuttingDown: isShuttingDown, // Pass shutdown state
            serviceConfigs: serviceConfigs, // Service specific configs loaded at startup
            configService: configService,   // Pass the initialized ConfigService
            mqService: mqService,         // Pass the initialized MqService (for publishing events)
            models: models,               // Pass all Sequelize models
            temporaryStorage: temporaryStorage, // Pass temporary storage if needed
            auditId: auditRecord.id // <-- Pass the audit record ID to the logic module
            // DiscoveryLogic might need the active runs set if it orchestrates sub-tasks
            // activeCollectionRunsSet: activeCollectionRuns // Optional: Pass set if DiscoveryLogic needs to track sub-tasks
        };

        // Call the core discovery logic function. It handles logging its own status,
        // publishing MQ triggers, and ideally, updating the CollectionRun record in the core DB.
        // It should return { runId, status, metrics } upon completion/resolution.
        const result = await DiscoveryLogic.performRun(runOptions); // <-- Wait for the promise to resolve

        // update audit with run details upon successful completion
        // Assuming DiscoveryLogic returns an object with runId, status, and metrics.
        // Check if auditRecord exists before attempting update (should always exist here)
        if (auditRecord) {
            try {
                await auditRecord.update({
                    run_id: result?.runId || null, // Use optional chaining
                    finished_at: new Date(),
                    status: result?.status || 'completed', // Default to 'completed' if logic doesn't return status
                    metrics: result?.metrics || {} // Default to empty object
                });
                logger.info(`CollectionRunsAudit record updated successfully for run ${result?.runId || 'N/A'}.`, { auditId: auditRecord.id, runId: result?.runId });
            } catch (dbUpdateError) {
                logger.error(`Failed to update CollectionRunsAudit record ${auditRecord.id} after successful DiscoveryLogic run:`, {
                    auditId: auditRecord.id,
                    runResult: result,
                    error: dbUpdateError.message,
                    stack: dbUpdateError.stack
                });
            }
        } else {
            logger.error('CollectionRunsAudit record was not created before DiscoveryLogic run.', { runResult: result });
        }


        logger.info(`Discovery run finished with status: ${result?.status || 'completed'}. Metrics:`, result?.metrics);
        // The discoveryLogic.performRun already published reconciliation trigger if needed

        // Return the result from DiscoveryLogic for tracking if needed
        return result;

    } catch (error) {
        // Catch block handles errors that occur *during* DiscoveryLogic.performRun or before audit creation.
        logger.error(`Error during discovery run orchestration:`, error);

        // Update audit with error details
        if (auditRecord) { // Only update if the audit record was successfully created
            try {
                await auditRecord.update({
                    finished_at: new Date(),
                    status: 'error', // Mark as error
                    error: { message: error.message, stack: error.stack } // Store error details
                });
                logger.error(`CollectionRunsAudit record ${auditRecord.id} marked as error.`, { auditId: auditRecord.id });
            } catch (dbUpdateError) {
                logger.error(`Failed to update CollectionRunsAudit record ${auditRecord.id} after DiscoveryLogic run error:`, {
                    auditId: auditRecord.id,
                    error: dbUpdateError.message,
                    stack: dbUpdateError.stack
                });
            }
        } else {
            logger.error('CollectionRunsAudit record was not created before DiscoveryLogic run error.', error);
        }

        // Re-throw the error so it's caught by the caller (scheduler or startup trigger)
        throw error;

    } finally {
        // Removal from activeCollectionRuns Set happens in the caller's logic or within the IIAFE if performRun was wrapped.
        // In this structure, performDiscoveryRun *is* the async task that the caller (`scheduleDiscoveryRuns` or `startService` immediate run) awaits or tracks.
        // The caller is responsible for adding/removing the promise returned by performDiscoveryRun from its tracking set.
        // So, the finally block here is for cleanup *within* the performDiscoveryRun logic itself if needed.
        // Since we added the promise in the caller, we don't delete it *here*.
    }
}


// --- Scheduling Setup ---
/**
 * Schedules the discovery task using cron based on configurable interval.
 * @param {object} dependencies - Dependencies for performDiscoveryRun.
 */
async function scheduleDiscoveryRuns(dependencies) { // <-- Accept dependencies
    // Attempt to parse polling interval from serviceConfigs.
    const discoveryIntervalMinutes = parseInt(dependencies.serviceConfigs.discoveryIntervalMinutes, 10); // <-- Get from dependencies

    // Validate the polling interval
    if (isNaN(discoveryIntervalMinutes) || discoveryIntervalMinutes <= 0) {
        logger.warn(`Configured discovery interval "${dependencies.serviceConfigs.discoveryIntervalMinutes}" is invalid or <= 0. Skipping scheduler setup.`); // <-- Use logger, get from dependencies
        return; // Don't schedule if interval is zero or negative
    }

    // Cron syntax: '*/${minutes} * * * *' means "at minute 0, N, 2N, etc., every hour"
    const cronSchedule = `*/${discoveryIntervalMinutes} * * * *`;
    logger.info(`Scheduling discovery runs to run every ${discoveryIntervalMinutes} minutes (Cron schedule: "${cronSchedule}")`); // <-- Use logger

    // Schedule the task and store the scheduled task instance
    scheduledDiscoveryTask = cron.schedule(cronSchedule, async () => {
        // The function that gets called by cron on schedule
        logger.info(`Cron schedule triggered.`); // <-- Use logger
        // Check shutdown flag before running
        if (isShuttingDown) { // <-- Check shutdown flag
            logger.warn(`Skipping scheduled discovery run due to shutdown.`); // <-- Use logger
            return;
        }
        // Call the orchestrator function, pass dependencies
        // We don't await here so the cron job handler returns quickly.
        // The graceful shutdown handles waiting for the actual run promise via `activeCollectionRuns`.
        const runPromise = performDiscoveryRun(dependencies); // <-- Capture the promise returned by performDiscoveryRun
        // Add the promise to the active tasks set managed by the caller (this scheduler)
        activeCollectionRuns.add(runPromise);
        // Remove the promise from the set when it settles (resolves or rejects)
        runPromise.finally(() => {
            activeCollectionRuns.delete(runPromise);
            // logger.debug(`Scheduled run promise removed. Active: ${activeCollectionRuns.size}`); // Optional debug
        });

    }).catch(err => { // Catch errors during the cron task itself (e.g., if cron scheduling fails)
        logger.error('Error scheduling cron task:', err); // <-- Use logger
    });

    logger.info(`Discovery scheduler started.`); // <-- Use logger
}


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Discovery Service.
 */
async function startService() {
    // Logger is already initialized as a const outside this function.

  try {
    logger.info(`Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    await ConfigService.init();
    logger.info(`ConfigService initialized successfully.`);

    // Load configurations specific to this service
    // Clear cache for service configs on startup (optional but safer if configs change)
    // Using a standard key format assuming ConfigService provides this.
    const serviceConfigCacheKey = ConfigService.mappingCacheKey(serviceName, 'Service', 'Service', serviceName, null);
    if (ConfigService.clearCache && typeof ConfigService.clearCache === 'function') {
        ConfigService.clearCache(serviceConfigCacheKey);
        logger.debug(`Cleared ConfigService cache for key: ${serviceConfigCacheKey}`);
    } else {
        logger.warn(`ConfigService.clearCache(key) not available/exported. Cannot clear specific service cache key '${serviceConfigCacheKey}'.`);
    }

    // Load configurations specific to this service (now definitely loading from DB if cache was cleared)
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);

    // Check if the essential 'discoveryIntervalMinutes' configuration is present
    if (!serviceConfigs || serviceConfigs.discoveryIntervalMinutes === undefined || serviceConfigs.discoveryIntervalMinutes === null) {
        logger.error(`Missing critical service configurations. Need 'discoveryIntervalMinutes'. Loaded:`, serviceConfigs);
        throw new Error("Missing critical service configuration 'discoveryIntervalMinutes'");
    }
    logger.info(`Loaded service configurations.`, { configKeys: Object.keys(serviceConfigs), serviceConfigs }); // Log loaded configs for debugging


    // 2. Initialize Message Queue Service
    // Pass logger to MqService for its internal logging and robust handling
    await MqService.init(logger); // <-- Passed logger
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    logger.info(`Message Queue connected and channel ready.`);

    // MqService should add its own listeners for critical channel and connection errors internally using the logger it received.
    // Removed redundant console listeners here.


    // 3. Initialize Temporary Storage (Redis)
    // Assume TemporaryStorage is needed by Discovery/Reconciliation logic
    await TemporaryStorage.init(); // Assuming TemporaryStorage also takes logger or logs internally after init
    logger.info('Temporary Storage initialized.');

    // 4. Initialize local Audit DB connection and sync model
    await auditSequelize.authenticate();
    logger.info('Local Audit DB connection authenticated.');
    // Sync the CollectionRunsAudit model - creates the table if it doesn't exist
    await CollectionRunsAudit.sync(); // no-op if table already exists
    logger.info('CollectionRunsAudit table ensured in local DB.');


    // 5. Set up Message Queue Consumer (the Reconciliation Task Worker)
    // This worker will listen for reconciliation triggers published by discovery runs
    await setupReconciliationWorker(); // Will store consumer tag and track tasks internally
    logger.info(`Reconciliation Worker setup complete and consuming messages.`);


    // 6. Set up Express server (Optional - for health check)
    app.get('/health', async (req, res) => { // Made async for potential API checks
        // Basic health check - check Config DB connection, MQ status, Temporary Storage status, Reconciliation worker status, Scheduler status
        const health = {
            status: 'UP', // Assume UP unless critical component is DOWN
            // Check Config DB connection state if possible
            configDb: ConfigService.sequelize && ConfigService.isDbConnected ? 'CONNECTED' : 'DISCONNECTED', // Assuming ConfigService has isDbConnected
            // Check local Audit DB status
            auditDb: auditSequelize && auditSequelize.authenticate ? (await auditSequelize.authenticate().then(() => 'CONNECTED').catch(() => 'DISCONNECTED')) : 'UNKNOWN', // Check connection state if possible

            // Use MqService.isReady getter for MQ status
            mqService: MqService.isReady ? 'CONNECTED' : 'DISCONNECTED',
            // Check Redis status - Assuming TemporaryStorage exposes isReady getter
            temporaryStorage: TemporaryStorage.isReady ? 'CONNECTED' : 'DISCONNECTED',
            // Check if reconciliation worker consumer is active (consumer tag set and MQ ready)
            reconciliationWorker: (!!reconciliationConsumerTag && MqService.isReady) ? 'ACTIVE' : 'INACTIVE', // Check reconciliationConsumerTag
             // Check if scheduler is active (task instance exists)
             discoveryScheduler: !!scheduledDiscoveryTask ? 'ACTIVE' : 'INACTIVE', // Check scheduledDiscoveryTask
             // TODO: Add checks for connectivity to target applications/Provisioning API if applicable (similar to worker services)
             // provisioningApi: provisioningApiStatus, // If ReconciliationLogic calls Provisioning
        };

        // Determine overall HTTP status based on component health
        // Critical components: Config DB, Audit DB, MQ Service, Reconciliation Worker (to process triggers), Scheduler (to generate triggers), Temp Storage
        const overallStatus = (health.configDb === 'CONNECTED' && health.auditDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.reconciliationWorker === 'ACTIVE' && health.discoveryScheduler === 'ACTIVE' && health.temporaryStorage === 'CONNECTED') ? 200 : 503; // <-- Include audit DB, worker, scheduler, temp storage

        if (overallStatus !== 200) {
            logger.warn('Health check reported degraded status.', health);
        } else {
            logger.debug('Health check reported healthy status.', health); // Use debug for frequent healthy checks
        }
        res.status(overallStatus).json(health);
    });

    // 6. Start the Express server listening for incoming requests (like health checks)
    server = app.listen(port, () => { // Capture server instance for graceful shutdown
      logger.info(`Service listening on port ${port}`);
    });


    // 7. Schedule the core data discovery process
    // Pass the dependencies needed by performDiscoveryRun, including the activeCollectionRuns Set
    const discoveryRunDependencies = { // <-- Create dependencies object
        logger,
        isShuttingDown, // Pass shutdown state
        serviceConfigs,
        configService: ConfigService,
        mqService: MqService,
        models: models,
        temporaryStorage: TemporaryStorage, // Pass temporary storage
        activeCollectionRuns: activeCollectionRuns // Pass the Set for tracking
    };
    await scheduleDiscoveryRuns(discoveryRunDependencies); // <-- Pass dependencies

    // Optionally, trigger an immediate run on startup for testing/initial sync
    if (process.env.RUN_ON_STARTUP !== 'false') { // Allow disabling immediate run via env var
        logger.info(`Triggering immediate discovery run on startup.`);
        // Call performDiscoveryRun directly, passing dependencies
        // We don't await here so startup isn't blocked by first run.
        const immediateRunPromise = performDiscoveryRun(discoveryRunDependencies); // Capture the promise
        // Track this immediate run promise for graceful shutdown
        activeCollectionRuns.add(immediateRunPromise);
        immediateRunPromise.finally(() => { // Remove from set when it settles
            activeCollectionRuns.delete(immediateRunPromise);
            // logger.debug(`Immediate run promise removed. Active: ${activeCollectionRuns.size}`); // Optional debug
        });

    } else {
        logger.info(`Immediate discovery run on startup disabled via environment variable.`);
    }


    logger.info(`Service initialization complete. Service is ready.`);

  } catch (error) {
    // Catch any errors during the service initialization phase
    const log = logger || console; // Use logger if initialized, otherwise fallback
    log.error(`Failed to start service.`, error);
    // TODO: Log startup failure to a centralized logging system before exiting
    process.exit(1); // Exit process immediately if startup fails
  }
}


// --- Reconciliation Task Worker Setup ---
/**
 * Sets up the Message Queue consumer that acts as the Reconciliation worker.
 * This worker listens to the queue and triggers the reconciliation logic.
 * Uses MqService.subscribe to manage the consumer robustly.
 */
async function setupReconciliationWorker() {
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Declare the exchange published to by discoveryLogic using MqService method
        await MqService.assertExchange(RECONCILIATION_TRIGGERS_EXCHANGE, 'topic', { durable: true });
        logger.info(`Worker: Exchange "${RECONCILIATION_TRIGGERS_EXCHANGE}" asserted.`); // <-- Use logger

        // Declare the queue for this worker to consume from using MqService method
        // Use a durable queue for reliability even if the service restarts.
        const queue = await MqService.assertQueue(RECONCILIATION_TASKS_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Worker: Queue "${queue.queue}" asserted.`); // <-- Use logger

        // Bind the queue to the exchange using the routing key for run completion triggers using MqService method
        await MqService.bindQueue(queue.queue, RECONCILIATION_TRIGGERS_EXCHANGE, RECONCILIATION_TRIGGER_ROUTING_KEY);
        logger.info(`Worker: Queue "${queue.queue}" bound to exchange "${RECONCILIATION_TRIGGERS_EXCHANGE}" with key "${RECONCILIATION_TRIGGER_ROUTING_KEY}".`); // <-- Use logger


        // Start consuming messages from the queue using MqService.subscribe
        // MqService.subscribe manages the channel.consume call and consumer tag internally,
           // and handles re-establishing the consumer if the channel/connection is lost and restored.
        const consumeResult = await MqService.subscribe(queue.queue, async (msg) => { // <-- Use MqService.subscribe
             // Check for null message which indicates consumer cancellation or channel closure
             if (msg === null) {
                 logger.warn('Worker: Consume callback received null message, indicating consumer cancellation or channel closure by MQ.'); // <-- Use logger
                 // MqService reconnection should handle re-establishing the consumer if needed
                 return; // Exit this specific message processing handler instance
             }

            // If service is shutting down, do not process new messages even if received before cancellation signal fully propagated.
            if (isShuttingDown) { // <-- Check shutdown flag
                logger.warn(`Worker: Skipping message processing due to service shutdown. Message delivery tag: ${msg.fields.deliveryTag}`); // <-- Use logger
                // Decide how to handle messages received during shutdown. NACK without requeue is an option.
                // The cancelConsumer should handle pending messages, but this is a safeguard.
                try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK message during shutdown:', { deliveryTag: msg.fields.deliveryTag, nackErr: nackErr.message }); }
                return; // Stop processing this message
            }

            let messagePayload = null;
            let runId = null; // The Discovery Run ID from the message
            const deliveryTag = msg.fields.deliveryTag; // <-- Capture delivery tag
            const correlationId = msg.properties.correlationId; // <-- Capture correlation id


            // Wrap message processing in an async task that we can track for graceful shutdown
            const processingTask = (async () => { // <-- IIAFE pattern
                try {
                    // Parse the message payload (expected to be { runId: '...' })
                    try {
                         messagePayload = JSON.parse(msg.content.toString());
                     } catch (parseError) {
                          logger.error('Worker received message with invalid JSON payload.', { deliveryTag, correlationId, parseError: parseError.message, payload: msg.content.toString() }); // <-- Use logger
                          // NACK malformed messages (don't requeue)
                          try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK malformed message:', { deliveryTag, nackErr: nackErr.message }); } // <-- Use logger, optional chaining
                          return; // Exit task processing
                     }

                    runId = messagePayload.runId; // Extract the run ID

                    if (!runId) {
                        logger.error(`Worker received malformed reconciliation trigger message: Missing runId. Payload:`, { deliveryTag, correlationId, payload: messagePayload }); // <-- Use logger
                        // NACK malformed messages (don't requeue)
                        try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK malformed message:', { deliveryTag, nackErr: nackErr.message }); } // <-- Use logger, optional chaining
                        return; // Exit task processing
                    }

                    logger.info(`Worker received reconciliation trigger message for run ID: ${runId}`, { runId, deliveryTag, correlationId }); // <-- Use logger

                    // --- Call the core reconciliation logic function ---
                    // Pass the runId and necessary dependencies to the logic module
                    const logicOptions = { // <-- Create logic options object
                        logger: logger, // <-- Pass logger
                        isShuttingDown: isShuttingDown, // <-- Pass shutdown state
                        configService: ConfigService, // Pass the initialized ConfigService
                        mqService: MqService,       // Pass the initialized MqService
                        models: models,             // Pass all Sequelize models (should include Discrepancy model)
                        serviceConfigs: serviceConfigs, // Pass service configs for provisioning API URL etc.
                        temporaryStorage: TemporaryStorage, // Pass temporary storage if needed
                        // TODO: Add other dependencies like target app connection pools (if reconciliation needs direct app access)
                    };
                   // The performReconciliation function handles its own logging and discrepancy saving.
                   await ReconciliationLogic.performReconciliation(runId, logicOptions);


                   // Acknowledge the message only after successful processing by performReconciliation
                   try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Worker: Failed to ack message after successful processing:', { deliveryTag, correlationId, runId, ackErr: ackErr.message }); } // <-- Use logger, optional chaining
                   logger.info(`Worker successfully processed and acknowledged reconciliation trigger for run ID: ${runId}`, { runId, deliveryTag, correlationId }); // <-- Use logger

                } catch (error) {
                   // Catch any errors that occur *during* the processing of a specific message (after payload validation)
                   logger.error(`Worker error processing reconciliation trigger for run ID ${runId || 'N/A'}:`, {
                      deliveryTag: deliveryTag, // <-- Use captured delivery tag
                      correlationId: correlationId, // <-- Use captured correlation id
                      runId: runId || 'N/A', // Include run ID if known
                      error: error.message,
                      stack: error.stack, // Log the stack trace
                      // payload: messagePayload // Optional: Log the full payload on error, be mindful of sensitive data
                  });

                  // Implement robust retry logic using NACK and potentially delayed/dead-letter queues
                  // Nack the message. Setting `requeue: false` means the broker will not send it back to the queue immediately.
                  // It will go to a dead-letter exchange/queue if configured, which is the correct pattern for retries.
                  // If NACK fails, just log and move on.
                  try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK message after processing error:', { deliveryTag, correlationId, runId: runId || 'N/A', nackErr: nackErr.message }); } // <-- Use logger, optional chaining
                  // TODO: Log this processing error properly, potentially store failure details for reporting or manual review via DLQ.
                } finally {
                    // Remove this task's promise from the set of active tasks
                    activeReconciliationTasks.delete(processingTask); // <-- Use Set.delete()
                    logger.debug(`Worker: Task for message ${deliveryTag} finished. Active tasks remaining: ${activeReconciliationTasks.size}`, { deliveryTag }); // <-- Use logger
                }
            })(); // Immediately invoke the async processing task

            // Add the promise of this processing task to the set of active tasks
            activeReconciliationTasks.add(processingTask); // <-- Use Set.add()

        }, {
            noAck: false // Crucial: We will manually acknowledge messages only after successful processing
        });

        reconciliationConsumerTag = consumeResult.consumerTag; // Store the consumer tag returned by MqService.subscribe
        logger.info(`Worker started consuming messages from queue "${queue.queue}" with consumer tag "${reconciliationConsumerTag}".`); // <-- Use logger

    } catch (setupError) {
        logger.error(`setupReconciliationWorker: Failed to setup Reconciliation Worker:`, setupError); // <-- Use logger
        // This is a critical startup error - the worker cannot run.
        throw new Error('Failed to setup Reconciliation Worker: ' + setupError.message);
    }
}


// --- Graceful Shutdown Handling ---
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
        if (scheduledDiscoveryTask) {
            scheduledDiscoveryTask.stop(); // Stop the cron task instance
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
        }


        // 3. Stop the Reconciliation worker consumer from receiving NEW messages
        if (reconciliationConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
            log.info(`Attempting to cancel MQ consumer "${reconciliationConsumerTag}"...`);
            try {
                // Use MqService method to cancel the consumer. It handles channel checks internally.
                await MqService.cancelConsumer(reconciliationConsumerTag); // <-- Use MqService method
                log.info(`MQ consumer "${reconciliationConsumerTag}" cancelled.`);
                // Note: MqService should manage the state of the consumer internally, no need to nullify reconciliationConsumerTag here.
            } catch (err) {
                // cancelConsumer should log its own errors, but log here too if needed.
                log.error(`Error cancelling MQ consumer "${reconciliationConsumerTag}". It might have already been cancelled or channel closed.`, {
                    consumerTag: reconciliationConsumerTag, error: err.message, stack: err.stack
                });
            }
        } else {
            log.warn('Reconciliation worker consumer not active (no consumer tag) or MqService not fully initialized. Skipping consumer cancellation.');
        }

        // 4. Wait for any currently processing tasks (Discovery runs & Reconciliation tasks) to finish
        const totalActiveTasks = activeCollectionRuns.size + activeReconciliationTasks.size;
        if (totalActiveTasks > 0) {
            log.info(`Waiting for ${totalActiveTasks} active tasks (Discovery runs: ${activeCollectionRuns.size}, Reconciliation tasks: ${activeReconciliationTasks.size}) to finish...`);

            // Combine promises from both sets of active tasks
            const allActiveTaskPromises = [
                ...Array.from(activeCollectionRuns), // Convert Set to Array
                ...Array.from(activeReconciliationTasks) // Convert Set to Array
            ];

            const processingTimeout = parseInt(process.env.SHUTDOWN_TASK_TIMEOUT_MS, 10) || 30000; // Configurable timeout, default 30s
            const tasksWait = Promise.allSettled(allActiveTaskPromises); // Wait for all promises to settle (either fulfill or reject)

            // Add a timeout for waiting to prevent hanging indefinitely
            const timeoutPromise = new Promise((resolve) => setTimeout(() => {
                 log.warn(`Timeout waiting for active tasks after ${processingTimeout}ms.`);
                 // Log remaining tasks if timeout occurs
                 const remaining = activeCollectionRuns.size + activeReconciliationTasks.size;
                 if (remaining > 0) {
                     log.warn(`Still ${remaining} tasks remaining. They will be interrupted by connection closure.`);
                 }
                 resolve(); // Allow shutdown to proceed after timeout warning
            }, processingTimeout));

            await Promise.race([tasksWait, timeoutPromise]); // Wait for tasks OR timeout

            log.info(`Finished waiting for active tasks.`);
            // Note: Any tasks that timed out will have their promises left in the Sets, but we proceed to close connections.
            // Closing MQ connections will interrupt any tasks still waiting for acks/nacks.
        } else {
            log.info(`No active tasks to wait for.`);
        }


        // 5. Shut down Message Queue gracefully
        log.info('Initiating MQ service shutdown...');
        try {
            // Use the dedicated shutdown method from MqService
            // This handles cancelling consumers (if not already done), closing the channel, and closing the connection,
            // and prevents reconnects.
            await MqService.shutdown(); // <-- Using MqService.shutdown()
            log.info('MQ service shut down gracefully.');
        } catch (mqShutdownError) {
            log.error('Error during MQ service shutdown:', { error: mqShutdownError.message, stack: mqShutdownError.stack });
            // Log the error but proceed with other shutdowns.
        }


        // 6. Close connections to other external services (Databases, Temporary Storage)
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
            models.sequelize && models.sequelize !== ConfigService.sequelize && models.sequelize.close ? // Check if models.sequelize exists, is different from ConfigService's, and has close method
                models.sequelize.close().then(() => log.info('Core DB connection closed.')).catch(err => log.error(`Error closing Core DB connection:`, err.message)) :
                 (log.debug('Core DB connection not initialized or is same as Config DB.'), Promise.resolve()),

            // Close Local Audit DB connection
            auditSequelize && auditSequelize.close ?
                auditSequelize.close().then(() => log.info('Local Audit DB connection closed.')).catch(err => log.error(`Error closing Local Audit DB connection:`, err.message)) :
                (log.debug('Local Audit DB connection not initialized.'), Promise.resolve()), // <-- Added Local Audit DB close


            // Close Temporary Storage (Redis) client
            // Assuming TemporaryStorage has a close method and isReady getter
            TemporaryStorage.isReady && TemporaryStorage.close ?
                TemporaryStorage.close().then(() => log.info('Temporary Storage (Redis) client closed.')).catch(err => log.error(`Error closing Redis client gracefully:`, err.message)) :
                (log.debug('Temporary Storage (Redis) client not initialized or not ready.'), Promise.resolve()),

            // TODO: If any connector adapters manage pools or persistent connections (e.g., DB connection pools, LDAP pools),
            // implement a way to signal them to shut down their connections gracefully here.
            // This might involve adding a shutdown method to DiscoveryLogic or a dedicated adapter manager.
            // DiscoveryLogic.shutdownConnections ? DiscoveryLogic.shutdownConnections().catch(...) : Promise.resolve(),
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
        const log = logger || console; // Use logger if initialized, otherwise fallback
        log.error('Error during graceful shutdown:', shutdownError);
        // TODO: Log shutdown failure to centralized system
        clearTimeout(forceExitTimer); // Clear the force exit timer
        process.exit(1); // Exit with error code
    }
}


// --- Global Error Handling ---
// Log uncaught exceptions and attempt graceful shutdown
process.on('uncaughtException', (err, origin) => {
    // Use logger if available, otherwise fallback to console.error
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
        log.warn('Uncaught Exception occurred during shutdown. Forcing immediate exit.');
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