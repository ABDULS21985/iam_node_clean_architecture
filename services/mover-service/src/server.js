// services/mover-service/src/server.js

// Load .env into process.env
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../../.env') // Assuming .env is in the root directory
});

// --- Database Setup (for local MoverRun tracking) ---
const { Sequelize } = require('sequelize');
// Assuming your mover-DB configuration is in shared/config/config.js under a 'moverAudit' key
const moverConfig = require('../../../shared/config/config.js').moverAudit; // Make sure to add 'moverAudit' config block
// Instantiate Sequelize for the local mover database
const auditSequelize = new Sequelize({ ...moverConfig });
// Import and define the MoverRunsAudit model using the local sequelize instance
// Pass Sequelize.DataTypes instead of the Sequelize class itself in newer versions
const MoverRunsAudit = require('../../../shared/models/moverrunsaudit')(auditSequelize, Sequelize.DataTypes);


// --- Node.js Core & Express Setup ---
const express = require('express');
const app = express();
// Use the port defined in .env (MOVER_PORT), default to 4003
const port = process.env.MOVER_PORT || 4003;
let server = null; // Keep track of the HTTP server instance


// --- Third-Party Libraries ---
const axios = require('axios'); // For calling the Provisioning Service API
// Use explicit require for axios-retry if it doesn't have default export in your setup
const axiosRetryModule = require('axios-retry');
const axiosRetry = axiosRetryModule.default || axiosRetryModule; // Safely get the function
const winston = require('winston'); // Added for structured logging


