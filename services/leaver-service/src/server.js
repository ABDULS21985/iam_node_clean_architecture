// services/leaver-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env') // Assuming .env is in the root directory
});

// Import Sequelize and our model
const { sequelize, LeaveRequest } = require('./models');


// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env (LEAVER_PORT), default to 4004
const port = process.env.LEAVER_PORT || 4004;
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry');
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // Added for structured logging


// --- Import Shared Services and Modules ---
const ConfigService = require('../../../shared/configService');
const MqService = require('../../../shared/mqService'); // Using the updated MqService
// Correct the import path for TemporaryStorage assuming it's in a shared location
const TemporaryStorage = require('../../../shared/temporaryStorage'); // <-- CORRECTED IMPORT PATH

// Define the service name for config loading and logging
const serviceName = 'leaver-service';
let serviceConfigs = {}; // Object to hold loaded service configurations


// --- Message Queue Configuration ---
// Define Message Queue details for consuming Leaver events
const IDENTITY_CHANGES_EXCHANGE = 'identity.changes'; // Exchange published to by ICS
const LEAVER_QUEUE = 'leaver.events.queue'; // Queue specific to the Leaver service
const LEAVER_ROUTING_KEY = 'leaver.exit'; // Routing key for leaver events published by ICS


// --- Worker State Management ---
let leaverConsumerTag = null; // To store the consumer tag for cancelling consumption during shutdown
const activeLeaverProcessingTasks = new Set(); // Track promises of ongoing message processing tasks for shutdown
let isShuttingDown = false; // Flag for graceful shutdown state


