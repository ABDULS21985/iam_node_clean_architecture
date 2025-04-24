// services/provisioning-service/src/server.js
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4005
const port = process.env.PROVISIONING_PORT || 4005;

// Add middleware to parse JSON request bodies
app.use(express.json());

// Import the provisioning logic module (it exports processProvisioningTask)
const ProvisioningLogic = require('./provisioningLogic'); // Adjust path if needed

// Import shared services and models
const ConfigService = require('../../shared/configService'); // Adjust the relative path as needed
const MqService = require('../../shared/mqService');       // Adjust the relative path as needed
const models = require('../../shared/models'); // Import all models

// Destructure models needed directly in this file (Task creation, User lookup)
const { ProvisioningTask, User } = models;


// Define the service name for config loading and logging
const serviceName = 'provisioning-service';
let serviceConfigs = {}; // Object to hold loaded service configurations

// Define Message Queue names for provisioning tasks
const PROVISIONING_TASKS_EXCHANGE = 'provisioning.tasks'; // Name of the exchange
const PROVISIONING_TASKS_QUEUE = 'provisioning.tasks.queue'; // Name of the queue
const PROVISIONING_TASK_ROUTING_KEY = 'task.new'; // Routing key for new tasks published


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Provisioning Service.
 */
async function startService() {
  try {
    console.log(`[${serviceName}] Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    // This also connects to the Config Database where ConnectorConfigs, MappingConfigs, etc. live
    await ConfigService.init();
    console.log(`[${serviceName}] ConfigService initialized successfully.`);

    // Load configurations specific to this service
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
    console.log(`[${serviceName}] Loaded service configurations:`, serviceConfigs);


    // 2. Initialize Message Queue Service
    await MqService.init();
    // Wait for the MQ channel to be ready before setting up consumers/publishers
    await MqService.waitForChannel();
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);


    // 3. Set up Message Queue Consumer (the Provisioning Task Worker)
    // This worker will listen for new provisioning tasks published to the queue
    await setupProvisioningTaskWorker();
    console.log(`[${serviceName}] Provisioning Task Worker setup complete.`);


    // 4. Set up Express server routes
    // This service primarily exposes an API for other services (Joiner, Mover, Leaver) to call
    app.get('/health', (req, res) => {
        // Basic health check - check Config DB connection, MQ status
        const health = {
            status: 'UP',
            configDb: ConfigService.sequelize && ConfigService.sequelize.connectionManager.hasOwnProperty('getConnection') ? 'CONNECTED' : 'DISCONNECTED',
            mqService: MqService.channel ? 'CONNECTED' : 'DISCONNECTED',
            // TODO: Add checks for any other external dependencies like target applications if connections are kept open
            // TODO: Add check for task queue status (e.g., number of messages)
        };
        const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED') ? 200 : 503;
        res.status(overallStatus).json(health);
    });

    // --- Provisioning API Endpoint ---
    // This is the main endpoint other services will call to request access changes
    // It accepts a desired state, creates a task, and queues it for processing.
    app.post('/provision', async (req, res) => {
        console.log(`[${serviceName}] Received provisioning request.`);
        const desiredState = req.body; // Expected to contain userId and roles

        try {
            // 1. Validate the desiredState input.
            if (!desiredState || !desiredState.userId || !Array.isArray(desiredState.roles)) {
                 res.status(400).json({ message: 'Invalid provisioning request: missing userId or roles array.' });
                 return;
            }
            // TODO: More robust validation of desiredState structure and content


            // 2. Find the user in our Core Data Model to ensure userId is valid and get internal ID
            const user = await User.findByPk(desiredState.userId);
            if (!user) {
                 res.status(404).json({ message: `User not found with ID: ${desiredState.userId}` });
                 return;
            }
             console.log(`[${serviceName}] Validated request for user ${user.hrmsId} (ID: ${user.id})`);


            // 3. Create a new ProvisioningTask entry in the database (status: 'pending').
            // Use the ProvisioningTask model directly
            const task = await ProvisioningTask.create({
                 userId: user.id, // Link task to the User ID (from IGLM DB)
                 desiredState: desiredState, // Store the full requested state
                 status: 'pending', // Initial status is pending
                 startTime: new Date(),
                 // results, errorDetails will be null initially
             });
            console.log(`[${serviceName}] Provisioning task created with ID ${task.id} and status 'pending'.`);


            // 4. Publish a message to the Message Queue to trigger the worker.
            // The message payload contains the task ID the worker needs to process.
            const taskMessagePayload = { taskId: task.id };
            await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload);
             console.log(`[${serviceName}] Published task ID ${task.id} to MQ exchange "${PROVISIONING_TASKS_EXCHANGE}" with key "${PROVISIONING_TASK_ROUTING_KEY}".`);


            // 5. Respond immediately with the task ID (202 Accepted).
            res.status(202).json({ message: 'Provisioning request accepted, task queued', taskId: task.id });


        } catch (error) {
            console.error(`[${serviceName}] Error processing provisioning request for user ${desiredState?.userId}:`, error);
            // If an error occurred *before* the task was created, we return 500.
            // If an error occurred *after* the task was created (e.g., DB create or MQ publish failed),
            // we should ideally update the task status to 'failed' or 'pending_retry' if possible,
            // but catching here just returns the error response. More complex handling needed for robustness.
            res.status(500).json({ message: 'Failed to accept provisioning request', error: error.message });
        }
    });

    // TODO: Add other endpoints (e.g., GET /provision/:taskId for status, managing provisioning connectors via Admin UI)


    // 5. Start the Express server listening for incoming requests
    app.listen(port, () => {
      console.log(`[${serviceName}] Service listening on port ${port}`);
    });

     console.log(`[${serviceName}] Service initialization complete.`);


  } catch (error) {
    // Catch any errors during the service initialization phase (DB connection, MQ init etc.)
    console.error(`[${serviceName}] Failed to start service:`, error);
    // TODO: Log startup failure to a centralized logging system before exiting
    process.exit(1); // Exit process immediately if startup fails
  }
}


// --- Provisioning Task Worker Setup ---
/**
 * Sets up the Message Queue consumer that acts as the Provisioning Task worker.
 * This worker listens to the queue and triggers the actual task processing logic.
 */
async function setupProvisioningTaskWorker() {
    // Ensure the necessary exchange and queue are declared (MqService.init might do this,
    // but declaring here ensures they exist before subscribing)
    const channel = MqService.channel; // Get the channel after MqService.init and waitForChannel

    if (!channel) {
        // This is a critical error - cannot set up worker without MQ channel
        throw new Error("MQ Channel not available for worker setup.");
    }

    try {
        // Declare the exchange used for provisioning tasks
        await channel.assertExchange(PROVISIONING_TASKS_EXCHANGE, 'topic', { durable: true });
        console.log(`[${serviceName}] Worker: Exchange "${PROVISIONING_TASKS_EXCHANGE}" asserted.`);

        // Declare the queue for this worker to consume from
        // A durable queue persists messages even if the worker or MQ restarts
        const queue = await channel.assertQueue(PROVISIONING_TASKS_QUEUE, { durable: true });
        console.log(`[${serviceName}] Worker: Queue "${queue.queue}" asserted.`);

        // Bind the queue to the exchange using the routing key for new tasks
        await channel.bindQueue(queue.queue, PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY);
        console.log(`[${serviceName}] Worker: Queue "${queue.queue}" bound to exchange "${PROVISIONING_TASKS_EXCHANGE}" with key "${PROVISIONING_TASK_ROUTING_KEY}".`);


        // Start consuming messages from the queue
        await channel.consume(queue.queue, async (msg) => {
            // This async function is called for each message received
            if (msg === null) {
                console.log(`[${serviceName}] Worker channel closed by MQ. Attempting to re-subscribe?`);
                // TODO: Implement robust channel closure handling and re-subscription logic
                // Depending on MqService implementation, it might handle reconnects.
                return;
            }

            let taskId = null;
            let messagePayload = null;

            try {
                // Parse the message payload
                messagePayload = JSON.parse(msg.content.toString());
                taskId = messagePayload.taskId; // Extract the task ID from the message

                if (!taskId) {
                    console.error(`[${serviceName}] Worker received malformed message: Missing taskId. Payload:`, messagePayload);
                    // Reject the message immediately (don't requeue) - it's fundamentally malformed
                    channel.nack(msg, false, false);
                    // TODO: Log this malformed message error properly
                    return;
                }

                console.log(`[${serviceName}] Worker received task message for task ID: ${taskId}`);

                // --- Call the core provisioning logic function ---
                // Pass the taskId and necessary dependencies to the logic module
                 const logicOptions = {
                     configService: ConfigService, // Pass the initialized ConfigService
                     mqService: MqService,       // Pass the initialized MqService
                     models: models,               // Pass all Sequelize models (includes ProvisioningTask)
                     // taskRepository is handled implicitly by using models directly
                     // TODO: Add other dependencies like logger, target application connection pools/caches
                 };
                // The processProvisioningTask function handles loading the task details by ID and updating its status
                await ProvisioningLogic.processProvisioningTask(taskId, logicOptions);


                // Acknowledge the message only after successful processing by processProvisioningTask
                channel.ack(msg);
                console.log(`[${serviceName}] Worker successfully processed and acknowledged task ID: ${taskId}`);

            } catch (error) {
                // Catch errors that occur *during* the processing of a specific message
                console.error(`[${serviceName}] Worker error processing task message for task ID ${taskId}:`, error);
                // TODO: Implement robust retry logic using NACK and potentially delayed/dead-letter queues
                // Nack the message. Setting `requeue: true` sends it back to the queue for a retry.
                // Need a strategy to prevent infinite retries on persistent errors (e.g., track retry count, move to DLQ).
                // For now, we'll requeue for a simple retry attempt.
                 channel.nack(msg, false, true); // Reject and requeue for a retry

                // TODO: Log this processing error properly, potentially with the message payload details
            }
        }, {
            noAck: false // Crucial: We will manually acknowledge messages only after successful processing
        });

        console.log(`[${serviceName}] Worker started consuming messages from queue "${queue.queue}".`);

    } catch (setupError) {
         console.error(`[${serviceName}] Failed to setup Provisioning Task Worker:`, setupError);
         // This is a critical startup error - the worker cannot run.
         throw new Error('Failed to setup Provisioning Task Worker: ' + setupError.message);
    }
}


// --- Graceful Shutdown Handling ---
// Listen for termination signals (e.g., from Docker/Kubernetes stop)
process.on('SIGTERM', async () => {
    console.log(`[${serviceName}] SIGTERM received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown (stop MQ consumer, finish ongoing tasks, close connections)
    // Stop consuming messages: MqService would need a stopConsuming method.
    // Wait for ongoing processProvisioningTask calls to finish (needs tracking)

    // Close connections to external services
    if (ConfigService.sequelize) {
        await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        console.log(`[${serviceName}] Config DB connection closed.`);
    }
    if (MqService.connection) {
        await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
        console.log(`[${serviceName}] MQ connection closed.`);
    }
    // Provisioning service might keep connections to target applications open - need to close those
    // TODO: Implement closing of Provisioning Connector connections/pools (ProvisioningLogic or adapters would manage this)

    console.log(`[${serviceName}] Graceful shutdown complete.`);
    process.exit(0); // Exit successfully
});

// Listen for interrupt signals (e.g., Ctrl+C)
process.on('SIGINT', async () => {
    console.log(`[${serviceName}] SIGINT received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown

    // Close connections to external services
    if (ConfigService.sequelize) {
         await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
         console.log(`[${serviceName}] Config DB connection closed.`);
    }
    if (MqService.connection) {
         await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
         console.log(`[${serviceName}] MQ connection closed.`);
    }
     // Provisioning service might keep connections to target applications open - need to close those
    // TODO: Implement closing of Provisioning Connector connections/pools

    console.log(`[${serviceName}] Graceful shutdown complete.`);
    process.exit(0); // Exit successfully
});

// Optional: Handle uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (err) => {
    console.error(`[${serviceName}] Uncaught Exception:`, err);
    // TODO: Log this critical error to a centralized logging system
    // Attempt graceful shutdown, or just exit immediately depending on policy
    // process.exit(1); // Exit after logging
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${serviceName}] Unhandled Rejection at Promise:`, promise, 'reason:', reason);
     // TODO: Log this critical error
    // Attempt graceful shutdown or exit
    // process.exit(1);
});


// --- Start the Service ---
// Call the initialization function to start the service
startService();