// --- Import Shared Services and Modules ---
const ConfigService = require('../../../shared/configService');
const MqService = require('../../../shared/mqService');
const TemporaryStorage = require('../../../shared/temporaryStorage'); // Correct path


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
// Initialize logger immediately so it's available for axiosRetry and early errors
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info', // Default to 'info', configurable via env var
    // Apply base formats at the logger level
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH::ss' }),
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
        // File transport (without colorization, standard format applied at logger level)
        // new winston.transports.File({
        //     filename: path.join(__dirname, '../../../../logs/mover-error.log'), // Adjusted path for mover service
        //     level: 'error',
        //      // If you want a different file format (e.g., not JSON), define printf here too
        //      // format: winston.format.combine(
        //      //     winston.format.timestamp({ format: 'YYYY-MM-DD HH::ss' }),
        //      //     winston.format.errors({ stack: true }),
        //      //     winston.format.splat(),
        //      //     winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
        //      //         const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
        //      //         return `${timestamp} [${service}] ${level.toUpperCase()}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
        //      //     })
        //      // )
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
        // Avoid logging sensitive URLs directly - just confirm existence
        logger.info('Loaded service configurations.', { provisioningUrlConfigured: !!serviceConfigs.provisioningServiceApiUrl });


        // 2. Load the Attribute-to-Role Mapping config used by this service
        // Get the name of the mapping config from serviceConfigs
        const attributeToRoleMappingName = serviceConfigs.attributeToRoleMappingName;
        // Clear the cache for this mapping config to ensure we get the latest version
        // Using a standard key format assuming ConfigService provides this.
        const mappingCacheKey = ConfigService.mappingCacheKey(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);
        ConfigService.clearCache(mappingCacheKey);
        // Use ConfigService to load the specific MappingConfig entry (leveraging its caching)
        // Mapping config for Attribute-to-Role mapping is assumed to be global or specific to source=null, service=null.
        attributeToRoleMappingConfig = await ConfigService.loadMappingConfig(attributeToRoleMappingName, 'UserAttributes', 'Roles', null, null);

        // Check for Mapping Config existence and expected structure
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


        // 3. Initialize Message Queue Service
        // Pass the logger instance to MqService init
        await MqService.init(logger); // <-- Passed logger
        // Wait for MQ channel to be ready for operations before setting up consumer
        await MqService.waitForChannel();
        logger.info('Message Queue connected and channel ready.');

        // 4. Initialize Temporary Storage (Redis)
        // Mover Service uses it for tracking active tasks or state across restarts (if implemented)
        await TemporaryStorage.init(); // Assuming init doesn't need logger or uses MqService's (less likely)
        logger.info('Temporary Storage initialized.');

        // 5. Initialize local Mover Audit DB connection and sync model
        await auditSequelize.authenticate();
        logger.info('Local Mover Audit DB connection authenticated.');
        // Sync the MoverRunsAudit model - creates the table if it doesn't exist
        await MoverRunsAudit.sync(); // ensures the audit table exists
        logger.info('MoverRunsAudit table ensured in local DB.');


        // 6. Set up Message Queue Consumer (the Mover Event Listener)
        // Pass the loaded mapping config and other necessary dependencies to the listener setup
        const moverListenerDependencies = {
            logger,
            isShuttingDown,
            serviceConfigs, // Includes provisioningServiceApiUrl
            configService: ConfigService,
            mqService: MqService,
            temporaryStorage: TemporaryStorage,
            roleAssignmentService: roleAssignmentService, // Role assignment logic
            attributeToRoleMappingConfig: attributeToRoleMappingConfig, // Mapping config
            moverRunsAuditModel: MoverRunsAudit // Pass the audit model
        };
        await setupMoverEventListener(moverListenerDependencies);
        logger.info('Mover Event Listener setup complete and consuming messages.');


        // 7. Set up Express server (Optional - for health check)
        app.get('/health', async (req, res) => { // Make health check async
            // Basic health check - check Config DB connection, MQ status, Temporary Storage status, potentially Provisioning API reachability
            // Check Config DB connection state if possible
            const configDbReady = ConfigService.sequelize && ConfigService.isDbConnected ? 'CONNECTED' : 'DISCONNECTED';

            // Check local Mover Audit DB status
             let moverAuditDbStatus = 'UNKNOWN';
             try {
                 await auditSequelize.authenticate(); // Attempt to authenticate local DB
                 moverAuditDbStatus = 'CONNECTED';
             } catch (dbErr) {
                 moverAuditDbStatus = 'DISCONNECTED';
                 logger.debug('Health check: Local Mover Audit DB unreachable.', { error: dbErr.message });
             }

            // Use MqService.isReady getter for MQ status
            const mqReady = MqService.isReady;
            // Check if consumer likely active (moverConsumerTag is set and MQ channel is ready)
            const mqConsumerActive = !!moverConsumerTag && MqService.isReady; // Use moverConsumerTag
            // Check Redis status - Assuming TemporaryStorage exposes a ready state or client status
            const tempStorageReady = TemporaryStorage.isReady ? 'CONNECTED' : 'DISCONNECTED'; // Use isReady getter if available

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
                moverAuditDb: moverAuditDbStatus, // <-- Added Local Mover Audit DB status
                mqService: mqReady ? 'CONNECTED' : 'DISCONNECTED',
                mqConsumer: mqConsumerActive ? 'ACTIVE' : 'INACTIVE', // Report consumer status
                temporaryStorage: tempStorageReady, // Added Redis status
                provisioningApi: provisioningApiStatus, // <-- Added Provisioning API status
            };

            // Overall status degraded if Config DB, Mover Audit DB, MQ Service, Temp Storage is not ready,
            // OR consumer is not active, OR Provisioning API is unreachable/config missing.
            const overallStatus = (health.configDb === 'CONNECTED' && health.moverAuditDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqConsumer === 'ACTIVE' && health.temporaryStorage === 'CONNECTED' && health.provisioningApi === 'REACHABLE') ? 200 : 503;
            if (overallStatus !== 200) {
                logger.warn('Health check reported degraded status.', health);
            } else {
                logger.debug('Health check reported healthy status.', health); // Use debug for frequent healthy checks
            }
            res.status(overallStatus).json(health);
        });

        // Start the Express server (for health checks or potential manual triggers)
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

// --- Core Mover Message Processing Logic ---
/**
 * Processes a single mover event message. Contains the core business logic.
 * @param {object} msg - The raw message object from the MQ consumer.
 * @param {object} dependencies - Object containing necessary service dependencies/configs.
 * @returns {Promise<{userId: string, hrmsId: string, provisioningApiResponse: object, determinedRoles: string[]}>} - Resolves with processing outcome details.
 * @throws {Error} - Throws if processing fails at a stage before API call, or if API call fails after retries.
 */
