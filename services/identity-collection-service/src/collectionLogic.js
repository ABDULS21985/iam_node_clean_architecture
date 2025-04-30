// services/identity-collection-service/src/collectionLogic.js

// Import helper modules
const TemporaryStorage = require('./temporaryStorage');
const DeltaDetection = require('./deltaDetection');
const DataProcessor = require('./dataProcessor');
const ConfigService = require('../../../shared/configService'); // Adjust path as needed

async function performRun(options) {
    const { serviceConfigs, configService, mqService, models, temporaryStorage, logger } = options;
    const { CollectionRun, ConnectorConfig, MappingConfig, User } = models;

    const serviceName = 'identity-collection-service';
    const snapshotKeyPrefix = `hrms_snapshot:`;

    let run;
    let hrmsConnectorConfig;
    let userMappingConfig;
    let rawHrmsData;
    let previousSnapshotMap;
    let deltas;
    let runMetrics = { processed: 0, joiners: 0, movers: 0, leavers: 0, errors: 0 };
    let errorDetails = null;

    try {
        console.log(`[${serviceName}] performRun: Starting new collection run.`);
        // Ensure CollectionRun model is available
        if (!CollectionRun) {
            throw new Error("CollectionRun model is not available in models.");
        }
        run = await CollectionRun.create({
            status: 'started',
            startTime: new Date(),
            metadata: { initialServiceConfigs: serviceConfigs }
        });
        console.log(`[${serviceName}] performRun: CollectionRun log created with ID ${run.id}`);

        // Load HRMS ConnectorConfig
        const identitySourceConnectorName = serviceConfigs.identitySourceConnectorName;
        if (!identitySourceConnectorName) {
            throw new Error("Service configuration 'identitySourceConnectorName' is missing.");
        }

        // Ensure ConfigService is initialized
        if (!configService || typeof configService.loadConnectorConfig !== 'function') {
             throw new Error("ConfigService is not properly initialized or passed.");
        }

        hrmsConnectorConfig = await configService.loadConnectorConfig(
            identitySourceConnectorName,
            'IdentityCollection',
            'hrms-db-postgres' // Assuming this is the specific type for the HRMS Postgres connector
        );

        if (!hrmsConnectorConfig) {
            throw new Error(`HRMS Connector Config not found for name: "${identitySourceConnectorName}".`);
        }

        // Link the CollectionRun to the connector config used
        await run.update({ connectorConfigId: hrmsConnectorConfig.id });
        const snapshotKey = `${snapshotKeyPrefix}${hrmsConnectorConfig.id}`;
        console.log(`[${serviceName}] performRun: Loaded HRMS Connector Config: "${hrmsConnectorConfig.name}"`);

        // Load User Mapping Config
        const userMappingName = serviceConfigs.userMappingName;
        if (!userMappingName) {
            throw new Error("Service configuration 'userMappingName' is missing.");
        }

        // Clear cache for this specific mapping before loading to ensure fresh config
        const userMappingCacheKey = ConfigService.mappingCacheKey(userMappingName, 'IdentitySource', 'User', null, null);
        ConfigService.clearCache(userMappingCacheKey);
        console.log(`[${serviceName}] performRun: Cleared ConfigService cache for user mapping key: ${userMappingCacheKey}`);

        userMappingConfig = await configService.loadMappingConfig(userMappingName, 'IdentitySource', 'User');

        // Debugging logs for mapping config structure
        console.log(`[${serviceName}] performRun: Debugging loaded userMappingConfig:`, JSON.stringify(userMappingConfig, null, 2));
        console.log(`[${serviceName}] performRun: Debugging mappingRules check:`, {
            isNull: userMappingConfig === null,
            hasMappingRules: !!userMappingConfig?.mappingRules,
            hasAttributeMappings: !!userMappingConfig?.mappingRules?.attributeMappings,
            hasMetadata: !!userMappingConfig?.mappingRules?.metadata
        });


        if (!userMappingConfig || !userMappingConfig.mappingRules || !userMappingConfig.mappingRules.attributeMappings) {
            console.error(`[${serviceName}] performRun: User Mapping Config not found or incomplete for "${userMappingName}".`);
            throw new Error(`User Mapping Config not found or incomplete: "${userMappingName}".`);
        }
         if (!userMappingConfig.mappingRules.metadata || !userMappingConfig.mappingRules.metadata.sourceUniqueIdField || !userMappingConfig.mappingRules.metadata.statusSourceField) {
             console.error(`[${serviceName}] performRun: User Mapping Config metadata incomplete for "${userMappingName}".`);
             throw new Error(`User Mapping Config metadata incomplete: "${userMappingName}". Missing sourceUniqueIdField or statusSourceField.`);
         }
        console.log(`[${serviceName}] performRun: Loaded User Mapping Config: "${userMappingConfig.name}".`);

        // Data Collection
        // --- Data Collection Phase ---
        try {
            console.log(`[${serviceName}] performRun: Attempting to dynamically load connector adapter module: "${hrmsConnectorConfig.type}"...`);

            // Dynamically require the connector module based on the config type
            const connectorModulePath = `./connectors/identity-collection/${hrmsConnectorConfig.type}`;
            const connectorModule = require(connectorModulePath);

            // Validate the loaded module
            if (!connectorModule || typeof connectorModule.collectData !== 'function') {
                throw new Error(`Connector adapter module "${hrmsConnectorConfig.type}" is invalid or does not export a collectData function.`);
            }
            console.log(`[${serviceName}] performRun: Successfully loaded connector adapter module: "${hrmsConnectorConfig.type}".`);

            // Retrieve the timestamp of the last successful run for incremental collection (if connector supports it)
            const lastSuccessfulRun = await CollectionRun.findOne({
                where: { status: 'completed', connectorConfigId: hrmsConnectorConfig.id },
                order: [['endTime', 'DESC']] // Get the most recent completed run
            });

            const lastRunTimestamp = lastSuccessfulRun ? lastSuccessfulRun.endTime : null;
            console.log(`[${serviceName}] performRun: Retrieved last successful run timestamp: ${lastRunTimestamp || 'None (first run).'}`);

            // Initiate data collection via the connector adapter
            console.log(`[${serviceName}] performRun: Initiating data collection via connector adapter...`);
            // Pass the full configuration property, not just mappingRules, as connector might need other metadata
            rawHrmsData = await connectorModule.collectData(hrmsConnectorConfig.configuration, lastRunTimestamp);


            runMetrics.processed = Array.isArray(rawHrmsData) ? rawHrmsData.length : 0;
            console.log(`[${serviceName}] performRun: Data collection completed. ${runMetrics.processed} record(s) retrieved.`);

            // --- 🔵 Log first few record KEYS for debugging ---
            if (Array.isArray(rawHrmsData) && rawHrmsData.length > 0) {
                 console.log(`[${serviceName}] performRun: Debugging keys of first few records...`);
                 rawHrmsData.slice(0, 5).forEach((record, index) => {
                     if (record && typeof record === 'object') {
                         console.log(`[${serviceName}] \tRecord ${index + 1} keys:`, Object.keys(record));
                     } else {
                         console.warn(`[${serviceName}] \tRecord ${index + 1} is not an object:`, record);
                     }
                 });
                 if (rawHrmsData.length > 5) {
                     console.log(`[${serviceName}] \t...and ${rawHrmsData.length - 5} additional record(s) not shown.`);
                 }
            } else if (Array.isArray(rawHrmsData)) {
                 console.warn(`[${serviceName}] performRun: rawHrmsData is an empty array.`);
            } else {
                 console.error(`[${serviceName}] performRun: rawHrmsData is null, undefined, or not an array.`);
            }
            // --- End Key Debugging ---


        } catch (connectorError) {
            console.error(`[${serviceName}] performRun: Fatal error during HRMS connector operation:`, connectorError);
             // Wrap connector errors to distinguish them
            throw new Error(`HRMS Connector adapter failure: ${connectorError.message}`);
        }
        // --- End Data Collection Phase ---


        // Load previous snapshot from temporary storage (Redis)
        // Ensure temporaryStorage is initialized
        if (!temporaryStorage || typeof temporaryStorage.loadSnapshot !== 'function' || typeof temporaryStorage.saveSnapshot !== 'function') {
             throw new Error("TemporaryStorage is not properly initialized or passed.");
        }
        previousSnapshotMap = await temporaryStorage.loadSnapshot(snapshotKey);
        previousSnapshotMap = previousSnapshotMap || {}; // Default to empty object if no snapshot exists
        console.log(`[${serviceName}] performRun: Loaded previous snapshot (items: ${Object.keys(previousSnapshotMap).length}).`);

        // Get unique ID field from mapping metadata
        const sourceUniqueIdField = userMappingConfig.mappingRules.metadata.sourceUniqueIdField;
        // Note: We already checked for missing sourceUniqueIdField during mapping config validation above

        // --- START FIX: Correctly find the target attribute name mapping from the source unique ID field ---
        let uniqueIdTargetAttribute = null;
        const attributeMappings = userMappingConfig.mappingRules.attributeMappings;

        // Search through attributeMappings to find which TARGET attribute
        // is mapped FROM the SOURCE unique ID field (sourceUniqueIdField)
        for (const targetKey in attributeMappings) {
            // Check if the source field value of this mapping entry matches the designated unique source ID field
            if (attributeMappings[targetKey] === sourceUniqueIdField) {
                uniqueIdTargetAttribute = targetKey;
                // Assuming the unique source ID maps to only ONE target attribute (e.g., employee_id -> hrmsId)
                break;
            }
        }

        // If no mapping was found where sourceUniqueIdField is the VALUE on the right side
        if (!uniqueIdTargetAttribute) {
            // This error means the userMappingConfig.attributeMappings doesn't contain an entry like {"someField": "employee_id"}
            throw new Error(`Missing attribute mapping for unique ID source field "${sourceUniqueIdField}". No entry found in attributeMappings where the value is "${sourceUniqueIdField}". This field must be mapped to a target attribute.`);
        }
        // We now know the name of the attribute in the IGLM User model that stores the unique source ID (e.g., 'hrmsId')

        // --- END FIX ---


        // Build the current snapshot map using the fetched raw data
        const currentSnapshotMap = {};
        if (!rawHrmsData || !Array.isArray(rawHrmsData)) {
            console.warn(`[${serviceName}] performRun: Raw HRMS data is invalid.`);
             // If no valid data, the current snapshot remains empty
        } else if (rawHrmsData.length > 0) {
             // --- START FIX: Use the SOURCE unique ID field name to access data from raw records ---

            // Validate that the raw data actually contains the column designated as the unique source ID
            if (!rawHrmsData[0].hasOwnProperty(sourceUniqueIdField)) {
                const availableFields = Object.keys(rawHrmsData[0]).join(', ');
                 // This error means the column specified by metadata.sourceUniqueIdField (e.g., 'employee_id')
                 // was not present in the data returned by the connector's query.
                 throw new Error(
                    `HRMS data missing source unique ID field: "${sourceUniqueIdField}". ` +
                    `This column must be selected by the connector query. Available fields in first record: ${availableFields}`
                );
            }

            rawHrmsData.forEach(record => {
                // Access the unique ID value from the raw record using the SOURCE field name
                const uniqueIdValue = record[sourceUniqueIdField];
                // Only include records that have a valid unique ID value
                if (uniqueIdValue !== undefined && uniqueIdValue !== null && uniqueIdValue !== '') { // Added check for empty string
                    // Store the raw record in the snapshot map, keyed by its unique ID value
                    currentSnapshotMap[uniqueIdValue] = record;
                } else {
                    // Log a warning for records that cannot be uniquely identified
                    console.warn(`[${serviceName}] performRun: Skipping record with missing/invalid unique ID for source field "${sourceUniqueIdField}". Record snippet:`, JSON.stringify(record).substring(0, 200) + '...'); // Log a snippet
                }
            });
             // --- END FIX ---
        }
        console.log(`[${serviceName}] performRun: Created current snapshot map (items: ${Object.keys(currentSnapshotMap).length}).`);


        // Delta Detection: Compare the previous and current snapshots
        // Ensure DeltaDetection is imported and has the compareSnapshots method
        if (!DeltaDetection || typeof DeltaDetection.compareSnapshots !== 'function') {
             throw new Error("DeltaDetection module is not properly imported or has no compareSnapshots method.");
        }
        // Pass the sourceUniqueIdField to DeltaDetection to help it understand which field is the key if needed internally,
        // although the maps are already keyed by the unique ID value.
        deltas = DeltaDetection.compareSnapshots(previousSnapshotMap, currentSnapshotMap, sourceUniqueIdField);

        runMetrics.joiners = deltas.joiners.length;
        runMetrics.movers = deltas.movers.length;
        runMetrics.leavers = deltas.leavers.length;
        console.log(`[${serviceName}] performRun: Deltas found - Joiners: ${runMetrics.joiners}, Movers: ${runMetrics.movers}, Leavers: ${runMetrics.leavers}`);

        // Process Deltas: Map the raw data according to userMappingConfig and publish messages
         // Ensure DataProcessor is imported and has the processDeltas method
        if (!DataProcessor || typeof DataProcessor.processDeltas !== 'function') {
             throw new Error("DataProcessor module is not properly imported or has no processDeltas method.");
        }
        // Pass the raw delta records and the mapping rules to the DataProcessor
        // The DataProcessor is responsible for applying the mapping rules to transform
        // the raw data into the IGLM User model format and interacting with the DB (via models)
        // and MQ (via mqService).
        await DataProcessor.processDeltas(deltas, userMappingConfig.mappingRules, models, mqService);
        console.log(`[${serviceName}] performRun: Deltas processed.`);

        // Save the new snapshot (current state) for the next run's comparison
        // Ensure temporaryStorage is initialized (checked above)
        await temporaryStorage.saveSnapshot(snapshotKey, currentSnapshotMap);
        console.log(`[${serviceName}] performRun: Saved new snapshot.`);

        errorDetails = null; // Clear any potential errors if we reached here
        return { status: 'completed', metrics: runMetrics }; // Indicate success

    } catch (error) {
        // --- Error Handling ---
        console.error(`[${serviceName}] performRun: Error during collection run:`, error);
        runMetrics.errors = (runMetrics.errors || 0) + 1; // Increment error count
        errorDetails = {
            message: error.message,
            // Capture stack trace unless in production for brevity/security
            stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
            // Add other relevant error info if available (e.g., error.code for DB errors)
            code: error.code, // Capture specific error codes like '42703'
            detail: error.detail,
            where: error.where,
        };
         // Return failure status and error details
        return { status: 'failed', metrics: runMetrics, errorDetails: errorDetails };

    } finally {
        // --- Finalization: Update the CollectionRun log ---
        if (run) {
             console.log(`[${serviceName}] performRun: Updating CollectionRun log ${run.id}.`);
            try {
                 // Determine final status based on whether errorDetails were set
                const finalStatus = errorDetails ? 'failed' : 'completed';
                 // Retrieve the run again in case it was modified elsewhere (less common but safer)
                const runToUpdate = await CollectionRun.findByPk(run.id);

                // Only update if the run is still in a transient state (started or retrying)
                if (runToUpdate && (runToUpdate.status === 'started' || runToUpdate.status === 'retrying')) {
                    await runToUpdate.update({
                        status: finalStatus,
                        endTime: new Date(), // Set end time regardless of status
                        metrics: runMetrics, // Save final metrics
                        errorDetails: errorDetails // Save error details if failed
                    });
                    console.log(`[${serviceName}] performRun: CollectionRun log ${run.id} updated to '${finalStatus}'.`);
                } else if (runToUpdate) {
                    console.warn(`[${serviceName}] performRun: CollectionRun log ${run.id} status was changed externally or already finalized.`);
                } else {
                    // This is a critical error if the run log itself can't be found/updated
                    console.error(`[${serviceName}] performRun: CRITICAL ERROR: CollectionRun log ${run.id} not found for final update.`);
                }
            } catch (updateErr) {
                console.error(`[${serviceName}] performRun: Failed to update CollectionRun log ${run.id}:`, updateErr);
                // If the run log update fails, at least log the original error that caused the run failure
                 if (errorDetails) {
                     console.error(`[${serviceName}] performRun: Original run error details:`, errorDetails);
                 }
            }
        } else {
            // This is a critical error if the run object itself was never created
            console.error(`[${serviceName}] performRun: CRITICAL ERROR: CollectionRun log object was not created at the start.`);
        }
        console.log(`[${serviceName}] --- Data Collection Run Process Finished ---`);
    }
}


module.exports = {
    performRun,
};