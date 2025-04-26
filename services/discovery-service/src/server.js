// services/discovery-service/src/server.js

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4006 (example port)
const port = process.env.DISCOVERY_PORT || 4006; // Add DISCOVERY_PORT to your .env
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const cron = require('node-cron'); // For scheduling tasks
// Assuming axios is installed and available for API calls if needed by discoveryLogic or reconciliationLogic
// const axios = require('axios');


// --- Import Shared Services and Models ---
const ConfigService = require('../../../shared/configService'); // Adjust path as needed
const MqService = require('../../../shared/mqService');      // Adjust path as needed
const models = require('../../../shared/models'); // Import all models
// Access models needed directly in this file or passed to logic
// Destructure models needed directly in this file or passed to logic
const { DiscoveryRun, CurrentAppState, Application, ConnectorConfig, MappingConfig, User, ReconciliationResult } = models; // Import models


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


// --- Discovery Run Orchestration (Logic lives in discoveryLogic.js) ---
/**
 * Orchestrates a single discovery run by calling the core logic module.
 * This function is called by the scheduler.
 */
async function performDiscoveryRun() {
    console.log(`[${serviceName}] performDiscoveryRun: Starting scheduled discovery task.`);

    try {
        // Prepare options for the discovery logic module
        const runOptions = {
            serviceConfigs: serviceConfigs, // Service specific configs loaded at startup
            configService: ConfigService,   // Pass the initialized ConfigService
            mqService: MqService,         // Pass the initialized MqService (for publishing events)
            models: models,               // Pass all Sequelize models (incl. DiscoveryRun, CurrentAppState, Application, ConnectorConfig)
            // TODO: Add dependencies like logger, temporary storage (if used by discovery logic)
        };

        // The discoverLogic.performRun function handles logging its own status and publishing MQ triggers
        const runResult = await DiscoveryLogic.performRun(runOptions);

        console.log(`[${serviceName}] performDiscoveryRun: Discovery run finished with status: ${runResult.status}. Metrics:`, runResult.metrics);
        // The discoveryLogic.performRun already published reconciliation trigger if needed
    } catch (error) {
        // This catch block is mainly for unexpected errors *outside* of performRun's internal handling,
        // e.g., if performRun itself threw an unhandled error before updating the log.
        console.error(`[${serviceName}] performDiscoveryRun: Uncaught error during scheduled discovery task orchestration:`, error);
        // TODO: Log this critical failure to a centralized logging system
    }
}


// --- Scheduling Setup ---
/**
 * Schedules the discovery task using cron based on configurable interval.
 */
async function scheduleDiscoveryRuns() {
    // Attempt to parse polling interval from serviceConfigs.
    const discoveryIntervalMinutes = parseInt(serviceConfigs.discoveryIntervalMinutes, 10) || 60; // Default to 60 minutes

    if (discoveryIntervalMinutes <= 0) {
         console.warn(`[${serviceName}] scheduleDiscoveryRuns: Configured discovery interval is ${discoveryIntervalMinutes} minutes (<= 0). Skipping scheduler setup.`);
         return; // Don't schedule if interval is zero or negative
    }

    // Cron syntax: '*/${minutes} * * * *' means "at minute 0, N, 2N, etc., every hour"
    const cronSchedule = `*/${discoveryIntervalMinutes} * * * *`;
    console.log(`[${serviceName}] scheduleDiscoveryRuns: Scheduling discovery runs to run every ${discoveryIntervalMinutes} minutes (Cron schedule: "${cronSchedule}")`);

    // Schedule the task and store the scheduled task instance
    scheduledDiscoveryTask = cron.schedule(cronSchedule, async () => {
        // The function that gets called by cron on schedule
        console.log(`[${serviceName}] Cron schedule triggered.`);
        await performDiscoveryRun(); // Call the orchestrator function
    });

    console.log(`[${serviceName}] Discovery scheduler started.`);
}


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Discovery Service.
 */
