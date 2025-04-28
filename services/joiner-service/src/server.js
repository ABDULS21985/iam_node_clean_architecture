// services/joiner-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env')
 });

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4002
const port = process.env.JOINER_PORT || 4002;
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry'); // Import axios-retry module
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // For structured logging


// --- Import Shared Services and Models ---
const ConfigService = require('../../../shared/configService'); // Adjust path as needed
const MqService = require('../../../shared/mqService');      // Adjust path as needed
// Access models if needed, though Joiner service might not interact directly with Core Data Model DB much
// const models = require('../../../shared/models'); // Not directly used here, but imported by ConfigService


// Import the Role Assignment Service (Assuming this service is stateless or initialized separately)
const roleAssignmentService = require('../../../shared/roleAssignmentService'); // Adjust path as needed


// --- Service Configuration ---
const serviceName = 'joiner-service'; // Service identifier for config and logging
let serviceConfigs = {}; // Object to hold loaded service configurations
let attributeToRoleMappingConfig = null; // Config for attribute-to-Role mapping


// --- Message Queue Configuration ---
// Define Message Queue details for consuming Joiner events
const IDENTITY_CHANGES_EXCHANGE = 'identity.changes'; // Exchange published to by ICS
const JOINER_QUEUE = 'joiner.events.queue'; // Queue specific to the Joiner service
const JOINER_ROUTING_KEY = 'joiner.new'; // Routing key for new joiner events published by ICS


// --- Worker State Management ---
let joinerConsumerTag = null; // To store the consumer tag for cancelling consumption during shutdown
const activeJoinerProcessingTasks = new Set(); // Track promises of ongoing message processing tasks
let isShuttingDown = false; // Flag for graceful shutdown state


// --- Setup Structured Logger (Winston) ---
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
            winston.format.printf(({ level, message, timestamp, service, stack }) => {
                // Access the formatted timestamp and other properties
                // The 'stack' property comes from the errors() format
                return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${stack ? '\n' + stack : ''}`;
            })
          )
        })
        // TODO: Add transports for centralized logging (e.g., ELK, Datadog, file rotation)
        // Example File transport (without colorization, standard format applied at logger level)
        // new winston.transports.File({
        //     filename: path.join(__dirname, '../../../../logs/error.log'),
        //     level: 'error',
        //     // Use printf here as well if you want a different file format,
        //     // or let the logger-level format handle it (default file format)
        //     format: winston.format.printf(({ level, message, timestamp, service, stack }) => {
        //         return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${stack ? '\n' + stack : ''}`;
        //     })
        // }),
      ],
    });
    
    logger.info('Logger initialized.');
    // ... rest of your code ...


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
 * Initializes all necessary components and starts the Joiner Service.
 */
