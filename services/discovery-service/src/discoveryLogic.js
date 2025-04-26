// services/discovery-service/src/discoveryLogic.js

// Import helper modules (still placeholders for now)
// const DiscoveryAdapterLoader = require('./discoveryAdapterLoader'); // Handles dynamic loading (optional helper)
// const ReconciliationLogic = require('./reconciliationLogic'); // Handles comparison/discrepancies (optional helper)

// Assuming axios is installed and available for API calls
const axios = require('axios'); // For calling the Provisioning Service API for revocation

// Helper function to get a value from a nested object path (copy from provisioningLogic or use shared utility)
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined; // Path not found or hit a non-object/null
        }
        current = current[part];
    }
    return current;
}

// Helper function to create a composite key for Discovered State lookup
function createDiscoveredStateKey(applicationId, appSpecificUserId, appSpecificEntitlementId) {
    // Ensure components are strings and handle null/undefined appropriately
    const appId = applicationId || 'null';
    const userId = appSpecificUserId || 'null';
    const entId = appSpecificEntitlementId || 'null';
    // Use a separator unlikely to appear in IDs. Ensure IDs are strings for consistent keys.
    return `${String(appId)}|${String(userId)}|${String(entId)}`;
}


// Define MQ constants for reconciliation triggers
const RECONCILIATION_TRIGGERS_EXCHANGE = 'reconciliation.triggers';
const RECONCILIATION_TRIGGER_ROUTING_KEY = 'run.completed'; // Routing key for triggers when a run is completed


/**
 * Orchestrates a single data discovery run from target applications.
 * This function contains the core logic based on configurations.
 * It finds applications to discover, calls the relevant adapters, and stores the results.
 *
 * @param {object} options - Options object passed from server.js.
 * @param {object} options.serviceConfigs - Service-specific configurations (e.g., { discoveryIntervalMinutes: ..., applicationsToDiscover: [...] }).
 * @param {object} options.configService - The initialized ConfigService instance (for accessing Config DB).
 * @param {object} options.mqService - The initialized MqService instance (for publishing events).
 * @param {object} options.models - Sequelize models object (e.g., { DiscoveryRun, CurrentAppState, Application, ConnectorConfig, MappingConfig, User, ... }).
 * @returns {Promise<object>} Run results including status, metrics, errors.
 */
