// services/provisioning-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env')
 });

// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4005
const port = process.env.PROVISIONING_PORT || 4005;
let server = null; // Keep track of the HTTP server instance

// Add middleware to parse JSON request bodies
app.use(express.json());


// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API (e.g. health checks, if implemented)
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry');
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // Added for structured logging


// --- Import Internal Modules ---
// Import the provisioning logic module (it exports processProvisioningTask and potentially shutdown)
const ProvisioningLogic = require('./provisioningLogic'); // Adjust path as needed

// --- Import Shared Services and Models ---
const ConfigService = require('../../../shared/configService'); // Adjust the relative path as needed
const MqService = require('../../../shared/mqService');       // Adjust path as needed
const TemporaryStorage = require('../../../shared/temporaryStorage'); // <-- Added TemporaryStorage import
const models = require('../../../shared/models'); // Import all models (User, Application, ProvisioningTask etc.)

// Destructure models needed directly in this file (Task creation, User/App lookup)
const { ProvisioningTask, User, Application } = models;


// Define the service name for config loading and logging
const serviceName = 'provisioning-service';
let serviceConfigs = {}; // Object to hold loaded service configurations


// Define Message Queue names for provisioning tasks
const PROVISIONING_TASKS_EXCHANGE = 'provisioning.tasks'; // Exchange published to by the API endpoints
const PROVISIONING_TASKS_QUEUE = 'provisioning.tasks.queue'; // Queue for provisioning tasks worker to consume
const PROVISIONING_TASK_ROUTING_KEY = 'task.new'; // Routing key for new tasks published


