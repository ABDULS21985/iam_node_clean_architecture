// services/mover-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env')
 });

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4003
const port = process.env.MOVER_PORT || 4003;
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
const TemporaryStorage = require('../../../shared/temporaryStorage'); 
// Access models if needed, though Mover service might not interact directly with Core Data Model DB
// const models = require('../../shared/models'); // Not directly used here, but imported by ConfigService


// Import the Role Assignment Service (Assuming this service is stateless or initialized separately)
const roleAssignmentService = require('../../../shared/roleAssignmentService'); 


// --- Service Configuration ---
const serviceName = 'mover-service'; // Service identifier for config and logging
let serviceConfigs = {}; // Object to hold loaded service configurations
let attributeToRoleMappingConfig = null; // Config for attribute-to-role mapping


// --- Message Queue Configuration ---
// Define Message Queue details for consuming Mover events
const IDENTITY_CHANGES_EXCHANGE = 'identity.changes'; // Exchange published to by ICS
const MOVER_QUEUE = 'mover.events.queue'; // Queue specific to the Mover service
const MOVER_ROUTING_KEY = 'mover.update'; // Routing key for mover events published by ICS


// --- Worker State Management ---
let moverConsumerTag = null; // To store the consumer tag for cancelling consumption during shutdown
const activeMoverProcessingTasks = new Set(); // Track promises of ongoing message processing tasks for shutdown
let isShuttingDown = false; // Flag for graceful shutdown state


