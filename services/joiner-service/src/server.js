// services/joiner-service/src/server.js
const express = require('express');
const app = express();
// Joiner service might not need to listen on a port if it's purely an MQ consumer,
// but include port definition and server start for consistency/health checks.
const port = process.env.JOINER_PORT || 4002;


// Import necessary libraries
const axios = require('axios'); // For calling the Provisioning Service API


// Import shared services and models
const ConfigService = require('../../shared/configService'); // Adjust path as needed
const MqService = require('../../shared/mqService');       // Adjust path as needed
// Access models if needed, though Joiner service might not interact directly with Core Data Model DB much
// const models = require('../../shared/models'); // Not directly used here, but imported by ConfigService

// Import the Role Assignment Service
const roleAssignmentService = require('../../shared/roleAssignmentService'); // Adjust path as needed


// Define the service name for config loading and logging
const serviceName = 'joiner-service';
let serviceConfigs = {}; // Object to hold loaded service configurations
let attributeToRoleMappingConfig = null; // Config for attribute-to-role mapping


// Define Message Queue details for consuming Joiner events
const IDENTITY_CHANGES_EXCHANGE = 'identity.changes'; // Exchange published to by ICS
const JOINER_QUEUE = 'joiner.events.queue'; // Queue specific to the Joiner service
const JOINER_ROUTING_KEY = 'joiner.new'; // Routing key for new joiner events published by ICS


// --- Service Initialization ---
/**
 * Initializes all necessary components and starts the Joiner Service.
 */
async function startService() {
  try {
    console.log(`[${serviceName}] Starting service initialization...`);

    // 1. Initialize Configuration Service and load configs for this service
    // This also connects to the Config Database where ConnectorConfigs, MappingConfigs, etc. live
    await ConfigService.init();
    console.log(`[${serviceName}] ConfigService initialized successfully.`);

    // Load configurations specific to this service (e.g., Provisioning Service API URL, Attribute-to-Role Mapping name)
    // serviceConfigs will contain the mappingRules from the 'Joiner Service Configuration' entry
    serviceConfigs = await ConfigService.loadServiceConfigs(serviceName);
     // Check for essential config
     if (!serviceConfigs || !serviceConfigs.provisioningServiceApiUrl || !serviceConfigs.attributeToRoleMappingName) {
          console.error(`[${serviceName}] Missing critical service configurations. Loaded:`, serviceConfigs);
          throw new Error("Missing critical service configuration ('provisioningServiceApiUrl' and/or 'attributeToRoleMappingName')");
     }
    console.log(`[${serviceName}] Loaded service configurations:`, serviceConfigs);


    // 2. Load the Attribute-to-Role Mapping config used by this service
    // Get the name of the mapping config from serviceConfigs
    const attributeToRoleMappingName = serviceConfigs.attributeToRoleMappingName;
    attributeToRoleMappingConfig = await ConfigService.sequelize.models.MappingConfig.findOne({
         where: { name: attributeToRoleMappingName, sourceType: 'UserAttributes', targetType: 'Roles' }
         // TODO: Add environment filter if configs are per environment
    });

    if (!attributeToRoleMappingConfig || !attributeToRoleMappingConfig.mappingRules || !attributeToRoleMappingConfig.mappingRules.attributeToRoleMapping) {
         console.error(`[${serviceName}] Attribute-to-Role Mapping Config "${attributeToRoleMappingName}" not found or incomplete. Joiner service cannot assign roles based on attributes.`);
         throw new Error(`Attribute-to-Role Mapping Config "${attributeToRoleMappingName}" not found or incomplete.`);
    } else {
         console.log(`[${serviceName}] Loaded Attribute-to-Role Mapping Config: "${attributeToRoleMappingConfig.name}".`);
    }


    // 3. Initialize Message Queue Service
    await MqService.init();
    await MqService.waitForChannel(); // Wait for MQ channel to be ready
    console.log(`[${serviceName}] Message Queue connected and channel ready.`);


    // 4. Set up Message Queue Consumer (the Joiner Event Listener)
    // Pass the loaded mapping config to the listener setup
    await setupJoinerEventListener(attributeToRoleMappingConfig);
    console.log(`[${serviceName}] Joiner Event Listener setup complete.`);


    // 5. Set up Express server (Optional - for health check)
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
    // Catch any errors during the service initialization phase (DB connection, MQ init etc.)
    console.error(`[${serviceName}] Failed to start service:`, error);
    // TODO: Log startup failure to a centralized logging system before exiting
    process.exit(1); // Exit process immediately if startup fails
  }
}


// --- Joiner Event Listener ---
/**
 * Sets up the Message Queue consumer for 'joiner.new' events.
 * @param {object} attributeToRoleMappingConfig - The loaded mapping config for role determination.
 */
