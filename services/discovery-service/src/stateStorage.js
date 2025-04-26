// services/discovery-service/src/stateStorage.js

// Import necessary models (will be passed in via options.models)
// const { CurrentAppState, User, Application, DiscoveryRun, MappingConfig } = models;

// Helper function to get a value from a nested object path (copied from provisioningLogic or use shared utility)
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


/**
 * Processes and stores discovered access data into the CurrentAppStates table.
 * Performs mapping to CurrentAppState model and attempts identity resolution.
 *
 * @param {Array<object>} discoveredAccessData - Array of raw objects returned by the Discovery Connector adapter.
 * Expected structure depends on the adapter and mapping, but typically [{ userIdentifierSourceField: '...', entitlementIdentifierSourceField: '...', other_attribute: '...', ... }, ...].
 * @param {object} application - The IGLM Application model instance for this discovery run.
 * @param {object} appMappingConfig - The Discovery MappingConfig for this application (SourceType: Discovery, TargetType: DiscoveredStateMapping).
 * Expected appMappingConfig.mappingRules.discoveredStateMapping structure (example):
 * {
 * "uniqueIdentifierSourceField": "sAMAccountName", // Field name in raw data for the user's ID in the target app
 * "entitlementIdentifierSourceField": "memberOf", // Field name in raw data for the entitlement ID in the target app
 * "userMapping": { // Required: How to map app user ID to IGLM User
 * "sourceField": "sAMAccountName", // Field in raw data to get value for search
 * "targetField": "email" // Field in IGLM User model to match against (must be unique)
 * // TODO: Add logic for complex mapping or lookups if needed
 * },
 * "entitlementMapping": { // Optional: How to map app entitlement ID to IGLM Entitlement (optional, for linking)
 * "sourceField": "memberOf", // Field in raw data
 * "targetField": "applicationEntitlementId" // Field in IGLM Entitlement model to match against (must be unique within app)
 * },
 * "attributeMapping": { // Optional: Map attributes from raw data to CurrentAppState metadata
 * "displayName": "displayName", // Map raw 'displayName' to metadata 'displayName'
 * "userAccountControl": "attributes.userAccountControl" // Nested attribute example
 * },
 * }
 * @param {object} models - Sequelize models object ({ CurrentAppState, User, Application, DiscoveryRun, MappingConfig, ... }).
 * @param {string} runId - The ID of the current DiscoveryRun.
 * @returns {Promise<void>} Resolves when all data from this application is processed and stored.
 */