// --- Setup Structured Logger (Winston ) ---
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
    //  File transport (without colorization, standard format applied at logger level)
    // new winston.transports.File({
    //     filename: path.join(__dirname, '../../../../logs/mover-error.log'), // Adjusted path for mover service
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
 * Initializes all necessary components and starts the Mover Service.
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

        if (!serviceConfigs || typeof serviceConfigs.provisioningServiceApiUrl !== 'string' || !serviceConfigs.provisioningServiceApiUrl || typeof serviceConfigs.attributeToRoleMappingName !== 'string' || !serviceConfigs.attributeToRoleMappingName) { // Added check for attributeToRoleMappingName
            logger.error('Missing critical service configurations.', { required: ['provisioningServiceApiUrl', 'attributeToRoleMappingName'], loaded: serviceConfigs });
            throw new Error("Missing critical service configuration ('provisioningServiceApiUrl' and/or 'attributeToRoleMappingName')");
        }
        logger.info('Loaded service configurations.', { provisioningUrlConfigured: !!serviceConfigs.provisioningServiceApiUrl }); // Avoid logging sensitive URLs directly


        // 2. Load the Attribute-to-Role Mapping config used by this service
        // Get the name of the mapping config from serviceConfigs
        const attributeToRoleMappingName = serviceConfigs.attributeToRoleMappingName;
        // Clear the cache for this mapping config to ensure we get the latest version
        const mappingCacheKey = ConfigService.mappingCacheKey(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);
        ConfigService.clearCache(mappingCacheKey);
        // Use ConfigService to load the specific MappingConfig entry (leveraging its caching)
        // Mapping config for Attribute-to-Role mapping is global, so serviceName and sourceId are null in the lookup.
        attributeToRoleMappingConfig = await ConfigService.loadMappingConfig(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);

        // --- CORRECTED CHECK FOR MAPPING CONFIG STRUCTURE ---
        // Check if config was found AND has the expected nested rules structure
        if (!attributeToRoleMappingConfig // Config entry wasn't found
            || !attributeToRoleMappingConfig.mappingRules // mappingRules object is missing
            || !attributeToRoleMappingConfig.mappingRules.attributeToRoleMapping // nested attributeToRoleMapping object is missing
            || !Array.isArray(attributeToRoleMappingConfig.mappingRules.attributeToRoleMapping.rules) // nested 'rules' property is missing or not an array
         ) {
            logger.error(`Attribute-to-Role Mapping Config "${attributeToRoleMappingName}" not found or incomplete (missing mappingRules, attributeToRoleMapping, or rules array). Mover service cannot re-assign roles based on attributes.`);
            throw new Error(`Attribute-to-Role Mapping Config "${attributeToRoleMappingName}" not found or incomplete.`);
       } else {
           // Optional: Log the number of rules found for confirmation
           logger.info(`Loaded Attribute-to-Role Mapping Config: "${attributeToRoleMappingConfig.name}". Rules found: ${attributeToRoleMappingConfig.mappingRules.attributeToRoleMapping.rules.length}`);
       }
        // --- END CORRECTED CHECK ---


        // 3. Initialize Message Queue Service
        await MqService.init();
        // Wait for MQ channel to be ready for operations before setting up consumer
        await MqService.waitForChannel();
        logger.info('Message Queue connected and channel ready.');

        // 4. Initialize Temporary Storage (Redis)
        // Mover Service might use it for tracking active tasks or state across restarts
        await TemporaryStorage.init();
        logger.info('Temporary Storage initialized.');


        // 5. Set up Message Queue Consumer (the Mover Event Listener)
        // Pass the loaded mapping config to the listener setup
        await setupMoverEventListener(attributeToRoleMappingConfig);
        logger.info('Mover Event Listener setup complete and consuming messages.');


        // 6. Set up Express server (Optional - for health check)
        app.get('/health', (req, res) => {
            // Basic health check - check Config DB connection, MQ status, Temporary Storage status
            // Simplified check for Config DB - existence of sequelize instance suggests init ran
            const configDbReady = ConfigService.sequelize?.options ? true : false;
            // Use MqService.isReady getter for MQ status
            const mqReady = MqService.isReady;
            // Check if consumer likely active (moverConsumerTag is set and MQ channel is ready)
            const mqConsumerActive = !!moverConsumerTag && MqService.isReady; // Use moverConsumerTag
            // Check Redis status
            const tempStorageReady = TemporaryStorage.redisClient && TemporaryStorage.redisClient.status === 'ready';

            const health = {
                status: 'UP',
                configDb: configDbReady ? 'CONNECTED' : 'DISCONNECTED',
                mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
                mqConsumer: mqConsumerActive ? 'ACTIVE' : 'INACTIVE', // Report consumer status
                temporaryStorage: tempStorageReady ? 'CONNECTED' : 'DISCONNECTED', // Added Redis status
                // TODO: Add Provisioning API status check (e.g., try a simple GET /health if available)
            };
            // Degraded if Config DB or MQ Service or Temp Storage is not ready, or consumer is not active
            const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqConsumer === 'ACTIVE' && health.temporaryStorage === 'CONNECTED') ? 200 : 503;
            if (overallStatus !== 200) {
                logger.warn('Health check reported degraded status.', health);
            }
            res.status(overallStatus).json(health);
        });

        // Start the Express server (for health checks or potential manual triggers)
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


// --- Mover Event Listener ---
/**
 * Sets up the Message Queue consumer for 'mover.update' events.
 * @param {object} attributeToRoleMappingConfig - The loaded mapping config for role determination.
 */