async function processMoverMessage(msg, dependencies) {
    const { logger, serviceConfigs, roleAssignmentService, attributeToRoleMappingConfig, axios } = dependencies;

    let eventPayload = null;
    let userId = null;
    let hrmsId = null;
    let updatedUserData = null;
    const messageCorrelationId = msg.properties.correlationId;
    const deliveryTag = msg.fields.deliveryTag;

    // --- Parse Message ---
    try {
        eventPayload = JSON.parse(msg.content.toString());
    } catch (parseError) {
        logger.error('Failed to parse mover event JSON payload.', { deliveryTag, correlationId: messageCorrelationId, parseError: parseError.message, payload: msg.content.toString() });
        throw new Error(`Invalid JSON payload: ${parseError.message}`); // Throw to be caught by onMoverEvent
    }

    // --- Validate Payload Structure ---
    userId = eventPayload.userId;
    hrmsId = eventPayload.hrmsId;
    updatedUserData = eventPayload.userData;

    if (!userId || !hrmsId || !updatedUserData || typeof updatedUserData !== 'object') {
        logger.error('Malformed mover event: Missing essential data (userId, hrmsId, or updatedUserData).', { deliveryTag, correlationId: messageCorrelationId, payload: eventPayload });
        throw new Error('Malformed mover event message.'); // Throw to be caught by onMoverEvent
    }

    logger.info(`Processing mover event for user ID: ${userId} (HRMS ID: ${hrmsId}).`, { userId, hrmsId, deliveryTag, correlationId: messageCorrelationId });

    // --- Determine NEW Desired Roles for the Mover ---
    const newDesiredRoles = await roleAssignmentService.determineRolesBasedOnMatrixRules(updatedUserData, attributeToRoleMappingConfig);
    const rolesForProvisioning = Array.isArray(newDesiredRoles) ? newDesiredRoles : [];
    logger.info(`Determined NEW desired roles: ${rolesForProvisioning.join(', ')} for user ${userId}`, { userId, roles: rolesForProvisioning, deliveryTag, correlationId: messageCorrelationId });

    // --- Trigger Provisioning ---
    const provisioningServiceApiUrl = serviceConfigs.provisioningServiceApiUrl;

    const desiredStatePayload = {
        userId: userId,
        roles: rolesForProvisioning,
        correlationId: messageCorrelationId,
        context: updatedUserData // Sending updated user data for context
    };

    logger.info(`Calling Provisioning Service API at ${provisioningServiceApiUrl}/provision to request desired state for user ${userId}...`, { userId, provisioningApiUrl, payloadSample: { userId: desiredStatePayload.userId, roles: desiredStatePayload.roles }, deliveryTag, correlationId: messageCorrelationId });

    // Use the axios instance (configured with retry) to call the API
    const response = await axios.post(`${provisioningServiceApiUrl}/provision`, desiredStatePayload);

    if (response.status === 202) {
        const taskId = response.data?.taskId;
        logger.info(`Provisioning request accepted by Provisioning Service.`, { userId, provisioningTaskId: taskId, deliveryTag, correlationId: messageCorrelationId });
        return { userId, hrmsId, provisioningApiResponse: response.data, determinedRoles: rolesForProvisioning }; // Return details on success
    } else {
         // Axios-retry exhausted retries or non-retryable status returned
        logger.error(`Provisioning API returned unexpected non-retryable status ${response.status} for user ${userId}.`, {
            userId: userId, status: response.status, responseData: response.data, payload: desiredStatePayload, deliveryTag, correlationId: messageCorrelationId
        });
        // Throw an error to be caught by onMoverEvent for logging in audit and NACKing.
        throw new Error(`Provisioning API returned unexpected status: ${response.status}`);
    }
}

// --- Mover Event Handler (with Audit) ---
/**
 * Handles a single mover event message, creating an audit trail.
 * @param {object} msg - The raw message object from the MQ consumer.
 * @param {object} dependencies - Object containing necessary service dependencies/configs.
 */
