// services/provisioning-service/src/server.js
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4005
const port = process.env.PROVISIONING_PORT || 4005;


// Add middleware to parse JSON request bodies
app.use(express.json());

// Import the provisioning logic module (it exports processProvisioningTask)
const ProvisioningLogic = require('./provisioningLogic'); // Adjust path as needed

// Import shared services and models
const ConfigService = require('../../shared/configService'); // Adjust the relative path as needed
const MqService = require('../../shared/mqService');       // Adjust path as needed
const models = require('../../shared/models'); // Import all models

// Destructure models needed directly in this file (Task creation, User/App lookup)
const { ProvisioningTask, User, Application } = models;


// Define the service name for config loading and logging
const serviceName = 'provisioning-service';
let serviceConfigs = {}; // Object to hold loaded service configurations


// Define Message Queue names for provisioning tasks
const PROVISIONING_TASKS_EXCHANGE = 'provisioning.tasks'; // Exchange published to by the API endpoints
const PROVISIONING_TASKS_QUEUE = 'provisioning.tasks.queue'; // Queue for provisioning tasks worker to consume
const PROVISIONING_TASK_ROUTING_KEY = 'task.new'; // Routing key for new tasks published


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Provisioning Service.
 */
async function startService() {
  try {
    console.log(`[${serviceName}] Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    await ConfigService.init();
    console.log(`[${serviceName}] ConfigService initialized successfully.`);

    // Load configurations specific to this service
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
     if (!serviceConfigs || !serviceConfigs.provisioningServiceApiUrl) {
          console.error(`[${serviceName}] Missing critical service configurations. Loaded:`, serviceConfigs);
          throw new Error("Missing critical service configuration 'provisioningServiceApiUrl'");
     }
    console.log(`[${serviceName}] Loaded service configurations:`, serviceConfigs);


    // 2. Initialize Message Queue Service
    await MqService.init();
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);


    // 3. Set up Message Queue Consumer (the Provisioning Task Worker)
    // This worker will listen for new provisioning tasks published to the queue
    await setupProvisioningTaskWorker();
    console.log(`[${serviceName}] Provisioning Task Worker setup complete.`);


    // 4. Set up Express server routes
    app.get('/health', (req, res) => {
        // Basic health check - check Config DB connection, MQ status
        const health = {
            status: 'UP',
            configDb: ConfigService.sequelize && ConfigService.sequelize.connectionManager.hasOwnProperty('getConnection') ? 'CONNECTED' : 'DISCONNECTED',
            mqService: MqService.channel ? 'CONNECTED' : 'DISCONNECTED',
            // TODO: Add checks for any other external dependencies like target applications if connections are kept open
        };
        const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED') ? 200 : 503;
        res.status(overallStatus).json(health);
    });

    // --- Provisioning API Endpoint (for Grants) ---
    // This is the main endpoint Joiner/Mover/Self-Service will call to request access changes (Grants based on roles)
    app.post('/provision', async (req, res) => {
        console.log(`[${serviceName}] Received provisioning request (Grant).`);
        // The request body is expected to contain the "desired state" { userId: '...', roles: [...] }
        const desiredState = req.body;
        let task; // Variable to hold the created task

        try {
            // 1. Validate the desiredState input for a Grant task.
            if (!desiredState || !desiredState.userId || !Array.isArray(desiredState.roles)) {
                 res.status(400).json({ message: 'Invalid provisioning request payload: Missing userId or roles array.' });
                 return;
            }
            // TODO: More robust validation of desiredState structure and content for Grants

            // 2. Find the user in our Core Data Model to ensure userId is valid
            const user = await User.findByPk(desiredState.userId);
            if (!user) {
                 res.status(404).json({ message: `User not found with ID: ${desiredState.userId}` });
                 return;
            }
             console.log(`[${serviceName}] Validated grant request for user ${user.hrmsId} (ID: ${user.id})`);


            // 3. Create a new ProvisioningTask entry (status: 'pending', type: 'grant').
            // We need to distinguish grant tasks from revoke tasks.
            // *** Requires adding a 'taskType' column to the ProvisioningTask model/migration ***
            // For now, we store the type within the desiredState payload itself.
            task = await ProvisioningTask.create({
                 userId: user.id, // Link task to the User ID (from IGLM DB)
                 // Store the full requested state payload
                 desiredState: { type: 'grant', payload: desiredState }, // Embed payload and indicate type
                 status: 'pending', // Initial status is pending
                 startTime: new Date(),
                 // results, errorDetails will be null initially
             });
            console.log(`[${serviceName}] Provisioning task created with ID ${task.id} and status 'pending'. Type: grant.`);


            // 4. Publish a message to the Message Queue to trigger the worker.
            const taskMessagePayload = { taskId: task.id };
            // Publish to the same queue, the worker logic will check the task type from the task record
            await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload); // Use the same routing key
             console.log(`[${serviceName}] Published grant task ID ${task.id} to MQ exchange "${PROVISIONING_TASKS_EXCHANGE}".`);


            // 5. Respond immediately with the task ID (202 Accepted).
            res.status(202).json({ message: 'Provisioning request accepted, task queued', taskId: task.id });


        } catch (error) {
            console.error(`[${serviceName}] Error processing grant provisioning request for user ${desiredState?.userId}:`, error);
            res.status(500).json({ message: 'Failed to accept provisioning request', error: error.message });
        }
    });


    // --- Dedicated Revocation API Endpoint (for Revokes) ---
    // This endpoint receives explicit revocation requests (e.g., from Reconciliation)
    app.post('/provision/revoke', async (req, res) => {
        console.log(`[${serviceName}] Received explicit revocation request.`);
        // The request body is expected to be a revocation payload structure
        // Example payload from Reconciliation: { userId: '...', applicationId: '...', appSpecificUserId: '...', entitlementsToRevoke: [{ iglmEntitlementId: '...', appSpecificEntitlementId: '...', ... }] }
        const revocationRequestPayload = req.body;
        let task; // Variable to hold the created task

        try {
            // 1. Validate the revocation request payload.
            // userId can be null for orphaned accounts, but applicationId and entitlementsToRevoke are required.
            if ((revocationRequestPayload.userId === undefined || revocationRequestPayload.userId !== null && typeof revocationRequestPayload.userId !== 'string') || !revocationRequestPayload.applicationId || !revocationRequestPayload.entitlementsToRevoke || !Array.isArray(revocationRequestPayload.entitlementsToRevoke) || revocationRequestPayload.entitlementsToRevoke.length === 0) {
                 res.status(400).json({ message: 'Invalid revocation request payload: Missing/invalid userId, applicationId, or non-empty entitlementsToRevoke array.' });
                 return;
            }
             // TODO: More robust validation of entitlementsToRevoke array structure


            // 2. Validate User (if userId is not null) and Application existence
            let user = null;
            if (revocationRequestPayload.userId !== null) {
                 user = await User.findByPk(revocationRequestPayload.userId);
                 if (!user) {
                      res.status(404).json({ message: `User not found with ID: ${revocationRequestPayload.userId}` });
                      return;
                 }
            }
             const application = await Application.findByPk(revocationRequestPayload.applicationId);
             if (!application) {
                  res.status(404).json({ message: `Application not found with ID: ${revocationRequestPayload.applicationId}` });
                  return;
             }
             console.log(`[${serviceName}] Validated revocation request for user ${user?.hrmsId || 'Orphan'} (ID: ${revocationRequestPayload.userId}) for Application ${application.name} (ID: ${revocationRequestPayload.applicationId}).`);


            // 3. Create a new ProvisioningTask entry for revocation (status: 'pending', type: 'revoke').
            // *** Requires adding a 'taskType' column to the ProvisioningTask model/migration ***
            // For now, store type in desiredState payload and potentially metadata.
            task = await ProvisioningTask.create({
                 userId: revocationRequestPayload.userId, // Link to User (null for orphans)
                 // Store the explicit revocation payload
                 desiredState: { type: 'revoke', payload: revocationRequestPayload }, // Embed payload and indicate type
                 status: 'pending', // Initial status
                 startTime: new Date(),
                 // results, errorDetails will be null initially
             });
            console.log(`[${serviceName}] Revocation task created with ID ${task.id} and status 'pending'. Type: revoke.`);


            // 4. Publish a message to the Message Queue to trigger the worker.
            const taskMessagePayload = { taskId: task.id };
            // Publish to the same queue, the worker logic will check the task type from the task record
            await MqService.publish(PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY, taskMessagePayload); // Use the same routing key
             console.log(`[${serviceName}] Published revocation task ID ${task.id} to MQ exchange "${PROVISIONING_TASKS_EXCHANGE}".`);


            // 5. Respond immediately with the task ID (202 Accepted).
            res.status(202).json({ message: 'Revocation request accepted, task queued', taskId: task.id });


        } catch (error) {
            console.error(`[${serviceName}] Error processing revocation request for user ${revocationRequestPayload?.userId}:`, error);
            res.status(500).json({ message: 'Failed to accept revocation request', error: error.message });
        }
    });


    // TODO: Add other endpoints (e.g., GET /provision/:taskId for status)


    // 5. Start the Express server listening for incoming requests
    app.listen(port, () => {
      console.log(`[${serviceName}] Service listening on port ${port}`);
    });

     console.log(`[${serviceName}] Service initialization complete.`);


  } catch (error) {
    // Catch any errors during the service initialization phase
    console.error(`[${serviceName}] Failed to start service:`, error);
    process.exit(1);
  }
}


// --- Provisioning Task Worker Setup ---
/**
 * Sets up the Message Queue consumer that acts as the Provisioning Task worker.
 * This worker listens to the queue and triggers the actual task processing logic.
 */
async function setupProvisioningTaskWorker() {
     const channel = MqService.channel; // Get the channel after MqService.init and waitForChannel

     if (!channel) {
         throw new Error("MQ Channel not available for Provisioning Task Worker setup.");
     }

     try {
         // Declare the exchange published to by the API endpoints
         await channel.assertExchange(PROVISIONING_TASKS_EXCHANGE, 'topic', { durable: true });
         console.log(`[${serviceName}] Worker: Exchange "${PROVISIONING_TASKS_EXCHANGE}" asserted.`);

         // Declare the queue for this worker to consume from
         const queue = await channel.assertQueue(PROVISIONING_TASKS_QUEUE, { durable: true });
         console.log(`[${serviceName}] Worker: Queue "${queue.queue}" asserted.`);

         // Bind the queue to the exchange using the routing key for new tasks
         await channel.bindQueue(queue.queue, PROVISIONING_TASKS_EXCHANGE, PROVISIONING_TASK_ROUTING_KEY);
         console.log(`[${serviceName}] Worker: Queue "${queue.queue}" bound to exchange "${PROVISIONING_TASKS_EXCHANGE}" with key "${PROVISIONING_TASK_ROUTING_KEY}".`);


         // Start consuming messages from the queue
         await channel.consume(queue.queue, async (msg) => {
             if (msg === null) {
                 console.log(`[${serviceName}] Worker channel closed by MQ.`);
                 return;
             }

             let messagePayload = null;
             let taskId = null; // The Task ID from the message

             try {
                 // Parse the message payload (expected to be { taskId: '...' })
                 messagePayload = JSON.parse(msg.content.toString());
                 taskId = messagePayload.taskId; // Extract the task ID from the message

                 if (!taskId) {
                     console.error(`[${serviceName}] Worker received malformed message: Missing taskId. Payload:`, messagePayload);
                     channel.nack(msg, false, false); // Reject the message (don't requeue) - it's malformed
                     // TODO: Log malformed message error
                     return;
                 }

                 console.log(`[${serviceName}] Worker received task message for task ID: ${taskId}`);

                 // --- Call the core provisioning logic function ---
                 // Pass the taskId and necessary dependencies to the logic module
                 const logicOptions = {
                     configService: ConfigService, // Pass the initialized ConfigService
                     mqService: MqService,       // Pass the initialized MqService
                     models: models,               // Pass all Sequelize models
                     // TODO: Add other dependencies like logger, target app connection pools
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
                 channel.nack(msg, false, true); // Reject and requeue for a retry

                // TODO: Log this processing error properly
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
process.on('SIGTERM', async () => {
    console.log(`[${serviceName}] SIGTERM received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown (stop MQ consumer, finish ongoing tasks, close connections)

    // Close connections
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

process.on('SIGINT', async () => {
    console.log(`[${serviceName}] SIGINT received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown

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
startService();