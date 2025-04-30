// services/provisioning-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env') // Assuming .env is in the root directory
});

// --- Database Setup (for local ProvisioningRun tracking) ---
const { Sequelize } = require('sequelize');
const provisioningConfig = require('../../../shared/config/config.js').provisioning; // Add a provisioning config block in shared/config/config.js
// Instantiate Sequelize for the local provisioning database
const provSequelize = new Sequelize({ ...provisioningConfig });
// Import and define the ProvisioningRun model using the local sequelize instance
const ProvisioningRun = require('../../../shared/models/provisioningrun')(provSequelize, Sequelize.DataTypes); // Pass Sequelize.DataTypes


// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4005
const port = process.env.PROVISIONING_PORT || 4005;
let server = null; // Keep track of the HTTP server instance

// Add middleware to parse JSON request bodies
app.use(express.json());


// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API (e.g. health checks, if implemented) -- Note: This service *is* the Provisioning Service API, so axios here would be for calling *other* services.
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
const TemporaryStorage = require('../../../shared/temporaryStorage'); // <-- Corrected Import Path (assuming shared)
const models = require('../../../shared/models'); // Import all models (User, Application, ProvisioningTask etc.)

// Destructure models needed directly in this file (Task creation, User/App lookup for API validation)
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
// Initialize logger immediately so it's available for axiosRetry and early errors
const logger = winston.createLogger({ // <-- Initialized as const
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
                    const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : ''; // Nicer JSON formatting
                    return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? '\n' + metaString : ''}${stack ? '\n' + stack : ''}`;
                })
            )
        })
        // TODO: Add transports for centralized logging (e.g., File, DailyRotateFile, Syslog, HTTP, dedicated logging service transport)
        // new winston.transports.File({ filename: path.join(__dirname, '../../../../logs/provisioning-error.log'), level: 'error' }),
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
        return !isShuttingDown && (axiosRetry.isNetworkError(error) || axiosRetry.isRetryableError(error) || (error.response && error.response.status === 429)); // Added 429 retry
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
        await ConfigService.init(); // Assuming ConfigService init connects to its DB
        logger.info('ConfigService initialized successfully.');

        // Load configurations specific to this service (e.g., anything needed by the logic module)
        // Clear cache for service configs on startup (optional but safer if configs change)
        const serviceConfigCacheKey = ConfigService.mappingCacheKey(serviceName, 'Service', 'Service', serviceName, null); // Using mappingCacheKey for consistency
        if (ConfigService.clearCache && typeof ConfigService.clearCache === 'function') {
            ConfigService.clearCache(serviceConfigCacheKey);
            logger.debug(`Cleared ConfigService cache for key: ${serviceConfigCacheKey}`);
        } else {
            logger.warn(`ConfigService.clearCache(key) not available/exported. Cannot clear specific service cache key '${serviceConfigCacheKey}'.`);
        }
        serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);

        // Provisioning service specific configs might be needed here for the worker logic
        // E.g.: Task processing concurrency limit, default adapter types, etc.
        // Check for essential config ( a default adapter type or policy?)
        // if (!serviceConfigs || !serviceConfigs.someEssentialConfig) {
        //     logger.error('Missing essential service configurations.', { loadedConfigs: serviceConfigs });
        //     throw new Error("Missing essential service configuration");
        // }
        logger.info('Loaded service configurations.', { configKeys: Object.keys(serviceConfigs) }); // Avoid logging sensitive data


        // 2. Initialize Message Queue Service
        // Pass logger to MqService for its internal logging and robust handling
        await MqService.init(logger); // <-- Passed logger
        await MqService.waitForChannel(); // Wait for MQ channel to be ready
        logger.info('Message Queue connected and channel ready.');

        // MqService should add its own listeners for critical channel and connection errors internally using the logger it received.
        // Removed redundant console listeners here.


        // 3. Initialize Temporary Storage (Redis)
        // Provisioning Service might use it for rate limiting, distributed locks, or caching adapter connections
        await TemporaryStorage.init(); // Assuming init doesn't need logger or uses MqService's (less likely)
        logger.info('Temporary Storage initialized.');

        // 4. Initialize local Provisioning DB connection and sync model
        await provSequelize.authenticate();
        logger.info('Local Provisioning DB connection authenticated.');
        // Sync the ProvisioningRun model - creates the table if it doesn't exist
        await ProvisioningRun.sync(); // no-op if DB already has the table
        logger.info('ProvisioningRun table ensured in local DB.');


        // 5. Set up Message Queue Consumer (the Provisioning Task Worker)
        // This worker will listen for new provisioning tasks published to the queue
        await setupProvisioningTaskWorker(); // Will store consumer tag and track tasks internally
        logger.info('Provisioning Task Worker setup complete and consuming messages.');


        // 6. Set up Express server routes
        app.get('/health', async (req, res) => { // Made async for potential API checks
            // Basic health check - check Config DB connection, MQ status, Temporary Storage status, Worker status
            // Check Config DB connection state if possible
            const configDbReady = ConfigService.sequelize && ConfigService.isDbConnected ? 'CONNECTED' : 'DISCONNECTED'; // Assuming ConfigService has isDbConnected

            // Check local Provisioning DB status
             let provDbStatus = 'UNKNOWN';
             try {
                 await provSequelize.authenticate(); // Attempt to authenticate local DB
                 provDbStatus = 'CONNECTED';
             } catch (dbErr) {
                 provDbStatus = 'DISCONNECTED';
                 logger.debug('Health check: Local Provisioning DB unreachable.', { error: dbErr.message });
             }

            // Use MqService.isReady getter for MQ status
            const mqReady = MqService.isReady;
            // Check if worker consumer likely active (provisioningConsumerTag is set and MQ channel is ready)
            const mqWorkerActive = !!provisioningConsumerTag && MqService.isReady; // Check provisioningConsumerTag
            // Check Redis status - Assuming TemporaryStorage exposes isReady getter
            const tempStorageReady = TemporaryStorage.isReady ? 'CONNECTED' : 'DISCONNECTED'; // Assuming TemporaryStorage has isReady getter


            const health = {
                status: 'UP', // Assume UP unless critical component is DOWN
                configDb: configDbReady,
                provisioningDb: provDbStatus, // <-- Added Local Provisioning DB status
                mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
                mqWorker: mqWorkerActive ? 'ACTIVE' : 'INACTIVE', // Report worker status
                temporaryStorage: tempStorageReady, // <-- Added TemporaryStorage status
                // TODO: Add checks for connectivity to target applications if connections are pooled by ProvisioningLogic/Adapters
                // Check if ProvisioningLogic itself reports healthy internal state?
                // provisioningLogic: ProvisioningLogic.isReady ? 'READY' : 'NOT_READY', // If ProvisioningLogic has isReady state
            };

            // Determine overall HTTP status based on component health
            // Critical components: Config DB, Provisioning DB, MQ Service, Worker (to process tasks), Temp Storage (if required by logic)
            const overallStatus = (health.configDb === 'CONNECTED' && health.provisioningDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqWorker === 'ACTIVE' && health.temporaryStorage === 'CONNECTED') ? 200 : 503; // <-- Include prov DB, worker and temp storage

            if (overallStatus !== 200) {
                logger.warn('Health check reported degraded status.', health);
            } else {
                logger.debug('Health check reported healthy status.', health); // Use debug for frequent healthy checks
            }
            res.status(overallStatus).json(health);
        });

        // --- Provisioning API Endpoint (for Grants) ---
        // This is the main endpoint Joiner/Mover/Self-Service will call to request access changes (Grants based on roles)
        app.post('/provision', async (req, res) => {
            // Check shutdown flag before accepting new API requests for processing
            if (isShuttingDown) {
                logger.warn('Received provisioning request (Grant) during shutdown. Rejecting.');
                res.status(503).json({ message: 'Service is shutting down, please try again later.' });
                return;
            }
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
                     desiredState: { type: 'grant', payload: desiredState }, // Storing type in desiredState
                     status: 'pending', // Initial status is pending
                     startTime: new Date(),
                    // results, errorDetails will be null initially
                    // Add correlationId if available from the incoming request/message header or payload
                     metadata: { correlationId: req.headers['x-correlation-id'] || desiredState.correlationId }
                });
                logger.info(`Provisioning task created.`, { taskId: task.id, taskType: 'grant', userId: user.id });


                // 4. Publish a message to the Message Queue to trigger the worker.
                // Check MqService readiness before publishing
                if (!MqService.isReady) {
                    logger.error('MqService not ready. Cannot publish task message to MQ.');
                    // Fail the task immediately or mark it for retry/manual intervention
                    // For now, throw error to reject the API request. Worker should pick it up later if MQ recovers.
                    // Or update task status to failed/pending_retry and rely on a separate retry mechanism
                     await task.update({ status: 'pending_mq_publish', errorDetails: { message: 'MQ not ready for publish' } }); // Mark task state
                    throw new Error("Message Queue service is not ready.");
                }
                const taskMessagePayload = { taskId: task.id };
                // Publish to the tasks exchange/queue, worker logic will pick it up
                await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload).catch(publishErr => {
                     // Log publish errors specifically
                     logger.error(`Error publishing grant task ID ${task.id} to MQ:`, publishErr);
                     // If MQ publish fails *after* MqService.publish is called (e.g. channel closes during publish)
                     // Update task status here as well if it's not already in a final state
                     if (task && task.status === 'pending') { // Only update if still pending
                         try { task.update({ status: 'pending_mq_publish', errorDetails: { message: 'MQ publish failed', error: publishErr.message } }); }
                         catch (dbErr) { logger.error('Failed to update task status after MQ publish failure:', { taskId: task.id, dbErr: dbErr.message }); }
                     }
                     // Re-throw the publish error so the API endpoint returns 500
                     throw publishErr;
                });
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
                // If a task was created but MQ publish failed, the status is updated above.
                // Respond 500 for internal server errors after validation/DB interaction.
                res.status(500).json({ message: 'Failed to accept provisioning request', error: error.message, taskId: task?.id }); // Include task ID if created
            }
        });


        // --- Dedicated Revocation API Endpoint (for Revokes) ---
        // This endpoint receives explicit revocation requests (e.g., from Reconciliation)
        app.post('/provision/revoke', async (req, res) => {
            // Check shutdown flag before accepting new API requests for processing
            if (isShuttingDown) {
                logger.warn('Received revocation request during shutdown. Rejecting.');
                res.status(503).json({ message: 'Service is shutting down, please try again later.' });
                return;
            }
            logger.info(`Received explicit revocation request.`, { remoteAddress: req.ip, method: req.method, url: req.originalUrl }); // Log request details
            // The request body is expected to be a revocation payload structure
            //  payload from Reconciliation: { userId: '...', applicationId: '...', appSpecificUserId: '...', entitlementsToRevoke: [{ iglmEntitlementId: '...', appSpecificEntitlementId: '...', ... }], correlationId: '...' }
            const revocationRequestPayload = req.body;
            let task; // Variable to hold the created task

            try {
                // 1. Validate the revocation request payload.
                // userId can be null for orphaned accounts, but applicationId and entitlementsToRevoke are required.
                if (typeof revocationRequestPayload !== 'object' || !revocationRequestPayload // Basic shape check
                     || (revocationRequestPayload.userId !== null && revocationRequestPayload.userId !== undefined && typeof revocationRequestPayload.userId !== 'string') // userId must be null/undefined or string
                     || !revocationRequestPayload.applicationId // applicationId is required
                     || typeof revocationRequestPayload.applicationId !== 'string' // applicationId must be string (UUID)
                     || !revocationRequestPayload.entitlementsToRevoke // entitlementsToRevoke required
                     || !Array.isArray(revocationRequestPayload.entitlementsToRevoke) // entitlementsToRevoke must be array
                     || revocationRequestPayload.entitlementsToRevoke.length === 0 // entitlementsToRevoke must not be empty
                   ) {
                    logger.warn('Invalid revocation request payload.', { payload: revocationRequestPayload });
                    res.status(400).json({ message: 'Invalid revocation request payload: Missing/invalid userId (must be null/undefined or string), applicationId (string), or non-empty entitlementsToRevoke array.' });
                    return;
                }
                // TODO: More robust validation of entitlementsToRevoke array structure (each item must have appSpecificEntitlementId etc.)


                // 2. Validate User (if userId is not null/undefined) and Application existence
                // Note: User model might not be strictly needed here if worker handles it, but checking provides immediate feedback.
                let user = null;
                if (revocationRequestPayload.userId !== null && revocationRequestPayload.userId !== undefined) { // Check explicitly for null/undefined
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
                     desiredState: { type: 'revoke', payload: revocationRequestPayload }, // Storing type in desiredState
                     status: 'pending', // Initial status
                     startTime: new Date(),
                    // Add correlationId if available from the incoming request/message header or payload
                     metadata: { correlationId: req.headers['x-correlation-id'] || revocationRequestPayload.correlationId }
                });
                logger.info(`Revocation task created.`, { taskId: task.id, taskType: 'revoke', userId: task.userId, applicationId: task.applicationId });


                // 4. Publish a message to the Message Queue to trigger the worker.
                // Check MqService readiness before publishing
                if (!MqService.isReady) {
                    logger.error('MqService not ready. Cannot publish task message to MQ.');
                    // Fail the task immediately or mark it for retry/manual intervention
                    // Or update task status to failed/pending_retry and rely on a separate retry mechanism
                    // Attempt to update task status even if MQ is down
                     try { await task.update({ status: 'pending_mq_publish', errorDetails: { message: 'MQ not ready for publish' } }); }
                     catch (dbErr) { logger.error('Failed to update task status after MQ not ready:', { taskId: task.id, dbErr: dbErr.message }); }
                    throw new Error("Message Queue service is not ready."); // Throw to reject API request
                }
                const taskMessagePayload = { taskId: task.id };
                // Publish to the tasks exchange/queue, worker logic will pick it up
                await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload).catch(publishErr => {
                    // Log publish errors specifically
                    logger.error(`Error publishing revoke task ID ${task.id} to MQ:`, publishErr);
                    // If MQ publish fails *after* MqService.publish is called (e.g. channel closes during publish)
                    // Update task status here as well if it's not already in a final state
                    if (task && task.status === 'pending') { // Only update if still pending
                        try { task.update({ status: 'pending_mq_publish', errorDetails: { message: 'MQ publish failed', error: publishErr.message } }); }
                        catch (dbErr) { logger.error('Failed to update task status after MQ publish failure:', { taskId: task.id, dbErr: dbErr.message }); }
                    }
                    // Re-throw the publish error so the API endpoint returns 500
                    throw publishErr;
                });
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
                // If a task was created but MQ publish failed, the status is updated above.
                // Respond 500 for internal server errors after validation/DB interaction.
                res.status(500).json({ message: 'Failed to accept revocation request', error: error.message, taskId: task?.id }); // Include task ID if created
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

        // Start consuming messages from the queue using MqService.subscribe
        // MqService.subscribe manages the channel.consume call and consumer tag internally,
        // and handles re-establishing the consumer if the channel/connection is lost and restored.
        const consumeResult = await MqService.subscribe(queue.queue, async (msg) => { // <-- Use MqService.subscribe
            // Check for null message which indicates consumer cancellation or channel closure
            if (msg === null) {
                logger.warn('Worker: Consume callback received null message, indicating consumer cancellation or channel closure by MQ. Worker will stop consuming.');
                // MqService reconnection should handle re-establishing the consumer if needed
                return;
            }

            // If service is shutting down, do not process new messages even if received before cancellation signal fully propagated.
            if (isShuttingDown) { // <-- Check shutdown flag
                logger.warn(`Worker: Skipping message processing due to service shutdown. Message delivery tag: ${msg.fields.deliveryTag}`);
                // Decide how to handle messages received during shutdown. NACK without requeue is an option.
                // The cancelConsumer should handle pending messages, but this is a safeguard.
                try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK message during shutdown:', { deliveryTag: msg.fields.deliveryTag, nackErr: nackErr.message }); }
                return; // Stop processing this message
            }


            let messagePayload = null;
            let taskId = null; // The Task ID from the message
            let runRecord = null; // Variable to hold the created ProvisioningRun record instance

            const messageCorrelationId = msg.properties.correlationId; // Get correlation ID for tracing
            const messageRedelivered = msg.fields.redelivered; // Check if message is being redelivered
            const deliveryTag = msg.fields.deliveryTag;


            logger.info(`Worker received message ${deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


            // Wrap message processing in an async task that we can track for graceful shutdown
            const processingTask = (async () => { // <-- IIAFE pattern
                try {
                    // Parse the message payload (expected to be { taskId: '...' })
                    try {
                        messagePayload = JSON.parse(msg.content.toString());
                    } catch (parseError) {
                        logger.error('Worker received message with invalid JSON payload.', { deliveryTag, correlationId: messageCorrelationId, parseError: parseError.message, payload: msg.content.toString() });
                        // ACK malformed messages (permanent failure) - they can't be processed without a valid taskId
                        try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Worker: Failed to ack malformed task message:', { deliveryTag, correlationId: messageCorrelationId, ackErr: ackErr.message }); }
                        return; // Stop processing this message
                    }

                    taskId = messagePayload.taskId; // Extract the task ID from the message

                    if (!taskId || typeof taskId !== 'string') {
                        logger.error('Worker received malformed message: Missing or invalid taskId.', { deliveryTag, correlationId: messageCorrelationId, payload: messagePayload });
                        // ACK malformed messages (don't requeue)
                        try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK malformed message:', { deliveryTag, correlationId: messageCorrelationId, nackErr: nackErr.message }); }
                        return; // Stop processing this message
                    }

                    logger.info(`Worker attempting to process task ID: ${taskId}.`, { taskId, deliveryTag, correlationId: messageCorrelationId });

                    // --- Persist Worker Run Details BEFORE calling core logic ---
                    try {
                        runRecord = await ProvisioningRun.create({
                            task_id: taskId, // The shared task ID being processed
                            routing_key: PROVISIONING_TASK_ROUTING_KEY, // Or msg.fields.routingKey if needed
                            payload: messagePayload, // Store the message payload for audit/debugging
                            correlation_id: messageCorrelationId,
                            status: 'processing' // Initial status
                        });
                         logger.info('ProvisioningRun record created in local DB.', { taskId, provisioningRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId });
                    } catch (dbCreateError) {
                        // If local DB creation fails, log and NACK the message. This indicates a local DB issue.
                        logger.error('Failed to create ProvisioningRun record in local DB. NACKing message.', {
                             taskId,
                             deliveryTag,
                             correlationId: messageCorrelationId,
                             error: dbCreateError.message,
                             stack: dbCreateError.stack
                        });
                        // NACK without requeue, rely on DLQ or manual intervention for local DB issues.
                        // The shared ProvisioningTask status might still be 'pending', which is acceptable.
                        try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Worker: Failed to NACK message after local DB creation error:', { deliveryTag, correlationId: messageCorrelationId, nackErr: nackErr.message }); }
                        return; // Stop processing this message
                    }


                    // --- Call the core provisioning logic function ---
                    // This function is responsible for fetching the shared ProvisioningTask record,
                    // performing the actions, and updating the shared ProvisioningTask status.
                    const logicOptions = {
                         logger: logger,
                         isShuttingDown: isShuttingDown,
                         serviceConfigs: serviceConfigs,
                         configService: ConfigService,
                         mqService: MqService,
                         models: models, // Pass all models (ProvisioningTask is needed by logic)
                         temporaryStorage: TemporaryStorage,
                    };
                    // The processProvisioningTask function handles loading the task details by ID and updating its status in the shared DB.
                    // It is crucial that processProvisioningTask is robust and updates the shared task status appropriately on success/failure/retry.
                    await ProvisioningLogic.processProvisioningTask(taskId, logicOptions);


                    // --- Update local DB record on successful core logic execution ---
                    if(runRecord) { // Only update if the record was created
                        try {
                             await runRecord.update({ // Update the specific local record instance
                               status: 'completed',
                               processed_at: new Date(),
                               // Optionally store results/details from core logic execution in the local run record if returned
                               // results: logicResults.summary
                             });
                             logger.info('ProvisioningRun marked completed in local DB.', { taskId, provisioningRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId });
                        } catch (dbUpdateError) {
                             logger.error('Failed to update ProvisioningRun record to completed in local DB.', {
                                  taskId,
                                  provisioningRunId: runRecord?.id, // Use optional chaining if update failed before runRecord was set
                                  deliveryTag,
                                  correlationId: messageCorrelationId,
                                  error: dbUpdateError.message,
                                  stack: dbUpdateError.stack
                             });
                             // Log the error, but still ACK the MQ message as the core provisioning logic (which updates shared task status) succeeded.
                        }
                    } else {
                        logger.warn('Could not update ProvisioningRun record to completed in local DB, record was not created.', { taskId, deliveryTag, correlationId: messageCorrelationId });
                    }


                    // Acknowledge the MQ message *only after* the core provisioning logic completes successfully (and local DB is updated).
                    // If ProvisioningLogic.processProvisioningTask throws an error, it will jump to the catch block below.
                    try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Worker: Failed to ack task message after successful processing:', { taskId, deliveryTag, correlationId: messageCorrelationId, ackErr: ackErr.message }); }
                    logger.info(`Worker successfully processed and acknowledged task message for ID: ${taskId}.`, { taskId, deliveryTag, correlationId: messageCorrelationId });

                } catch (error) {
                    // Catch errors that occur *during* the core provisioning logic execution (e.g., DB error loading task, adapter error, etc.)
                    // The ProvisioningLogic.processProvisioningTask function should handle updating the *shared* ProvisioningTask status ('failed', 'retrying', etc.) before throwing.
                    logger.error(`Worker error processing task ID ${taskId || 'N/A'}.`, {
                        taskId: taskId || 'N/A',
                        error: error.message,
                        stack: error.stack,
                        deliveryTag: deliveryTag, // <-- Use captured delivery tag
                        correlationId: messageCorrelationId
                    });

                    // --- Update local DB record on processing error ---
                    // Only attempt to update if runRecord was created successfully
                    if (runRecord) {
                        try {
                             await runRecord.update({
                               status: 'failed',
                               error_message: `Processing Error: ${error.message}` // Include error from core logic
                             });
                             logger.error('ProvisioningRun marked failed in local DB.', { taskId: taskId || 'N/A', provisioningRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId });
                        } catch (dbUpdateError) {
                             logger.error('Failed to update ProvisioningRun record to failed in local DB after processing error.', {
                                  taskId: taskId || 'N/A',
                                  provisioningRunId: runRecord.id,
                                  deliveryTag,
                                  correlationId: messageCorrelationId,
                                  error: dbUpdateError.message,
                                  stack: dbUpdateError.stack
                             });
                        }
                    } else {
                        logger.warn('Could not update ProvisioningRun record in local DB after processing error, record was not created.', { taskId: taskId || 'N/A', deliveryTag, correlationId: messageCorrelationId });
                    }


                    // NACK the message without requeue - rely on DLQ/DLX strategy for retries
                    // This NACK signals to the broker that this delivery failed.
                    // The decision to retry the task should be managed by the DLQ setup or a separate retry mechanism, NOT immediate requeue.
                    try {
                         MqService.channel?.nack(msg, false, false); // NACK, don't requeue immediately
                    } catch (nackErr) {
                        logger.error(`Worker: Failed to NACK task message after processing error.`, { taskId: taskId || 'N/A', deliveryTag, correlationId: messageCorrelationId, nackErr: nackErr.message });
                    }
                    // TODO: Log processing failure details persistently for monitoring/manual intervention via DLQ.
                } finally {
                    // --- Remove this task's promise from the set of active tasks ---
                    activeProvisioningProcessingTasks.delete(processingTask); // Use Set.delete
                     // logger.debug(`Task for message ${deliveryTag} finished. Active tasks remaining: ${activeProvisioningProcessingTasks.size}`, { deliveryTag }); // Optional: debug tracking
                }
            })(); // Execute the async message processing logic immediately

            // --- Track the message processing task for graceful shutdown ---
            activeProvisioningProcessingTasks.add(processingTask); // Use Set.add
            // Removal happens in the finally block of the IIAFE above
            // The .finally() attached here is redundant as it's already handled in the IIAFE
            // processingTask.finally(() => {
            //     activeProvisioningProcessingTasks.delete(processingTask);
            //     // logger.debug(`Task for message ${deliveryTag} finished. Active tasks remaining: ${activeProvisioningProcessingTasks.size}`); // Optional: debug tracking
            // });
            // Note: We do NOT await processingTask here. The consume callback should be fast to allow
            // processing subsequent messages, as long as we limit concurrency elsewhere if needed.
            // Consider using channel.prefetch(count) to limit the number of unacknowledged messages this consumer receives at once.
            // This helps control concurrency and prevents overwhelming the worker.


        }, {
            noAck: false // Manual acknowledgement is required
        });

        // MqService.subscribe returns the consumer tag upon successful subscription
        provisioningConsumerTag = consumeResult.consumerTag; // Store the consumer tag returned by MqService.subscribe
        logger.info(`Worker started consuming messages from queue "${queue.queue}" with consumer tag "${provisioningConsumerTag}".`);

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

    const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30000; // Max time to wait (default 30 seconds)
    const shutdownStart = Date.now();
    let forceExitTimer;

    // Set a timer to force exit if graceful shutdown takes too long
    forceExitTimer = setTimeout(() => {
        logger.error(`Graceful shutdown timed out after ${shutdownTimeout}ms. Forcing exit.`);
        // TODO: Log timeout failure to centralized system
        process.exit(1); // Exit with error code
    }, shutdownTimeout);


    try {
        // 1. Stop Express HTTP server from accepting new requests
       if (server) {
            logger.info('Stopping HTTP server...');
            await new Promise((resolve) => { // Use resolve only, errors are logged but don't halt shutdown
                server.close((err) => {
                    if (err) {
                        logger.error('Error stopping HTTP server:', { error: err.message });
                    } else {
                        logger.info('HTTP server stopped.');
                    }
                    resolve(); // Always resolve to continue shutdown process
                });
            });
        }


        // 2. Stop the MQ worker consumer from accepting new messages
        // Use the cancelConsumer method from MqService and the stored consumer tag
        // MqService.cancelConsumer already handles the check for isShuttingDown internally
        if (provisioningConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
            logger.info(`Attempting to cancel MQ worker consumer with tag: ${provisioningConsumerTag}`);
            try {
                // Use MqService method to cancel the consumer. It handles channel checks internally.
                await MqService.cancelConsumer(provisioningConsumerTag); // Use MqService method
                logger.info(`MQ worker consumer ${provisioningConsumerTag} cancelled successfully.`);
                // Note: MqService should manage the state of the consumer internally, no need to nullify provisioningConsumerTag here.
            } catch (err) {
                // cancelConsumer should log its own errors, but log here too if needed.
                logger.error(`Error cancelling MQ worker consumer ${provisioningConsumerTag}. It might have already been cancelled or channel closed.`, {
                    consumerTag: provisioningConsumerTag, error: err.message, stack: err.stack
                });
            }
        } else {
            logger.warn('MQ worker consumer not active (no consumer tag) or MqService not fully initialized. Skipping consumer cancellation.');
        }


        // 3. Wait for any currently processing task messages to finish
        // The activeProvisioningProcessingTasks set holds promises from the consume callback.
        if (activeProvisioningProcessingTasks.size > 0) {
            logger.info(`Waiting for ${activeProvisioningProcessingTasks.size} active task processing tasks to finish...`);
            // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
            // Add a timeout for waiting to prevent hanging indefinitely
            const processingTimeout = parseInt(process.env.SHUTDOWN_TASK_TIMEOUT_MS, 10) || 30000; // Configurable timeout, default 30s
            const tasksWait = Promise.allSettled(Array.from(activeProvisioningProcessingTasks)); // Convert Set to Array for allSettled
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
            // Note: Any tasks that timed out will have their promises left in the set, but we proceed to close connections.
            // Closing MQ connections will interrupt any tasks still waiting for acks/nacks.
        } else {
            logger.info('No active task processing tasks to wait for.');
        }


        // 4. Shut down Message Queue gracefully
        logger.info('Initiating MQ service shutdown...');
        try {
            // Use the dedicated shutdown method from MqService
            // This handles cancelling consumers (if not already done), closing the channel, and closing the connection,
            // and prevents reconnects.
            await MqService.shutdown(); // <-- Using MqService.shutdown()
            logger.info('MQ service shut down gracefully.');
        } catch (mqShutdownError) {
            logger.error('Error during MQ service shutdown:', { error: mqShutdownError.message, stack: mqShutdownError.stack });
            // Log the error but proceed with other shutdowns.
        }


        // 5. Close connections to external services (Databases, Temporary Storage, Target Apps)
 logger.info('Closing other external connections...');
 // Use the close methods from ConfigService, TemporaryStorage, ProvisioningLogic (for target app connections), and the local Provisioning DB
 const connectionClosePromises = [
      // Close Config DB connection (initialized by ConfigService)
      ConfigService.sequelize ? ConfigService.sequelize.close().then(() => logger.info('Config DB connection closed.')).catch(err => logger.error('Error closing Config DB connection:', err.message)) : (logger.debug('Config DB connection not initialized.'), Promise.resolve()), // Config DB connection
      // Close Local Provisioning DB connection
      provSequelize ? provSequelize.close().then(() => logger.info('Local Provisioning DB connection closed.')).catch(err => logger.error('Error closing Local Provisioning DB connection:', err.message)) : (logger.debug('Local Provisioning DB connection not initialized.'), Promise.resolve()), // <-- Added Local Provisioning DB close
      // Close Temporary Storage (Redis) connection
      // Assuming TemporaryStorage has a close method and isReady getter
      TemporaryStorage.isReady && TemporaryStorage.close ? TemporaryStorage.close().then(() => logger.info('Temporary Storage (Redis) client closed.')).catch(err => logger.error('Error closing Redis client gracefully:', err.message)) : (logger.debug('Temporary Storage (Redis) client not initialized or not ready.'), Promise.resolve()), // <-- Added TemporaryStorage close

      // Provisioning service manages connections to target applications - need to close those
      // Assume ProvisioningLogic has a method to close these connections, potentially async.
      // This call needs to happen here during graceful shutdown.
      ProvisioningLogic.shutdown ? ProvisioningLogic.shutdown().then(() => logger.info('ProvisioningLogic shutdown complete (e.g., closed adapter pools).')).catch(err => logger.error('Error shutting down ProvisioningLogic (e.g., closing adapter pools):', err.message)) : (logger.debug('ProvisioningLogic.shutdown method not found.'), Promise.resolve()), // <-- Added call to ProvisioningLogic shutdown
 ];

 await Promise.allSettled(connectionClosePromises); // Wait for all connection closures


 logger.info('Graceful shutdown complete.');
 process.exit(0); // Exit successfully

 } catch (shutdownError) { // <-- This catch block syntax is correct now
     // Catch any unexpected errors *during* the shutdown process
     logger.error('Error during graceful shutdown:', shutdownError);
     // TODO: Log shutdown failure to centralized system
     clearTimeout(forceExitTimer); // Clear the force exit timer
     process.exit(1); // Exit with error code
 }

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