async function startService() {
  try {
    logger.info('Starting service initialization...');

    // 1. Initialize Configuration Service and load configs for this service
    // This also connects to the Config Database where ConnectorConfigs, MappingConfigs, etc. live
    await ConfigService.init();
    logger.info('ConfigService initialized successfully.');

    // Load configurations specific to this service (e.g., Provisioning Service API URL, Attribute-to-Role Mapping name)
    // serviceConfigs will contain the mappingRules from the 'Joiner Service Configuration' entry
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
     // Check for essential config
     if (!serviceConfigs || typeof serviceConfigs.provisioningServiceApiUrl !== 'string' || !serviceConfigs.provisioningServiceApiUrl || typeof serviceConfigs.attributeToRoleMappingName !== 'string' || !serviceConfigs.attributeToRoleMappingName) {
          logger.error('Missing or invalid critical service configurations.', { required: ['provisioningServiceApiUrl', 'attributeToRoleMappingName'], loaded: serviceConfigs });
          throw new Error("Missing or invalid critical service configuration ('provisioningServiceApiUrl' and/or 'attributeToRoleMappingName')");
     }
    logger.info('Loaded service configurations.', { configKeys: Object.keys(serviceConfigs) }); // Avoid logging sensitive data


    // 2. Load the Attribute-to-Role Mapping config used by this service
    // Get the name of the mapping config from serviceConfigs
    const attributeToRoleMappingName = serviceConfigs.attributeToRoleMappingName;
    // Clear the cache for this mapping config to ensure we get the latest version
    // This is important if the mapping config is updated frequently or in a different service.
    const mappingCacheKey = ConfigService.mappingCacheKey(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);
    // Clear the cache for this specific mapping config
    ConfigService.clearCache(mappingCacheKey);
    // Use ConfigService to load the specific MappingConfig entry (leveraging its caching)
    // Mapping config for Attribute-to-Role mapping is global, so serviceName and sourceId are null in the lookup.
    attributeToRoleMappingConfig = await ConfigService.loadMappingConfig(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);

    // --- CORRECTED CHECK FOR MAPPING CONFIG STRUCTURE ---
    if (!attributeToRoleMappingConfig // Config entry wasn't found (shouldn't happen if ConfigService says Found: true)
        || !attributeToRoleMappingConfig.mappingRules // mappingRules object is missing
        || !attributeToRoleMappingConfig.mappingRules.attributeToRoleMapping // nested attributeToRoleMapping object is missing (based on setupConfigs structure)
        || !Array.isArray(attributeToRoleMappingConfig.mappingRules.attributeToRoleMapping.rules) // nested 'rules' property is missing or not an array
      ) {
         logger.error(`Attribute-to-Role Mapping Config "${attributeToRoleMappingName}" not found or incomplete (missing mappingRules, attributeToRoleMapping, or rules array). Joiner service cannot assign roles based on attributes.`);
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


    // 4. Set up Message Queue Consumer (the Joiner Event Listener)
    // Pass the loaded mapping config to the listener setup
    await setupJoinerEventListener(attributeToRoleMappingConfig);
    logger.info('Joiner Event Listener setup complete.');


    // 5. Set up Express server (Optional - for health check)
    app.get('/health', (req, res) => {
        // Basic health check - check Config DB connection, MQ status, potentially Provisioning API reachability
        const configDbReady = ConfigService.sequelize?.options ? true : false; // Basic check if sequelize initialized
        const mqReady = MqService.isReady; // Use MqService.isReady getter
        // TODO: Add check for connectivity to Provisioning Service API? (e.g., try a simple GET /health if available)
        // const provisioningApiUrl = serviceConfigs.provisioningServiceApiUrl; // Available here

        const health = {
            status: 'UP',
            configDb: configDbReady ? 'CONNECTED' : 'DISCONNECTED',
            mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
            // TODO: Add Provisioning API status check
        };
        const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED') ? 200 : 503;
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
    // Catch any errors during the service initialization phase (DB connection, MQ init etc.)
    logger.error('Failed to start service.', {
        error: error.message,
        stack: error.stack // Log the stack trace
    });
    // Exit process immediately if initialization fails
    process.exit(1);
  }
}


// --- Joiner Event Listener ---
/**
 * Sets up the Message Queue consumer for 'joiner.new' events.
 * This async function is called for each message received from the queue.
 * It processes the joiner event and triggers provisioning.
 * @param {object} attributeToRoleMappingConfig - The loaded mapping config for role determination.
 */
async function setupJoinerEventListener(attributeToRoleMappingConfig) {
     // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
     // Access the channel instance directly for topology assertions and consumption setup.
     // These assertions are idempotent and safe to retry on reconnects if MqService handles it.

     try {
         // Assert the exchange published to by ICS using MqService's method
         await MqService.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
         logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

         // Assert the queue specific to this Joiner service using MqService's method
         // Use a durable queue for reliability even if the service restarts.
         const queue = await MqService.assertQueue(JOINER_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
         logger.info(`Listener: Queue "${queue.queue}" asserted.`);

         // Bind the queue to the exchange using the 'joiner.new' routing key using MqService's method
         await MqService.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, JOINER_ROUTING_KEY);
         logger.info(`Listener: Queue "<span class="math-inline">\{queue\.queue\}" bound to exchange "</span>{IDENTITY_CHANGES_EXCHANGE}" with key "${JOINER_ROUTING_KEY}".`);


         // Start consuming messages from the queue
         // The onMessage callback is called by amqplib for each message.
         const consumer = await MqService.channel.consume(queue.queue, async (msg) => {
             // Check for null message which indicates consumer cancellation or channel closure
             if (msg === null) {
                 logger.warn('Listener channel closed by MQ while consuming. Consumer will stop.');
                 // MqService reconnection should handle re-establishing the consumer if needed
                 return; // Exit this specific message processing handler instance
             }

              // Wrap message processing in an async task that we can track for graceful shutdown
              const processingTask = (async () => {
                  let eventPayload = null;
                  let userId = null; // IGLM User ID from the event
                  let hrmsId = null; // HRMS ID from the event
                  let mappedUserData = null; // Mapped IGLM User data from ICS event
                  const messageCorrelationId = msg.properties.correlationId; // Get correlation ID for tracing
                  const messageRedelivered = msg.fields.redelivered; // Check if message is being redelivered

                  logger.info(`Listener received message ${msg.fields.deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag: msg.fields.deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


                  try {
                    // Parse the message payload (expected to be { userId: '...', hrmsId: '...', userData: {...} ... })
                    eventPayload = JSON.parse(msg.content.toString());
                    // Use userData from ICS event, as it's the mapped IGLM User object
                    userId = eventPayload.userId; // IGLM User ID created by ICS
                    hrmsId = eventPayload.hrmsId; // HRMS ID from ICS event
                    mappedUserData = eventPayload.userData; // The MAPPED IGLM User data from ICS

                    if (!userId || !hrmsId || !mappedUserData || typeof mappedUserData !== 'object') {
                        logger.error('Listener received malformed joiner event message: Missing essential data (userId, hrmsId, or mappedUserData).', { payload: eventPayload });
                        // Acknowledge malformed messages (permanent failure) using the channel from msg if available, or MqService.channel
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', ackErr); }
                        return; // Stop processing this message
                  }

                    logger.info(`Listener processing joiner event for user ID: ${userId} (HRMS ID: ${hrmsId}).`, { userId, hrmsId });

                    // --- Determine Initial Roles for the New User ---
                    // Use the mapped user data from ICS event as input for role determination
                    // Assuming roleAssignmentService is available and does not require async init or DB connection from Joiner server
                    const newDesiredRoles = await roleAssignmentService.determineRolesBasedOnMatrixRules(mappedUserData, attributeToRoleMappingConfig);

                    const rolesForProvisioning = Array.isArray(newDesiredRoles) ? newDesiredRoles : [];
                    logger.info(`Listener: Determined initial desired roles: ${rolesForProvisioning.join(', ')} for user ${userId}`, { userId, roles: rolesForProvisioning });


                    // --- Trigger Provisioning ---
                    const provisioningServiceApiUrl = serviceConfigs.provisioningServiceApiUrl; // Get from service configs

                    const desiredStatePayload = {
                        userId: userId, // IGLM User ID (UUID)
                        roles: rolesForProvisioning, // Array of IGLM Role names
                        // Include correlationId in the API call for tracing
                        correlationId: messageCorrelationId
                  };

                    logger.info(`Listener: Calling Provisioning Service API at ${provisioningServiceApiUrl}/provision to request provisioning for user ${userId}...`, { userId, provisioningApiUrl, payloadSample: { userId: desiredStatePayload.userId, roles: desiredStatePayload.roles } });

                    // Use axios.post with retry logic enabled globally. Axios-retry will handle transient errors.
                    // We await this call, including any retries configured in the global axiosRetry.
                    const response = await axios.post(`${provisioningServiceApiUrl}/provision`, desiredStatePayload);

                    if (response.status === 202) { // 202 Accepted means request was received and queued by Provisioning Service
                        logger.info(`Listener: Provisioning request accepted for user ${userId}. Task ID: ${response.data.taskId}.`, { userId, provisioningTaskId: response.data.taskId, correlationId: messageCorrelationId });
                        // TODO: Log or track the provisioning task ID associated with this joiner event in a local DB or log for audit.
                    } else {
                        // Axios-retry would have exhausted retries or it's a non-retryable status code (e.g., 400 Bad Request).
                        // This indicates a permanent failure for this message payload relative to the Provisioning Service API.
                        logger.error(`Listener: Provisioning API returned unexpected non-retryable status ${response.status} for user ${userId}. Acknowledging message as failed.`, { userId, status: response.status, responseData: response.data, payload: desiredStatePayload, correlationId: messageCorrelationId });
                        // Acknowledge the message to remove it from the queue, as it won't ever succeed with this payload/response.
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after non-retryable API status:', { userId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                        // TODO: Log this permanent processing failure properly (e.g., store in a dead letter queue or failure log).
                        return; // Stop processing this message task
                  }

                 // Acknowledge the message *only after* the entire processing (including API call potentially with retries) is successful.
                 // If any error occurred in the try block before this line, it would jump to the catch block and NACK.
                 try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after successful processing:', { userId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                 logger.info(`Listener successfully processed and acknowledged joiner event for user ID: ${userId}`, { userId, deliveryTag: msg.fields.deliveryTag });

             } catch (error) {
                 // Catch any errors that occurred during message processing (parsing, role assignment, or API call *after* axios-retry exhausts)
                 logger.error(`Listener error processing joiner event message for user ID ${userId || 'N/A'} (HRMS ID ${hrmsId || 'N/A'}):`, {
                     deliveryTag: msg.fields.deliveryTag,
                     correlationId: messageCorrelationId,
                     userId: userId || 'N/A', // Include user ID if known
                     hrmsId: hrmsId || 'N/A', // Include HRMS ID if known
                     error: error.message,
                     stack: error.stack, // Log the stack trace
                     // payload: eventPayload // Optional: Log the full payload on error, be mindful of sensitive data
                 });

                 // NACK the message. Setting `requeue: false` means the broker will not send it back to the queue immediately.
                 // It will go to a dead-letter exchange/queue if configured, which is the correct pattern for retries.
                 // If NACK fails, just log and move on.
                 try { MqService.channel.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to nack message after processing error:', { userId, deliveryTag: msg.fields.deliveryTag, nackErr: nackErr.message }); }
                 // TODO: Log this processing failure properly, potentially store failure details for reporting or manual review.
             } finally {
                 // --- Remove this task's promise from the set of active tasks ---
                 // This needs to happen AFTER the promise created by the outer async IIFE resolves/rejects
                 // This cannot be directly inside this inner finally block as the outer IIFE might still be running.
                 // The logic to add/remove should be outside this inner callback.
                 // This comment is slightly misleading based on the IIAFE pattern.
             }
         })(); // Execute the async message processing logic immediately

          // --- Track the message processing task for graceful shutdown ---
          activeJoinerProcessingTasks.add(processingTask);
          // Remove the task from the set when it completes (either resolves or rejects)
          processingTask.finally(() => {
              activeJoinerProcessingTasks.delete(processingTask);
              // logger.debug(`Task for message ${msg.fields.deliveryTag} finished. Active tasks remaining: ${activeJoinerProcessingTasks.size}`); // Optional: debug tracking
          });
         // Note: We do NOT await processingTask here. The consume callback should be fast to allow
         // processing subsequent messages, as long as we limit concurrency elsewhere if needed.


         }, {
             noAck: false // Crucial: We will manually acknowledge messages only after successful processing
         });

         joinerConsumerTag = consumer.consumerTag; // Store the consumer tag returned by channel.consume
         logger.info(`Listener started consuming messages from queue "<span class="math-inline">\{queue\.queue\}" with consumer tag "</span>{joinerConsumerTag}".`);

     } catch (setupError) {
          logger.error(`Failed to setup Joiner Event Listener:`, setupError);
          // This is a critical startup error - the listener cannot run.
          throw new Error('Failed to setup Joiner Event Listener: ' + setupError.message);
     }
}


// --- Graceful Shutdown Handling ---
// Listen for termination signals (e.g., from Docker/Kubernetes stop)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Handle Ctrl+C

// Graceful shutdown function
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn(`Shutdown already in progress. Received signal: ${signal}`);
    return;
  }
  isShuttingDown = true;
  logger.info(`${signal} received, starting graceful shutdown.`);

  // 1. Stop the MQ consumer from receiving NEW messages
  // Use the cancelConsumer method from MqService and the stored consumer tag
    if (joinerConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(joinerConsumerTag);
            logger.info(`MQ consumer "${joinerConsumerTag}" cancelled.`);
        } catch (err) {
            logger.error(`Error cancelling MQ consumer "${joinerConsumerTag}":`, err);
            // Decide if failure to cancel consumer is critical. Proceeding might be safer.
        }
    } else {
        logger.warn('MQ consumer not active (no consumer tag) or MqService not fully initialized. Skipping consumer cancellation.');
    }


  // 2. Wait for any currently processing message tasks to finish
  // The activeJoinerProcessingTasks set holds promises from the consume callback.
    if (activeJoinerProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeJoinerProcessingTasks.size} active message processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = 30000; // Wait max 30 seconds for tasks to finish
        const tasksWait = Promise.allSettled(activeJoinerProcessingTasks);
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
             logger.warn(`Timeout waiting for active message processing tasks after ${processingTimeout}ms.`);
             // Log remaining tasks if timeout occurs
             if (activeJoinerProcessingTasks.size > 0) {
                 logger.warn(`Still ${activeJoinerProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
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
      MqService.connection ? MqService.closeConnection().catch(err => logger.error('Error closing MQ Connection gracefully:', err.message)) : Promise.resolve() // Close connection using MqService method
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