async function storeDiscoveredState(discoveredAccessData, application, appMappingConfig, models, runId) {
    const serviceName = 'discovery-service';
    console.log(`[StateStorage] Storing discovered state for Application "${application.name}" (Run ID: ${runId}). Records: ${discoveredAccessData?.length || 0}`);

    const { CurrentAppState, User } = models; // Access models
    const discoveredStateMappingRules = appMappingConfig?.mappingRules?.discoveredStateMapping;

    if (!discoveredStateMappingRules || !discoveredStateMappingRules.uniqueIdentifierSourceField || !discoveredStateMappingRules.entitlementIdentifierSourceField || !discoveredStateMappingRules.userMapping) {
        console.error(`[StateStorage] Missing or incomplete Discovered State Mapping Rules for Application "${application.name}". Cannot store state.`);
        throw new Error(`Missing or incomplete mapping rules for storing discovered state for Application "${application.name}".`);
    }
     if (!discoveredStateMappingRules.userMapping.sourceField || !discoveredStateMappingRules.userMapping.targetField) {
          console.error(`[StateStorage] Missing or incomplete 'userMapping' rule (sourceField or targetField) for Application "${application.name}". Cannot store state.`);
          throw new Error(`Missing or incomplete 'userMapping' rule for Application "${application.name}".`);
     }


    const userMappingRule = discoveredStateMappingRules.userMapping; // Rule for mapping app user ID to IGLM User
    const rawUserIdentifierField = discoveredStateMappingRules.uniqueIdentifierSourceField; // Field in raw data for app user ID
    const rawEntitlementIdentifierField = discoveredStateMappingRules.entitlementIdentifierSourceField; // Field in raw data for app entitlement ID
    const attributeMappingRules = discoveredStateMappingRules.attributeMapping || {}; // Rules for mapping raw attributes to metadata


    // --- Process and Store Each Discovered Record ---
    const recordsProcessed = discoveredAccessData?.length || 0;
    let successfulInsertsUpdates = 0;
    let failedRecords = 0;
    let identityResolvedCount = 0;
    let entitlementResolvedCount = 0; // Track linking to IGLM Entitlement model

    // Using a Map for raw records can help if adapter output has duplicates, but adapter should aim for unique pairs
    // const rawRecordsMap = new Map(); // Map to store unique raw records by a composite key if needed

    for (const rawRecord of discoveredAccessData || []) { // Ensure loop works even if data is null/undefined
        let currentAppStateData = null;
        let userId = null; // Will store resolved IGLM User ID
        let iglmEntitlementId = null; // Will store resolved IGLM Entitlement ID
        let appSpecificUserId = null;
        let appSpecificEntitlementId = null;

        try {
            // 1. Map Raw Data to CurrentAppState fields & Perform Basic Validation
            // Get the app-specific identifiers from the raw data using the configured field names
            appSpecificUserId = getNestedValue(rawRecord, rawUserIdentifierField);
            appSpecificEntitlementId = getNestedValue(rawRecord, rawEntitlementIdentifierField);

            if (appSpecificUserId === undefined || appSpecificUserId === null || appSpecificEntitlementId === undefined || appSpecificEntitlementId === null) {
                 console.warn(`[StateStorage] Skipping discovered record: Missing app user ID ("${rawUserIdentifierField}") or entitlement ID ("${rawEntitlementIdentifierField}") in raw data for Application "${application.name}".`, rawRecord);
                 failedRecords++;
                 continue; // Skip this record
            }

            // Ensure identifiers are strings (DB requires this)
            appSpecificUserId = String(appSpecificUserId);
            appSpecificEntitlementId = String(appSpecificEntitlementId);


            // 2. Perform Identity Resolution (Map app user ID to IGLM User ID)
            // Use the userMappingRule (e.g., map app user ID from raw data to IGLM User email or hrmsId)
            const userMatchSourceField = userMappingRule.sourceField; // Field in raw data to get value for search
            const userMatchTargetField = userMappingRule.targetField; // Field in IGLM User model to match

             let userMatchValue = getNestedValue(rawRecord, userMatchSourceField); // Get the value from raw data

             if (!userMatchSourceField || !userMatchTargetField || userMatchValue === undefined || userMatchValue === null) {
                  console.warn(`[StateStorage] Cannot perform identity resolution for record (App User ID: ${appSpecificUserId}, Entitlement ID: ${appSpecificEntitlementId}): Incomplete user mapping rule or missing source value "${userMatchSourceField}". User ID in IGLM DB will be NULL.`);
                  // userId remains null, logged below
             } else {
                  // Find the IGLM User based on the mapped value
                  // This assumes the targetField in the User model has a unique index for efficient lookup
                  const matchedUser = await User.findOne({ where: { [userMatchTargetField]: userMatchValue } });

                  if (matchedUser) {
                      userId = matchedUser.id; // Store the IGLM User ID
                      identityResolvedCount++;
                      // console.log(`[StateStorage] Identity resolved: App User ID "${appSpecificUserId}" mapped to IGLM User ID ${userId} via "${userMatchTargetField}"="${userMatchValue}".`);
                  } else {
                      console.log(`[StateStorage] Identity not resolved for record (App User ID: ${appSpecificUserId}, Entitlement ID: ${appSpecificEntitlementId}): No IGLM User found matching "${userMatchTargetField}"="${userMatchValue}" for Application "${application.name}". This is an Orphaned Account.`);
                      // userId remains null
                  }
             }


            // 3. Perform Entitlement Resolution (Map app entitlement ID to IGLM Entitlement ID) (Optional)
            // This step links the discovered entitlement to the central IGLM Entitlement model.
            // Useful for reporting or linking state to roles.
            const entitlementMappingRule = discoveredStateMappingRules.entitlementMapping;
             if (entitlementMappingRule?.sourceField && entitlementMappingRule?.targetField) {
                  const entitlementMatchSourceField = entitlementMappingRule.sourceField; // Field in raw data
                  const entitlementMatchTargetField = entitlementMappingRule.targetField; // Field in IGLM Entitlement model

                  let entitlementMatchValue = getNestedValue(rawRecord, entitlementMatchSourceField); // Get value from raw data

                   if (entitlementMatchValue !== undefined && entitlementMatchValue !== null) {
                        // Find the IGLM Entitlement based on the mapped value
                        // Assumes targetField in Entitlement model has a unique index (or unique within app)
                        const matchedEntitlement = await models.Entitlement.findOne({
                             where: {
                                  applicationId: application.id, // Filter by application
                                  [entitlementMatchTargetField]: entitlementMatchValue
                             }
                        });

                        if (matchedEntitlement) {
                            iglmEntitlementId = matchedEntitlement.id; // Store the IGLM Entitlement ID
                            entitlementResolvedCount++;
                            // console.log(`[StateStorage] Entitlement resolved: App Entitlement ID "${appSpecificEntitlementId}" mapped to IGLM Entitlement ID ${iglmEntitlementId} via "${entitlementMatchTargetField}"="${entitlementMatchValue}".`);
                        } else {
                            // console.log(`[StateStorage] Entitlement not resolved for record (App User ID: ${appSpecificUserId}, Entitlement ID: ${appSpecificEntitlementId}): No IGLM Entitlement found matching "${entitlementMatchTargetField}"="${entitlementMatchValue}" for Application "${application.name}".`);
                            // iglmEntitlementId remains null
                        }
                   } else {
                       // console.warn(`[StateStorage] Cannot perform entitlement resolution: Missing source value "${entitlementMatchSourceField}" in raw data.`);
                       // iglmEntitlementId remains null
                   }
             }


            // 4. Map other raw attributes to CurrentAppState metadata
            const metadata = {};
            for(const metaKey in attributeMappingRules) {
                 if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                      const rawField = attributeMappingRules[metaKey]; // e.g. "status_column"
                      metadata[metaKey] = getNestedValue(rawRecord, rawField); // Get value from raw row
                 }
            }
             // Ensure metadata is an object even if empty
             if (typeof metadata !== 'object' || metadata === null) metadata = {};


            // 5. Prepare Data for CurrentAppState Model
            currentAppStateData = {
                 userId: userId, // Resolved IGLM User ID (can be null for orphans)
                 applicationId: application.id, // Linked to the current Application
                 appSpecificUserId: appSpecificUserId, // User ID in the target application (string)
                 appSpecificEntitlementId: appSpecificEntitlementId, // Entitlement ID in the target application (string)
                 iglmEntitlementId: iglmEntitlementId, // Resolved IGLM Entitlement ID (can be null)
                 discoveredAt: new Date(), // Timestamp of this discovery run (or use run.startTime)
                 runId: runId, // Link to the current DiscoveryRun
                 metadata: metadata // Other mapped attributes
            };

            // 6. Store or Update Record in CurrentAppStates table (Idempotency)
            // Use upsert based on the composite unique index ['applicationId', 'appSpecificUserId', 'appSpecificEntitlementId']
            // This ensures that running discovery multiple times for the same app/user/entitlement updates the record.
            const [currentAppStateEntry, created] = await CurrentAppState.upsert(currentAppStateData, {
                 // The 'where' clause for upsert is implicitly based on the model's unique keys (the composite index)
                 // returning: true, // Get the instance back if needed (optional)
            });

            if (created) {
                 // console.log(`[StateStorage] Created new CurrentAppState entry: App User ID "${appSpecificUserId}" Entitlement ID "${appSpecificEntitlementId}" for App "${application.name}".`);
                 successfulInsertsUpdates++;
            } else {
                 // console.log(`[StateStorage] Updated existing CurrentAppState entry: App User ID "${appSpecificUserId}" Entitlement ID "${appSpecificEntitlementId}" for App "${application.name}".`);
                 successfulInsertsUpdates++;
            }


        } catch (recordProcessError) {
            console.error(`[StateStorage] Error processing discovered record for Application "${application.name}" (App User ID: ${appSpecificUserId || 'N/A'}, Entitlement ID: ${appSpecificEntitlementId || 'N/A'}):`, recordProcessError);
            failedRecords++;
            // Continue processing other records
        }
    }

    console.log(`[StateStorage] Finished storing state for Application "${application.name}" (Run ID: ${runId}). Processed: ${recordsProcessed}, Succeeded: ${successfulInsertsUpdates}, Failed: ${failedRecords}. Identity Resolved: ${identityResolvedCount}. Entitlement Resolved: ${entitlementResolvedCount}.`);


    // --- Handle Old State (Cleanup) ---
    // Remove records from CurrentAppStates for this application that were *not* seen in this run.
    // This indicates access that has been revoked in the target application since the last run.
    // Delete entries linked to the *previous* run for this application that weren't in the *current* run's data.
    // A simple approach: delete entries for this app where runId is NOT the current runId.
    // This assumes *every* entry for this app is seen in *every* full run.
    // If adapter supports incremental, cleanup logic is more complex (mark old, upsert new, delete marked).
    // Let's implement the simple delete-by-runId approach as outlined before.

     await removeOldState(application.id, runId, models); // Call the helper to remove old state
     console.log(`[StateStorage] Removed old discovered state for Application "${application.name}" prior to run ID ${runId}.`);


    // TODO: Publish events for detected changes (new state, state gone, state updated attributes)
    // This can be done here or as part of reconciliation logic. Comparing previous snapshot vs current state after upsert
    // is needed to identify changes.


}