async function setupMoverEventListener(attributeToRoleMappingConfig) {
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Assert the exchange published to by ICS using MqService's method
        await MqService.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
        logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

        // Assert the queue specific to this Mover service using MqService's method
        // Use a durable queue for reliability even if the service restarts.
        const queue = await MqService.assertQueue(MOVER_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Listener: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the 'mover.update' routing key using MqService's method
        await MqService.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, MOVER_ROUTING_KEY);
        logger.info(`Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${MOVER_ROUTING_KEY}".`);


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
                let updatedUserData = null; // Mapped IGLM User data from ICS event
                const messageCorrelationId = msg.properties.correlationId; // Get correlation ID for tracing
                const messageRedelivered = msg.fields.redelivered; // Check if message is being redelivered

                logger.info(`Listener received message ${msg.fields.deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag: msg.fields.deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


                try {
                    eventPayload = JSON.parse(msg.content.toString());
                    userId = eventPayload.userId; // IGLM User ID from ICS event
                    hrmsId = eventPayload.hrmsId; // HRMS ID from ICS event
                    updatedUserData = eventPayload.userData; // This is the MAPPED IGLM User data from ICS event
                    // eventPayload might also contain 'changedAttributes' which could be used for optimization
                    // const changedAttributes = eventPayload.changedAttributes;


                    if (!userId || !hrmsId || !updatedUserData || typeof updatedUserData !== 'object') {
                        logger.error('Listener received malformed mover event: Missing essential data (userId, hrmsId, or updatedUserData).', { payload: eventPayload });
                        // ACK malformed messages to remove them permanently. Logged above.
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', ackErr); }
                        return;
                    }

                    logger.info(`Listener processing mover event for user ID: ${userId} (HRMS ID: ${hrmsId}).`, { userId, hrmsId });

                    // --- Determine NEW Desired Roles for the Mover ---
                    // Use the updated mapped user data from ICS event as input for role determination
                    // The roleAssignmentService determines the FULL set of roles based on the current state.
                    // It doesn't just determine *changes*.
                    const newDesiredRoles = await roleAssignmentService.determineRolesBasedOnMatrixRules(updatedUserData, attributeToRoleMappingConfig); // <-- Call the role assignment service

                    const rolesForProvisioning = Array.isArray(newDesiredRoles) ? newDesiredRoles : [];
                    logger.info(`Listener: Determined NEW desired roles: ${rolesForProvisioning.join(', ')} for user ${userId}`, { userId, roles: rolesForProvisioning });


                    // --- Trigger Provisioning ---
                    // Prepare the payload for the Provisioning Service API
                    // The Provisioning Service will compare these desired roles to the user's *current*
                    // entitlements and perform grant/revoke actions as needed.
                    const desiredStatePayload = {
                        userId: userId, // IGLM User ID
                        roles: rolesForProvisioning, // Array of *new* determined IGLM Role names (Desired State)
                        // Include correlationId for tracing
                        correlationId: messageCorrelationId,
                        // Optionally add context like the updated user data if Provisioning needs it
                        context: updatedUserData // Sending updated user data for context
                  };

                    logger.info(`Listener: Calling Provisioning Service API at ${serviceConfigs.provisioningServiceApiUrl}/provision to request desired state for user ${userId}...`, { userId, provisioningApiUrl: serviceConfigs.provisioningServiceApiUrl, payloadSample: { userId: desiredStatePayload.userId, roles: desiredStatePayload.roles } });

                    // Use axios.post with built-in retry (configured globally). Await the call including retries.
                    const response = await axios.post(`${serviceConfigs.provisioningServiceApiUrl}/provision`, desiredStatePayload);

                    if (response.status === 202) { // 202 Accepted means request was received and queued by Provisioning Service
                        const taskId = response.data?.taskId;
                        logger.info(`Listener: Provisioning request accepted for user.`, { userId, taskId: taskId, correlationId: messageCorrelationId });
                        // TODO: Log or track the provisioning task ID for audit/status checks (e.g., in Mover Service DB)
                    } else {
                        // Axios-retry exhausted retries or non-retryable status (e.g., 400)
                        // This indicates a permanent failure for this message payload relative to the Provisioning Service API.
                        logger.error(`Listener: Provisioning API returned unexpected non-retryable status ${response.status} for user. Acknowledging message as permanently failed.`, {
                            userId: userId, status: response.status, responseData: response.data, payload: desiredStatePayload, correlationId: messageCorrelationId
                        });
                        // ACK malformed/permanently failed messages
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after non-retryable API status:', { userId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                        // TODO: Implement alerting or store failure details persistently.
                        return; // Stop processing this message task
                    }

                    // Acknowledge the message *only after* the entire processing (including API call potentially with retries) is successful (API call accepted)
                    try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after successful processing:', { userId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                    logger.info(`Listener successfully processed and acknowledged mover event.`, { userId, deliveryTag: msg.fields.deliveryTag });


             } catch (error) {
                  // Error during message parsing or API call (after axios-retry exhausts)
                  logger.error(`Listener error processing mover event message.`, {
                      userId: userId || 'N/A',
                      error: error.message,
                      stack: error.stack,
                      deliveryTag: msg.fields.deliveryTag,
                      correlationId: messageCorrelationId
                });

                  // NACK without requeue - rely on DLQ/DLX strategy
                  // If NACK fails, just log and move on.
                  try {
                      channel.nack(msg, false, false); // NACK, don't requeue immediately
                  } catch (nackErr) {
                      logger.error(`Failed to NACK message after processing error.`, { userId: userId || 'N/A', deliveryTag: msg.fields.deliveryTag, nackError: nackErr.message });
                  }
                  // TODO: Log processing failure details for monitoring/manual intervention via DLQ.
            } finally {
                 // --- Remove this task's promise from the set of active tasks ---
                 // This needs to happen AFTER the promise created by the outer async IIAFE resolves/rejects
                 // This comment is slightly misleading based on the IIAFE pattern.
             }
        })(); // Execute the async message processing logic immediately

         // --- Track the message processing task for graceful shutdown ---
        activeMoverProcessingTasks.add(processingTask);
        // Remove the task from the set when it completes (either resolves or rejects)
        processingTask.finally(() => {
            activeMoverProcessingTasks.delete(processingTask);
            // logger.debug(`Task for message ${msg.fields.deliveryTag} finished. Active tasks remaining: ${activeMoverProcessingTasks.size}`); // Optional: debug tracking
        });
        // Note: We do NOT await processingTask here. The consume callback should be fast to allow
        // processing subsequent messages, as long as we limit concurrency elsewhere if needed.

        }, {
            noAck: false // Manual acknowledgement is required
        });

        // Store the consumer tag
        moverConsumerTag = consumeResult.consumerTag;
        logger.info(`Listener started consuming messages with consumer tag: ${moverConsumerTag}.`);

    } catch (setupError) {
        logger.error('Failed to setup Mover Event Listener.', {
            error: setupError.message,
            stack: setupError.stack
        });
        throw new Error('Failed to setup Mover Event Listener: ' + setupError.message);
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
    if (moverConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        logger.info(`Attempting to cancel MQ consumer with tag: ${moverConsumerTag}`);
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(moverConsumerTag);
            logger.info(`MQ consumer ${moverConsumerTag} cancelled successfully.`);
            moverConsumerTag = null; // Mark as cancelled
        } catch (err) {
            logger.error(`Error cancelling MQ consumer ${moverConsumerTag}. It might have already been cancelled or channel closed.`, {
                error: err.message
            });
        }
    } else {
        logger.warn('MQ consumer tag not found or already null, skipping cancellation.');
    }


    // 2. Wait for any currently processing message tasks to finish
    // The activeMoverProcessingTasks set holds promises from the consume callback.
    if (activeMoverProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeMoverProcessingTasks.size} active message processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = 30000; // Wait max 30 seconds for tasks to finish
        const tasksWait = Promise.allSettled(activeMoverProcessingTasks);
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
             logger.warn(`Timeout waiting for active message processing tasks after ${processingTimeout}ms.`);
             // Log remaining tasks if timeout occurs
             if (activeMoverProcessingTasks.size > 0) {
                 logger.warn(`Still ${activeMoverProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
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


    // 4. Close connections to external services (Databases, Message Queue, Temporary Storage)
  logger.info('Closing external connections...');
  // Use the close methods from ConfigService and MqService
  const connectionClosePromises = [
      ConfigService.sequelize ? ConfigService.sequelize.close().catch(err => logger.error('Error closing Config DB connection:', err.message)) : Promise.resolve(), // Config DB connection
      // Closing MQ connection also closes the channel. Explicit channel close first is fine.
      MqService.channel ? MqService.closeChannel().catch(err => logger.error('Error closing MQ Channel gracefully:', err.message)) : Promise.resolve(), // Close channel using MqService method
      MqService.connection ? MqService.closeConnection().catch(err => logger.error('Error closing MQ Connection gracefully:', err.message)) : Promise.resolve(), // Close connection using MqService method
      // Close Temporary Storage (Redis) connection
      TemporaryStorage.redisClient ? TemporaryStorage.close().catch(err => logger.error('Error closing Redis client gracefully:', err.message)) : Promise.resolve(), // Added TemporaryStorage close
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