// services/identity-collection-service/src/collectionLogic.js

// Import helper modules that contain the specific logic implementations
const TemporaryStorage = require('./temporaryStorage'); // Handles snapshot persistence (Implemented)
const DeltaDetection = require('./deltaDetection'); // Handles comparison logic (Implemented)
const DataProcessor = require('./dataProcessor'); // Handles mapping, DB updates, MQ publishing (Outlined/Placeholder)

// Note: Connector adapters are dynamically required based on config.type


/**
 * Orchestrates a single data collection run from HRMS.
 * This function contains the core logic based on configurations.
 *
 * @param {object} options - Options object passed from server.js.
 * @param {object} options.serviceConfigs - Service-specific configurations (e.g., { hrmsConnectorName: '...', userMappingName: '...', pollingIntervalMinutes: ... }).
 * @param {object} options.configService - The initialized ConfigService instance (for accessing Config DB directly if needed).
 * @param {object} options.mqService - The initialized MqService instance.
 * @param {object} options.models - Sequelize models object (e.g., { User, ConnectorConfig, MappingConfig, CollectionRun, ... }).
 * @param {object} options.temporaryStorage - The initialized TemporaryStorage module implementation.
 * @returns {Promise<object>} Run results including status, metrics, errors.
 */
async function performRun(options) {
    // Destructure options for easier access to dependencies
    const { serviceConfigs, configService, mqService, models, temporaryStorage } = options;
    // Access models explicitly for clarity
    const { CollectionRun, ConnectorConfig, MappingConfig, User } = models;

    const serviceName = 'identity-collection-service'; // Service identifier
    const snapshotKeyPrefix = `hrms_snapshot:`; // Prefix for keys in temporary storage

    let run; // Variable to hold the CollectionRun log entry
    let hrmsConnectorConfig;
    let mappingConfig;
    let rawHrmsData;
    let previousSnapshotMap; // Use Map for snapshot data
    let deltas;
    let runMetrics = { processed: 0, joiners: 0, movers: 0, leavers: 0, errors: 0 };
    let errorDetails = null;


    try {
        console.log(`[${serviceName}] performRun: Starting new collection run.`);
        // 1. Create a new CollectionRun entry in the database (status: 'started').
        // We create it here to get a run ID immediately
        run = await CollectionRun.create({
             status: 'started',
             startTime: new Date(),
             metadata: { initialServiceConfigs: serviceConfigs } // Log initial configs for context
        });
        console.log(`[${serviceName}] performRun: CollectionRun log created with ID ${run.id}`);


        // 2. Load the HRMS ConnectorConfig from the DB
        // The name of the primary HRMS connector should be in this service's config (e.g., loaded by server.js)
        const hrmsConnectorName = serviceConfigs.hrmsConnectorName;
        if (!hrmsConnectorName) {
            throw new Error("Service configuration 'hrmsConnectorName' is missing. Cannot identify HRMS source.");
        }
        hrmsConnectorConfig = await ConnectorConfig.findOne({
            where: {
                name: hrmsConnectorName,
                serviceType: 'IdentityCollection'
                // TODO: Add environment filter if configs are per environment (e.g., env: serviceConfigs.environment)
            }
        });
        if (!hrmsConnectorConfig) {
            throw new Error(`HRMS Connector Config not found for name: "${hrmsConnectorName}". Please configure.`);
        }
        // Link the run log to the connector config
        await run.update({ connectorConfigId: hrmsConnectorConfig.id });
        const snapshotKey = `${snapshotKeyPrefix}${hrmsConnectorConfig.id}`; // Use connector ID for snapshot key
        console.log(`[${serviceName}] performRun: Loaded HRMS Connector Config: "${hrmsConnectorConfig.name}" (Type: "${hrmsConnectorConfig.type}", ID: ${hrmsConnectorConfig.id}). Snapshot key: ${snapshotKey}`);


        // 3. Load the MappingConfig from the DB
        // The name of the HRMS user mapping config should also be in this service's config
        const userMappingName = serviceConfigs.userMappingName;
         if (!userMappingName) {
            throw new Error("Service configuration 'userMappingName' is missing. Cannot find user mapping.");
        }
        mappingConfig = await MappingConfig.findOne({
             where: {
                 name: userMappingName,
                 sourceType: 'HRMS'
                 // TODO: Add filter by sourceId if mapping configs are linked to a specific connector/app
                 // e.g., sourceId: hrmsConnectorConfig.id
             }
         });
        if (!mappingConfig) {
             throw new Error(`Mapping Config not found for name: "${userMappingName}". Please configure.`);
        }
         // Basic check for essential mapping rules
         if (!mappingConfig.mappingRules || !mappingConfig.mappingRules.metadata || !mappingConfig.mappingRules.metadata.hrmsUniqueIdField) {
              throw new Error(`Mapping Config "${userMappingName}" is missing essential 'mappingRules' or 'hrmsUniqueIdField' metadata.`);
         }
         console.log(`[${serviceName}] performRun: Loaded Mapping Config: "${mappingConfig.name}" (ID: ${mappingConfig.id}). HRMS Unique ID Field: "${mappingConfig.mappingRules.metadata.hrmsUniqueIdField}"`);


        // --- Data Collection and Delta Detection ---

        // 4. Dynamically load the correct HRMS connector adapter module
        // 5. Use the loaded connector adapter and config.configuration to pull raw data from HRMS.
        try {
            const connectorModule = require(`./connectors/identity-collection/${hrmsConnectorConfig.type}`); // Dynamic require based on config.type
            if (!connectorModule || typeof connectorModule.collectData !== 'function') {
                 throw new Error(`Connector adapter module "${hrmsConnectorConfig.type}" not found in ./connectors/identity-collection/ or missing collectData function.`);
            }
             console.log(`[${serviceName}] performRun: Loaded connector adapter module: "${hrmsConnectorConfig.type}".`);

             // Pass connector-specific configuration and potentially last run timestamp for incremental pulls
             const lastSuccessfulRun = await CollectionRun.findOne({
                 where: { status: 'completed', connectorConfigId: hrmsConnectorConfig.id },
                 order: [['endTime', 'DESC']] // Get the most recent successful run
             });
             const lastRunTimestamp = lastSuccessfulRun ? lastSuccessfulRun.endTime : null;
             console.log(`[${serviceName}] performRun: Calling connector adapter. Last successful run end time: ${lastRunTimestamp}`);

            rawHrmsData = await connectorModule.collectData(hrmsConnectorConfig.configuration, lastRunTimestamp);
            runMetrics.processed = rawHrmsData ? rawHrmsData.length : 0;
            console.log(`[${serviceName}] performRun: Successfully pulled ${runMetrics.processed} records from HRMS.`);

        } catch (connectorError) {
            // Catch errors specific to loading/calling the connector adapter
            console.error(`[${serviceName}] performRun: HRMS Connector adapter error (Type: ${hrmsConnectorConfig?.type || 'unknown'}):`, connectorError);
             throw new Error(`HRMS Connector "${hrmsConnectorConfig?.name || 'unknown'}" failed data collection: ${connectorError.message}`); // Re-throw with context
        }


        // 6. Load previous snapshot from temporary storage.
        // Uses the temporaryStorage interface passed from server.js
        // The key is based on the connector config ID to ensure snapshots are source-specific.
        previousSnapshotMap = await temporaryStorage.loadSnapshot(snapshotKey);
        // Ensure it's a Map or empty object if null
        previousSnapshotMap = previousSnapshotMap || {};
        console.log(`[${serviceName}] performRun: Loaded previous snapshot from temporary storage (items: ${Object.keys(previousSnapshotMap).length}).`);


        // Convert current raw data to a Map for easier comparison and later saving
        // The HRMS unique ID field name is required for this and comes from MappingConfig metadata
        const hrmsUniqueIdField = mappingConfig.mappingRules.metadata.hrmsUniqueIdField; // Get from loaded config

        const currentSnapshotMap = {};
         if (rawHrmsData && rawHrmsData.length > 0) {
             // Validate that the unique ID field exists in the raw data before creating map
             if (!rawHrmsData[0].hasOwnProperty(hrmsUniqueIdField)) {
                 console.error(`[${serviceName}] performRun: Raw HRMS data missing expected unique ID field: "${hrmsUniqueIdField}". Cannot proceed.`);
                 // If the first record doesn't have it, assume none do. This is a critical data integrity issue.
                 throw new Error(`HRMS data missing required unique identifier field: "${hrmsUniqueIdField}". Please check mapping config or HRMS source data.`);
             }
             rawHrmsData.forEach(record => {
                 currentSnapshotMap[record[hrmsUniqueIdField]] = record;
             });
         }
        console.log(`[${serviceName}] performRun: Created current snapshot map (items: ${Object.keys(currentSnapshotMap).length}).`);


        // 7. Compare data to find deltas (Joiners, Movers, Leavers)
        // Uses the DeltaDetection helper module
        deltas = DeltaDetection.compareSnapshots(previousSnapshotMap, currentSnapshotMap, hrmsUniqueIdField);
         runMetrics.joiners = deltas.joiners.length;
         runMetrics.movers = deltas.movers.length;
         runMetrics.leavers = deltas.leavers.length;
         console.log(`[${serviceName}] performRun: Deltas found - Joiners: ${runMetrics.joiners}, Movers: ${runMetrics.movers}, Leavers: ${runMetrics.leavers}`);


        // --- Data Processing and Publishing ---

        // 8. Apply mapping rules & 9. Process deltas & Publish MQ Events
        // Uses the DataProcessor helper module
        // Pass deltas, mappingRules, models, mqService, and potentially logger/error logging interface
        await DataProcessor.processDeltas(deltas, mappingConfig.mappingRules, models, mqService);
        console.log(`[${serviceName}] performRun: Deltas processed and events published.`);


        // 10. Update the temporary storage with the new snapshot.
        // Uses the temporaryStorage interface passed from server.js
        await temporaryStorage.saveSnapshot(snapshotKey, currentSnapshotMap);
         console.log(`[${serviceName}] performRun: Saved new snapshot to temporary storage.`);


        // If we reached here, the run completed successfully
        return { status: 'completed', metrics: runMetrics };

    } catch (error) {
        // Catch any errors that occurred during the steps *before* updating the log in finally
        console.error(`[${serviceName}] performRun: Error during collection run:`, error);
        runMetrics.errors = (runMetrics.errors || 0) + 1; // Increment error count
        errorDetails = {
            message: error.message,
            stack: error.stack,
            // TODO: Add more context from the error if possible (e.g., record ID if processing fails for one)
        };
        // Return 'failed' status with metrics and error details
        return { status: 'failed', metrics: runMetrics, errorDetails: errorDetails };

    } finally {
        // This block always runs to update the run log entry
        if (run) { // Ensure run log entry was created before trying to update
            console.log(`[${serviceName}] performRun: Updating CollectionRun log ${run.id}.`);
            try {
                 await run.update({
                    // Set status to 'completed' unless an error occurred (errorDetails is not null)
                    status: errorDetails ? 'failed' : 'completed',
                    endTime: new Date(),
                    metrics: runMetrics,
                    errorDetails: errorDetails
                });
                 console.log(`[${serviceName}] performRun: CollectionRun log ${run.id} updated.`);
            } catch (updateErr) {
                 console.error(`[${serviceName}] performRun: CRITICAL ERROR failed to update CollectionRun log ${run.id}:`, updateErr);
                 // This is bad, the run status is not correctly recorded.
                 // TODO: Implement alerting for this critical failure.
            }
        } else {
             console.error(`[${serviceName}] performRun: CRITICAL ERROR CollectionRun log object was not created. Cannot record run status.`);
              // TODO: Implement alerting for this critical failure.
        }
        console.log(`[${serviceName}] --- Data Collection Run Process Finished ---`);
    }
}


// No other functions or exports needed from this module usually.
// Helper functions like applyMapping are internal to DataProcessor.js


module.exports = {
  performRun,
};