async function startService() {
  try {
    console.log(`[${serviceName}] Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    await ConfigService.init();
    console.log(`[${serviceName}] ConfigService initialized successfully.`);

    // --- Add these lines to clear cache ---
    // Construct the cache key exactly as ConfigService does internally
    const serviceCacheKey = `service:${serviceName}`;
    // Check if the specific clearCache function exists and is callable before using it
    if (ConfigService.clearCache && typeof ConfigService.clearCache === 'function') {
         // Assuming clearCache is synchronous as defined in the provided configService.js
         // If clearCache were async, you would add 'await' here.
         ConfigService.clearCache(serviceCacheKey);
         console.log(`[${serviceName}] Cleared ConfigService cache for key: ${serviceCacheKey}`);
    } else {
         // Log a warning if the specific clearCache function isn't available or exported
         console.warn(`[${serviceName}] ConfigService.clearCache(key) not available/exported. Cannot clear specific service cache key '${serviceCacheKey}'. Consider exporting it from configService.js if needed.`);
         // As a fallback, you could clear *all* cache, but this might have wider effects:
         // if (ConfigService.clearAllCache) { ConfigService.clearAllCache(); }
    }
    // --- End Add these lines ---

    // Load configurations specific to this service (now definitely loading from DB if cache was cleared)
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);

    // --- Add this log ---
    // Log the raw configuration object loaded for debugging purposes
    console.log(`[${serviceName}] Loaded raw serviceConfigs:`, JSON.stringify(serviceConfigs, null, 2));
    // --- End Add this log ---

    // **** This is the check that correctly caused the previous error ****
    // Check if the essential 'discoveryIntervalMinutes' configuration is present
    if (!serviceConfigs || serviceConfigs.discoveryIntervalMinutes === undefined || serviceConfigs.discoveryIntervalMinutes === null) {
         // Log error and throw if critical configuration is missing
         console.error(`[${serviceName}] startService: Missing critical service configurations. Need 'discoveryIntervalMinutes'. Loaded:`, serviceConfigs);
         throw new Error("Missing critical service configuration 'discoveryIntervalMinutes'");
    }
    // *********************************************************************
    // Log the loaded configs object (might be slightly redundant now with the raw log above)
    console.log(`[${serviceName}] Loaded service configurations successfully.`);


    // 2. Initialize Message Queue Service and setup channel event listeners
    await MqService.init();
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);

    // Add listeners for critical MQ channel and connection errors
    MqService.channel.on('close', () => console.log(`[${serviceName}] MQ channel closed.`));
    MqService.channel.on('error', (err) => console.error(`[${serviceName}] MQ channel error:`, err));
    MqService.connection.on('close', (err) => console.log(`[${serviceName}] MQ connection closed.`, err));
    MqService.connection.on('error', (err) => console.error(`[${serviceName}] MQ connection error:`, err));
    MqService.connection.on('blocked', (reason) => console.warn(`[${serviceName}] MQ connection blocked:`, reason));
    MqService.connection.on('unblocked', () => console.log(`[${serviceName}] MQ connection unblocked.`));


    // 3. Set up Message Queue Consumer (the Reconciliation Task Worker)
    // This worker will listen for reconciliation triggers published by discovery runs
    await setupReconciliationWorker();
    console.log(`[${serviceName}] Reconciliation Worker setup complete.`);


    // 4. Set up Express server (Optional - for health check)
    // Note: Error routes/middleware can be added here as well
    app.get('/health', (req, res) => {
        const health = {
            status: 'UP',
            configDb: ConfigService.sequelize && ConfigService.sequelize.connectionManager.hasOwnProperty('getConnection') ? 'CONNECTED' : 'DISCONNECTED', // Check config DB connection status
            mqService: MqService.channel ? 'CONNECTED' : 'DISCONNECTED', // Check MQ channel status
            // TODO: Add checks for connectivity to target applications (maybe via pools managed by adapters)
        };
        const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED') ? 200 : 503; // Use 503 Service Unavailable for degraded state
        res.status(overallStatus).json(health);
    });

    // TODO: Add other API endpoints later (e.g., for internal connector management - CRUD Connector/Mapping Configs? Or is this via Admin UI calling a dedicated Config Service?)


    // 5. Start the Express server listening for incoming requests (like health checks)
    server = app.listen(port, () => { // Capture server instance for graceful shutdown
      console.log(`[${serviceName}] Service listening on port ${port}`);
    });


    // 6. Schedule the core data discovery process
    // This will read the interval from serviceConfigs and set up the cron job that calls performDiscoveryRun
    await scheduleDiscoveryRuns();

    // Optionally, trigger an immediate run on startup for testing/initial sync
    // console.log(`[${serviceName}] Triggering immediate discovery run on startup.`);
    // performDiscoveryRun(); // Call without await so startup isn't blocked by first run


    console.log(`[${serviceName}] Service initialization complete.`);

  } catch (error) {
    // Catch any errors during the service initialization phase
    console.error(`[${serviceName}] Failed to start service:`, error);
    // TODO: Log startup failure to a centralized logging system before exiting
    process.exit(1); // Exit process immediately if startup fails
  }
}


// --- Reconciliation Task Worker Setup ---
/**
 * Sets up the Message Queue consumer that acts as the Reconciliation worker.
 * This worker listens to the queue and triggers the reconciliation logic.
 */
async function setupReconciliationWorker() {
    const channel = MqService.channel; // Get the channel after MqService.init and waitForChannel

    if (!channel) {
        throw new Error("MQ Channel not available for Reconciliation Worker setup.");
    }

    try {
        // Declare the exchange published to by discoveryLogic
        await channel.assertExchange(RECONCILIATION_TRIGGERS_EXCHANGE, 'topic', { durable: true });
        console.log(`[${serviceName}] Worker: Exchange "${RECONCILIATION_TRIGGERS_EXCHANGE}" asserted.`);

        // Declare the queue for this worker to consume from
        // Use a durable queue for reliability even if the service restarts.
        const queue = await channel.assertQueue(RECONCILIATION_TASKS_QUEUE, { durable: true });
        console.log(`[${serviceName}] Worker: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the routing key for run completion triggers
        await channel.bindQueue(queue.queue, RECONCILIATION_TRIGGERS_EXCHANGE, RECONCILIATION_TRIGGER_ROUTING_KEY);
        console.log(`[${serviceName}] Worker: Queue "${queue.queue}" bound to exchange "${RECONCILIATION_TRIGGERS_EXCHANGE}" with key "${RECONCILIATION_TRIGGER_ROUTING_KEY}".`);


        // Start consuming messages from the queue and store the consumer tag
        const consumeResult = await channel.consume(queue.queue, async (msg) => {
            if (msg === null) {
                console.log(`[${serviceName}] Worker channel closed by MQ while consuming.`);
                // TODO: Implement robust channel closure handling and re-subscription logic
                return;
            }

            let messagePayload = null;
            let runId = null; // The Discovery Run ID from the message

            // Wrap message processing in an async task that we can track
            const processingTask = (async () => {
                try {
                    // Parse the message payload (expected to be { runId: '...' })
                    messagePayload = JSON.parse(msg.content.toString());
                    runId = messagePayload.runId; // Extract the run ID

                    if (!runId) {
                        console.error(`[${serviceName}] Worker received malformed reconciliation trigger message: Missing runId. Payload:`, messagePayload);
                        channel.nack(msg, false, false); // Reject the message (don't requeue) - it's malformed
                        // TODO: Log malformed message error
                        return; // Exit task processing
                    }

                    console.log(`[${serviceName}] Worker received reconciliation trigger message for run ID: ${runId}`);

                    // --- Call the core reconciliation logic function ---
                    // Pass the runId and necessary dependencies to the logic module
                    const logicOptions = {
                        configService: ConfigService, // Pass the initialized ConfigService
                        mqService: MqService,       // Pass the initialized MqService
                        models: models,             // Pass all Sequelize models
                        serviceConfigs: serviceConfigs // Pass service configs for provisioning API URL etc.
                        // TODO: Add other dependencies like logger, target app connection pools (if reconciliation needs direct app access)
                    };
                   // The performReconciliation function handles its own logging and discrepancy saving
                   await ReconciliationLogic.performReconciliation(runId, logicOptions);


                   // Acknowledge the message only after successful processing by performReconciliation
                   channel.ack(msg);
                   console.log(`[${serviceName}] Worker successfully processed and acknowledged reconciliation trigger for run ID: ${runId}`);

                } catch (error) {
                   // Catch errors that occur *during* the processing of a specific message
                   console.error(`[${serviceName}] Worker error processing reconciliation trigger for run ID ${runId || 'N/A'}:`, error);
                   // Implement robust retry logic using NACK and potentially delayed/dead-letter queues
                   // Nack the message. Setting `requeue: true` sends it back to the queue for a retry.
                   // Need a strategy to prevent infinite retries on persistent errors (e.g., after N attempts, send to dead-letter)
                   channel.nack(msg, false, true); // Reject and requeue for a retry

                   // TODO: Log this processing error properly, potentially with the message payload details
                } finally {
                    // Remove this task's promise from the set of active tasks
                    activeReconciliationTasks.delete(processingTask);
                }
            })(); // Immediately invoke the async processing task

            // Add the promise of this processing task to the set of active tasks
            activeReconciliationTasks.add(processingTask);

        }, {
            noAck: false // Crucial: We will manually acknowledge messages only after successful processing
        });

        reconciliationConsumerTag = consumeResult.consumerTag; // Store the consumer tag
        console.log(`[${serviceName}] Worker started consuming messages from queue "${queue.queue}" with consumer tag "${reconciliationConsumerTag}".`);

    } catch (setupError) {
        console.error(`[${serviceName}] setupReconciliationWorker: Failed to setup Reconciliation Worker:`, setupError);
        // This is a critical startup error - the worker cannot run.
        throw new Error('Failed to setup Reconciliation Worker: ' + setupError.message);
    }
}


// --- Graceful Shutdown Handling ---
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
    if (scheduledDiscoveryTask) {
        scheduledDiscoveryTask.stop(); // Stop the cron task instance
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

    // 3. Stop MQ consumption and wait for any active tasks to finish
    if (MqService.channel && reconciliationConsumerTag) {
        console.log(`[${serviceName}] Cancelling MQ consumer "${reconciliationConsumerTag}"...`);
        try {
            // This tells the MQ broker to stop sending new messages to this consumer
            await MqService.channel.cancel(reconciliationConsumerTag);
            console.log(`[${serviceName}] MQ consumer "${reconciliationConsumerTag}" cancelled.`);
        } catch (err) {
            console.error(`[${serviceName}] Error cancelling MQ consumer "${reconciliationConsumerTag}":`, err);
            // Decide if failure to cancel is critical. Proceeding might lead to processing messages during shutdown.
        }
    } else {
        console.log(`[${serviceName}] MQ consumer was not running.`);
    }

    // Wait for any currently processing reconciliation tasks to complete
    // The activeReconciliationTasks set holds promises from the worker's message handler.
    if (activeReconciliationTasks.size > 0) {
        console.log(`[${serviceName}] Waiting for ${activeReconciliationTasks.size} active reconciliation tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        await Promise.allSettled(activeReconciliationTasks);
        console.log(`[${serviceName}] All active reconciliation tasks have finished.`);
    } else {
        console.log(`[${serviceName}] No active reconciliation tasks to wait for.`);
    }


    // 4. Close connections to external services (Databases, Message Queue)
    console.log(`[${serviceName}] Closing external service connections...`);
    if (ConfigService.sequelize) {
        console.log(`[${serviceName}] Closing Config DB connection...`);
        await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        console.log(`[${serviceName}] Config DB connection closed.`);
    }
    // Assuming models.sequelize is the Core Data Model DB connection if used directly
    if (models.sequelize && models.sequelize !== ConfigService.sequelize) { // Check if different from ConfigService DB
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
    // TODO: If any connector adapters manage pools or persistent connections (e.g., DB connection pools, LDAP pools),
    // implement a way to signal them to shut down their connections gracefully here.
    // This might involve adding a shutdown method to DiscoveryLogic or a dedicated adapter manager.


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
    process.exit(1); // Exit immediately after logging the error (common safety measure)
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${serviceName}] Unhandled Rejection at Promise:`, promise, 'reason:', reason);
     // TODO: Log this critical error to a centralized logging system
    // Similar to uncaughtException, exiting might be necessary in production.
    // gracefulShutdown().then(() => process.exit(1)).catch(() => process.exit(1)); // Example: attempt shutdown then exit
    process.exit(1); // Exit immediately after logging
});


// --- Start the Service ---
// Call the initialization function to start the service
startService();