async function onMoverEvent(msg, dependencies) {
    const { logger, mqService, moverRunsAuditModel } = dependencies;
    let auditRecord = null;
    let parsedPayload = null; // Variable to hold the parsed payload

    const deliveryTag = msg.fields?.deliveryTag;
    const correlationId = msg.properties?.correlationId;

    logger.debug(`onMoverEvent: Starting processing for delivery tag ${deliveryTag}`, { deliveryTag, correlationId });

    try {
        // Attempt to parse the payload early to include in the audit record
        try {
             parsedPayload = JSON.parse(msg.content.toString());
        } catch (parseError) {
             // Log parse error, create audit record with partial info if possible, then throw to catch below
             logger.error('Failed to parse mover event JSON payload for audit.', { deliveryTag, correlationId, parseError: parseError.message, payload: msg.content.toString() });
             // Still attempt to create an audit record even with parse error
             try {
                auditRecord = await moverRunsAuditModel.create({
                    run_id: null, // Cannot determine userId/runId yet
                    status: 'parse_error',
                    started_at: new Date(),
                    finished_at: new Date(),
                    input_payload_raw: msg.content.toString(), // Store raw payload
                    error: { message: `JSON Parse Error: ${parseError.message}`, stack: parseError.stack }
                });
                logger.info('MoverRunsAudit record created for parse error.', { auditId: auditRecord.id, deliveryTag, correlationId });
             } catch (dbErr) {
                 logger.error('Failed to create MoverRunsAudit record for parse error.', { deliveryTag, correlationId, dbError: dbErr.message, originalParseError: parseError.message });
             }
             // NACK malformed messages to remove them permanently. Logged above.
             try { mqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to NACK malformed message after parse/audit error:', { deliveryTag, correlationId, nackErr: nackErr.message }); }
             return; // Stop processing this message
        }


        // 1) create audit record after successful parsing
         try {
             auditRecord = await moverRunsAuditModel.create({
               // Attempt to get userId early if available in payload for run_id
               run_id: parsedPayload?.userId || null,
               status: 'started',
               started_at: new Date(),
               input_payload: parsedPayload, // Store parsed payload
               correlation_id: correlationId // Store correlation ID
             });
             logger.info('MoverRunsAudit record created for mover event.', { auditId: auditRecord.id, userId: parsedPayload?.userId, hrmsId: parsedPayload?.hrmsId, deliveryTag, correlationId });
         } catch (dbCreateError) {
             logger.error('Failed to create MoverRunsAudit record in DB.', {
                 userId: parsedPayload?.userId,
                 hrmsId: parsedPayload?.hrmsId,
                 deliveryTag,
                 correlationId,
                 error: dbCreateError.message,
                 stack: dbCreateError.stack
             });
             // If DB creation fails, NACK the message. The shared Provisioning Task DB is the source of truth.
             // An audit record failing doesn't stop the core task but means we lose this specific run's audit.
             try { mqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to NACK message after audit creation error:', { deliveryTag, correlationId, nackErr: nackErr.message }); }
             return; // Stop processing this message
         }


        // 2) Call your existing parsing + business logic
        // This function is expected to throw if processing fails.
        const processingOutcome = await processMoverMessage(msg, dependencies); // Pass msg and dependencies

        // 3) update audit on success
         if (auditRecord) { // Only update if the audit record was successfully created
             try {
                 await auditRecord.update({
                   run_id: processingOutcome?.userId || auditRecord.run_id, // Update run_id if processMoverMessage provided it (using userId)
                   finished_at: new Date(),
                   status: 'completed',
                   result: processingOutcome // Store processing outcome details
                 });
                 logger.info('MoverRunsAudit record marked completed.', { auditId: auditRecord.id, userId: processingOutcome?.userId, deliveryTag, correlationId });
             } catch (dbUpdateError) {
                 logger.error('Failed to update MoverRunsAudit record to completed.', {
                      auditId: auditRecord.id,
                      userId: processingOutcome?.userId,
                      deliveryTag,
                      correlationId,
                      error: dbUpdateError.message,
                      stack: dbUpdateError.stack
                 });
                 // Log the error but continue to ACK the message as the core task succeeded.
             }
         } else {
             logger.warn('MoverRunsAudit record not available to mark as completed.', { deliveryTag, correlationId });
         }


        // ack the message only after all steps (including audit update) are attempted
        try { mqService.channel?.ack(msg); } catch (ackErr) { logger.error('Failed to ACK message after successful processing and audit update:', { deliveryTag, correlationId, ackErr: ackErr.message }); }
        logger.info(`Listener successfully processed and acknowledged mover event.`, { deliveryTag, correlationId });


    } catch (error) {
        // 4) update audit on error
        logger.error(`Error during mover event processing task.`, {
            deliveryTag: deliveryTag, // Use captured delivery tag
            correlationId: correlationId, // Use captured correlation id
            userId: parsedPayload?.userId || 'N/A', // Use parsedPayload if available
            hrmsId: parsedPayload?.hrmsId || 'N/A',
            error: error.message,
            stack: error.stack
        });

         if (auditRecord) { // Only update if the audit record was successfully created
             try {
                 await auditRecord.update({
                   finished_at: new Date(),
                   status: 'failed',
                   error: { message: error.message, stack: error.stack }
                 });
                 logger.error('MoverRunsAudit record marked failed.', { auditId: auditRecord.id, userId: parsedPayload?.userId, deliveryTag, correlationId });
             } catch (dbUpdateError) {
                 logger.error('Failed to update MoverRunsAudit record to failed.', {
                     auditId: auditRecord.id,
                     userId: parsedPayload?.userId,
                     deliveryTag,
                     correlationId,
                     error: dbUpdateError.message,
                     stack: dbUpdateError.stack
                 });
                 // Log the error but continue to NACK the message.
             }
         } else {
             logger.warn('MoverRunsAudit record not available to mark as failed.', { deliveryTag, correlationId });
         }


        // nack the message without requeue - rely on DLQ/DLX
        try { mqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Failed to NACK message after processing error and audit update:', { deliveryTag, correlationId, nackErr: nackErr.message }); }
        // TODO: Log this processing failure properly, potentially store failure details for reporting or manual review via DLQ.
    } finally {
         // Clean up the tracking Set. This needs to happen *outside* this function,
         // in the finally block attached to the promise returned by this function's execution.
         // The Set tracking is handled in the subscribe callback below.
    }
}


// --- Mover Event Listener ---
/**
 * Sets up the Message Queue consumer for 'mover.update' events.
 * Uses MqService.subscribe to manage the consumer robustly.
 * @param {object} dependencies - Dependencies for the message handler.
 */
async function setupMoverEventListener(dependencies) {
    // MqService.waitForChannel() was called in startService, ensuring the channel is ready before we get here.
    // Topology assertions and consumption setup will use the MqService methods.

    try {
        // Assert the exchange published to by ICS using MqService's method
        // assertExchange includes an internal waitForChannel
        await MqService.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
        logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

        // Assert the queue specific to this Mover service using MqService's method
        // Use a durable queue for reliability even if the service restarts.
        // assertQueue includes an internal waitForChannel
        const queue = await MqService.assertQueue(MOVER_QUEUE, { durable: true }); // assertQueue returns { queue: 'queueName', ... }
        logger.info(`Listener: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the 'mover.update' routing key using MqService's method
        // bindQueue includes an internal waitForChannel
        await MqService.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, MOVER_ROUTING_KEY);
        logger.info(`Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${MOVER_ROUTING_KEY}".`);


        // Start consuming messages from the queue using MqService.subscribe
        // MqService.subscribe manages the channel.consume call and consumer tag internally,
        // and handles re-establishing the consumer if the channel/connection is lost and restored.
        const consumeResult = await MqService.subscribe(queue.queue, async (msg) => { // <-- Using MqService.subscribe
             // Check for null message which indicates consumer cancellation or channel closure
             if (msg === null) {
                 logger.warn('Listener: Consume callback received null message, indicating consumer cancellation or channel closure by MQ.');
                 // MqService reconnection should handle re-establishing the consumer if needed
                 return; // Exit this specific message processing handler instance
             }

             // If service is shutting down, do not process new messages even if received before cancellation signal fully propagated.
             if (dependencies.isShuttingDown) { // <-- Check shutdown flag via dependencies
                 logger.warn(`Listener: Skipping message processing due to service shutdown. Message delivery tag: ${msg.fields.deliveryTag}`);
                 // Decide how to handle messages received during shutdown. NACK without requeue is an option.
                 // The cancelConsumer should handle pending messages, but this is a safeguard.
                 try { MqService.channel?.nack(msg, false, false); } catch (nackErr) { logger.error('Listener: Failed to NACK message during shutdown:', { deliveryTag: msg.fields.deliveryTag, nackErr: nackErr.message }); }
                 return; // Stop processing this message
             }


             // Execute the message processing logic within the audit handler function
             // Wrap the call in an async task that we can track for graceful shutdown
             const processingTask = onMoverEvent(msg, dependencies); // <-- Call the audit handler function

             // --- Track the message processing task for graceful shutdown ---
             // Add the promise returned by onMoverEvent to the set
             activeMoverProcessingTasks.add(processingTask);
             // Schedule removal from the set when the promise settles
             processingTask.finally(() => {
                 activeMoverProcessingTasks.delete(processingTask);
                 logger.debug(`Task for message ${msg.fields.deliveryTag || 'N/A'} finished. Active tasks remaining: ${activeMoverProcessingTasks.size}`, { deliveryTag: msg.fields.deliveryTag || 'N/A' }); // Optional: debug tracking
             });
             // Note: We do NOT await processingTask here. The consume callback should be fast to allow
             // processing subsequent messages, as long as we limit concurrency elsewhere if needed.
             // Consider using channel.prefetch(count) to limit the number of unacknowledged messages this consumer receives at once.
             // This helps control concurrency and prevents overwhelming the worker.


        }, {
            noAck: false // Manual acknowledgement is required
           });

        // MqService.subscribe returns the consumer tag upon successful subscription
        moverConsumerTag = consumeResult.consumerTag; // Store the consumer tag returned by MqService.subscribe
        logger.info(`Listener started consuming messages from queue "${queue.queue}" with consumer tag "${moverConsumerTag}".`);

    } catch (setupError) {
        logger.error(`Failed to setup Mover Event Listener:`, setupError);
        // This is a critical startup error - the listener cannot run.
        throw new Error('Failed to setup Mover Event Listener: ' + setupError.message);
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
        })); // Removed .then/.catch chain as error handling is now in the callback
    }


    // 2. Stop the MQ consumer from receiving NEW messages
    // Use the cancelConsumer method from MqService and the stored consumer tag
    if (moverConsumerTag) { // Check if consumer tag exists (implies setup succeeded)
        logger.info(`Attempting to cancel MQ consumer with tag: ${moverConsumerTag}`);
        try {
            // Use MqService method to cancel the consumer. It handles channel checks internally.
            await MqService.cancelConsumer(moverConsumerTag);
            logger.info(`MQ consumer "${moverConsumerTag}" cancelled.`);
            // Note: MqService should manage the state of the consumer internally, no need to nullify moverConsumerTag here.
        } catch (err) {
            logger.error(`Error cancelling MQ consumer "${moverConsumerTag}". It might have already been cancelled or channel closed.`, {
                consumerTag: moverConsumerTag, error: err.message, stack: err.stack
            });
        }
    } else {
        logger.warn('MQ consumer not active (no consumer tag) or MqService not fully initialized. Skipping consumer cancellation.');
    }


    // 3. Wait for any currently processing message tasks to finish
    // The activeMoverProcessingTasks set holds promises from the consume callback.
    if (activeMoverProcessingTasks.size > 0) {
        logger.info(`Waiting for ${activeMoverProcessingTasks.size} active message processing tasks to finish...`);
        // Use Promise.allSettled to wait for all promises to settle (either fulfill or reject)
        // Add a timeout for waiting to prevent hanging indefinitely
        const processingTimeout = parseInt(process.env.SHUTDOWN_TASK_TIMEOUT_MS, 10) || 30000; // Configurable timeout, default 30s
        const tasksWait = Promise.allSettled(Array.from(activeMoverProcessingTasks)); // Convert Set to Array for allSettled
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
             logger.warn(`Timeout waiting for active message processing tasks after ${processingTimeout}ms.`);
             // Log remaining tasks if timeout occurs
             if (activeMoverProcessingTasks.size > 0) {
                 logger.warn(`Still ${activeMoverProcessingTasks.size} tasks remaining. They will be interrupted by connection closure.`);
                 // Optional: log details of remaining tasks
                 // activeMoverProcessingTasks.forEach(task => logger.warn('Remaining task for message:', task.messageInfo)); // If task promises stored message info
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


    // 5. Close connections to other external services (Databases, Temporary Storage)
    logger.info('Closing other external connections...');
    // Use the close methods from ConfigService, TemporaryStorage, and local Audit DB
    const connectionClosePromises = [
        // Close Config DB connection (initialized by ConfigService)
        ConfigService.sequelize ? ConfigService.sequelize.close().then(() => logger.info('Config DB connection closed.')).catch(err => logger.error('Error closing Config DB connection:', err.message)) : (logger.debug('Config DB connection not initialized.'), Promise.resolve()), // Config DB connection
        // Close Local Mover Audit DB connection
        auditSequelize ? auditSequelize.close().then(() => logger.info('Local Mover Audit DB connection closed.')).catch(err => logger.error('Error closing Local Mover Audit DB connection:', err.message)) : (logger.debug('Local Mover Audit DB connection not initialized.'), Promise.resolve()), // <-- Added Local Audit DB close
        // Close Temporary Storage (Redis) connection
        // Assuming TemporaryStorage has a close method and isReady getter
        TemporaryStorage.isReady && TemporaryStorage.close ? TemporaryStorage.close().then(() => logger.info('Temporary Storage (Redis) client closed.')).catch(err => logger.error('Error closing Redis client gracefully:', err.message)) : (logger.debug('Temporary Storage (Redis) client not initialized or not ready.'), Promise.resolve()), // <-- Added TemporaryStorage close
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