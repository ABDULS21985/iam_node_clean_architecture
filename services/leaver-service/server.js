// services/leaver-service/src/server.js
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4004
const port = process.env.LEAVER_PORT || 4004;

// Import necessary libraries
const axios = require('axios');
const axiosRetry = require('axios-retry');
const winston = require('winston'); // Added for structured logging

// Import shared services and models
const ConfigService = require('../../shared/configService');
const MqService = require('../../shared/mqService');
// const models = require('../../shared/models'); // Still likely not directly needed here

// Define the service name for config loading and logging
const serviceName = 'leaver-service';
let serviceConfigs = {}; // Object to hold loaded service configurations
let consumerTag = null; // To hold the MQ consumer tag for cancellation
let isShuttingDown = false; // Flag for graceful shutdown state

// Define Message Queue details
const IDENTITY_CHANGES_EXCHANGE = 'identity.changes';
const LEAVER_QUEUE = 'leaver.events.queue';
const LEAVER_ROUTING_KEY = 'leaver.exit';

// --- Setup Structured Logger (Winston Example) ---
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
        // Simple meta stringifier
        const metaString = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `${timestamp} [${service}] ${level}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
    })
  ),
  defaultMeta: { service: serviceName },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, service, stack, ...meta }) => {
            const metaString = Object.keys(meta).length ? JSON.stringify(meta) : '';
            return `${timestamp} [${service}] ${level}: ${message}${metaString ? ' ' + metaString : ''}${stack ? '\n' + stack : ''}`;
        })
      )
    })
    // TODO: Add transport for centralized logging (e.g., ELK, Datadog, file rotation)
  ],
});

logger.info('Logger initialized.');

// --- Configure axios-retry ---
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.ExponentialBackoff,
    onRetry: (retryCount, error, requestConfig) => {
        logger.warn(`Axios Retry: Attempt ${retryCount} failed for ${requestConfig.method.toUpperCase()} ${requestConfig.url}. Error: ${error.message}`, {
            url: requestConfig.url,
            method: requestConfig.method,
            retryCount: retryCount,
            error: error.message
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
        serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
        if (!serviceConfigs || !serviceConfigs.provisioningServiceApiUrl) {
            logger.error('Missing critical service configuration: provisioningServiceApiUrl.', { loadedConfigs: serviceConfigs });
            throw new Error("Missing critical service configuration 'provisioningServiceApiUrl'");
        }
        logger.info('Loaded service configurations.', { provisioningUrlConfigured: !!serviceConfigs.provisioningServiceApiUrl }); // Avoid logging sensitive URLs directly

        // 2. Initialize Message Queue Service
        await MqService.init();
        await MqService.waitForChannel();
        logger.info('Message Queue connected and channel ready.');

        // 3. Set up Message Queue Consumer
        await setupLeaverEventListener(); // Will start consuming messages
        logger.info('Leaver Event Listener setup complete and consuming messages.');

        // 4. Set up Express server
        app.get('/health', (req, res) => {
            const health = {
                status: 'UP',
                configDb: ConfigService.sequelize?.connectionManager?.validate ? 'CONNECTED' : 'DISCONNECTED', // Simplified check
                mqService: MqService.channel ? 'CONNECTED' : 'DISCONNECTED',
                // Check if essential config is present, not live connectivity here
                provisioningServiceApiConfigured: serviceConfigs.provisioningServiceApiUrl ? 'CONFIGURED' : 'MISSING',
                mqConsumerActive: !!consumerTag && MqService.channel // Check if consumer likely active
            };
            // Degraded if DB or MQ is down, or consumer failed to start
            const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED' && health.mqConsumerActive) ? 200 : 503;
            if (overallStatus !== 200) {
                logger.warn('Health check reported degraded status:', health);
            }
            res.status(overallStatus).json(health);
        });

        app.listen(port, () => {
            logger.info(`Service listening on port ${port}`);
        });

        logger.info('Service initialization complete.');

    } catch (error) {
        logger.error('Failed to start service.', {
            error: error.message,
            stack: error.stack
        });
        // Logging to centralized system via Winston transports
        process.exit(1);
    }
}

// --- Leaver Event Listener ---
/**
 * Sets up the Message Queue consumer for 'leaver.exit' events.
 */
async function setupLeaverEventListener() {
    const channel = MqService.channel;

    if (!channel) {
        logger.error("MQ Channel not available for Leaver Event Listener setup.");
        throw new Error("MQ Channel not available for Leaver Event Listener setup.");
    }

    try {
        await channel.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
        logger.info(`Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

        const queue = await channel.assertQueue(LEAVER_QUEUE, { durable: true });
        logger.info(`Listener: Queue "${queue.queue}" asserted.`);

        await channel.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, LEAVER_ROUTING_KEY);
        logger.info(`Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${LEAVER_ROUTING_KEY}".`);

        // Start consuming and store the consumer tag
        const consumeResult = await channel.consume(queue.queue, async (msg) => {
            if (msg === null) {
                // This indicates the channel was closed by the broker.
                logger.warn('Listener: Consume callback received null message, indicating channel closure by MQ broker.');
                // Reset consumerTag as it's no longer valid.
                consumerTag = null;
                 // TODO: Implement more robust reconnection/re-subscription logic here or in MqService.
                 // This might involve trying to re-initialize MqService or notifying an orchestrator.
                 // For now, we just log the warning. The health check will reflect the disconnected MQ state.
                return;
            }

            let eventPayload = null;
            let userId = null;
            let hrmsId = null;

            try {
                eventPayload = JSON.parse(msg.content.toString());
                userId = eventPayload.userId;
                hrmsId = eventPayload.hrmsId;
                // const userData = eventPayload.userData; // Last known state

                if (!userId || !hrmsId) {
                    logger.error('Listener received malformed leaver event: Missing userId or hrmsId.', { payload: eventPayload });
                    // ACK malformed messages to remove them permanently. Logged above.
                    channel.ack(msg);
                    return;
                }

                logger.info(`Listener received leaver event.`, { userId, hrmsId });

                // Trigger Provisioning
                const desiredStatePayload = {
                    userId: userId,
                    roles: [] // Desired state for leaver: no roles
                    // Consider adding userData if Provisioning needs it for context:
                    // context: userData
                };

                logger.info(`Listener: Calling Provisioning Service API for user.`, { userId });
                const provisioningServiceApiUrl = serviceConfigs.provisioningServiceApiUrl;

                // Axios call with built-in retry
                const response = await axios.post(`${provisioningServiceApiUrl}/provision`, desiredStatePayload);

                if (response.status === 202) { // Accepted
                    const taskId = response.data?.taskId;
                    logger.info(`Listener: Provisioning request accepted for user.`, { userId, taskId: taskId });
                    // Optionally track taskId if needed for audit/status checks
                    // Example: await AuditLog.logProvisioningStart(userId, taskId);
                } else {
                    // Non-retryable error from Provisioning Service after retries (or non-202 success)
                    logger.error(`Listener: Provisioning API returned unexpected status after retries.`, {
                        userId: userId,
                        status: response.status,
                        responseBody: response.data
                    });
                    // ACK to remove message - permanent failure for this attempt.
                    channel.ack(msg);
                     // TODO: Implement alerting or store failure details persistently if needed.
                    return;
                }

                // ACK only after successful processing (API call accepted)
                channel.ack(msg);
                logger.info(`Listener successfully processed and acknowledged leaver event.`, { userId });

            } catch (error) {
                // Error during message parsing or API call (after retries failed)
                logger.error(`Listener error processing leaver event message.`, {
                    userId: userId || 'N/A', // Include userId if available
                    error: error.message,
                    stack: error.stack,
                    // Optionally include payload snippet (be careful with sensitive data)
                    // payloadSnippet: msg.content.toString().substring(0, 100)
                });

                // NACK without requeue - rely on DLQ/DLX strategy defined on the queue
                try {
                    channel.nack(msg, false, false);
                } catch (nackError) {
                    logger.error(`Failed to NACK message after processing error.`, { originalError: error.message, nackError: nackError.message });
                }
                // TODO: Log processing failure details for monitoring/manual intervention via DLQ.
            }
        }, {
            noAck: false // Manual acknowledgement is required
        });

        // Store the consumer tag
        consumerTag = consumeResult.consumerTag;
        logger.info(`Listener started consuming messages with consumer tag: ${consumerTag}.`);

    } catch (setupError) {
        logger.error('Failed to setup Leaver Event Listener.', {
            error: setupError.message,
            stack: setupError.stack
        });
        throw new Error('Failed to setup Leaver Event Listener: ' + setupError.message);
    }
}