// --- Worker State Management ---
let provisioningConsumerTag = null; // To store the consumer tag for cancelling consumption during shutdown
const activeProvisioningProcessingTasks = new Set(); // Track promises of ongoing message processing tasks for shutdown
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
    //     filename: path.join(__dirname, '../../../../logs/provisioning-error.log'), // Adjusted path
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
// Apply retry logic to the axios instance for API calls TO other services (e.g., potentially calling back to IGLM API or other external services if needed)
// Note: Provisioning Service ITSELF is called via API, so this is for its OUTBOUND calls.
axiosRetry(axios, {
    retries: 3, // Number of retry attempts
    retryDelay: axiosRetry.ExponentialBackoff, // Use exponential backoff for delays between retries
    // retryCondition is optional, default is to retry on network errors and 5xx status codes.
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
 * Initializes all necessary components and starts the Provisioning Service.
 */
async function startService() {
  try {
    logger.info('Starting service initialization...');

    // 1. Initialize Configuration Service and load configs for this service
    // This also connects to the Config Database where ConnectorConfigs, MappingConfigs, etc. live
    await ConfigService.init();
    logger.info('ConfigService initialized successfully.');

    // Load configurations specific to this service (e.g., anything needed by the logic module)
    // Clear cache for service configs on startup (optional but safer if configs change)
    const serviceConfigCacheKey = ConfigService.mappingCacheKey(serviceName, 'Service', 'Service', serviceName, null); // Using mappingCacheKey for consistency
    ConfigService.clearCache(serviceConfigCacheKey);
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);

    // Provisioning service specific configs might be needed here for the worker logic
    // : Task processing concurrency limit, etc.
    // Check for essential config ( a default adapter type or policy?)
    // if (!serviceConfigs || !serviceConfigs.someEssentialConfig) {
    //     logger.error('Missing essential service configurations.', { loadedConfigs: serviceConfigs });
    //     throw new Error("Missing essential service configuration");
    // }
    logger.info('Loaded service configurations.', { configKeys: Object.keys(serviceConfigs) }); // Avoid logging sensitive data


    // 2. Initialize Message Queue Service
    await MqService.init();
    // Wait for MQ channel to be ready for operations before setting up consumer
    await MqService.waitForChannel();
    logger.info('Message Queue connected and channel ready.');

    // 3. Initialize Temporary Storage (Redis)
    // Provisioning Service might use it for rate limiting, distributed locks, or caching adapter connections
    await TemporaryStorage.init(); // <-- Added TemporaryStorage init
    logger.info('Temporary Storage initialized.');


    // 4. Set up Message Queue Consumer (the Provisioning Task Worker)
    // This worker will listen for new provisioning tasks published to the queue
    await setupProvisioningTaskWorker();
    logger.info('Provisioning Task Worker setup complete and consuming messages.');


    // 5. Set up Express server routes
    app.get('/health', (req, res) => {
        // Basic health check - check Config DB connection, MQ status, Temporary Storage status
        // Simplified check for Config DB - existence of sequelize instance suggests init ran
        const configDbReady = ConfigService.sequelize?.options ? true : false;
        // Use MqService.isReady getter for MQ status
        const mqReady = MqService.isReady;
        // Check if worker consumer likely active (provisioningConsumerTag is set and MQ channel is ready)
        const mqConsumerActive = !!provisioningConsumerTag && MqService.isReady; // Use provisioningConsumerTag
        // Check Redis status
        const tempStorageReady = TemporaryStorage.redisClient && TemporaryStorage.redisClient.status === 'ready'; // <-- Added Redis check

        const health = {
            status: 'UP',
            configDb: configDbReady ? 'CONNECTED' : 'DISCONNECTED',
            mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
            mqWorker: mqConsumerActive ? 'ACTIVE' : 'INACTIVE', // Report worker status
            temporaryStorage: tempStorageReady ? 'CONNECTED' : 'DISCONNECTED', // <-- Added Redis status
            // TODO: Add checks for connectivity to target applications if connections are pooled by ProvisioningLogic/Adapters
        };
        // Degraded if Config DB or MQ Service or Temp Storage is not ready, or worker is not active
        const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqWorker === 'ACTIVE' && health.temporaryStorage === 'CONNECTED') ? 200 : 503;
        if (overallStatus !== 200) {
            logger.warn('Health check reported degraded status.', health);
        }
        res.status(overallStatus).json(health);
    });

    // --- Provisioning API Endpoint (for Grants) ---
    // This is the main endpoint Joiner/Mover/Self-Service will call to request access changes (Grants based on roles)
    app.post('/provision', async (req, res) => {
        logger.info(`Received provisioning request (Grant).`, { remoteAddress: req.ip, method: req.method, url: req.originalUrl }); // Log request details
        // The request body is expected to contain the "desired state" { userId: '...', roles: [...] }
        const desiredState = req.body;
        let task; // Variable to hold the created task

        try {
            // 1. Validate the desiredState input for a Grant task.
            if (!desiredState || typeof desiredState !== 'object' || !desiredState.userId || !Array.isArray(desiredState.roles)) {
                logger.warn('Invalid provisioning request payload.', { payload: desiredState });
                res.status(400).json({ message: 'Invalid provisioning request payload: Missing userId or roles array.' });
                return;
            }
            // TODO: More robust validation of desiredState structure and content for Grants

            // 2. Find the user in our Core Data Model to ensure userId is valid
            // Note: Provisioning Service might not need models loaded here if it relies on worker logic.
            // But checking here provides immediate feedback to the caller.
            if (!User) {
                logger.error('User model not available in Provisioning API.');
                throw new Error("User model not available for validation.");
            }
            const user = await User.findByPk(desiredState.userId);
            if (!user) {
                logger.warn('Provisioning request for unknown user.', { userId: desiredState.userId });
                res.status(404).json({ message: `User not found with ID: ${desiredState.userId}` });
                return;
            }
            logger.info(`Validated grant request for user ${user.hrmsId} (ID: ${user.id})`);


            // 3. Create a new ProvisioningTask entry (status: 'pending', type: 'grant').
            // *** Requires adding a 'taskType' column to the ProvisioningTask model/migration ***
            // Store type in desiredState payload + potentially metadata.
            if (!ProvisioningTask) {
                logger.error('ProvisioningTask model not available in Provisioning API.');
                throw new Error("ProvisioningTask model not available.");
            }
            task = await ProvisioningTask.create({
                 userId: user.id, // Link task to the User ID (from IGLM DB)
                 // Store the full requested state payload and indicate type
                 desiredState: { type: 'grant', payload: desiredState },
                 status: 'pending', // Initial status is pending
                 startTime: new Date(),
                 // results, errorDetails will be null initially
                 // Add correlationId if available from the incoming request/message header
                 metadata: { correlationId: req.headers['x-correlation-id'] || desiredState.correlationId }
            });
            logger.info(`Provisioning task created.`, { taskId: task.id, taskType: 'grant', userId: user.id });


            // 4. Publish a message to the Message Queue to trigger the worker.
            const taskMessagePayload = { taskId: task.id };
            // Publish to the same queue, the worker logic will check the task type from the task record
            // MqService.publish is resilient and waits for the channel internally
            await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload);
            logger.info(`Published grant task ID ${task.id} to MQ.`, { taskId: task.id });


            // 5. Respond immediately with the task ID (202 Accepted).
            res.status(202).json({ message: 'Provisioning request accepted, task queued', taskId: task.id });


        } catch (error) {
            logger.error(`Error processing grant provisioning request for user ${desiredState?.userId || 'N/A'}.`, {
                userId: desiredState?.userId || 'N/A',
                error: error.message,
                stack: error.stack,
                payloadSnippet: JSON.stringify(desiredState).substring(0, 200) + '...' // Log snippet of payload
            });
            res.status(500).json({ message: 'Failed to accept provisioning request', error: error.message });
        }
    });


    // --- Dedicated Revocation API Endpoint (for Revokes) ---
    // This endpoint receives explicit revocation requests (e.g., from Reconciliation)
    app.post('/provision/revoke', async (req, res) => {
        logger.info(`Received explicit revocation request.`, { remoteAddress: req.ip, method: req.method, url: req.originalUrl }); // Log request details
        // The request body is expected to be a revocation payload structure
        //  payload from Reconciliation: { userId: '...', applicationId: '...', appSpecificUserId: '...', entitlementsToRevoke: [{ iglmEntitlementId: '...', appSpecificEntitlementId: '...', ... }], correlationId: '...' }
        const revocationRequestPayload = req.body;
        let task; // Variable to hold the created task

        try {
            // 1. Validate the revocation request payload.
            // userId can be null for orphaned accounts, but applicationId and entitlementsToRevoke are required.
            if (typeof revocationRequestPayload !== 'object' || !revocationRequestPayload // Basic shape check
                 || (revocationRequestPayload.userId !== null && typeof revocationRequestPayload.userId !== 'string') // userId must be null or string
                 || !revocationRequestPayload.applicationId // applicationId is required
                 || typeof revocationRequestPayload.applicationId !== 'string' // applicationId must be string (UUID)
                 || !revocationRequestPayload.entitlementsToRevoke // entitlementsToRevoke required
                 || !Array.isArray(revocationRequestPayload.entitlementsToRevoke) // entitlementsToRevoke must be array
                 || revocationRequestPayload.entitlementsToRevoke.length === 0 // entitlementsToRevoke must not be empty
               ) {
                logger.warn('Invalid revocation request payload.', { payload: revocationRequestPayload });
                res.status(400).json({ message: 'Invalid revocation request payload: Missing/invalid userId (must be null or string), applicationId (string), or non-empty entitlementsToRevoke array.' });
                return;
            }
            // TODO: More robust validation of entitlementsToRevoke array structure (each item must have appSpecificEntitlementId etc.)


            // 2. Validate User (if userId is not null) and Application existence
            // Note: User model might not be strictly needed here if worker handles it, but checking provides immediate feedback.
            let user = null;
            if (revocationRequestPayload.userId !== null) {
                 if (!User) { logger.error('User model not available in Provisioning API (revoke).'); throw new Error("User model not available."); }
                 user = await User.findByPk(revocationRequestPayload.userId);
                 if (!user) {
                      logger.warn('Revocation request for unknown user ID.', { userId: revocationRequestPayload.userId });
                      res.status(404).json({ message: `User not found with ID: ${revocationRequestPayload.userId}` });
                      return;
                 }
            }
            // Note: Application model might not be strictly needed here if worker handles it, but checking provides immediate feedback.
            if (!Application) { logger.error('Application model not available in Provisioning API (revoke).'); throw new Error("Application model not available."); }
            const application = await Application.findByPk(revocationRequestPayload.applicationId);
             if (!application) {
                  logger.warn('Revocation request for unknown application ID.', { applicationId: revocationRequestPayload.applicationId });
                  res.status(404).json({ message: `Application not found with ID: ${revocationRequestPayload.applicationId}` });
                  return;
             }
            logger.info(`Validated revocation request for user ${user?.hrmsId || 'Orphan'} (ID: ${revocationRequestPayload.userId || 'N/A'}) for Application ${application.name} (ID: ${revocationRequestPayload.applicationId}).`, { userId: revocationRequestPayload.userId, applicationId: revocationRequestPayload.applicationId });


            // 3. Create a new ProvisioningTask entry for revocation (status: 'pending', type: 'revoke').
            // *** Requires adding a 'taskType' column to the ProvisioningTask model/migration ***
            // For now, store type in desiredState payload.
            if (!ProvisioningTask) {
                logger.error('ProvisioningTask model not available in Provisioning API (revoke).');
                throw new Error("ProvisioningTask model not available.");
            }
            task = await ProvisioningTask.create({
                 userId: revocationRequestPayload.userId, // Link to User (null for orphans)
                 applicationId: revocationRequestPayload.applicationId, // Link to Application
                 // Store the explicit revocation payload and indicate type
                 desiredState: { type: 'revoke', payload: revocationRequestPayload },
                 status: 'pending', // Initial status
                 startTime: new Date(),
                 // Add correlationId if available from the incoming request/message header
                 metadata: { correlationId: req.headers['x-correlation-id'] || revocationRequestPayload.correlationId }
            });
            logger.info(`Revocation task created.`, { taskId: task.id, taskType: 'revoke', userId: task.userId, applicationId: task.applicationId });


            // 4. Publish a message to the Message Queue to trigger the worker.
            const taskMessagePayload = { taskId: task.id };
            // Publish to the same queue, the worker logic will check the task type from the task record
            // MqService.publish is resilient and waits for the channel internally
            await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload);
            logger.info(`Published revoke task ID ${task.id} to MQ.`, { taskId: task.id });


            // 5. Respond immediately with the task ID (202 Accepted).
            res.status(202).json({ message: 'Revocation request accepted, task queued', taskId: task.id });


        } catch (error) {
            logger.error(`Error processing revocation request for user ${revocationRequestPayload?.userId || 'N/A'} for application ${revocationRequestPayload?.applicationId || 'N/A'}.`, {
                userId: revocationRequestPayload?.userId || 'N/A',
                applicationId: revocationRequestPayload?.applicationId || 'N/A',
                error: error.message,
                stack: error.stack,
                 payloadSnippet: JSON.stringify(revocationRequestPayload).substring(0, 200) + '...' // Log snippet of payload
            });
            res.status(500).json({ message: 'Failed to accept revocation request', error: error.message });
        }
    });


    // TODO: Add other endpoints (e.g., GET /provision/:taskId for status)


    // 6. Start the Express server listening for incoming requests
    server = app.listen(port, () => { // Store server instance for graceful shutdown
        logger.info(`Service listening on port ${port}`);
    });

    logger.info('Service initialization complete.');


  } catch (error) {
    // Catch any errors during the service initialization phase
    logger.error('Failed to start service.', {
        error: error.message,
        stack: error.stack
    });
    // Exit process immediately if initialization fails
    process.exit(1);
  }
}