async function performRun(options) {
    // Destructure options for easier access to dependencies
    const { serviceConfigs, configService, mqService, models } = options;
    // Access models explicitly for clarity
    const { DiscoveryRun, CurrentAppState, Application, ConnectorConfig, MappingConfig, User } = models;

    const serviceName = 'discovery-service'; // Service identifier

    let run; // Variable to hold the DiscoveryRun log entry
    let errorDetails = null;
    let runMetrics = { applicationsProcessed: 0, recordsDiscovered: 0, usersDiscovered: 0, entitlementsDiscovered: 0, errors: 0 };
    let overallRunStatus = 'failed'; // Default to failed if not completed

    try {
        console.log(`[${serviceName}] performRun: Starting new discovery run.`);
        // 1. Create a new DiscoveryRun entry in the database (status: 'started').
        run = await DiscoveryRun.create({
             status: 'started',
             startTime: new Date(),
             metadata: { initialServiceConfigs: serviceConfigs } // Log initial configs for context
        });
        console.log(`[${serviceName}] performRun: DiscoveryRun log created with ID ${run.id}`);


        // 2. Determine which Applications to discover.
        // This list comes from the service's configuration.
        const applicationsToDiscoverNames = serviceConfigs.applicationsToDiscover || [];
        if (applicationsToDiscoverNames.length === 0) {
             console.warn(`[${serviceName}] performRun: No applications configured for discovery in service config. Skipping discovery run.`);
             runMetrics.applicationsProcessed = 0;
             overallRunStatus = 'completed'; // Consider it completed if nothing to discover
             await run.update({ status: overallRunStatus, endTime: new Date(), metrics: runMetrics }); // Update log for skipped run
             return { status: overallRunStatus, metrics: runMetrics }; // Exit early
        }
        console.log(`[${serviceName}] performRun: Configured to discover from ${applicationsToDiscoverNames.length} applications.`);

        // Load Application models from the database based on their names
        const applications = await Application.findAll({
             where: { name: applicationsToDiscoverNames }
             // TODO: Add environment filter if applications are environment specific
        });

        if (applications.length === 0) {
             console.error(`[${serviceName}] performRun: No matching Application entries found in DB for configured names: ${applicationsToDiscoverNames.join(', ')}. Cannot proceed.`);
             throw new Error("No configured Application entries found in database.");
        }
         runMetrics.applicationsProcessed = applications.length;
         console.log(`[${serviceName}] performRun: Found ${applications.length} Application entries to process.`);


        // --- Orchestrate Discovery per Application ---
        let allApplicationsDiscoveredSuccessfully = true;

        for (const application of applications) {
             console.log(`[${serviceName}] performRun: Starting discovery for Application "${application.name}" (ID: ${application.id}).`);

             let appConnectorConfig; // Connector config for Discovery
             let appMappingConfig; // Mapping from App-specific -> IGLM User/Entitlement
             let discoveredAccessData = null; // Raw data from the adapter
             let appDiscoverySuccessful = false; // Track success for this application

             try {
                 // 3. Load the Discovery Connector Config for this application.
                 // Find a ConnectorConfig with serviceType 'Discovery' linked to this Application (sourceId = application.id).
                 // Note: This assumes a MappingConfig entry with sourceType 'Discovery' also exists with sourceId = application.id
                 appConnectorConfig = await ConnectorConfig.findOne({
                     where: {
                          sourceType: 'Discovery', // This is a discovery connector
                          sourceId: application.id, // Linked to this specific Application ID
                          // TODO: Add environment filter
                     }
                 });

                 if (!appConnectorConfig) {
                      console.warn(`[${serviceName}] performRun: No Discovery Connector Config found for Application "${application.name}" (ID: ${application.id}). Skipping discovery for this app.`);
                       // Log a skipped result for this application
                       // Add { status: 'skipped', message: 'No discovery connector config' } to a results array per application if needed
                       continue; // Skip to the next application in the loop
                 }
                  // Basic validation that the connector config is for discovery
                  if (appConnectorConfig.serviceType !== 'Discovery') {
                       console.warn(`[${serviceName}] performRun: Connector Config "${appConnectorConfig.name}" (ID: ${appConnectorConfig.id}) linked to Application "${application.name}" is not marked as serviceType 'Discovery'. This might be a configuration error.`);
                  }
                   console.log(`[${serviceName}] performRun: Loaded App Discovery Connector Config: "${appConnectorConfig.name}" (Type: "${appConnectorConfig.type}", ID: ${appConnectorConfig.id}).`);


                 // 4. Load the Application-specific Mapping Config (App-specific -> IGLM User/Entitlement)
                 // Assumed MappingConfig entry with sourceType: 'Discovery', sourceId: application.id, targetType: 'DiscoveredStateMapping'
                 appMappingConfig = await MappingConfig.findOne({
                     where: {
                         sourceType: 'Discovery', // Mapping used for discovery
                         sourceId: application.id, // Linked to this specific application ID
                         targetType: 'DiscoveredStateMapping', // Type of mapping
                         // TODO: Add environment filter
                     }
                 });
                 // If no specific mapping config, adapter will need to use default mapping or structure.
                 const discoveredStateMappingRules = (appMappingConfig?.mappingRules?.discoveredStateMapping) || {};
                  if (!appMappingConfig) {
                       console.warn(`[${serviceName}] performRun: No specific Discovered State Mapping Config found for Application "${application.name}". Adapter will need to use default mapping.`);
                  } else if (!discoveredStateMappingRules || !discoveredStateMappingRules.uniqueIdentifierSourceField || !discoveredStateMappingRules.entitlementIdentifierSourceField || !discoveredStateMappingRules.attributeMapping) { // Check attributeMapping here too
                       console.error(`[${serviceName}] performRun: Discovered State Mapping Config "${appMappingConfig.name}" is incomplete for Application "${application.name}". Cannot proceed.`);
                       throw new Error(`Discovered State Mapping Config for "${application.name}" is incomplete.`);
                  }


                   console.log(`[${serviceName}] performRun: Loaded App Discovered State Mapping Config (exists: ${!!appMappingConfig}). Unique ID Source: "${discoveredStateMappingRules.uniqueIdentifierSourceField}". Entitlement ID Source: "${discoveredStateMappingRules.entitlementIdentifierSourceField}".`);


                 // 5. Call the connector adapter to pull current access state data.
                 // Assuming adapters are in ./connectors/discovery/ and file name matches ConnectorConfig.type
                 const connectorModule = require(`./connectors/discovery/${appConnectorConfig.type}`); // Dynamic require
                 // Discovery Adapter needs a standard interface like discoverAccess(configDetails, mappingRules, lastRunTimestamp)
                 if (!connectorModule || typeof connectorModule.discoverAccess !== 'function') {
                      throw new Error(`Discovery Connector adapter module "${appConnectorConfig.type}" not found in ./connectors/discovery/ or missing discoverAccess function.`);
                 }
                 console.log(`[${serviceName}] performRun: Loaded discovery adapter module: "${appConnectorConfig.type}".`);


                 // Pass connector config.configuration, the discovered state mapping rules, and potentially last run timestamp for incremental discovery
                 const lastSuccessfulRun = await DiscoveryRun.findOne({
                      where: { status: 'completed', applicationId: application.id },
                      order: [['endTime', 'DESC']] // Get the most recent successful run for this app
                 });
                 const lastRunTimestamp = lastSuccessfulRun ? lastSuccessfulRun.endTime : null;
                  console.log(`[${serviceName}] performRun: Calling discovery adapter discoverAccess. Last successful run end time for this app: ${lastRunTimestamp}.`);

                 // The adapter needs the mapping rules to know *what* data points to pull and *how* to structure them (e.g., which fields are user IDs, which are entitlements).
                 discoveredAccessData = await connectorModule.discoverAccess(appConnectorConfig.configuration, discoveredStateMappingRules, lastRunTimestamp);
                 // discoveredAccessData is expected to be an array of objects representing user/entitlement pairs from the target app
                 // Example expected structure from adapter: [{ userIdentifierSourceField: '...', entitlementIdentifierSourceField: '...', other_attribute: '...', ... }, ...]

                 runMetrics.recordsDiscovered += discoveredAccessData ? discoveredAccessData.length : 0;
                 console.log(`[${serviceName}] performRun: Successfully pulled ${discoveredAccessData ? discoveredAccessData.length : 0} discovered records for Application "${application.name}".`);


                 // 6. Process Discovered State Data & Store in CurrentAppStates table.
                 // This involves mapping the raw discovered data to the CurrentAppState model structure.
                 // It also involves linking the discovered state to IGLM Users (identity resolution).
                 // This complex logic will go into a helper module (e.g., src/stateStorage.js).
                 const StateStorage = require('./stateStorage'); // Should be available after npm install

                 // Pass raw discovered data, app details, mapping config, models, and the current run ID
                 await StateStorage.storeDiscoveredState(discoveredAccessData, application, appMappingConfig, models, run.id);
                 console.log(`[${serviceName}] performRun: Discovered state stored for Application "${application.name}".`);

                 appDiscoverySuccessful = true; // Mark this application's discovery as successful


             } catch (appDiscoveryError) {
                 console.error(`[${serviceName}] performRun: Error discovering Application "${application.name}" (ID: ${application.id}):`, appDiscoveryError);
                 allApplicationsDiscoveredSuccessfully = false; // Mark overall run as failed if any app fails
                 errorDetails = errorDetails || {};
                 errorDetails[application.id] = { message: appDiscoveryError.message, stack: appDiscoveryError.stack }; // Store error under app ID
                 runMetrics.errors++; // Increment error count
                 // Continue processing other applications
             }
        } // End loop through applications


        // --- Finalize Discovery Run ---
        overallRunStatus = allApplicationsDiscoveredSuccessfully ? 'completed' : 'failed';

        // 7. Update the DiscoveryRun entry (status, end time, metrics).
         const runToUpdate = await DiscoveryRun.findByPk(run.id);
          if (runToUpdate) {
              if (runToUpdate.status === 'started' || runToUpdate.status === 'retrying') {
                  await runToUpdate.update({
                      status: overallRunStatus,
                      endTime: new Date(),
                      metrics: runMetrics,
                      errorDetails: errorDetails
                  });
                  console.log(`[${serviceName}] performRun: DiscoveryRun log ${run.id} status updated to '${overallRunStatus}'.`);
              } else {
                   console.log(`[${serviceName}] performRun: DiscoveryRun log ${run.id} status was changed externally to '${runToUpdate.status}'. Skipping final status update.`);
              }
          } else {
               console.error(`[${serviceName}] performRun: CRITICAL ERROR: DiscoveryRun log ${run.id} not found when trying to finalize.`);
          }


        // 8. Publish status updates to the Message Queue (Optional)
        // Publish using the *final* determined status
        const discoveryRunCompletedEventPayload = {
             runId: run.id,
             status: overallRunStatus,
             metrics: runMetrics,
             errorDetails: errorDetails,
             timestamp: new Date()
        };
        await mqService.publish('discovery.status', `run.${overallRunStatus}`, discoveryRunCompletedEventPayload);
        console.log(`[${serviceName}] performRun: Published 'discovery.status' event (run.${overallRunStatus}) for run ${run.id}.`);

        // --- Trigger Reconciliation Logic AFTER Discovery Run ---
        // This is where the Reconciliation logic is triggered based on the completed discovery run.
        // It can be called directly or triggered via MQ.
        // Option A (Direct Call): Call ReconciliationLogic.performReconciliation(run.id, options) here if it runs in the same process.
        // Option B (MQ Trigger): Publish a message to trigger a separate worker or service. This is generally preferred for decoupling.
        // We outlined Option B in server.js setup. The message published in step 8 already triggers the worker!
        // So, the trigger mechanism is already implemented by publishing 'discovery.status.run.completed'.
        // The worker in server.js listens to this.

         console.log(`[${serviceName}] performRun: Reconciliation will be triggered by MQ event 'discovery.status.run.${overallRunStatus}'.`);


        // Return final status and metrics
        return { status: overallRunStatus, metrics: runMetrics, errorDetails: errorDetails };


    } catch (overallError) {
        console.error(`[${serviceName}] performRun: Uncaught critical error during discovery run setup for run ID ${run?.id}:`, overallError);
         errorDetails = errorDetails || { message: overallError.message, stack: overallError.stack };
         runMetrics.errors = (runMetrics.errors || 0) + 1;

         // Ensure run status is marked failed if a critical uncaught error occurs
         try {
             const runToUpdate = run ? await DiscoveryRun.findByPk(run.id) : null;
              if (runToUpdate && (runToUpdate.status === 'started' || runToUpdate.status === 'retrying')) { // Only update if still initial status
                  await runToUpdate.update({
                       status: 'failed', // Mark as failed
                       endTime: new Date(),
                       errorDetails: errorDetails, // Store uncaught error details
                       metrics: runMetrics // Store any metrics collected before error
                  });
                   console.log(`[${serviceName}] performRun: DiscoveryRun log ${run?.id} status updated to 'failed' due to uncaught error.`);
             } else if (runToUpdate) {
                   console.log(`[${serviceName}] performRun: DiscoveryRun log ${run.id} status was changed externally to '${runToUpdate.status}' before uncaught error handling.`);
             } else {
                  console.error(`[${serviceName}] performRun: CRITICAL ERROR: DiscoveryRun log object was null during uncaught error.`);
             }
         } catch (updateErr) {
              console.error(`[${serviceName}] performRun: CRITICAL ERROR failed to update DiscoveryRun log ${run?.id} after uncaught error:`, updateErr);
         }

        // Re-throw the error? Or just return? Let the scheduler catch it.
        return { status: 'failed', metrics: runMetrics, errorDetails: errorDetails };

    } finally {
       // Cleanup (e.g., close SSH pools managed by adapters)
       console.log(`[${serviceName}] performRun: Discovery run process finished finally block.`);
    }
}


// Helper function to get a value from a nested object path (copied locally for self-containment)
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined; // Path not found or hit a non-object/null
        }
        current = current[part];
    }
    return current;
}


// Helper function to create a composite key for Discovered State lookup
function createDiscoveredStateKey(applicationId, appSpecificUserId, appSpecificEntitlementId) {
    // Ensure components are strings and handle null/undefined appropriately
    const appId = applicationId || 'null';
    const userId = appSpecificUserId || 'null';
    const entId = appSpecificEntitlementId || 'null';
    // Use a separator unlikely to appear in IDs. Ensure IDs are strings for consistent keys.
    return `${String(appId)}|${String(userId)}|${String(entId)}`;
}


// Export the main orchestration function
module.exports = {
  performRun,
};