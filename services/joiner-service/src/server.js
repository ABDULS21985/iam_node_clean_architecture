// services/joiner-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env') // Assuming .env is in the root directory
});

// --- Database Setup (for local JoinerRun tracking) ---
const { Sequelize } = require('sequelize');
const joinerConfig = require('../../../shared/config/config.js').joiner; // Assuming DB config is in shared/config/config.js
// Instantiate Sequelize for the local joiner database
const joinerSequelize = new Sequelize({ ...joinerConfig });
// Import and define the JoinerRun model using the local sequelize instance
const JoinerRun = require('../../../shared/models/joinerrun')(joinerSequelize, Sequelize.DataTypes); // Pass Sequelize.DataTypes


// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env (JOINER_PORT), default to 4002
const port = process.env.JOINER_PORT || 4002;
let server = null; // Keep track of the HTTP server instance

// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry'); // Import axios-retry module
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // For structured logging


// --- Import Shared Services and Modules ---
const ConfigService = require('../../../shared/configService'); // Adjust path as needed
const MqService = require('../../../shared/mqService'); // Adjust path as needed
// Removed unused TemporaryStorage import
// const TemporaryStorage = require('../../../shared/temporaryStorage'); // Removed

// Import the Role Assignment Service (Assuming this service is stateless or initialized separately)
const roleAssignmentService = require('../../../shared/roleAssignmentService'); // Adjust path as needed


