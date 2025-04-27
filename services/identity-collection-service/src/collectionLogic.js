// services/identity-collection-service/src/collectionLogic.js

// Import helper modules
const TemporaryStorage = require('./temporaryStorage');
const DeltaDetection = require('./deltaDetection');
const DataProcessor = require('./dataProcessor');
const ConfigService = require('../../../shared/configService');

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
        
        hrmsConnectorConfig = await configService.loadConnectorConfig(
            identitySourceConnectorName, 
            'IdentityCollection', 
            'hrms-db-postgres'
        );

        if (!hrmsConnectorConfig) {
            throw new Error(`HRMS Connector Config not found for name: "${identitySourceConnectorName}".`);
        }
        
        await run.update({ connectorConfigId: hrmsConnectorConfig.id });
        const snapshotKey = `${snapshotKeyPrefix}${hrmsConnectorConfig.id}`;
        console.log(`[${serviceName}] performRun: Loaded HRMS Connector Config: "${hrmsConnectorConfig.name}"`);

        // Load User Mapping Config
        const userMappingName = serviceConfigs.userMappingName;
        if (!userMappingName) {
            throw new Error("Service configuration 'userMappingName' is missing.");
        }

        const userMappingCacheKey = ConfigService.mappingCacheKey(userMappingName, 'IdentitySource', 'User', null, null);
        ConfigService.clearCache(userMappingCacheKey);
        console.log(`[${serviceName}] performRun: Cleared ConfigService cache for user mapping key: ${userMappingCacheKey}`);

        userMappingConfig = await configService.loadMappingConfig(userMappingName, 'IdentitySource', 'User');

        // Debugging logs
        console.log(`[${serviceName}] performRun: Debugging loaded userMappingConfig:`, JSON.stringify(userMappingConfig, null, 2));
        console.log(`[${serviceName}] performRun: Debugging mappingRules check:`, {
            isNull: userMappingConfig === null,
            hasMappingRules: !!userMappingConfig?.mappingRules,
            hasAttributeMappings: !!userMappingConfig?.mappingRules?.attributeMappings,
            hasMetadata: !!userMappingConfig?.mappingRules?.metadata
        });

        if (!userMappingConfig || !userMappingConfig.mappingRules || !userMappingConfig.mappingRules.attributeMappings) {
            console.error(`[${serviceName}] performRun: User Mapping Config not found or incomplete`);
            throw new Error(`User Mapping Config not found or incomplete: "${userMappingName}".`);
        }
        console.log(`[${serviceName}] performRun: Loaded User Mapping Config: "${userMappingConfig.name}".`);

        // Data Collection
        try {
            const connectorModule = require(`./connectors/identity-collection/${hrmsConnectorConfig.type}`);
            if (!connectorModule || typeof connectorModule.collectData !== 'function') {
                throw new Error(`Connector adapter module "${hrmsConnectorConfig.type}" not found or invalid.`);
            }
            console.log(`[${serviceName}] performRun: Loaded connector adapter module: "${hrmsConnectorConfig.type}".`);

            const lastSuccessfulRun = await CollectionRun.findOne({
                where: { status: 'completed', connectorConfigId: hrmsConnectorConfig.id },
                order: [['endTime', 'DESC']]
            });
            const lastRunTimestamp = lastSuccessfulRun ? lastSuccessfulRun.endTime : null;
            console.log(`[${serviceName}] performRun: Calling connector adapter. Last run: ${lastRunTimestamp}`);

            rawHrmsData = await connectorModule.collectData(hrmsConnectorConfig.configuration, lastRunTimestamp);
            runMetrics.processed = rawHrmsData ? rawHrmsData.length : 0;
            console.log(`[${serviceName}] performRun: Successfully pulled ${runMetrics.processed} records from HRMS.`);

        } catch (connectorError) {
            console.error(`[${serviceName}] performRun: HRMS Connector adapter error:`, connectorError);
            throw new Error(`HRMS Connector failed: ${connectorError.message}`);
        }

        // Load previous snapshot
        previousSnapshotMap = await temporaryStorage.loadSnapshot(snapshotKey);
        previousSnapshotMap = previousSnapshotMap || {};
        console.log(`[${serviceName}] performRun: Loaded previous snapshot (items: ${Object.keys(previousSnapshotMap).length}).`);

        // Get unique ID field with proper error checking
        const sourceUniqueIdField = userMappingConfig?.mappingRules?.metadata?.sourceUniqueIdField;
        if (!sourceUniqueIdField) {
            throw new Error(`Missing sourceUniqueIdField in mapping config metadata for ${userMappingConfig.name}`);
        }

        // Get the mapped field name for the unique ID
        const uniqueIdMappedField = userMappingConfig.mappingRules.attributeMappings[sourceUniqueIdField];
        if (!uniqueIdMappedField) {
            throw new Error(`Missing mapping for unique ID field "${sourceUniqueIdField}" in attribute mappings`);
        }

        const currentSnapshotMap = {};
        if (!rawHrmsData || !Array.isArray(rawHrmsData)) {
            console.warn(`[${serviceName}] performRun: Raw HRMS data is invalid.`);
        } else if (rawHrmsData.length > 0) {
            // Validate the mapped field exists in the source data
            if (!rawHrmsData[0].hasOwnProperty(uniqueIdMappedField)) {
                const availableFields = Object.keys(rawHrmsData[0]).join(', ');
                throw new Error(
                    `HRMS data missing mapped unique ID field: "${uniqueIdMappedField}" (mapped from "${sourceUniqueIdField}"). ` +
                    `Available fields: ${availableFields}`
                );
            }
            
            rawHrmsData.forEach(record => {
                const uniqueIdValue = record[uniqueIdMappedField];
                if (uniqueIdValue !== undefined && uniqueIdValue !== null) {
                    currentSnapshotMap[uniqueIdValue] = record;
                } else {
                    console.warn(`[${serviceName}] performRun: Skipping record with null ID for field "${uniqueIdMappedField}".`);
                }
            });
        }
        console.log(`[${serviceName}] performRun: Created current snapshot map (items: ${Object.keys(currentSnapshotMap).length}).`);

        // Delta Detection
        deltas = DeltaDetection.compareSnapshots(previousSnapshotMap, currentSnapshotMap, sourceUniqueIdField);
        runMetrics.joiners = deltas.joiners.length;
        runMetrics.movers = deltas.movers.length;
        runMetrics.leavers = deltas.leavers.length;
        console.log(`[${serviceName}] performRun: Deltas found - Joiners: ${runMetrics.joiners}, Movers: ${runMetrics.movers}, Leavers: ${runMetrics.leavers}`);

        // Process Deltas
        await DataProcessor.processDeltas(deltas, userMappingConfig.mappingRules, models, mqService);
        console.log(`[${serviceName}] performRun: Deltas processed.`);

        // Save new snapshot
        await temporaryStorage.saveSnapshot(snapshotKey, currentSnapshotMap);
        console.log(`[${serviceName}] performRun: Saved new snapshot.`);

        errorDetails = null;
        return { status: 'completed', metrics: runMetrics };

    } catch (error) {
        console.error(`[${serviceName}] performRun: Error during collection run:`, error);
        runMetrics.errors = (runMetrics.errors || 0) + 1;
        errorDetails = {
            message: error.message,
            stack: error.stack,
        };
        return { status: 'failed', metrics: runMetrics, errorDetails: errorDetails };

    } finally {
        if (run) {
            console.log(`[${serviceName}] performRun: Updating CollectionRun log ${run.id}.`);
            try {
                const finalStatus = errorDetails ? 'failed' : 'completed';
                const runToUpdate = await CollectionRun.findByPk(run.id);
                
                if (runToUpdate && (runToUpdate.status === 'started' || runToUpdate.status === 'retrying')) {
                    await runToUpdate.update({
                        status: finalStatus,
                        endTime: new Date(),
                        metrics: runMetrics,
                        errorDetails: errorDetails
                    });
                    console.log(`[${serviceName}] performRun: CollectionRun log ${run.id} updated to '${finalStatus}'.`);
                } else if (runToUpdate) {
                    console.log(`[${serviceName}] performRun: CollectionRun log ${run.id} status was changed externally.`);
                } else {
                    console.error(`[${serviceName}] performRun: CRITICAL ERROR: CollectionRun log ${run.id} not found.`);
                }
            } catch (updateErr) {
                console.error(`[${serviceName}] performRun: Failed to update CollectionRun log:`, updateErr);
            }
        } else {
            console.error(`[${serviceName}] performRun: CRITICAL ERROR: CollectionRun log object was not created.`);
        }
        console.log(`[${serviceName}] --- Data Collection Run Process Finished ---`);
    }
}

module.exports = {
    performRun,
};