// --- Graceful Shutdown Handling ---
async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        logger.warn(`Shutdown already in progress. Received signal: ${signal}`);
        return;
    }
    isShuttingDown = true;
    logger.info(`${signal} received, starting graceful shutdown.`);

    // 1. Stop the MQ consumer from accepting new messages
    if (consumerTag && MqService.channel) {
        logger.info(`Attempting to cancel MQ consumer with tag: ${consumerTag}`);
        try {
            await MqService.channel.cancel(consumerTag);
            logger.info(`MQ consumer ${consumerTag} cancelled successfully.`);
            consumerTag = null; // Mark as cancelled
        } catch (cancelError) {
            logger.error(`Error cancelling MQ consumer ${consumerTag}. It might have already been cancelled or channel closed.`, {
                error: cancelError.message
            });
        }
    } else if (!consumerTag) {
        logger.warn('MQ consumer tag not found or already null, skipping cancellation.');
    } else if (!MqService.channel) {
         logger.warn('MQ channel not available, skipping consumer cancellation.');
    }

    // TODO: Implement wait logic if needed to allow in-progress message handlers to complete.
    // This can be complex; often relies on tracking active handlers.
    // await Promise.all(activeMessagePromises); // Simplified concept

    logger.info('Closing external connections...');
    // 2. Close external connections
    const results = await Promise.allSettled([
        ConfigService.sequelize ? ConfigService.sequelize.close() : Promise.resolve(),
        // Important: Close channel *after* cancelling consumer if channel is still needed for cancellation confirmation
        MqService.channel ? MqService.channel.close() : Promise.resolve(),
        MqService.connection ? MqService.connection.close() : Promise.resolve(),
    ]);

    results.forEach((result, index) => {
        const serviceName = ['Config DB', 'MQ Channel', 'MQ Connection'][index];
        if (result.status === 'fulfilled') {
            logger.info(`${serviceName} connection closed successfully.`);
        } else {
            logger.error(`Error closing ${serviceName} connection:`, { reason: result.reason?.message || result.reason });
        }
    });

    logger.info('Graceful shutdown complete.');
    process.exit(0);
}

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Handle Ctrl+C

// --- Uncaught Exception / Unhandled Rejection Handling ---
process.on('uncaughtException', (err, origin) => {
    logger.error('Uncaught Exception.', {
        error: err.message,
        stack: err.stack,
        origin: origin
    });
    if (!isShuttingDown) {
        gracefulShutdown('uncaughtException').catch(() => process.exit(1));
    } else {
        process.exit(1); // Already shutting down
    }
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection.', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined,
        promiseDetails: promise
    });
    // Decide whether to exit based on severity or policy
    // if (!isShuttingDown) {
    //     gracefulShutdown('unhandledRejection').catch(() => process.exit(1));
    // } else {
    //     process.exit(1);
    // }
});

// --- Start the Service ---
startService();