// --- Provisioning Task Worker Setup ---
/**
 * Sets up the Message Queue consumer that acts as the Provisioning Task worker.
 * This worker listens to the queue and triggers the actual task processing logic.
 */
async function setupProvisioningTaskWorker() {
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Declare the exchange published to by the API endpoints using MqService's method
        await MqService.assertExchange(PROVISIONING_TASKS_EXCHANGE, 'topic', { durable: true });
        logger.info(`Worker: Exchange "${PROVISIONING_TASKS_EXCHANGE}" asserted.`);

        // Declare the queue for this worker to consume from using MqService's method
        // Use a durable queue for reliability. Configure DLQ/DLX if retries are needed via NACK.
        const queue = await MqService.assertQueue(PROVISIONING_TASKS_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Worker: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the routing key for new tasks using MqService's method
        await MqService.bindQueue(queue.queue, PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY);
        logger.info(`Worker: Queue "${queue.queue}" bound to exchange "${PROVISIONING_TASKS_EXCHANGE}" with key "${PROVISIONING_TASK_ROUTING_KEY}".`);

        // Start consuming messages from the queue
        // The onMessage callback is called by amqplib for each message.
        const consumeResult = await MqService.channel.consume(queue.queue, async (msg) => {
             // Check for null message which indicates consumer cancellation or channel closure
             if (msg === null) {
                 logger.warn('Worker: Consume callback received null message, indicating channel closure by MQ broker. Worker will stop consuming.');
                 // MqService reconnection should handle re-establishing the consumer if needed
                 return;
             }

             // Wrap message processing in an async task that we can track for graceful shutdown
             const processingTask = (async () => { // <-- IIAFE pattern
                let messagePayload = null;
                let taskId = null; // The Task ID from the message
                const messageCorrelationId = msg.properties.correlationId; // Get correlation ID for tracing
                const messageRedelivered = msg.fields.redelivered; // Check if message is being redelivered

                logger.info(`Worker received message ${msg.fields.deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag: msg.fields.deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


                try {
                    // Parse the message payload (expected to be { taskId: '...' })
                    messagePayload = JSON.parse(msg.content.toString());
                    taskId = messagePayload.taskId; // Extract the task ID from the message

                    if (!taskId || typeof taskId !== 'string') {
                        logger.error('Worker received malformed message: Missing or invalid taskId.', { payload: messagePayload });
                        // ACK malformed messages (permanent failure) - they can't be processed without a valid taskId
                        try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed task message:', ackErr); }
                        return; // Stop processing this message
                    }

                    logger.info(`Worker processing task ID: ${taskId}.`, { taskId });

                    // --- Call the core provisioning logic function ---
                    // Pass the taskId and necessary dependencies to the logic module
                    const logicOptions = {
                        configService: ConfigService, // Pass the initialized ConfigService
                        mqService: MqService,       // Pass the initialized MqService (for status events)
                        models: models,               // Pass all Sequelize models (ProvisioningTask, User, App, etc.)
                        temporaryStorage: TemporaryStorage, // Pass TemporaryStorage if logic/adapters need it
                        logger: logger,               // Pass the logger instance
                        // TODO: Add other dependencies like target app connection pools or adapters cache manager
                  };
                  // The processProvisioningTask function handles loading the task details by ID and updating its status in the DB.
                  await ProvisioningLogic.processProvisioningTask(taskId, logicOptions);


                  // Acknowledge the message *only after* successful processing by processProvisioningTask
                  // If processProvisioningTask throws an error, it will jump to the catch block below.
                  try { MqService.channel.ack(msg); } catch (ackErr) { logger.error('Failed to ack task message after successful processing:', { taskId, deliveryTag: msg.fields.deliveryTag, ackErr: ackErr.message }); }
                  logger.info(`Worker successfully processed and acknowledged task ID: ${taskId}.`, { taskId, deliveryTag: msg.fields.deliveryTag });

            } catch (error) {
                // Catch errors that occur *during* the processing of a specific task message (e.g., DB error, API call failure within logic, adapter error)
                logger.error(`Worker error processing task message for task ID ${taskId || 'N/A'}.`, {
                    taskId: taskId || 'N/A', // Include task ID if known
                    error: error.message,
                    stack: error.stack,
                    deliveryTag: msg.fields.deliveryTag,
                    correlationId: messageCorrelationId
                });

                // NACK without requeue - rely on DLQ/DLX strategy for retries
                // The worker logic (processProvisioningTask) should handle updating the Task status to 'failed' or 'retrying'.
                // This NACK signals to the broker that this delivery failed.
                try {
                    channel.nack(msg, false, false); // NACK, don't requeue immediately
                } catch (nackErr) {
                    logger.error(`Failed to NACK task message after processing error.`, { taskId: taskId || 'N/A', deliveryTag: msg.fields.deliveryTag, nackErr: nackErr.message });
                }
                // TODO: Log processing failure details persistently for monitoring/manual intervention via DLQ.
            } finally {
                 // --- Remove this task's promise from the set of active tasks ---
                 // This needs to happen AFTER the promise created by the outer async IIAFE resolves/rejects
                 // This comment is slightly misleading based on the IIAFE pattern.
             }
        })(); // Execute the async message processing logic immediately

         // --- Track the message processing task for graceful shutdown ---
        activeProvisioningProcessingTasks.add(processingTask);
        // Remove the task from the set when it completes (either resolves or rejects)
        processingTask.finally(() => {
            activeProvisioningProcessingTasks.delete(processingTask);
            // logger.debug(`Task for message ${msg.fields.deliveryTag} finished. Active tasks remaining: ${activeProvisioningProcessingTasks.size}`); // Optional: debug tracking
        });
        // Note: We do NOT await processingTask here. The consume callback should be fast to allow
        // processing subsequent messages, as long as we limit concurrency elsewhere if needed.

        }, {
            noAck: false // Manual acknowledgement is required
        });

        // Store the consumer tag
        provisioningConsumerTag = consumeResult.consumerTag;
        logger.info(`Worker started consuming messages with consumer tag: ${provisioningConsumerTag}.`);

    } catch (setupError) {
        logger.error('Failed to setup Provisioning Task Worker.', {
            error: setupError.message,
            stack: setupError.stack
        });
        throw new Error('Failed to setup Provisioning Task Worker: ' + setupError.message);
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
    if (provisioningConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        logger.info(`Attempting to cancel MQ worker consumer with tag: ${provisioningConsumerTag}`);
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(provisioningConsumerTag);
            logger.info(`MQ worker consumer ${provisioningConsumerTag} cancelled successfully.`);
            provisioningConsumerTag = null; // Mark as cancelled
        } catch (err) {
            logger.error(`Error cancelling MQ worker consumer ${provisioningConsumerTag}. It might have already been cancelled or channel closed.`, {
                error: err.message
            });
        }
    } else {
        logger.warn('MQ worker consumer tag not found or already null, skipping cancellation.');
    }


    // 2. Wait for any currently processing task messages to finish
    // The activeProvisioningProcessingTasks set holds promises from the consume callback.
    if (activeProvisioningProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeProvisioningProcessingTasks.size} active task processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = 30000; // Wait max 30 seconds for tasks to finish
        const tasksWait = Promise.allSettled(activeProvisioningProcessingTasks);
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
             logger.warn(`Timeout waiting for active task processing tasks after ${processingTimeout}ms.`);
             // Log remaining tasks if timeout occurs
             if (activeProvisioningProcessingTasks.size > 0) {
                 logger.warn(`Still ${activeProvisioningProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
             }
             resolve(); // Allow shutdown to proceed after timeout warning
        }, processingTimeout));

        await Promise.race([tasksWait, timeoutPromise]); // Wait for tasks OR timeout

        logger.info(`Finished waiting for active task processing tasks.`);
    } else {
        logger.info('No active task processing tasks to wait for.');
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


    // 4. Close connections to external services (Databases, Message Queue, Temporary Storage, Target Apps)
  logger.info('Closing external connections...');
  // Use the close methods from ConfigService, MqService, TemporaryStorage
  const connectionClosePromises = [
      ConfigService.sequelize ? ConfigService.sequelize.close().catch(err => logger.error('Error closing Config DB connection:', err.message)) : Promise.resolve(), // Config DB connection
      // Closing MQ connection also closes the channel. Explicit channel close first is fine.
      MqService.channel ? MqService.closeChannel().catch(err => logger.error('Error closing MQ Channel gracefully:', err.message)) : Promise.resolve(), // Close channel using MqService method
      MqService.connection ? MqService.closeConnection().catch(err => logger.error('Error closing MQ Connection gracefully:', err.message)) : Promise.resolve(), // Close connection using MqService method
      // Close Temporary Storage (Redis) connection
      TemporaryStorage.redisClient ? TemporaryStorage.close().catch(err => logger.error('Error closing Redis client gracefully:', err.message)) : Promise.resolve(),
      // Provisioning service manages connections to target applications - need to close those
      // Assume ProvisioningLogic has a method to close these connections.
       ProvisioningLogic.shutdown ? ProvisioningLogic.shutdown().catch(err => logger.error('Error shutting down ProvisioningLogic (e.g., closing adapter pools):', err.message)) : Promise.resolve(), // <-- Added call to ProvisioningLogic shutdown
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
  // 
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