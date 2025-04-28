// services/leaver-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env')
 });

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4004
const port = process.env.LEAVER_PORT || 4004;
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry');
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // Added for structured logging


// --- Import Shared Services and Models ---
const ConfigService = require('../../../shared/configService');
const MqService = require('../../../shared/mqService');
const TemporaryStorage = require('../../identity-collection-service/src/temporaryStorage'); 
// Access models if needed, though Leaver service might not interact directly with Core Data Model DB much
// const models = require('../../shared/models'); // Still likely not directly needed here

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
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info', // Default to 'info', configurable via env var
  // Apply base formats at the logger level
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }), // Log stack traces
    winston.format.splat(), // Handle %s, %d, %j string interpolation
    // Note: printf is moved down to the transport where colorization happens
  ),
  defaultMeta: { service: serviceName }, // Automatically add service name to each log
  transports: [
    // Console transport with colorization and custom printf
    new winston.transports.Console({
      // Apply colorization and printf specifically to the console transport
      format: winston.format.combine(
        winston.format.colorize(), // Apply colors *before* printing
        winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
            // Access the formatted timestamp and other properties
            // Include meta data if present
            const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
            return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
        })
      )
    })
    // TODO: Add transports for centralized logging (e.g., ELK, Datadog, file rotation)
    // Example File transport (without colorization, standard format applied at logger level)
    // new winston.transports.File({
    //     filename: path.join(__dirname, '../../../../logs/leaver-error.log'), 
    //     level: 'error',
    //     format: winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
    //         const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    //         return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
    //     })
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
        logger.info('Loaded service configurations.', { provisioningUrlConfigured: !!serviceConfigs.provisioningServiceApiUrl }); // Avoid logging sensitive URLs directly


        // 2. Initialize Message Queue Service
        await MqService.init();
        // Wait for MQ channel to be ready for operations before setting up consumer
        await MqService.waitForChannel();
        logger.info('Message Queue connected and channel ready.');

        // 3. Initialize Temporary Storage (Redis) - Leaver Service might use it if tracking tasks across restarts
        // Although not strictly necessary for the basic consume/provision pattern,
        // keeping this consistent with other services that might need it.
        // Remove this block if Leaver Service explicitly does not require temporary storage.
        await TemporaryStorage.init(); // <-- Added TemporaryStorage init
        logger.info('Temporary Storage initialized.');


        // 4. Set up Message Queue Consumer
        await setupLeaverEventListener(); // Will start consuming messages
        logger.info('Leaver Event Listener setup complete and consuming messages.');

        // 5. Set up Express server
        app.get('/health', (req, res) => {
            // Basic health check - check Config DB connection, MQ status, potentially Provisioning API reachability
            // Simplified check for Config DB - existence of sequelize instance suggests init ran
            const configDbReady = ConfigService.sequelize?.options ? true : false;
            // Use MqService.isReady getter for MQ status
            const mqReady = MqService.isReady;
            // Check if consumer likely active (leaverConsumerTag is set and MQ channel is ready)
            const mqConsumerActive = !!leaverConsumerTag && MqService.isReady; // Use leaverConsumerTag
            // Check Redis status
            const tempStorageReady = TemporaryStorage.redisClient && TemporaryStorage.redisClient.status === 'ready'; // <-- Added Redis check

            const health = {
                status: 'UP',
                configDb: configDbReady ? 'CONNECTED' : 'DISCONNECTED',
                mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
                mqConsumer: mqConsumerActive ? 'ACTIVE' : 'INACTIVE', // Report consumer status
                temporaryStorage: tempStorageReady ? 'CONNECTED' : 'DISCONNECTED', // <-- Added Redis status
                // TODO: Add Provisioning API status check (e.g., try a simple GET /health if available)
            };
            // Degraded if Config DB or MQ Service or Temp Storage is not ready, or consumer is not active
            const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqConsumer === 'ACTIVE' && health.temporaryStorage === 'CONNECTED') ? 200 : 503; // <-- Added Temp Storage to check
            if (overallStatus !== 200) {
                logger.warn('Health check reported degraded status.', health);
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
 */
async function setupLeaverEventListener() {
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Assert the exchange published to by ICS using MqService's method
        await MqService.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
        logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

        // Assert the queue specific to this Leaver service using MqService's method
        // Use a durable queue for reliability even if the service restarts.
        const queue = await MqService.assertQueue(LEAVER_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Listener: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the 'leaver.exit' routing key using MqService's method
        await MqService.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, LEAVER_ROUTING_KEY);
        logger.info(`Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${LEAVER_ROUTING_KEY}".`);

        // Start consuming messages from the queue
        // The onMessage callback is called by amqplib for each message.
        const consumeResult = await MqService.channel.consume(queue.queue, async (msg) => {
             // Check for null message which indicates consumer cancellation or channel closure
             if (msg === null) {
                 logger.warn('Listener: Consume callback received null message, indicating channel closure by MQ broker. Consumer will stop.');
                 // MqService reconnection should handle re-establishing the consumer if needed
                 return; // Exit this specific message processing handler instance
             }

             // Wrap message processing in an async task that we can track for graceful shutdown
             const processingTask = (async () => { // <-- IIAFE pattern
                let eventPayload = null;
                let userId = null; // IGLM User ID from the event
                let hrmsId = null; // HRMS ID from the event
                // const userData = eventPayload.userData; // Last known state from ICS event
                const messageCorrelationId = msg.properties.correlationId; // Get correlation ID for tracing
                const messageRedelivered = msg.fields.redelivered; // Check if message is being redelivered

                logger.info(`Listener received message ${msg.fields.deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag: msg.fields.deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


                try {
                    eventPayload = JSON.parse(msg.content.toString());
                    userId = eventPayload.userId; // IGLM User ID from ICS event
                    hrmsId = eventPayload.hrmsId; // HRMS ID from ICS event
                    // You might need userData or specific attributes from the event for de-provisioning logic
                    // const userData = eventPayload.userData;

                    if (!userId || !hrmsId) {
                        logger.error('Listener received malformed leaver event: Missing userId or hrmsId.', { payload: eventPayload });
                        // ACK malformed messages to remove them permanently. Logged above.
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', ackErr); }
                        return;
                    }

                    logger.info(`Listener processing leaver event.`, { userId, hrmsId });

                    // --- Trigger De-Provisioning ---
                    // The Leaver event signifies the user should have NO access.
                    // Send a desired state with empty roles/entitlements.
                    const desiredStatePayload = {
                        userId: userId, // IGLM User ID (UUID)
                        roles: [], // Desired state for leaver: no roles (implies revoke all current roles/entitlements)
                        // Include correlationId for tracing
                        correlationId: messageCorrelationId,
                        // Optionally add context like the last known user data if Provisioning needs it
                        // context: eventPayload.userData
                  };

                    logger.info(`Listener: Calling Provisioning Service API at ${serviceConfigs.provisioningServiceApiUrl}/provision to request de-provisioning for user ${userId}...`, { userId, provisioningApiUrl: serviceConfigs.provisioningServiceApiUrl, payloadSample: { userId: desiredStatePayload.userId, roles: desiredStatePayload.roles } });

                    // Axios call with built-in retry. Await the call including retries.
                    const response = await axios.post(`${serviceConfigs.provisioningServiceApiUrl}/provision`, desiredStatePayload);

                    if (response.status === 202) { // 202 Accepted means request was received and queued
                        const taskId = response.data?.taskId;
                        logger.info(`Listener: De-provisioning request accepted for user.`, { userId, taskId: taskId, correlationId: messageCorrelationId });
                        // TODO: Log or track the provisioning task ID for audit/status checks
                    } else {
                        // Axios-retry exhausted retries or non-retryable status
                        logger.error(`Listener: Provisioning API returned unexpected non-retryable status ${response.status} for user. Acknowledging message as failed.`, {
                            userId: userId, status: response.status, responseData: response.data, payload: desiredStatePayload, correlationId: messageCorrelationId
                        });
                        // ACK malformed/permanently failed messages
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after non-retryable API status:', { userId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                        // TODO: Implement alerting or store failure details persistently.
                        return;
                    }

                    // ACK only after successful processing (API call accepted)
                    try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after successful processing:', { userId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                    logger.info(`Listener successfully processed and acknowledged leaver event.`, { userId, deliveryTag: msg.fields.deliveryTag });

             } catch (error) {
                  // Error during message parsing or API call (after retries failed)
                  logger.error(`Listener error processing leaver event message.`, {
                      userId: userId || 'N/A',
                      error: error.message,
                      stack: error.stack,
                      deliveryTag: msg.fields.deliveryTag,
                      correlationId: messageCorrelationId
                });

                  // NACK without requeue - rely on DLQ/DLX strategy
                  try {
                      channel.nack(msg, false, false);
                  } catch (nackError) {
                      logger.error(`Failed to NACK message after processing error.`, { userId: userId || 'N/A', deliveryTag: msg.fields.deliveryTag, nackError: nackError.message });
                  }
                  // TODO: Log processing failure details for monitoring/manual intervention via DLQ.
            } finally {
                 // --- Remove this task's promise from the set of active tasks ---
                 // This needs to happen AFTER the promise created by the outer async IIFE resolves/rejects
                 // This comment is slightly misleading based on the IIAFE pattern.
             }
        })(); // Execute the async message processing logic immediately

         // --- Track the message processing task for graceful shutdown ---
        activeLeaverProcessingTasks.add(processingTask);
        // Remove the task from the set when it completes (either resolves or rejects)
        processingTask.finally(() => {
            activeLeaverProcessingTasks.delete(processingTask);
            // logger.debug(`Task for message ${msg.fields.deliveryTag} finished. Active tasks remaining: ${activeLeaverProcessingTasks.size}`); // Optional: debug tracking
        });
        // Note: We do NOT await processingTask here. The consume callback should be fast to allow
        // processing subsequent messages, as long as we limit concurrency elsewhere if needed.

        }, {
            noAck: false // Manual acknowledgement is required
        });

        // Store the consumer tag
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

    // 1. Stop the MQ consumer from accepting new messages
    if (leaverConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        logger.info(`Attempting to cancel MQ consumer with tag: ${leaverConsumerTag}`);
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(leaverConsumerTag);
            logger.info(`MQ consumer ${leaverConsumerTag} cancelled successfully.`);
            leaverConsumerTag = null; // Mark as cancelled
        } catch (err) {
            logger.error(`Error cancelling MQ consumer ${leaverConsumerTag}. It might have already been cancelled or channel closed.`, {
                error: err.message
            });
        }
    } else {
        logger.warn('MQ consumer tag not found or already null, skipping cancellation.');
    }


    // 2. Wait for any currently processing message tasks to finish
    // The activeLeaverProcessingTasks set holds promises from the consume callback.
    if (activeLeaverProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeLeaverProcessingTasks.size} active message processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = 30000; // Wait max 30 seconds for tasks to finish
        const tasksWait = Promise.allSettled(activeLeaverProcessingTasks);
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
             logger.warn(`Timeout waiting for active message processing tasks after ${processingTimeout}ms.`);
             // Log remaining tasks if timeout occurs
             if (activeLeaverProcessingTasks.size > 0) {
                 logger.warn(`Still ${activeLeaverProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
             }
             resolve(); // Allow shutdown to proceed after timeout warning
        }, processingTimeout));

        await Promise.race([tasksWait, timeoutPromise]); // Wait for tasks OR timeout

        logger.info(`Finished waiting for active message processing tasks.`);
    } else {
        logger.info('No active message processing tasks to wait for.');
    }


    // 3. Stop Express HTTP server
   if (server) {
        logger.info('Stopping HTTP server...');
        await new Promise((resolve, reject) => server.close((err) => {
            if (err) {
                logger.error('Error stopping HTTP server:', { error: err.message });
                // Decide if HTTP server close failure is critical or just log and proceed
                return reject(err); // Treat as failure to stop gracefully
            }
            resolve();
        }))
            .then(() => logger.info('HTTP server stopped.'))
            .catch(err => logger.error('Failed to stop HTTP server gracefully:', err.message)); // Log the rejection from the promise
    }


    // 4. Close connections to external services (Databases, Message Queue)
  logger.info('Closing external connections...');
  // Use the close methods from ConfigService and MqService
  const connectionClosePromises = [
      ConfigService.sequelize ? ConfigService.sequelize.close().catch(err => logger.error('Error closing Config DB connection:', err.message)) : Promise.resolve(), // Config DB connection
      // Closing MQ connection also closes the channel. Explicit channel close first is fine.
      MqService.channel ? MqService.closeChannel().catch(err => logger.error('Error closing MQ Channel gracefully:', err.message)) : Promise.resolve(), // Close channel using MqService method
      MqService.connection ? MqService.closeConnection().catch(err => logger.error('Error closing MQ Connection gracefully:', err.message)) : Promise.resolve(), // Close connection using MqService method
      // Close Temporary Storage (Redis) connection
      TemporaryStorage.redisClient ? TemporaryStorage.close().catch(err => logger.error('Error closing Redis client gracefully:', err.message)) : Promise.resolve(), // <-- Added TemporaryStorage close
      // TODO: If RoleAssignmentService or other shared modules manage connections, close them here.
  ];

  await Promise.allSettled(connectionClosePromises); // Wait for all connection closures


  logger.info('Graceful shutdown complete.');
  process.exit(0); // Exit successfully
}


// Optional: Handle uncaught exceptions and unhandled promise rejections
// Log critical errors before potentially exiting
process.on('uncaughtException', (err, origin) => {
  logger.error('Uncaught Exception.', {
      error: err.message,
      stack: err.stack,
      origin: origin,
      isShuttingDown: isShuttingDown // Add shutdown state to logs
  });
  // In production, it's often best to exit after an uncaught exception,
  // as the application state might be corrupted. Attempt graceful shutdown if possible.
  if (!isShuttingDown) {
      // Add a slight delay before initiating shutdown to allow logs to flush
      setTimeout(() => gracefulShutdown('uncaughtException').catch(() => process.exit(1)), 1000);
  } else {
      // If already shutting down due to another signal/error, just ensure process exits
      logger.warn('Uncaught Exception during shutdown. Forcing exit.');
      process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection.', {
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
      isShuttingDown: isShuttingDown
      // promiseDetails: promise // Optional: log promise details
  });
    // Consider exiting similar to uncaughtException, but depends on application specifics.
    // For a worker service, exiting on unexpected errors is generally safer.
    if (!isShuttingDown) {
        setTimeout(() => gracefulShutdown('unhandledRejection').catch(() => process.exit(1)), 1000);
    } else {
        logger.warn('Unhandled Rejection during shutdown. Forcing exit.');
        process.exit(1);
    }
});


// --- Start the Service ---
// Call the initialization function to start the service
startService();