// --- Service Configuration ---
const serviceName = 'joiner-service'; // Service identifier for config and logging
// Use const for serviceConfigs after initial load to prevent accidental reassignment
let serviceConfigs = null; // Object to hold loaded service configurations
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
// Initialize logger immediately so it's available for axiosRetry and early errors
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info', // Default to 'info', configurable via env var
    // Apply base formats at the logger level
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }), // Log stack traces
        winston.format.splat(), // Handle %s, %d, %j string interpolation
        // Use JSON format for structured logging (recommended for production)
        // Or use a custom printf format for console readability:
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
        // TODO: Add transports for centralized logging (e.g., ELK, Datadog, file rotation)
        // Example File transport (without colorization, standard format applied at logger level)
        // new winston.transports.File({
        //     filename: path.join(__dirname, '../../../../logs/joiner-error.log'),
        //     level: 'error',
        //      // If you want a different file format (e.g., not JSON), define printf here too
        //      // format: winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
        //      //     const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
        //      //     return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
        //      // })
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
        // Only retry if not shutting down and it's a retryable error
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
        const loadedServiceConfigs = await ConfigService.loadServiceConfigs(serviceName); // Load into a temporary variable first
        // Assign to module-scoped variable only after successful load and check
        serviceConfigs = loadedServiceConfigs;

        // Check for essential config BEFORE proceeding
        if (!serviceConfigs || typeof serviceConfigs.provisioningServiceApiUrl !== 'string' || !serviceConfigs.provisioningServiceApiUrl || typeof serviceConfigs.attributeToRoleMappingName !== 'string' || !serviceConfigs.attributeToRoleMappingName) {
            logger.error('Missing or invalid critical service configurations.', { required: ['provisioningServiceApiUrl', 'attributeToRoleMappingName'], loaded: serviceConfigs });
            throw new Error("Missing or invalid critical service configuration ('provisioningServiceApiUrl' and/or 'attributeToRoleMappingName')");
        }
        logger.info('Loaded service configurations.', { configKeys: Object.keys(serviceConfigs), provisioningUrlConfigured: !!serviceConfigs.provisioningServiceApiUrl }); // Avoid logging sensitive data


        // 2. Load the Attribute-to-Role Mapping config used by this service
        // Get the name of the mapping config from serviceConfigs
        const attributeToRoleMappingName = serviceConfigs.attributeToRoleMappingName;
        // Clear the cache for this mapping config to ensure we get the latest version
        // This is important if the mapping config is updated frequently or in a different service.
        // Using a standard key format assuming ConfigService provides this.
        const mappingCacheKey = ConfigService.mappingCacheKey(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);
        // Clear the cache for this specific mapping config
        ConfigService.clearCache(mappingCacheKey);
        // Use ConfigService to load the specific MappingConfig entry (leveraging its caching)
        // Mapping config for Attribute-to-Role mapping is assumed to be global or specific to source=null, service=null.
        const loadedMappingConfig = await ConfigService.loadMappingConfig(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);

        // Assign to module-scoped variable only after successful load and check
        attributeToRoleMappingConfig = loadedMappingConfig;

        // Check for Mapping Config existence and expected structure
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


        // 3. Initialize Message Queue Service
        // Pass the logger instance to MqService init
        await MqService.init(logger); // <-- Passed logger
        // Wait for MQ channel to be ready for operations before setting up consumer
        await MqService.waitForChannel();
        logger.info('Message Queue connected and channel ready.');

        // 4. Initialize local Joiner DB connection and sync model
        await joinerSequelize.authenticate();
        logger.info('Local Joiner DB connection authenticated.');
        // Sync the JoinerRun model - creates the table if it doesn't exist
        await JoinerRun.sync(); // no-op if table already exists
        logger.info('JoinerRun table ensured in local DB.');


        // 5. Set up Message Queue Consumer (the Joiner Event Listener)
        // Pass the loaded mapping config AND the required service configs (like API URL) to the listener setup
        // This ensures the message handler closure has direct access to the necessary configs.
        await setupJoinerEventListener(attributeToRoleMappingConfig, serviceConfigs); // <-- Passed attribute mapping AND service configs
        logger.info('Joiner Event Listener setup complete.');


        // 6. Set up Express server (Optional - for health check)
        app.get('/health', async (req, res) => { // Make health check async
            // Basic health check - check Config DB connection, MQ status, potentially Provisioning API reachability
            // Simplified check for Config DB - existence of sequelize instance suggests init ran and connection attempt was made
            const configDbReady = ConfigService.sequelize && ConfigService.isDbConnected ? 'CONNECTED' : 'DISCONNECTED'; // Check connection state if possible
            // Check local Joiner DB status
             let joinerDbStatus = 'UNKNOWN';
             try {
                 await joinerSequelize.authenticate(); // Attempt to authenticate local DB
                 joinerDbStatus = 'CONNECTED';
             } catch (dbErr) {
                 joinerDbStatus = 'DISCONNECTED';
                 logger.debug('Health check: Local Joiner DB unreachable.', { error: dbErr.message });
             }

            // Use MqService.isReady getter for MQ status
            const mqReady = MqService.isReady;
            // Check if consumer likely active (joinerConsumerTag is set and MQ channel is ready)
            const mqConsumerActive = !!joinerConsumerTag && MqService.isReady; // Use joinerConsumerTag

            // Add a check for the Provisioning API endpoint
            let provisioningApiStatus = 'UNKNOWN';
             // Check if serviceConfigs and the API URL property exist before attempting API check
            if (serviceConfigs && serviceConfigs.provisioningServiceApiUrl && typeof serviceConfigs.provisioningServiceApiUrl === 'string') {
                const apiUrl = serviceConfigs.provisioningServiceApiUrl;
                try {
                    // Perform a lightweight check, e.g., a GET on /health if available, or a small GET endpoint
                    // Avoid hitting a heavy endpoint. Using axios with short timeout and no retry for health check.
                    const apiCheckResponse = await axios.get(`${apiUrl}/health`, { timeout: 2000, axiosRetry: { retries: 0 } }); // Assuming /health exists
                    provisioningApiStatus = apiCheckResponse.status >= 200 && apiCheckResponse.status < 300 ? 'REACHABLE' : 'UNREACHABLE';
                } catch (apiError) {
                    provisioningApiStatus = 'UNREACHABLE';
                    logger.debug('Health check: Provisioning API unreachable.', { error: apiError.message }); // Log debug for health check
                }
            } else {
                 provisioningApiStatus = 'CONFIG_MISSING'; // Report config is missing for API check
                 logger.debug('Health check: Provisioning API URL config missing.');
            }


            const health = {
                status: 'UP', // Assume UP unless critical component is DOWN
                configDb: configDbReady,
                joinerDb: joinerDbStatus, // <-- Added Local Joiner DB status
                mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
                mqConsumer: mqConsumerActive ? 'ACTIVE' : 'INACTIVE', // Report consumer status
                provisioningApi: provisioningApiStatus, // <-- Added Provisioning API status
            };

            // Overall status degraded if Config DB, Joiner DB, MQ Service is not ready,
            // OR consumer is not active, OR Provisioning API is unreachable/config missing.
            const overallStatus = (health.configDb === 'CONNECTED' && health.joinerDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqConsumer === 'ACTIVE' && health.provisioningApi === 'REACHABLE') ? 200 : 503; // <-- Added Joiner DB, consumer and API to check
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
 * Uses MqService.subscribe to manage the consumer robustly.
 * @param {object} attributeToRoleMappingConfig - The loaded mapping config for role determination.
 * @param {object} serviceConfigs - The loaded service configurations (passed to the handler's scope).
 */
async function setupJoinerEventListener(attributeToRoleMappingConfig, serviceConfigs) { // <-- Accept serviceConfigs as parameter
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Assert the exchange published to by ICS using MqService's method
        // assertExchange includes an internal waitForChannel
        await MqService.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
        logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

        // Assert the queue specific to this Joiner service using MqService's method
        // Use a durable queue for reliability even if the service restarts.
        // assertQueue includes an internal waitForChannel
        const queue = await MqService.assertQueue(JOINER_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Listener: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the 'joiner.new' routing key using MqService's method
        // bindQueue includes an internal waitForChannel
        await MqService.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, JOINER_ROUTING_KEY);
        logger.info(`Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${JOINER_ROUTING_KEY}".`);


        // Start consuming messages from the queue using MqService.subscribe
        // Pass the message handling function. The serviceConfigs are available via closure from setupJoinerEventListener.
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
                let mappedUserData = null; // Mapped IGLM User data from ICS event
                 let runRecord = null; // Variable to hold the created JoinerRun record instance

                // Safely get identifiers from the message fields/properties
                const deliveryTag = msg.fields?.deliveryTag; // Use optional chaining
                const messageCorrelationId = msg.properties?.correlationId; // Use optional chaining
                const messageRedelivered = msg.fields?.redelivered; // Use optional chaining


                logger.info(`Listener received message ${deliveryTag}. Redelivered: ${messageRedelivered}. Correlation ID: ${messageCorrelationId}`, { deliveryTag, redelivered: messageRedelivered, correlationId: messageCorrelationId });


                try {
                    // --- Parse Message ---
                    try {
                        eventPayload = JSON.parse(msg.content.toString());
                    } catch (parseError) {
                        logger.error('Listener received message with invalid JSON payload.', { deliveryTag, parseError: parseError.message, payload: msg.content.toString(), correlationId: messageCorrelationId });
                        // ACK malformed messages to remove them permanently. Logged above.
                        // Use optional chaining for channel access during potential shutdown
                        try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', { deliveryTag, ackErr: ackErr.message, correlationId: messageCorrelationId }); }
                        return; // Stop processing this message
                    }

                    // --- Validate Payload Structure ---
                    userId = eventPayload.userId; // IGLM User ID created by ICS
                    hrmsId = eventPayload.hrmsId; // HRMS ID from ICS event
                    mappedUserData = eventPayload.userData; // The MAPPED IGLM User data from ICS

                    if (!userId || !hrmsId || !mappedUserData || typeof mappedUserData !== 'object') {
                        logger.error('Listener received malformed joiner event message: Missing essential data (userId, hrmsId, or mappedUserData).', { deliveryTag, payload: eventPayload, correlationId: messageCorrelationId });
                        // Acknowledge malformed messages (permanent failure)
                        try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ack malformed message:', { deliveryTag, ackErr: ackErr.message, correlationId: messageCorrelationId }); }
                        return; // Stop processing this message
                    }

                    logger.info(`Listener processing joiner event for user ID: ${userId} (HRMS ID: ${hrmsId}).`, { userId, hrmsId, deliveryTag, correlationId: messageCorrelationId });

                    // --- Determine Initial Roles for the New User ---
                    // attributeToRoleMappingConfig is available via closure from setupJoinerEventListener
                    const newDesiredRoles = await roleAssignmentService.determineRolesBasedOnMatrixRules(mappedUserData, attributeToRoleMappingConfig);

                    const rolesForProvisioning = Array.isArray(newDesiredRoles) ? newDesiredRoles : [];
                    logger.info(`Listener: Determined initial desired roles: ${rolesForProvisioning.join(', ')} for user ${userId}`, { userId, roles: rolesForProvisioning, deliveryTag, correlationId: messageCorrelationId });


                    // --- Persist Event Run Details BEFORE calling external API ---
                     try {
                         runRecord = await JoinerRun.create({
                             hrms_id: hrmsId,
                             user_id: userId,
                             routing_key: JOINER_ROUTING_KEY,
                             payload: eventPayload, // Store the full payload for audit/debugging
                             correlation_id: messageCorrelationId,
                             status: 'pending' // Initial status
                         });
                         logger.info('JoinerRun record created in DB.', { userId, hrmsId, joinerRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId });
                     } catch (dbCreateError) {
                          // If DB creation fails, log and NACK the message. This might indicate a DB issue.
                          logger.error('Failed to create JoinerRun record in DB. NACKing message.', {
                               userId,
                               hrmsId,
                               deliveryTag,
                               correlationId: messageCorrelationId,
                               error: dbCreateError.message,
                               stack: dbCreateError.stack
                          });
                          // NACK without requeue, rely on DLQ or manual intervention for DB issues.
                          try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to NACK message after DB creation error:', { deliveryTag, nackErr: nackErr.message, correlationId: messageCorrelationId }); }
                          return; // Stop processing this message
                     }


                    // --- Trigger Provisioning ---
                    // Get the API URL from the serviceConfigs passed into setupJoinerEventListener's closure
                    const provisioningServiceApiUrl = serviceConfigs.provisioningServiceApiUrl;

                    // Add a check here as a safeguard, although it should be guaranteed by startService init check
                    if (!provisioningServiceApiUrl) {
                         logger.error('Listener: CRITICAL: Provisioning Service API URL is missing in loaded service configs during message processing.', { userId, hrmsId, deliveryTag, correlationId: messageCorrelationId });
                         // Update DB record to failed before NACKing
                         if(runRecord) { // Only update if the record was created
                             try { await runRecord.update({ status: 'failed', error_message: 'Missing Provisioning API URL config.' }); logger.error('JoinerRun marked failed in DB due to missing API URL config.', { userId, joinerRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId }); }
                             catch(dbErr) { logger.error('Failed to update JoinerRun record to failed after missing API URL config error:', { userId, joinerRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId, error: dbErr.message }); }
                         }
                         // Treat as a permanent failure for this message due to critical config error
                         try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to nack message after missing API URL config error:', { userId, deliveryTag, nackErr: nackErr.message, correlationId: messageCorrelationId }); }
                         return; // Stop processing this message task
                    }


                    const desiredStatePayload = {
                        userId: userId, // IGLM User ID (UUID)
                        roles: rolesForProvisioning, // Array of IGLM Role names
                        // Include correlationId in the API call for tracing
                        correlationId: messageCorrelationId
                    };

                    logger.info(`Listener: Calling Provisioning Service API at ${provisioningServiceApiUrl}/provision to request provisioning for user ${userId}...`, { userId, provisioningApiUrl, payloadSample: { userId: desiredStatePayload.userId, roles: desiredStatePayload.roles }, deliveryTag, correlationId: messageCorrelationId });

                    // Use axios.post with retry logic enabled globally. Axios-retry will handle transient errors.
                    // We await this call, including any retries configured in the global axiosRetry.
                    const response = await axios.post(`${provisioningServiceApiUrl}/provision`, desiredStatePayload);

                    if (response.status === 202) { // 202 Accepted means request was received and queued by Provisioning Service
                        const taskId = response.data?.taskId; // Assuming API returns a task ID
                        logger.info(`Listener: Provisioning request accepted by Provisioning Service.`, { userId, provisioningTaskId: taskId, deliveryTag, correlationId: messageCorrelationId });
                        // TODO: Log or track the provisioning task ID associated with this joiner event in a local DB or log for audit.

                        // --- Update DB record on successful API call ---
                        if(runRecord) { // Only update if the record was created
                            try {
                                 await runRecord.update({ // Update the specific record instance
                                   status: 'completed',
                                   processed_at: new Date(),
                                   provisioning_task_id: taskId // Store the task ID
                                 });
                                 logger.info('JoinerRun marked completed in DB.', { userId, joinerRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId });
                            } catch (dbUpdateError) {
                                 logger.error('Failed to update JoinerRun record to completed in DB.', {
                                      userId,
                                      joinerRunId: runRecord?.id, // Use optional chaining if update failed before runRecord was set
                                      deliveryTag,
                                      correlationId: messageCorrelationId,
                                      error: dbUpdateError.message,
                                      stack: dbUpdateError.stack
                                 });
                                 // Decide how to handle this: Is it critical? API call succeeded, but DB update failed.
                                 // For robustness, we probably still want to ACK the MQ message, as the core task (triggering provisioning) succeeded.
                                 // A separate process might reconcile DB statuses. Log the error and proceed to ACK.
                            }
                        } else {
                            logger.warn('Could not update JoinerRun record to completed in DB, record was not created.', { userId, deliveryTag, correlationId: messageCorrelationId });
                        }


                    } else {
                        // Axios-retry would have exhausted retries or it's a non-retryable status code (e.g., 400 Bad Request).
                        // This indicates a permanent failure for this message payload relative to the Provisioning Service API.
                        logger.error(`Listener: Provisioning API returned unexpected non-retryable status ${response.status} for user ${userId}.`, { userId, status: response.status, responseData: response.data, payload: desiredStatePayload, deliveryTag, correlationId: messageCorrelationId });

                         // --- Update DB record on API error ---
                        // Only attempt to update if runRecord was created successfully
                         if (runRecord) {
                             try {
                                  await runRecord.update({
                                    status: 'failed',
                                    error_message: `API Error: ${response.status} - ${JSON.stringify(response.data)}`
                                  });
                                  logger.error('JoinerRun marked failed in DB due to API error.', { userId, joinerRunId: runRecord.id, deliveryTag, correlationId: messageCorrelationId });
                             } catch (dbUpdateError) {
                                  logger.error('Failed to update JoinerRun record to failed in DB after API error.', {
                                       userId,
                                       joinerRunId: runRecord.id,
                                       deliveryTag,
                                       correlationId: messageCorrelationId,
                                       error: dbUpdateError.message,
                                       stack: dbUpdateError.stack
                                  });
                             }
                         } else {
                             logger.warn('Could not update JoinerRun record in DB after API error, record was not created.', { userId, deliveryTag, correlationId: messageCorrelationId });
                         }

                        // NACK the message as processing failed permanently
                        try { MqService.channel?.nack(msg, false, false); } catch (nackError) { logger.error(`Failed to nack message after non-retryable API status.`, { userId, deliveryTag, nackError: nackError.message, correlationId: messageCorrelationId }); }
                        // TODO: Log this permanent processing failure properly (e.g., store in a dead letter queue or failure log).
                        return; // Stop processing this message task
                    }

                    // ACK only after successful processing (API call accepted and DB update attempted)
                    // If any error occurred in the try block before this line, it would jump to the catch block and NACK.
                    try { MqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ack message after successful processing:', { userId, deliveryTag, ackErr: ackErr.message, correlationId: messageCorrelationId }); }
                    logger.info(`Listener successfully processed and acknowledged joiner event for user ID: ${userId}`, { userId, deliveryTag, correlationId: messageCorrelationId });

                } catch (error) {
                    // Catch any errors that occurred during message processing (parsing, validation, role assignment, DB create errors if not caught above)
                    // or errors from axios after retries exhausted.
                    logger.error(`Listener error processing joiner event message for user ID ${userId || 'N/A'} (HRMS ID ${hrmsId || 'N/A'}):`, {
                        deliveryTag: deliveryTag || 'N/A', // Use the captured deliveryTag
                        correlationId: messageCorrelationId || 'N/A', // Use the captured correlationId
                        userId: userId || 'N/A', // Include user ID if known
                        hrmsId: hrmsId || 'N/A', // Include HRMS ID if known
                        error: error.message,
                        stack: error.stack, // Log the stack trace
                        // payload: eventPayload // Optional: Log the full payload on error, be mindful of sensitive data
                    });

                    // --- Update DB record on processing error ---
                    // Only attempt to update if runRecord was created successfully
                    if (runRecord) {
                        try {
                             await runRecord.update({
                               status: 'failed',
                               error_message: `Processing Error: ${error.message}`
                             });
                             logger.error('JoinerRun marked failed in DB due to processing error.', { userId: userId || 'N/A', joinerRunId: runRecord.id, deliveryTag: deliveryTag || 'N/A', correlationId: messageCorrelationId || 'N/A' });
                        } catch (dbUpdateError) {
                             logger.error('Failed to update JoinerRun record to failed in DB after processing error.', {
                                  userId: userId || 'N/A',
                                  joinerRunId: runRecord.id,
                                  deliveryTag: deliveryTag || 'N/A',
                                  correlationId: messageCorrelationId || 'N/A',
                                  error: dbUpdateError.message,
                                  stack: dbUpdateError.stack
                             });
                        }
                    } else {
                        logger.warn('Could not update JoinerRun record in DB after processing error, record was not created.', { userId: userId || 'N/A', deliveryTag: deliveryTag || 'N/A', correlationId: messageCorrelationId || 'N/A' });
                    }

                    // NACK the message without requeue
                    try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to nack message after processing error:', { userId: userId || 'N/A', deliveryTag: deliveryTag || 'N/A', nackErr: nackErr.message, correlationId: messageCorrelationId || 'N/A' }); }
                    // TODO: Log this processing failure properly, potentially store failure details for reporting or manual review.
                } finally {
                     // Remove the task from the set when it completes (either resolves or rejects)
                     // 'processingTask' is available via closure here
                     activeJoinerProcessingTasks.delete(processingTask);
                     // logger.debug(`Task for message ${deliveryTag || 'N/A'} finished. Active tasks remaining: ${activeJoinerProcessingTasks.size}`, { deliveryTag: deliveryTag || 'N/A', correlationId: messageCorrelationId || 'N/A' });
                }
            })(); // Execute the async message processing logic immediately

            // --- Track the message processing task for graceful shutdown ---
            // Add the promise to the set. The cleanup logic is now within the IIAFE's finally block.
            activeJoinerProcessingTasks.add(processingTask);

            // Note: We do NOT await processingTask here. The consume callback should be fast to allow
            // processing subsequent messages, as long as we limit concurrency elsewhere if needed.
            // Consider using channel.prefetch(count) to limit the number of unacknowledged messages this consumer receives at once.
            // This helps control concurrency and prevents overwhelming the worker.
            // Example: await MqService.channel.prefetch(10); // Before starting consume - should be done by MqService.subscribe internally if needed.


        }, {
            noAck: false // Crucial: We will manually acknowledge messages only after successful processing
        });

        // MqService.subscribe returns the consumer tag upon successful subscription
        joinerConsumerTag = consumeResult.consumerTag; // Store the consumer tag returned by MqService.subscribe
        logger.info(`Listener started consuming messages from queue "${queue.queue}" with consumer tag "${joinerConsumerTag}".`);

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

     // Emit a shutdown event from MqService first so components waiting on MQ state can react
    MqService.emit('shutdown');


    // 1. Stop the Express HTTP server (if running) from accepting new requests
    if (server) {
        logger.info('Stopping HTTP server...');
        await new Promise((resolve, reject) => server.close((err) => {
            if (err) {
                logger.error('Error stopping HTTP server:', { error: err.message });
                // Decide if HTTP server close failure is critical. Log and proceed.
                // It's better to let other shutdown steps continue.
                resolve(); // Resolve anyway
            } else {
                logger.info('HTTP server stopped.');
                resolve();
            }
        }));
    }


    // 2. Stop the MQ consumer from receiving NEW messages
    // Use the cancelConsumer method from MqService and the stored consumer tag
    // MqService.cancelConsumer already handles the check for isShuttingDown internally
    if (joinerConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        logger.info(`Attempting to cancel MQ consumer with tag: ${joinerConsumerTag}`);
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(joinerConsumerTag);
            logger.info(`MQ consumer "${joinerConsumerTag}" cancelled.`);
            // Note: MqService should manage the state of the consumer internally, no need to nullify joinerConsumerTag here.
        } catch (err) {
            // cancelConsumer should log its own errors, but log here too if needed.
            logger.error(`Error cancelling MQ consumer "${joinerConsumerTag}". It might have already been cancelled or channel closed.`, {
                consumerTag: joinerConsumerTag, error: err.message, stack: err.stack
            });
        }
    } else {
        logger.warn('MQ consumer not active (no consumer tag) or MqService not fully initialized. Skipping consumer cancellation.');
    }


    // 3. Wait for any currently processing message tasks to finish
    // The activeJoinerProcessingTasks set holds promises from the consume callback.
    if (activeJoinerProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeJoinerProcessingTasks.size} active message processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = parseInt(process.env.SHUTDOWN_TASK_TIMEOUT_MS, 10) || 30000; // Configurable timeout, default 30s
        const tasksWait = Promise.allSettled(Array.from(activeJoinerProcessingTasks)); // Convert Set to Array for allSettled
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
            logger.warn(`Timeout waiting for active message processing tasks after ${processingTimeout}ms.`);
            // Log remaining tasks if timeout occurs
            if (activeJoinerProcessingTasks.size > 0) {
                logger.warn(`Still ${activeJoinerProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
                // Optional: log details of remaining tasks
                // activeJoinerProcessingTasks.forEach(task => logger.warn('Remaining task for message:', task.messageInfo)); // If task promises stored message info
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
        // This handles cancelling consumers (if not already done), closing the channel, and closing the connection,
        // and prevents reconnects.
        await MqService.shutdown(); // <-- Using MqService.shutdown()
        logger.info('MQ service shut down gracefully.');
    } catch (mqShutdownError) {
        logger.error('Error during MQ service shutdown:', { error: mqShutdownError.message, stack: mqShutdownError.stack });
        // Log the error but proceed with other shutdowns.
    }


    // 5. Close connections to other external services (Databases)
    logger.info('Closing other external connections...');
    // Use the close methods from ConfigService and any other stateful connections
    const connectionClosePromises = [
        // Close Config DB connection (initialized by ConfigService)
        ConfigService.sequelize ? ConfigService.sequelize.close().then(() => logger.info('Config DB connection closed.')).catch(err => logger.error('Error closing Config DB connection:', err.message)) : (logger.debug('Config DB connection not initialized.'), Promise.resolve()), // Config DB connection
        // Close Local Joiner DB connection
         joinerSequelize ? joinerSequelize.close().then(() => logger.info('Local Joiner DB connection closed.')).catch(err => logger.error('Error closing Local Joiner DB connection:', err.message)) : (logger.debug('Local Joiner DB connection not initialized.'), Promise.resolve()), // <-- Added Local Joiner DB close
        // No TemporaryStorage to close based on the import.
        // TODO: If RoleAssignmentService or other shared modules manage connections (e.g., an external user directory connection pool), close them here.
        // Example: roleAssignmentService.shutdownConnections ? roleAssignmentService.shutdownConnections().catch(...) : Promise.resolve(),
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