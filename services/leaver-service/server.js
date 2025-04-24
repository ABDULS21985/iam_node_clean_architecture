// services/leaver-service/src/server.js
const express = require('express');
const app = express();
// Use the port defined in .env, default to 4004
const port = process.env.LEAVER_PORT || 4004;


// Import necessary libraries
const axios = require('axios'); // For calling the Provisioning Service API


// Import shared services and models
const ConfigService = require('../../shared/configService'); // Adjust path as needed
const MqService = require('../../shared/mqService');       // Adjust path as needed
// Access models if needed, though Leaver service might not interact directly with Core Data Model DB
// const models = require('../../shared/models');


// Define the service name for config loading and logging
const serviceName = 'leaver-service';
let serviceConfigs = {}; // Object to hold loaded service configurations

// Define Message Queue details for consuming Leaver events
const IDENTITY_CHANGES_EXCHANGE = 'identity.changes'; // Exchange published to by ICS
const LEAVER_QUEUE = 'leaver.events.queue'; // Queue specific to the Leaver service
const LEAVER_ROUTING_KEY = 'leaver.exit'; // Routing key for leaver events published by ICS


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Leaver Service.
 */
async function startService() {
  try {
    console.log(`[${serviceName}] Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    await ConfigService.init();
    console.log(`[${serviceName}] ConfigService initialized successfully.`);

    // Load configurations specific to this service (e.g., Provisioning Service API URL)
    // serviceConfigs will contain the mappingRules from the 'Leaver Service Configuration' entry
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
     // Check for essential config
     if (!serviceConfigs || !serviceConfigs.provisioningServiceApiUrl) {
          console.error(`[${serviceName}] Missing critical service configurations. Loaded:`, serviceConfigs);
          throw new Error("Missing critical service configuration 'provisioningServiceApiUrl'");
     }
    console.log(`[${serviceName}] Loaded service configurations:`, serviceConfigs);


    // 2. Initialize Message Queue Service
    await MqService.init();
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);


    // 3. Set up Message Queue Consumer (the Leaver Event Listener)
    await setupLeaverEventListener();
    console.log(`[${serviceName}] Leaver Event Listener setup complete.`);


    // 4. Set up Express server (Optional - for health check)
    app.get('/health', (req, res) => {
        // Basic health check - check Config DB connection, MQ status
        const health = {
            status: 'UP',
            configDb: ConfigService.sequelize && ConfigService.sequelize.connectionManager.hasOwnProperty('getConnection') ? 'CONNECTED' : 'DISCONNECTED',
            mqService: MqService.channel ? 'CONNECTED' : 'DISCONNECTED',
            // TODO: Add check for connectivity to Provisioning Service API?
        };
        const overallStatus = (health.configDb === 'CONNECTED' && health.mqService === 'CONNECTED') ? 200 : 503;
        res.status(overallStatus).json(health);
    });

    // Start the Express server if needed
    app.listen(port, () => {
      console.log(`[${serviceName}] Service listening on port ${port}`);
    });

     console.log(`[${serviceName}] Service initialization complete.`);


  } catch (error) {
    // Catch any errors during the service initialization phase
    console.error(`[${serviceName}] Failed to start service:`, error);
    // TODO: Log startup failure to a centralized logging system before exiting
    process.exit(1); // Exit process immediately if startup fails
  }
}


// --- Leaver Event Listener ---
/**
 * Sets up the Message Queue consumer for 'leaver.exit' events.
 */
async function setupLeaverEventListener() {
     const channel = MqService.channel; // Get the channel after MqService.init and waitForChannel

     if (!channel) {
         throw new Error("MQ Channel not available for Leaver Event Listener setup.");
     }

     try {
         // Declare the exchange published to by ICS
         await channel.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
         console.log(`[${serviceName}] Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

         // Declare the queue specific to this Leaver service
         const queue = await channel.assertQueue(LEAVER_QUEUE, { durable: true });
         console.log(`[${serviceName}] Listener: Queue "${queue.queue}" asserted.`);

         // Bind the queue to the exchange using the 'leaver.exit' routing key
         await channel.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, LEAVER_ROUTING_KEY);
         console.log(`[${serviceName}] Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${LEAVER_ROUTING_KEY}".`);


         // Start consuming messages from the queue
         await channel.consume(queue.queue, async (msg) => {
             // This async function is called for each message received
             if (msg === null) {
                 console.log(`[${serviceName}] Listener channel closed by MQ.`);
                 // TODO: Implement robust channel closure handling and re-subscription logic
                 return;
             }

             let eventPayload = null;
             let userId = null; // IGLM User ID from the event
             let hrmsId = null; // HRMS ID from the event

             try {
                 // Parse the message payload (expected to be { userId: '...', hrmsId: '...', userData: {...}, ... })
                 eventPayload = JSON.parse(msg.content.toString());
                 userId = eventPayload.userId;
                 hrmsId = eventPayload.hrmsId;
                 // Leaver event userData is the *last known state* from ICS before removal

                 if (!userId || !hrmsId) {
                     console.error(`[${serviceName}] Listener received malformed leaver event message: Missing userId or hrmsId. Payload:`, eventPayload);
                     channel.nack(msg, false, false); // Reject the message (don't requeue)
                     // TODO: Log malformed message error
                     return;
                 }

                 console.log(`[${serviceName}] Listener received leaver event for user ID: ${userId} (HRMS ID: ${hrmsId}).`);

                 // --- Trigger Deprovisioning for the Leaver ---
                 // Call the Provisioning Service API endpoint (/provision)
                 // The payload is the desired state (IGLM User ID + Roles).
                 // For a leaver, the desired state is to have *no* roles.
                 // The Provisioning Service will interpret [] roles as revoke all access related to roles.

                 const desiredStatePayload = {
                     userId: userId, // IGLM User ID
                     roles: [] // <-- The desired state for a leaver is typically an empty array of roles
                     // TODO: Add other context if needed by Provisioning Service, e.g., user attributes
                 };

                 console.log(`[${serviceName}] Listener: Calling Provisioning Service API to request removal of ALL roles for user ${userId}`);

                 const provisioningServiceApiUrl = serviceConfigs.provisioningServiceApiUrl; // Get from service configs

                 try {
                     const response = await axios.post(`${provisioningServiceApiUrl}/provision`, desiredStatePayload);

                     if (response.status === 202) {
                         console.log(`[${serviceName}] Listener: Provisioning request accepted for user ${userId}. Task ID: ${response.data.taskId}`);
                         // TODO: Log or track the provisioning task ID if needed (e.g., in Leaver Service DB)
                     } else {
                         console.error(`[${serviceName}] Listener: Provisioning API returned unexpected status ${response.status} for user ${userId}. Response:`, response.data);
                         // TODO: Handle unexpected API responses
                         throw new Error(`Provisioning API returned status ${response.status}`); // Re-throw
                     }

                 } catch (apiError) {
                     console.error(`[${serviceName}] Listener: Error calling Provisioning Service API for user ${userId}:`, apiError.message);
                      // TODO: Implement retry logic for API calls
                      throw apiError; // Re-throw to be caught by the worker's catch block
                 }

                 // Acknowledge the message only after successful processing (including calling the API)
                 channel.ack(msg);
                 console.log(`[${serviceName}] Listener successfully processed and acknowledged leaver event for user ID: ${userId}`);

             } catch (error) {
                 // Catch errors that occur *during* the processing of a specific message
                 console.error(`[${serviceName}] Listener error processing leaver event message for user ID ${userId}:`, error);
                 // TODO: Implement robust retry logic using NACK and potentially delayed queues
                  channel.nack(msg, false, true); // Reject and requeue for a retry

                 // TODO: Log this processing error
             }
         }, {
             noAck: false // Crucial: We will manually acknowledge messages
         });

         console.log(`[${serviceName}] Listener started consuming messages from queue "${queue.queue}".`);

     } catch (setupError) {
          console.error(`[${serviceName}] Failed to setup Leaver Event Listener:`, setupError);
          // Critical startup error
          throw new Error('Failed to setup Leaver Event Listener: ' + setupError.message);
     }
}


// --- Graceful Shutdown Handling ---
process.on('SIGTERM', async () => {
    console.log(`[${serviceName}] SIGTERM received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown

    // Close connections
    if (ConfigService.sequelize) {
        await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        console.log(`[${serviceName}] Config DB connection closed.`);
    }
    if (MqService.connection) {
        await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
        console.log(`[${serviceName}] MQ connection closed.`);
    }

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

    console.log(`[${serviceName}] Graceful shutdown complete.`);
    process.exit(0); // Exit successfully
});

// Optional: Handle uncaught exceptions and unhandled promise rejections
process.on('uncaughtException', (err) => {
    console.error(`[${serviceName}] Uncaught Exception:`, err);
    // TODO: Log critical error
    // Attempt graceful shutdown or exit
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[${serviceName}] Unhandled Rejection at Promise:`, promise, 'reason:', reason);
     // TODO: Log critical error
    // Attempt graceful shutdown or exit
});


// --- Start the Service ---
startService();