// --- Setup Structured Logger (Winston Example) ---
// Initialize logger immediately so it's available for axiosRetry and early errors
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info', // Default to 'info', configurable via env var
    // Apply base formats at the logger level
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }), // Log stack traces
        winston.format.splat(), // Handle %s, %d, %j string interpolation
        winston.format.json() // Recommended for production for parsing
    ),
    defaultMeta: { service: serviceName }, // Automatically add service name to each log
    transports: [
        // Console transport with colorization and custom printf for readability
        new winston.transports.Console({
            // Apply colorization and printf specifically to the console transport
            format: winston.format.combine(
                winston.format.colorize(), // Apply colors *before* printing
                winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
                    // Access the formatted timestamp and other properties
                    // Include meta data if present (stringify objects nicely)
                    const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : ''; // Nicer JSON formatting
                    return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? '\n' + metaString : ''}${stack ? '\n' + stack : ''}`;
                })
            )
        })
        // TODO: Add transports for centralized logging (e.g., ELK, Datadog, file rotation)
        // Example File transport (without colorization, standard format applied at logger level)
        // new winston.transports.File({
        //     filename: path.join(__dirname, '../../../../logs/leaver-error.log'),
        //     level: 'error',
        // }),
    ],
});

logger.info('Logger initialized.');

// --- Configure axios-retry ---
// Apply retry logic to the axios instance for API calls to external services (like Provisioning Service)
axiosRetry(axios, {
    retries: 3, // Number of retry attempts
    retryDelay: axiosRetry.ExponentialBackoff, // Use exponential backoff for delays between retries
    // retryCondition is optional, default is to retry on network errors and 5xx status codes.
    // You might want to add specific 4xx codes like 429 (Too Many Requests) if your API returns them.
    retryCondition: (error) => {
        // Only retry if not shutting down
        return !isShuttingDown && (axiosRetry.isNetworkError(error) || axiosRetry.isRetryableError(error) || (error.response && error.response.status === 429));
    },
    onRetry: (retryCount, error, requestConfig) => {
        // Log details on each retry attempt using the logger
        logger.warn(`Axios Retry: Attempt ${retryCount} failed for ${requestConfig.method?.toUpperCase()} ${requestConfig.url}. Error: ${error.message}`, {
            url: requestConfig.url,
            method: requestConfig.method,
            retryCount: retryCount,
            errorMessage: error.message,
            // Optionally log error code or status if available
            errorCode: error.code,
            status: error.response?.status
        });
    }
});
logger.info('Configured axios with retry logic.');

// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Leaver Service.
 */
async function startService() {
    try {
        logger.info('Starting service initialization...');

        // 0️⃣ Initialize DB connection and sync models
        await sequelize.authenticate();
        logger.info('Leaver DB connection authenticated.');
        // We only defined LeaveRequest; sync it without dropping
        await LeaveRequest.sync();
        logger.info('LeaveRequest table ensured in DB.');


        // 1. Initialize Configuration Service
        await ConfigService.init();
        logger.info('ConfigService initialized successfully.');

        // Load service-specific configurations
        // Clear cache for service configs on startup (optional but safer if configs change)
        const serviceConfigCacheKey = ConfigService.mappingCacheKey(serviceName, 'Service', 'Service', serviceName, null); // Using mappingCacheKey for consistency
        ConfigService.clearCache(serviceConfigCacheKey);
        serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);

        if (!serviceConfigs || typeof serviceConfigs.provisioningServiceApiUrl !== 'string' || !serviceConfigs.provisioningServiceApiUrl) {
            logger.error('Missing critical service configuration: provisioningServiceApiUrl.', { loadedConfigs: serviceConfigs });
            throw new Error("Missing critical service configuration 'provisioningServiceApiUrl'");
        }
        // Avoid logging sensitive URLs directly - just confirm existence
        logger.info('Loaded service configurations.', { provisioningUrlConfigured: !!serviceConfigs.provisioningServiceApiUrl });


        // 2. Initialize Message Queue Service
        // Pass the logger instance to MqService init
        await MqService.init(logger); // <-- Passed logger
        // Wait for MQ channel to be ready for operations before setting up consumer
        await MqService.waitForChannel();
        logger.info('Message Queue connected and channel ready.');

        // 3. Initialize Temporary Storage (Redis) - Leaver Service might use it if tracking tasks across restarts
        // Although not strictly necessary for the basic consume/provision pattern,
        // keeping this consistent with other services that might need it.
        // Remove this block if Leaver Service explicitly does not require temporary storage.
        await TemporaryStorage.init(); // Assuming init doesn't need logger or uses MqService's (less likely)
        logger.info('Temporary Storage initialized.');


        // 4. Set up Message Queue Consumer
        await setupLeaverEventListener(); // Will start consuming messages
        logger.info('Leaver Event Listener setup complete and consuming messages.');

        // 5. Set up Express server
        app.get('/health', async (req, res) => { // Make health check async if it needs to await checks
            // Basic health check - check Config DB connection, MQ status, potentially Provisioning API reachability
            // Simplified check for Config DB - existence of sequelize instance suggests init ran
            const configDbReady = ConfigService.sequelize && ConfigService.isDbConnected ? 'CONNECTED' : 'DISCONNECTED'; // Check connection state if possible
            // Use MqService.isReady getter for MQ status
            const mqReady = MqService.isReady;
            // Check if consumer likely active (leaverConsumerTag is set and MQ channel is ready)
            const mqConsumerActive = !!leaverConsumerTag && MqService.isReady; // Use leaverConsumerTag
            // Check Redis status - Assuming TemporaryStorage exposes a ready state or client status
            const tempStorageReady = TemporaryStorage.isReady ? 'CONNECTED' : 'DISCONNECTED'; // Use isReady getter if available
            // Check Leaver DB status
            let leaverDbStatus = 'UNKNOWN';
            try {
                 await sequelize.authenticate(); // Attempt to authenticate
                 leaverDbStatus = 'CONNECTED';
            } catch (dbErr) {
                 leaverDbStatus = 'DISCONNECTED';
                 logger.debug('Health check: Leaver DB unreachable.', { error: dbErr.message });
            }


            // Optional: Add a check for the Provisioning API endpoint
            let provisioningApiStatus = 'UNKNOWN';
            try {
                // Perform a lightweight check, e.g., a GET on /health if available, or a small GET endpoint
                const apiUrl = serviceConfigs.provisioningServiceApiUrl;
                // Avoid hitting a heavy endpoint. Using axios with short timeout and no retry for health check.
                const apiCheckResponse = await axios.get(`${apiUrl}/health`, { timeout: 2000, axiosRetry: { retries: 0 } }); // Assuming /health exists
                provisioningApiStatus = apiCheckResponse.status >= 200 && apiCheckResponse.status < 300 ? 'REACHABLE' : 'UNREACHABLE';
            } catch (apiError) {
                provisioningApiStatus = 'UNREACHABLE';
                logger.debug('Health check: Provisioning API unreachable.', { error: apiError.message }); // Log debug for health check
            }


            const health = {
                status: 'UP', // Assume UP unless critical component is DOWN
                configDb: configDbReady,
                leaverDb: leaverDbStatus, // <-- Added Leaver DB status
                mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
                mqConsumer: mqConsumerActive ? 'ACTIVE' : 'INACTIVE', // Report consumer status
                temporaryStorage: tempStorageReady, // <-- Added Redis status
                provisioningApi: provisioningApiStatus, // <-- Added Provisioning API status
            };

            // Overall status degraded if Config DB, Leaver DB, MQ Service, Temp Storage is not ready,
            // OR consumer is not active, OR Provisioning API is unreachable.
            const overallStatus = (health.configDb === 'CONNECTED' && health.leaverDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqConsumer === 'ACTIVE' && health.temporaryStorage === 'CONNECTED' && health.provisioningApi === 'REACHABLE') ? 200 : 503; // <-- Added Temp Storage, Leaver DB, and API to check
            if (overallStatus !== 200) {
                logger.warn('Health check reported degraded status.', health);
            } else {
                logger.debug('Health check reported healthy status.', health); // Use debug for frequent healthy checks
            }
            res.status(overallStatus).json(health);
        });

        // Start the Express server if needed (for health checks or potential manual triggers)
        server = app.listen(port, () => { // Store server instance for graceful shutdown
            logger.info(`Service listening on port ${port}`);
        });

        logger.info('Service initialization complete.');

    } catch (error) {
        logger.error('Failed to start service.', {
            error: error.message,
            stack: error.stack
        });
        // Exit process immediately if initialization fails
        process.exit(1);
    }
}

// --- Leaver Event Listener ---
/**
 * Sets up the Message Queue consumer for 'leaver.exit' events.
 * This async function is called for each message received from the queue.
 * It processes the leaver event and triggers de-provisioning.
 * Uses MqService.subscribe to manage the consumer robustly.
 */
async function setupLeaverEventListener() {
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Assert the exchange published to by ICS using MqService's method
        // assertExchange includes an internal waitForChannel
        await MqService.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
        logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

        // Assert the queue specific to this Leaver service using MqService's method
        // Use a durable queue for reliability even if the service restarts.
        // assertQueue includes an internal waitForChannel
        const queue = await MqService.assertQueue(LEAVER_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Listener: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the 'leaver.exit' routing key using MqService's method
        // bindQueue includes an internal waitForChannel
        await MqService.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, LEAVER_ROUTING_KEY);
        logger.info(`Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${LEAVER_ROUTING_KEY}".`);

        // Start consuming messages from the queue using MqService.subscribe
        // MqService.subscribe manages the channel.consume call and consumer tag internally
        const consumeResult = await MqService.subscribe(queue.queue, async (msg) => { // <-- Using MqService.subscribe
            // Check for null message which indicates consumer cancellation or channel closure
            if (msg === null) {
                logger.warn('Listener: Consume callback received null message, indicating consumer cancellation or channel closure by MQ.');
                // MqService reconnection should handle re-establishing the consumer if needed
                return; // Exit this specific message processing handler instance
            }

            // Wrap message processing in an async task that we can track for graceful shutdown
            // IIAFE = Immediately Invoked Async Function Expression
            const processingTask = (async () => {
                let eventPayload = null;
                let userId = null; // IGLM User ID from the event
                let hrmsId = null; // HRMS ID from the event
                // const userData = eventPayload.userData; // Last known state from ICS event
                const messageCorrelationId = msg.properties.correlationId; // Get correlation ID for tracing
                const messageRedelivered = msg.fields.redelivered; // Check if message is being redelivered
                const deliveryTag = msg.fields.deliveryTag;

                logger.info(`Listener received message ${deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


                try {
                    // --- Parse Message ---
                    try {
                        eventPayload = JSON.parse(msg.content.toString());
                    } catch (parseError) {
                        logger.error('Listener received message with invalid JSON payload.', { deliveryTag, parseError: parseError.message, payload: msg.content.toString() });
                        // ACK malformed messages to remove them permanently. Logged above.
                        // Use optional chaining for channel access during potential shutdown
                        try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', { deliveryTag, ackErr: ackErr.message }); }
                        return; // Stop processing this message
                    }

                    // --- Validate Payload Structure ---
                    userId = eventPayload.userId; // IGLM User ID from ICS event
                    hrmsId = eventPayload.hrmsId; // HRMS ID from ICS event

                    if (!userId || !hrmsId) {
                        logger.error('Listener received malformed leaver event: Missing userId or hrmsId.', { deliveryTag, payload: eventPayload });
                        // ACK malformed messages to remove them permanently. Logged above.
                        // Use optional chaining for channel access during potential shutdown
                        try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', { deliveryTag, ackErr: ackErr.message }); }
                        return; // Stop processing this message
                    }

                    logger.info(`Listener processing leaver event for user.`, { userId, hrmsId, deliveryTag, correlationId: messageCorrelationId });

                    // --- Persist Event before processing ---
                    try {
                        await LeaveRequest.create({
                          user_id: userId,
                          hrms_id: hrmsId,
                          // Optional: Store more details if needed, e.g., raw_payload: msg.content.toString()
                          // Add correlationId for tracing in the DB record
                          correlation_id: messageCorrelationId
                        });
                        logger.info('LeaveRequest record created in DB.', { userId, hrmsId, deliveryTag, correlationId: messageCorrelationId });
                    } catch (dbCreateError) {
                         // If DB creation fails, log and NACK the message. This might indicate a DB issue.
                         logger.error('Failed to create LeaveRequest record in DB.', {
                              userId,
                              hrmsId,
                              deliveryTag,
                              correlationId: messageCorrelationId,
                              error: dbCreateError.message,
                              stack: dbCreateError.stack
                         });
                         // NACK without requeue, rely on DLQ or manual intervention for DB issues.
                         try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to NACK message after DB creation error:', { deliveryTag, nackErr: nackErr.message }); }
                         return; // Stop processing this message
                    }


                    // --- Trigger De-Provisioning ---
                    // The Leaver event signifies the user should have NO access.
                    // Send a desired state with empty roles/entitlements to the Provisioning Service.
                    const desiredStatePayload = {
                        userId: userId, // IGLM User ID (UUID)
                        roles: [], // Desired state for leaver: no roles (implies revoke all current roles/entitlements)
                        // Include correlationId for tracing
                        correlationId: messageCorrelationId,
                        // Optionally add context like the last known user data if Provisioning needs it
                        // context: eventPayload.userData
                    };

                    logger.info(`Listener: Calling Provisioning Service API to request de-provisioning for user ${userId}...`, { userId, provisioningApiUrl: serviceConfigs.provisioningServiceApiUrl, deliveryTag, correlationId: messageCorrelationId });

                    // Axios call with built-in retry configured globally. Await the call including retries.
                    const response = await axios.post(`${serviceConfigs.provisioningServiceApiUrl}/provision`, desiredStatePayload);

                    if (response.status === 202) { // 202 Accepted means request was received and queued
                        const taskId = response.data?.taskId; // Assuming API returns a task ID
                        logger.info(`Listener: De-provisioning request accepted by Provisioning Service.`, { userId, taskId: taskId, deliveryTag, correlationId: messageCorrelationId });
                        // TODO: Log or track the provisioning task ID for audit/status checks if needed by this service

                        // --- Update DB record on successful API call ---
                        try {
                             await LeaveRequest.update(
                               { status: 'completed', processed_at: new Date() },
                               { where: { user_id: userId, status: null } } // Use status: null or another indicator to find the unprocessed record
                             );
                             logger.info('LeaveRequest marked completed in DB.', { userId, deliveryTag, correlationId: messageCorrelationId });
                        } catch (dbUpdateError) {
                             logger.error('Failed to update LeaveRequest record to completed in DB.', {
                                  userId,
                                  deliveryTag,
                                  correlationId: messageCorrelationId,
                                  error: dbUpdateError.message,
                                  stack: dbUpdateError.stack
                             });
                             // Decide how to handle this: Is it critical? Maybe log and continue to ACK MQ?
                             // For now, log the error but still ACK the message as the API call was accepted.
                             // A separate process might be needed to reconcile DB status.
                        }

                    } else {
                        // Axios-retry exhausted retries or non-retryable status code returned
                        logger.error(`Listener: Provisioning API returned unexpected non-retryable status ${response.status} for user.`, {
                            userId: userId, status: response.status, responseData: response.data, payload: desiredStatePayload, deliveryTag, correlationId: messageCorrelationId
                        });
                        // NACK without requeue - rely on DLQ/DLX strategy for messages that failed API call permanently
                        // Use optional chaining for channel access during potential shutdown
                        try { MqService.channel?.nack(msg, false, false); } catch (nackError) { logger.error(`Failed to NACK message after non-retryable API status.`, { userId, deliveryTag, nackError: nackError.message }); }
                        // TODO: Implement alerting or store failure details persistently if relying solely on DLQ isn't sufficient.

                         // --- Update DB record on API error ---
                         try {
                              await LeaveRequest.update(
                                { status: 'failed', error_message: `API Error: ${response.status} - ${JSON.stringify(response.data)}` }, // More descriptive error
                                { where: { user_id: userId, status: null } } // Find the unprocessed record
                              );
                              logger.error('LeaveRequest marked failed in DB due to API error.', { userId, deliveryTag, correlationId: messageCorrelationId });
                         } catch (dbUpdateError) {
                              logger.error('Failed to update LeaveRequest record to failed in DB after API error.', {
                                   userId,
                                   deliveryTag,
                                   correlationId: messageCorrelationId,
                                   error: dbUpdateError.message,
                                   stack: dbUpdateError.stack
                              });
                         }

                        return; // Stop processing this message
                    }

                    // ACK only after successful processing (API call accepted and DB status updated to completed, even if update failed)
                    // Use optional chaining for channel access during potential shutdown
                    try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after successful processing:', { userId, deliveryTag, ackErr: ackErr.message }); }
                    logger.info(`Listener successfully processed and acknowledged leaver event.`, { userId, deliveryTag, correlationId: messageCorrelationId });

                } catch (error) {
                    // This catch handles errors during JSON parsing (if not caught inside the inner try),
                    // payload validation (if not caught inside), DB creation errors,
                    // or Axios errors after retries are exhausted.
                    logger.error(`Listener error processing leaver event message.`, {
                        userId: userId || 'N/A', // Log userId if determined
                        hrmsId: hrmsId || 'N/A',
                        error: error.message,
                        stack: error.stack,
                        deliveryTag: msg.fields.deliveryTag,
                        correlationId: messageCorrelationId
                    });

                    // --- Update DB record on processing error ---
                    // Only attempt to update if userId was successfully extracted
                    if (userId) {
                        try {
                             await LeaveRequest.update(
                               { status: 'failed', error_message: `Processing Error: ${error.message}` },
                               { where: { user_id: userId, status: null } } // Find the unprocessed record
                             );
                             logger.error('LeaveRequest marked failed in DB due to processing error.', { userId, deliveryTag, correlationId: messageCorrelationId });
                        } catch (dbUpdateError) {
                             logger.error('Failed to update LeaveRequest record to failed in DB after processing error.', {
                                  userId,
                                  deliveryTag,
                                  correlationId: messageCorrelationId,
                                  error: dbUpdateError.message,
                                  stack: dbUpdateError.stack
                             });
                        }
                    } else {
                        logger.warn('Could not update LeaveRequest record in DB after processing error, userId was not determined.', { deliveryTag, correlationId: messageCorrelationId });
                    }


                    // NACK without requeue - rely on DLQ/DLX strategy for processing errors
                    // Use optional chaining for channel access during potential shutdown
                    try {
                        // Use MqService.channel explicitly here for NACK
                        MqService.channel?.nack(msg, false, false); // NACK, do not requeue, do not reject
                    } catch (nackError) {
                        logger.error(`Failed to NACK message after processing error.`, { userId: userId || 'N/A', deliveryTag: msg.fields.deliveryTag, nackError: nackError.message });
                    }
                    // TODO: Log processing failure details to a dedicated system or queue for monitoring/manual intervention via DLQ.
                } finally {
                    // --- This task's promise is automatically removed from the set by the .finally() handler attached below ---
                }
            })(); // Execute the async message processing logic immediately

            // --- Track the message processing task for graceful shutdown ---
            activeLeaverProcessingTasks.add(processingTask);
            // Remove the task from the set when it completes (either resolves or rejects)
            processingTask.finally(() => {
                activeLeaverProcessingTasks.delete(processingTask);
                // logger.debug(`Task for message ${deliveryTag} finished. Active tasks remaining: ${activeLeaverProcessingTasks.size}`, { deliveryTag }); // Optional: debug tracking
            });
            // Note: We do NOT await processingTask here. The consume callback should be fast to allow
            // processing subsequent messages, as long as we limit concurrency elsewhere if needed.
            // Consider using channel.prefetch(count) to limit the number of unacknowledged messages this consumer receives at once.
            // This helps control concurrency and prevents overwhelming the worker.
            // Example: await MqService.channel.prefetch(10); // Before starting consume
            // The prefetch should ideally be part of the MqService.subscribe options or channel setup.


        }, {
            noAck: false // Manual acknowledgement is required
        });

        // Store the consumer tag returned by MqService.subscribe
        leaverConsumerTag = consumeResult.consumerTag;
        logger.info(`Listener started consuming messages with consumer tag: ${leaverConsumerTag}.`);

    } catch (setupError) {
        logger.error('Failed to setup Leaver Event Listener.', {
            error: setupError.message,
            stack: setupError.stack
        });
        throw new Error('Failed to setup Leaver Event Listener: ' + setupError.message);
    }
}

// --- Graceful Shutdown Handling ---
// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Handle Ctrl+C

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        logger.warn(`Shutdown already in progress. Received signal: ${signal}`);
        return;
    }
    isShuttingDown = true;
    logger.info(`${signal} received, starting graceful shutdown.`);

    // 1. Stop the Express HTTP server (if running) from accepting new requests
    if (server) {
        logger.info('Stopping HTTP server...');
        await new Promise((resolve, reject) => server.close((err) => {
            if (err) {
                logger.error('Error stopping HTTP server:', { error: err.message });
                // Decide if HTTP server close failure is critical or just log and proceed
                // For graceful shutdown, it's often better to log and proceed with other shutdowns.
                // Rejecting here means Promise.allSettled (if used) would catch it,
                // but using resolve() allows the flow to continue even on error.
                // Let's resolve to continue other shutdown steps.
                resolve();
            } else {
                logger.info('HTTP server stopped.');
                resolve();
            }
        })); // Removed .then/.catch chain as error handling is now in the callback
    } else {
        logger.info('HTTP server was not started.');
    }


    // 2. Cancel the MQ consumer from accepting new messages
    // This will also cause the consume callback to receive a null message.
    if (leaverConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        logger.info(`Attempting to cancel MQ consumer with tag: ${leaverConsumerTag}`);
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(leaverConsumerTag);
            logger.info(`MQ consumer ${leaverConsumerTag} cancelled successfully.`);
            // Do NOT nullify leaverConsumerTag here. Let MqService manage consumer state internally.
        } catch (err) {
            // cancelConsumer should log its own errors, but log here too if needed.
            logger.error(`Error cancelling MQ consumer ${leaverConsumerTag}. It might have already been cancelled or channel closed.`, {
                consumerTag: leaverConsumerTag, error: err.message, stack: err.stack
            });
        }
    } else {
        logger.warn('MQ consumer tag not found or already null, skipping cancellation.');
    }


    // 3. Wait for any currently processing message tasks to finish
    // The activeLeaverProcessingTasks set holds promises from the consume callback.
    if (activeLeaverProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeLeaverProcessingTasks.size} active message processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = parseInt(process.env.SHUTDOWN_TASK_TIMEOUT_MS, 10) || 30000; // Configurable timeout, default 30s
        const tasksWait = Promise.allSettled(Array.from(activeLeaverProcessingTasks)); // Convert Set to Array for allSettled
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
            logger.warn(`Timeout waiting for active message processing tasks after ${processingTimeout}ms.`);
            // Log remaining tasks if timeout occurs
            if (activeLeaverProcessingTasks.size > 0) {
                logger.warn(`Still ${activeLeaverProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
                // Optional: log details of remaining tasks
                // activeLeaverProcessingTasks.forEach(task => logger.warn('Remaining task for message:', task.messageInfo)); // If task promises stored message info
            }
            resolve(); // Allow shutdown to proceed after timeout warning
        }, processingTimeout));

        await Promise.race([tasksWait, timeoutPromise]); // Wait for tasks OR timeout

        logger.info(`Finished waiting for active message processing tasks.`);
        // Note: Any tasks that timed out will have their promises left in the set, but we proceed to close connections.
        // Closing MQ connections will interrupt any tasks still waiting for acks/nacks.
    } else {
        logger.info('No active message processing tasks to wait for.');
    }


    // 4. Shut down Message Queue gracefully
    logger.info('Initiating MQ service shutdown...');
    try {
        // Use the dedicated shutdown method from MqService
        // This handles closing the channel and connection and prevents reconnects.
        await MqService.shutdown(); // <-- Using MqService.shutdown()
        logger.info('MQ service shut down gracefully.');
    } catch (mqShutdownError) {
        logger.error('Error during MQ service shutdown:', { error: mqShutdownError.message, stack: mqShutdownError.stack });
        // Log the error but proceed with other shutdowns.
    }


    // 5. Close connections to other external services (Databases, Temporary Storage)
    logger.info('Closing other external connections...');
    // Use the close methods from ConfigService, TemporaryStorage, and Sequelize instance
    const connectionClosePromises = [
        // Close Config DB connection (initialized by ConfigService)
        ConfigService.sequelize ? ConfigService.sequelize.close().then(() => logger.info('Config DB connection closed.')).catch(err => logger.error('Error closing Config DB connection:', err.message)) : (logger.debug('Config DB connection not initialized.'), Promise.resolve()), // Config DB connection
        // Close Leaver DB connection
        sequelize ? sequelize.close().then(() => logger.info('Leaver DB connection closed.')).catch(err => logger.error('Error closing Leaver DB connection:', err.message)) : (logger.debug('Leaver DB connection not initialized.'), Promise.resolve()), // <-- Added Leaver DB close
        // Close Temporary Storage (Redis) connection
        // Assuming TemporaryStorage has a close method and isReady getter
        TemporaryStorage.isReady && TemporaryStorage.close ? TemporaryStorage.close().then(() => logger.info('Temporary Storage (Redis) client closed.')).catch(err => logger.error('Error closing Redis client gracefully:', err.message)) : (logger.debug('Temporary Storage (Redis) client not initialized or not ready.'), Promise.resolve()), // <-- Added TemporaryStorage close
        // TODO: If RoleAssignmentService or other shared modules manage connections, close them here.
    ];

    await Promise.allSettled(connectionClosePromises); // Wait for all connection closures


    logger.info('Graceful shutdown complete.');
    process.exit(0); // Exit successfully
}


// Optional: Handle uncaught exceptions and unhandled promise rejections
// Log critical errors before potentially exiting
process.on('uncaughtException', (err, origin) => {
    // Use logger if initialized, otherwise fallback to console
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
        setTimeout(() => gracefulShutdown('uncaughtException').catch(() => process.exit(1)), 1000);
    } else {
        // If already shutting down due to another signal/error, just ensure process exits
        log.warn('Uncaught Exception during shutdown. Forcing exit.');
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    // Use logger if initialized, otherwise fallback to console
    const log = logger || console;
    log.error('Unhandled Promise Rejection.', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined,
        isShuttingDown: isShuttingDown
        // promiseDetails: promise // Optional: log promise details
    });
    // Consider exiting similar to uncaughtException, but depends on application specifics.
    // For a worker service, exiting on unexpected errors is generally safer.
    // Avoid re-triggering shutdown if already in progress.
    if (!isShuttingDown) {
        setTimeout(() => gracefulShutdown('unhandledRejection').catch(() => process.exit(1)), 1000);
    } else {
        log.warn('Unhandled Rejection during shutdown. Forcing exit.');
        process.exit(1);
    }
});


// --- Start the Service ---
// Call the initialization function to start the service
startService();