async function setupJoinerEventListener(attributeToRoleMappingConfig) {
     const channel = MqService.channel; // Get the channel after MqService.init and waitForChannel

     if (!channel) {
         throw new Error("MQ Channel not available for Joiner Event Listener setup.");
     }

     try {
         // Declare the exchange published to by ICS
         await channel.assertExchange(IDENTITY_CHANGES_EXCHANGE, 'topic', { durable: true });
         console.log(`[${serviceName}] Listener: Exchange "${IDENTITY_CHANGES_EXCHANGE}" asserted.`);

         // Declare the queue specific to this Joiner service
         // A durable queue persists messages. Auto-delete means queue is deleted when last consumer disconnects.
         // Exclusive means only this consumer can consume from it.
         // Use a durable queue for reliability even if the service restarts.
         const queue = await channel.assertQueue(JOINER_QUEUE, { durable: true });
         console.log(`[${serviceName}] Listener: Queue "${queue.queue}" asserted.`);

         // Bind the queue to the exchange using the 'joiner.new' routing key
         await channel.bindQueue(queue.queue, IDENTITY_CHANGES_EXCHANGE, JOINER_ROUTING_KEY);
         console.log(`[${serviceName}] Listener: Queue "${queue.queue}" bound to exchange "${IDENTITY_CHANGES_EXCHANGE}" with key "${JOINER_ROUTING_KEY}".`);


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
             let initialUserData = null; // Mapped IGLM User data from ICS event

             try {
                 // Parse the message payload (expected to be { userId: '...', hrmsId: '...', userData: {...}, ... })
                 eventPayload = JSON.parse(msg.content.toString());
                 userId = eventPayload.userId;
                 hrmsId = eventPayload.hrmsId;
                 initialUserData = eventPayload.userData; // This is the MAPPED IGLM User data from ICS

                 if (!userId || !hrmsId || !initialUserData) {
                     console.error(`[${serviceName}] Listener received malformed joiner event message: Missing essential data (userId, hrmsId, or userData). Payload:`, eventPayload);
                     channel.nack(msg, false, false); // Reject the message (don't requeue) - it's malformed
                     // TODO: Log malformed message error
                     return;
                 }

                 console.log(`[${serviceName}] Listener received joiner event for user ID: ${userId} (HRMS ID: ${hrmsId}). Initial User Data:`, initialUserData);

                 // --- Determine Initial Roles for the New User ---
                 // Use the roleAssignmentService and the loaded mapping config
                 // Pass the initialUserData and the attributeToRoleMappingConfig
                 const newDesiredRoles = await roleAssignmentService.determineRolesBasedOnMatrixRules(initialUserData, attributeToRoleMappingConfig); // <-- Call the role assignment service

                 // Ensure newDesiredRoles is an array
                 const rolesForProvisioning = Array.isArray(newDesiredRoles) ? newDesiredRoles : [];
                 console.log(`[${serviceName}] Listener: Determined initial desired roles: ${rolesForProvisioning.join(', ')} for user ${userId}`);


                 // --- Trigger Provisioning ---
                 // Prepare the payload for the Provisioning Service API
                 const desiredStatePayload = {
                     userId: userId, // IGLM User ID
                     roles: rolesForProvisioning // Array of determined IGLM Role names
                     // TODO: Add other context if needed by Provisioning Service, e.g., user attributes from initialUserData
                 };

                 console.log(`[${serviceName}] Listener: Calling Provisioning Service API to request roles: ${rolesForProvisioning.join(', ')} for user ${userId}`);

                 const provisioningServiceApiUrl = serviceConfigs.provisioningServiceApiUrl; // Get from service configs

                 try {
                     const response = await axios.post(`${provisioningServiceApiUrl}/provision`, desiredStatePayload);

                     if (response.status === 202) {
                         console.log(`[${serviceName}] Listener: Provisioning request accepted for user ${userId}. Task ID: ${response.data.taskId}`);
                         // TODO: Log or track the provisioning task ID if needed (e.g., in Joiner Service DB)
                     } else {
                         console.error(`[${serviceName}] Listener: Provisioning API returned unexpected status ${response.status} for user ${userId}. Response:`, response.data);
                         // TODO: Handle unexpected API responses
                         throw new Error(`Provisioning API returned status ${response.status}`); // Re-throw to be caught by worker
                     }

                 } catch (apiError) {
                     console.error(`[${serviceName}] Listener: Error calling Provisioning Service API for user ${userId}:`, apiError.message);
                      // TODO: Implement retry logic for API calls if transient error
                      // If Provisioning Service is down or returns 500, we need to retry calling it.
                      // This requires NACK and potentially a retry count or delayed queue.
                      throw apiError; // Re-throw to be caught by the worker's catch block
                 }

                 // Acknowledge the message only after successful processing (including calling the API)
                 channel.ack(msg);
                 console.log(`[${serviceName}] Listener successfully processed and acknowledged joiner event for user ID: ${userId}`);

             } catch (error) {
                 // Catch errors that occur *during* the processing of a specific message
                 console.error(`[${serviceName}] Listener error processing joiner event message for user ID ${userId}:`, error);
                 // TODO: Implement robust retry logic using NACK and potentially delayed/dead-letter queues
                  channel.nack(msg, false, true); // Reject and requeue for a retry

                 // TODO: Log this processing error properly, potentially with the message payload details
             }
         }, {
             noAck: false // Crucial: We will manually acknowledge messages only after successful processing
         });

         console.log(`[${serviceName}] Listener started consuming messages from queue "${queue.queue}".`);

     } catch (setupError) {
          console.error(`[${serviceName}] Failed to setup Joiner Event Listener:`, setupError);
          // This is a critical startup error - the listener cannot run.
          throw new Error('Failed to setup Joiner Event Listener: ' + setupError.message);
     }
}


// --- Graceful Shutdown Handling ---
process.on('SIGTERM', async () => {
    console.log(`[${serviceName}] SIGTERM received, starting graceful shutdown.`);
    // TODO: Implement graceful shutdown (stop MQ consumer, finish ongoing tasks, close connections)
    // Stop consuming messages: MqService would need a stopConsuming method.
    // Wait for ongoing API calls to Provisioning Service to finish?

    // Close connections to external services
    if (ConfigService.sequelize) {
        await ConfigService.sequelize.close().catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        console.log(`[${serviceName}] Config DB connection closed.`);
    }
    if (MqService.connection) {
        await MqService.connection.close().catch(err => console.error(`[${serviceName}] Error closing MQ connection:`, err));
        console.log(`[${serviceName}] MQ connection closed.`);
    }
    // No other persistent connections managed by Joiner service typically

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
     // No other persistent connections managed by Joiner service typically

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