/**
 * Removes old discovered access state entries for a specific application.
 * Typically removes entries linked to runs *before* the current run ID.
 *
 * @param {string} applicationId - The ID of the Application to clean up state for.
 * @param {string} currentRunId - The ID of the current DiscoveryRun. Entries with runId < currentRunId will be considered old.
 * @param {object} models - Sequelize models object ({ CurrentAppState, DiscoveryRun, ... }).
 * @returns {Promise<void>} Resolves when old state is removed.
 */
async function removeOldState(applicationId, currentRunId, models) {
     const serviceName = 'discovery-service';
     console.log(`[StateStorage] Cleaning up old discovered state for Application "${applicationId}" prior to run ID ${currentRunId}.`);

     const { CurrentAppState, DiscoveryRun } = models; // Access models

     try {
         // Find all entries for this application that are NOT linked to the current run ID.
         // Delete these entries. This assumes that upserting creates/updates records
         // with the *current* runId, so any entry whose runId is *not* currentRunId
         // must represent access that was *not* present in the current data pull.
         const deleteResult = await CurrentAppState.destroy({
              where: {
                   applicationId: applicationId,
                   runId: { [models.Sequelize.Op.ne]: currentRunId } // Where runId is NOT the current run ID
              }
               // This logic assumes that upserting creates/updates records with the *current* runId.
               // This effectively deletes any discovered state for this app that was linked to a *previous* run
               // and was not present in the data pulled during the *current* run.
         });

         console.log(`[StateStorage] Cleaned up ${deleteResult} old state entries for Application "${applicationId}".`);


     } catch (cleanupError) {
         console.error(`[StateStorage] Error cleaning up old discovered state for Application "${applicationId}" (Run ID: ${currentRunId}):`, cleanupError);
         // Log the error, but don't throw as the main discovery run might have succeeded.
     }
}


// Helper function to get a value from a nested object path (copy or use shared)
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


// Export the main storage function(s)
module.exports = {
  storeDiscoveredState,
  // removeOldState // Export if called directly elsewhere (less likely)
};