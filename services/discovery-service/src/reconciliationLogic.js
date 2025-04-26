// services/discovery-service/src/reconciliationLogic.js

// Import helper modules (still placeholders for now)
// const ProvisioningAdapterLoader = require('./provisioningAdapterLoader'); // Handles dynamic loading
// const AccessMapper = require('./accessMapper'); // Maps IGLM roles/entitlements to app entitlements
const axios = require('axios'); // For calling the Provisioning Service API for revocation

// Helper function to get a value from a nested object path (copy from provisioningLogic or use shared)
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


// Helper function to map IGLM User to App-Specific User ID using Provisioning Mapping Config
// This function is needed here to prepare the revocation payload and check for missing access.
function mapIglmUserToAppUserId(user, mappingConfig) {
    const serviceName = 'reconciliation-logic'; // Or pass serviceName
    // Check for the expected structure based on recent discussion
    const identifierMapping = mappingConfig?.mappingRules?.userIdentifierMapping;

    if (!user || typeof user !== 'object' || !identifierMapping || typeof identifierMapping !== 'object' || !identifierMapping.sourceField || typeof identifierMapping.sourceField !== 'string') {
        // console.warn(`[${serviceName}] mapIglmUserToAppUserId: Invalid input or missing userIdentifierMapping sourceField for app ${mappingConfig?.applicationId}.`);
        return null; // Cannot map if input is invalid or mapping rule is missing/malformed
    }

    const sourceField = identifierMapping.sourceField;

    let rawIdentifierValue;
    // Use the getNestedValue helper to extract the user attribute based on the mapping config sourceField
    rawIdentifierValue = getNestedValue(user, sourceField);


    if (rawIdentifierValue === null || rawIdentifierValue === undefined) {
        // This warning might be noisy if many users are missing a field, maybe make it debug level or log externally
        // console.warn(`[${serviceName}] mapIglmUserToAppUserId: Source field "${sourceField}" value is null/undefined on user ${user.id} (${user.hrmsId}) for app ${mappingConfig?.applicationId}. Cannot determine app identifier.`);
        return null; // User identifier attribute is missing for this user/mapping
    }

    // Just return the value as a string
    return String(rawIdentifierValue);
}

// Helper function to map IGLM Entitlement to App-Specific Entitlement ID using Provisioning Mapping Config
// This function is needed here to get the app-specific ID for checking existence in discovered state and for the revoke payload.
function mapIglmEntitlementToAppEntitlementId(iglmEntitlementId, mappingConfig) {
    const serviceName = 'reconciliation-logic'; // Or pass serviceName
    // Check for the expected structure based on recent discussion
    const entitlementMappings = mappingConfig?.mappingRules?.entitlementMappings;

    if (!entitlementMappings || typeof entitlementMappings !== 'object') {
        // console.warn(`[${serviceName}] mapIglmEntitlementToAppEntitlementId: Invalid input or missing entitlementMappings for app ${mappingConfig?.applicationId}.`);
        return null; // Cannot map if input is invalid or entitlement mappings are missing
    }

    // Direct lookup by IGLM Entitlement ID
    const entitlementRule = entitlementMappings[iglmEntitlementId];

    if (!entitlementRule || !entitlementRule.appEntitlementId) {
        // This means there's no provisioning mapping for this specific IGLM entitlement in this application
        // console.warn(`[${serviceName}] Warning: Provisioning mapping rule not found or missing appEntitlementId for IGLM Entitlement ${iglmEntitlementId} in app ${mappingConfig?.applicationId}. Cannot determine app-specific entitlement ID.`);
        return null; // Mapping rule not found or incomplete
    }

    return String(entitlementRule.appEntitlementId); // Return the app-specific ID as a string
}


/**
 * Performs reconciliation by comparing desired access state (from IGLM DB)
 * with discovered access state (in CurrentAppStates).
 * Identifies violations, missing access, and orphaned accounts.
 *
 * @param {string} latestDiscoveryRunId - The ID of the latest successful DiscoveryRun to reconcile against.
 * @param {object} options - Options object including shared services and models.
 * @param {object} options.configService - The initialized ConfigService.
 * @param {object} options.mqService - The initialized MqService (optional, for publishing discrepancy events).
 * @param {object} options.models - Sequelize models object ({ CurrentAppState, User, Role, RoleEntitlementMapping, Application, MappingConfig, DiscoveryRun, ReconciliationResult, Entitlement, ... }).
 * @returns {Promise<object>} A promise resolving with reconciliation results (e.g., counts of discrepancies).
 */
async function performReconciliation(latestDiscoveryRunId, options) {
    const serviceName = 'reconciliation-logic'; // Or pass serviceName/context

    console.log(`[${serviceName}] Starting reconciliation based on Discovery Run ID: ${latestDiscoveryRunId}`);

    // Destructure options
    const { configService, mqService, models } = options;
    const { CurrentAppState, User, Role, RoleEntitlementMapping, Application, MappingConfig, DiscoveryRun, ReconciliationResult, Entitlement } = models;


    const discrepancies = {
        violations: [], // User has access they shouldn't (Discovered NOT Desired)
        missingAccess: [], // User is missing access they should have (Desired NOT Discovered)
        orphanedAccounts: [], // Discovered state not linked to an IGLM user
        // unmappedEntitlements: [] // Discovered state mapped to user/app, but entitlement not mapped to an IGLM Entitlement model (Handled implicitly as a violation if user/app is not desired)
    };
    const entitlementsToRevoke = []; // List of CurrentAppState entries to trigger deprovisioning for (Violations/Orphans)


    try {
        // 1. Load Discovered State (Current State) from the latest run.
        const discoveredStates = await CurrentAppState.findAll({
            where: { runId: latestDiscoveryRunId },
            include: [ // Include associations to get related data
                 { model: User, as: 'user' }, // Include the IGLM User if linked (for non-orphans)
                 { model: Application, as: 'application' }, // Include the Application
                 { model: Entitlement, as: 'entitlement' } // Include the IGLM Entitlement if linked
            ]
        });
        console.log(`[${serviceName}] Loaded ${discoveredStates.length} discovered access state entries from run ID ${latestDiscoveryRunId}.`);

        if (discoveredStates.length === 0) {
             console.warn(`[${serviceName}] No discovered state entries found for run ID ${latestDiscoveryRunId}. Skipping reconciliation.`);
             // Log the result
             await ReconciliationResult.create({
                 runId: latestDiscoveryRunId,
                 discrepancyType: 'Info', // Use 'Info' type for informational logs
                 timestamp: new Date(),
                 details: { message: 'No discovered state entries found for this run.', discrepanciesSummary: { violations: 0, missingAccess: 0, orphanedAccounts: 0 } } // Summary should reflect 0
             });
             return { status: 'completed', message: 'No discovered state to reconcile', discrepancies: { violations: 0, missingAccess: 0, orphanedAccounts: 0 } };
        }

        // --- Build Lookup Maps for Efficient Comparison ---
        // Map for quick lookup of Discovered States: key = appId|appUserId|appEntitlementId
        const discoveredStateLookupMap = new Map();
        // Map for quick lookup of Discovered IGLM Entitlement IDs: key = userId|appId|iglmEntitlementId
         const discoveredIglmEntitlementLookupMap = new Map(); // Entries here are for resolved users/entitlements

        for (const discoveredEntry of discoveredStates) {
            // Create composite key for the discovered entry using app-specific identifiers
             const key = createDiscoveredStateKey(
                 discoveredEntry.applicationId,
                 discoveredEntry.appSpecificUserId,
                 discoveredEntry.appSpecificEntitlementId
             );
             discoveredStateLookupMap.set(key, discoveredEntry); // Store the entry by its composite key

             // If identity and entitlement were resolved during discovery, also map by IGLM IDs
             if (discoveredEntry.userId !== null && discoveredEntry.iglmEntitlementId !== null) {
                  const iglmKey = `${discoveredEntry.userId}|${discoveredEntry.applicationId}|${discoveredEntry.iglmEntitlementId}`;
                  discoveredIglmEntitlementLookupMap.set(iglmKey, discoveredEntry); // Store the entry by its IGLM IDs
             } else {
                 // console.log(`[${serviceName}] Discovered entry not fully resolved (userId or iglmEntitlementId is null). App User ID: ${discoveredEntry.appSpecificUserId}, App Entitlement ID: ${discoveredEntry.appSpecificEntitlementId}`);
                 // These unresolved entries will be processed in the violation/orphan check below.
             }
        }
         console.log(`[${serviceName}] Built discovered state lookup maps (total entries: ${discoveredStates.length}, IGLM-linked entries: ${discoveredIglmEntitlementLookupMap.size}).`);


        // 2. Load Desired State and related Mappings for the users found in discovered states.
        // Get all unique *resolved* User IDs from the discovered states.
        const userIdsToReconcile = [...new Set(discoveredStates.map(state => state.userId).filter(id => id !== null))]; // Get unique non-null User IDs
        console.log(`[${serviceName}] Loading desired state for ${userIdsToReconcile.length} IGLM users (Identity Resolved).`);

        let usersWithDesiredState = [];
        const appsInDesiredStateIds = new Set(); // Collect application IDs from desired state
        const iglmEntitlementDetailsMap = new Map(); // Map to store IGLM Entitlement details keyed by ID (needed for missing access logging)
        const applicationDetailsMap = new Map(); // Map to store Application details keyed by ID (needed for missing access logging and provisioning calls)

        if (userIdsToReconcile.length > 0) {
             // Load these IGLM Users including their Desired Roles and Mapped Entitlements
             // This requires traversing User -> Role -> RoleEntitlementMapping -> Entitlement -> Application
             usersWithDesiredState = await User.findAll({
                  where: { id: userIdsToReconcile }, // Filter by users found in discovered state
                  include: {
                      model: Role, as: 'roles',
                      through: { attributes: [] },
                      include: {
                          model: Entitlement, as: 'entitlements',
                          through: { model: RoleEntitlementMapping, attributes: [] },
                          include: { model: Application, as: 'application', attributes: ['id', 'name'] } // Get App ID and name
                      }
                   }
                   // TODO: Consider performance for large number of users or complex role/entitlement graphs
                   // You might need to optimize this query or load data incrementally
             });
        }
        console.log(`[${serviceName}] Loaded desired state for ${usersWithDesiredState.length} users.`);

         // Build a map of Desired State for quick lookup: userId -> Map<appId, Set<iglmEntitlementId>>
         const desiredStateMap = new Map();
         for (const user of usersWithDesiredState) {
              const userDesiredApps = new Map(); // Map<appId, Set<iglmEntitlementId>>
              for (const role of user.roles) {
                   for (const entitlement of role.entitlements) {
                        if (entitlement.application) {
                             const appId = entitlement.application.id;
                             const iglmEntitlementId = entitlement.id;

                             if (!userDesiredApps.has(appId)) {
                                  userDesiredApps.set(appId, new Set());
                             }
                             userDesiredApps.get(appId).add(iglmEntitlementId); // Add IGLM Entitlement ID to the set for this app

                             // Store entitlement and app details for later use in discrepancies and provisioning
                             if (!iglmEntitlementDetailsMap.has(iglmEntitlementId)) {
                                  iglmEntitlementDetailsMap.set(iglmEntitlementId, entitlement.toJSON());
                             }
                              if (!applicationDetailsMap.has(appId)) {
                                 applicationDetailsMap.set(appId, entitlement.application.toJSON());
                              }
                              appsInDesiredStateIds.add(appId); // Track relevant app IDs

                        } else {
                             console.warn(`[${serviceName}] Reconciliation: Desired Entitlement "${entitlement.name}" (${entitlement.id}) mapped to role "${role.name}" for user ${user.hrmsId} is missing Application details.`);
                        }
                   }
              }
              desiredStateMap.set(user.id, userDesiredApps);
         }
         console.log(`[${serviceName}] Built desired state lookup map for ${desiredStateMap.size} users across ${appsInDesiredStateIds.size} applications.`);

        // Load Provisioning Mapping Configurations for all relevant applications
        const provisioningMappingConfigs = await MappingConfig.findAll({
            where: {
                applicationId: Array.from(appsInDesiredStateIds), // Get mappings for all apps found in desired state
                type: 'provisioning' // Assuming provisioning mapping type is consistently 'provisioning'
            }
        });
        const provisioningMappingConfigMap = new Map(); // Map<appId, MappingConfig>
        provisioningMappingConfigs.forEach(config => {
            provisioningMappingConfigMap.set(config.applicationId, config);
        });
        console.log(`[${serviceName}] Loaded ${provisioningMappingConfigs.length} provisioning mapping configurations for ${provisioningMappingConfigMap.size} applications.`);


        // 3. Compare States & Identify Discrepancies.

        // --- 3a. Identify Violations (Excess Access) & Orphaned Accounts ---
        console.log(`[${serviceName}] Identifying violations and orphaned accounts...`);
        for (const discoveredEntry of discoveredStates) {
             const { id: discoveredStateId, userId, applicationId, appSpecificUserId, appSpecificEntitlementId, iglmEntitlementId, metadata, discoveredAt, runId, user, application } = discoveredEntry; // Destructure includes

             if (userId === null) {
                  // This is an orphaned account - always a discrepancy
                  console.log(`[${serviceName}] Discrepancy: Orphaned Account detected - App "${application?.name}" User "${appSpecificUserId}" Entitlement "${appSpecificEntitlementId}".`);
                  discrepancies.orphanedAccounts.push({
                      currentAppStateId: discoveredStateId, // Include ID of the discovered state entry
                      applicationName: application?.name,
                      applicationId: applicationId,
                      appSpecificUserId: appSpecificUserId,
                      appSpecificEntitlementId: appSpecificEntitlementId,
                      discoveredAt: discoveredAt,
                      runId: runId,
                      metadata: metadata,
                      rawEntry: discoveredEntry.toJSON() // Include the full entry for context
                  });
                  // Add this discoveredEntry to the list of entitlements to revoke.
                  entitlementsToRevoke.push(discoveredEntry); // Add the CurrentAppState entry itself
                  continue; // Move to the next discovered entry
             }

             // --- Handle Non-Orphaned Accounts (Identity was resolved) ---
             // Check if this specific discovered entitlement (by IGLM Entitlement ID) is desired for this user in this application
             // Only check if entitlement was resolved during discovery (iglmEntitlementId is not null)
             const isEntitlementDesired = (iglmEntitlementId !== null && desiredStateMap.has(userId) && desiredStateMap.get(userId).has(applicationId) && desiredStateMap.get(userId).get(applicationId).has(iglmEntitlementId)) || false;

              if (!isEntitlementDesired) {
                   // User has access (discoveredEntry) that is NOT in the desired state.
                   // This is a VIOLATION and a candidate for REVOCATION.
                   console.log(`[${serviceName}] Discrepancy: Violation/Excess Access - User ${user?.hrmsId} (${userId}) has entitlement "${appSpecificEntitlementId}" in App "${application?.name}" but it's NOT desired.`);
                    discrepancies.violations.push({
                        currentAppStateId: discoveredStateId, // Include ID of the discovered state entry
                        userId: userId,
                        hrmsId: user?.hrmsId,
                        applicationName: application?.name,
                        applicationId: applicationId,
                        appSpecificUserId: appSpecificUserId,
                        appSpecificEntitlementId: appSpecificEntitlementId,
                        iglmEntitlementId: iglmEntitlementId, // Might be null if entitlement not resolved but user was
                        discoveredAt: discoveredAt,
                        runId: runId,
                        metadata: metadata,
                        rawEntry: discoveredEntry.toJSON()
                    });
                    entitlementsToRevoke.push(discoveredEntry); // Add this discovered entry to the list of entitlements to revoke.

              } else {
                   // User has access (discoveredEntry) AND it IS in the desired state. This access is COMPLIANT.
                   // console.log(`[${serviceName}] Compliant Access: User ${user?.hrmsId} has desired entitlement "${appSpecificEntitlementId}" in App "${application?.name}".`);
              }
        } // End loop through discoveredStates


        // --- 3b. Identify Missing Access (Desired NOT Discovered) ---
        console.log(`[${serviceName}] Identifying missing access...`);

        const entitlementsToGrant = []; // List of desired entitlements to trigger provisioning for

        // Iterate through the desired state map (userId -> appId -> iglmEntitlementId Set)
        for (const [userId, userDesiredApps] of desiredStateMap.entries()) {
             // Get the full user object (already loaded)
             const user = usersWithDesiredState.find(u => u.id === userId);

             for (const [appId, desiredEntitlementIdsSet] of userDesiredApps.entries()) {
                   // Get the application object from map (already loaded)
                   const application = applicationDetailsMap.get(appId);
                   const mappingConfig = provisioningMappingConfigMap.get(appId); // Get the pre-loaded provisioning mapping for this app

                   // Skip if no mapping config exists for this desired app
                   if (!mappingConfig) {
                        console.warn(`[${serviceName}] Warning: No provisioning mapping config found for application "${application?.name}" (${appId}). Cannot check for missing access or prepare remediation for this app/user combination.`);
                        // TODO: Potentially log a discrepancy type for 'unmappable applications/users in desired state'?
                        continue; // Cannot check for missing access if mapping is unavailable
                   }

                   // Determine the app-specific user ID for this IGLM user using the mapping config
                   const appSpecificUserId = mapIglmUserToAppUserId(user, mappingConfig);

                   if (appSpecificUserId === null) {
                        console.warn(`[${serviceName}] Warning: Cannot determine app-specific user ID for IGLM user ${user?.hrmsId} (${userId}) in app "${application?.name}" (${appId}) using mapping. Skipping missing access check for this app/user.`);
                        // TODO: Potentially log a discrepancy type for 'unmappable users in desired state'?
                        continue; // Cannot check for missing access if user ID is unmappable
                   }

                   for (const iglmEntitlementId of desiredEntitlementIdsSet) {
                       // Get entitlement details (already in map)
                       const iglmEntitlement = iglmEntitlementDetailsMap.get(iglmEntitlementId);

                       // Determine the app-specific entitlement ID using the mapping config
                       const appSpecificEntitlementId = mapIglmEntitlementToAppEntitlementId(iglmEntitlementId, mappingConfig);

                       if (appSpecificEntitlementId === null) {
                            // This warning might be noisy, consider logging levels or grouping
                            // console.warn(`[${serviceName}] Warning: Cannot determine app-specific entitlement ID for IGLM Entitlement "${iglmEntitlement?.name}" (${iglmEntitlementId}) in app "${application?.name}" (${appId}) using mapping. Skipping missing access check.`);
                            // TODO: Potentially log a discrepancy type for 'unmappable entitlements in desired state'?
                            continue; // Cannot check for missing access if entitlement ID is unmappable
                       }

                       // Now we have the desired app-specific pair: (appSpecificUserId, appSpecificEntitlementId)
                       // Create the expected discovered state key using this pair
                       const expectedDiscoveredKey = createDiscoveredStateKey(appId, appSpecificUserId, appSpecificEntitlementId);

                       // Check if this key exists in the discovered state lookup map (based on app-specific IDs)
                       if (!discoveredStateLookupMap.has(expectedDiscoveredKey)) {
                            // If the expected app-specific item is NOT in the discovered state lookup, it's MISSING ACCESS!
                            console.log(`[${serviceName}] Discrepancy: Missing Access - User ${user?.hrmsId} (${userId}) should have entitlement "${appSpecificEntitlementId}" (mapped from "${iglmEntitlement?.name}") in App "${application?.name}" (${appId}) but it was NOT discovered.`);

                            discrepancies.missingAccess.push({
                                userId: userId,
                                hrmsId: user?.hrmsId,
                                applicationName: application?.name,
                                applicationId: appId,
                                iglmEntitlementId: iglmEntitlementId,
                                iglmEntitlementName: iglmEntitlement?.name,
                                expectedAppSpecificUserId: appSpecificUserId, // The ID we expected to find
                                expectedAppSpecificEntitlementId: appSpecificEntitlementId, // The ID we expected to find
                                timestamp: new Date(), // Timestamp of reconciliation run
                            });

                            // Add this missing access item to the list for potential provisioning
                            // We need the IGLM user, App, and the Entitlement (IGLM and App-Specific IDs)
                            entitlementsToGrant.push({
                                userId: userId,
                                applicationId: appId,
                                iglmEntitlementId: iglmEntitlementId,
                                appSpecificUserId: appSpecificUserId, // Need this for the provisioning payload
                                appSpecificEntitlementId: appSpecificEntitlementId, // Need this for the provisioning payload
                                // Include other relevant details if needed for provisioning task
                                // e.g., user attributes, entitlement metadata from desired state
                            });


                        } else {
                            // Desired access was found in discovered state - COMPLIANT
                            // console.log(`[${serviceName}] Compliant Access (Desired found): User ${user?.hrmsId} has expected entitlement "${appSpecificEntitlementId}" in App "${application?.name}".`);
                        }
                   } // End loop through desired entitlements
             } // End loop through user's desired apps
        } // End loop through desiredStateMap

        console.log(`[${serviceName}] Identified ${entitlementsToGrant.length} entitlements to grant.`);


        console.log(`[${serviceName}] Reconciliation comparison complete for Discovery Run ID ${latestDiscoveryRunId}. Discrepancies found: Violations=${discrepancies.violations.length}, Orphaned Accounts=${discrepancies.orphanedAccounts.length}, Missing Access=${discrepancies.missingAccess.length}.`);


        // --- 4. Store Reconciliation Results ---
        // Store the identified discrepancies in the ReconciliationResult table.
        console.log(`[${serviceName}] Storing ${Object.values(discrepancies).flat().length} discrepancies.`);
        for (const type in discrepancies) {
             // Ensure we only iterate over own properties that are arrays
             if (Object.prototype.hasOwnProperty.call(discrepancies, type) && Array.isArray(discrepancies[type])) {
                  for (const discrepancy of discrepancies[type]) {
                       await ReconciliationResult.create({
                           runId: latestDiscoveryRunId,
                           discrepancyType: type, // 'violations', 'missingAccess', 'orphanedAccounts'
                           // Store IDs and string identifiers where available from the discrepancy object
                           userId: discrepancy.userId || null,
                           applicationId: discrepancy.applicationId || null,
                           // Use specific vs expected based on discrepancy type
                           appSpecificUserId: discrepancy.appSpecificUserId || discrepancy.expectedAppSpecificUserId || null,
                           appSpecificEntitlementId: discrepancy.appSpecificEntitlementId || discrepancy.expectedAppSpecificEntitlementId || null,
                           iglmEntitlementId: discrepancy.iglmEntitlementId || null, // Include IGLM Entitlement ID for violations/missing
                           details: discrepancy, // Store the full discrepancy object (includes rawEntry if available, and names/expected IDs for missing)
                           timestamp: new Date() // Timestamp of reconciliation run
                       }).catch(err => console.error(`[${serviceName}] Failed to save ReconciliationResult entry:`, err)); // Log individual save errors
                  }
             }
        }
        console.log(`[${serviceName}] Discrepancies stored.`);


        // --- 5. Trigger Remediation (Deprovisioning and Provisioning) ---

        // 5a. Trigger Deprovisioning for identified entitlements to revoke.
        // This list (entitlementsToRevoke) contains the *CurrentAppState* entries to remove access for (Violations/Orphans).
        // Call the Provisioning Service API for each entitlement to revoke.
        // Group revocations by user and application for efficient API calls.

        const revocationsByAppAndUser = new Map(); // Map<userId, Map<appId, Array<CurrentAppStateEntry>>>
        for (const stateToRevoke of entitlementsToRevoke) {
             // Use IGLM ID or 'orphan' marker as key
             const userId = stateToRevoke.userId || 'orphan';
             const appId = stateToRevoke.applicationId;

             if (!revocationsByAppAndUser.has(userId)) revocationsByAppAndUser.set(userId, new Map());
             if (!revocationsByAppAndUser.get(userId).has(appId)) revocationsByAppAndUser.get(userId).set(appId, []);

             revocationsByAppAndUser.get(userId).get(appId).push(stateToRevoke); // Add the CurrentAppState entry
        }

         console.log(`[${serviceName}] Triggering deprovisioning for ${entitlementsToRevoke.length} entitlements across ${revocationsByAppAndUser.size} user/application combinations.`);

        // Loop through users needing revocations
        for (const [userId, appsToRevokeMap] of revocationsByAppAndUser.entries()) {
             // Get the user object for context (might be null if 'orphan')
              const user = usersWithDesiredState.find(u => u.id === userId) || { id: userId, hrmsId: 'ORPHAN' }; // Mock user object for logging

             // Loop through applications needing revocations for this user
             for (const [appId, statesToRevoke] of appsToRevokeMap.entries()) {
                 // Get the application object for context (use map first, then query if needed)
                 const application = applicationDetailsMap.get(appId) || await Application.findByPk(appId, { attributes: ['id', 'name'] });

                 if (!application) {
                     console.error(`[${serviceName}] Reconciliation: Cannot trigger revocation for user ${user.hrmsId}: Application ${appId} not found.`);
                     // TODO: Log this error in ReconciliationResult?
                     continue; // Skip this app/user combination
                 }

                 // Prepare the payload for the Provisioning Service API for explicit revocation
                 // This payload contains the user identifier for the target app and a list of items to revoke.
                 const revocationPayload = {
                      userId: userId === 'orphan' ? null : userId, // Pass IGLM User ID (null for orphans)
                      applicationId: appId, // Application ID
                      appSpecificUserId: statesToRevoke[0].appSpecificUserId, // User ID as known by the target app (assuming one per app/user group)
                      entitlementsToRevoke: statesToRevoke.map(item => ({ // Map list of CurrentAppState entries
                          iglmEntitlementId: item.iglmEntitlementId, // Can be null
                          appEntitlementId: item.appSpecificEntitlementId, // The actual ID needed by the adapter
                          discoveredMetadata: item.metadata, // Pass discovered metadata
                          // TODO: Add original mapping details if needed by adapter (lookup in Prov mapping configs)
                      }))
                 };

                 console.log(`[${serviceName}] Reconciliation: Calling Provisioning Service API to request revocation for App "${application.name}", user ${revocationPayload.appSpecificUserId}. Entitlements: ${revocationPayload.entitlementsToRevoke.map(e => e.appEntitlementId || e.iglmEntitlementId).join(', ')}.`); // Log both IDs for context
                 // console.log(`[${serviceName}] -> Payload:`, revocationPayload); // Log payload carefully


                 const provisioningServiceApiUrl = options.serviceConfigs?.provisioningServiceApiUrl || "http://localhost:4005"; // Get from options or default

                 try {
                      // Call the Provisioning Service API for explicit revocation
                      // TODO: Define and use a specific endpoint for revocation (e.g., POST /provision/revoke)
                      // Ensure this endpoint exists and is implemented in Provisioning Service server.js
                      // It should validate the payload, queue a ProvisioningTask, and return 202.
                      const response = await axios.post(`${provisioningServiceApiUrl}/provision/revoke`, revocationPayload); // Placeholder endpoint

                      if (response.status === 202) {
                           console.log(`[${serviceName}] Reconciliation: Revocation request accepted for App "${application.name}", user ${revocationPayload.appSpecificUserId}. Task ID: ${response.data.taskId || 'N/A'}`);
                           // TODO: Log the task ID in ReconciliationResult?
                      } else {
                          console.error(`[${serviceName}] Reconciliation: Revocation API for App "${application.name}" returned unexpected status ${response.status}. Response:`, response.data?.toString());
                           // TODO: Log/handle unexpected API response in ReconciliationResult
                      }
                 } catch (apiError) {
                      console.error(`[${serviceName}] Reconciliation: Error calling Revocation API for App "${application.name}", user ${revocationPayload.appSpecificUserId}:`, apiError.message);
                      // TODO: Implement retry logic for API calls
                      // TODO: Log error in ReconciliationResult
                 }
             } // End loop through apps for this user
        } // End loop through users

        // 5b. Trigger Provisioning for identified entitlements to grant (Missing Access).
        // Group entitlementsToGrant by user and application for efficient API calls.
        const grantsByAppAndUser = new Map(); // Map<userId, Map<appId, Array<EntitlementDetails>>>
        for (const grantItem of entitlementsToGrant) {
            const userId = grantItem.userId;
            const appId = grantItem.applicationId;

            if (!grantsByAppAndUser.has(userId)) grantsByAppAndUser.set(userId, new Map());
            if (!grantsByAppAndUser.get(userId).has(appId)) grantsByAppAndUser.get(userId).set(appId, []);

            grantsByAppAndUser.get(userId).get(appId).push(grantItem); // Add the grant item
        }

        console.log(`[${serviceName}] Triggering provisioning for ${entitlementsToGrant.length} entitlements across ${grantsByAppAndUser.size} user/application combinations.`);

         // Loop through users needing grants
        for (const [userId, appsToGrantMap] of grantsByAppAndUser.entries()) {
             // Get the user object for context (should not be orphan for grants)
            const user = usersWithDesiredState.find(u => u.id === userId);

            // Loop through applications needing grants for this user
            for (const [appId, grantItems] of appsToGrantMap.entries()) {
                // Get the application object for context (use map first)
                const application = applicationDetailsMap.get(appId);

                if (!application) {
                    console.error(`[${serviceName}] Reconciliation: Cannot trigger provisioning for user ${user?.hrmsId}: Application ${appId} not found.`);
                     // TODO: Log this error in ReconciliationResult?
                    continue;
                }

                // Prepare the payload for the Provisioning Service API for granting access
                // This payload should contain the user identifier for the target app and a list of items to grant.
                const provisioningPayload = {
                    userId: userId, // IGLM User ID
                    applicationId: appId, // Application ID
                    appSpecificUserId: grantItems[0].appSpecificUserId, // User ID as known by the target app (assuming one per app/user group)
                    entitlementsToGrant: grantItems.map(item => ({ // Map list of grant items
                        iglmEntitlementId: item.iglmEntitlementId,
                        appEntitlementId: item.appSpecificEntitlementId, // The actual ID needed by the adapter
                         // Include other relevant details derived from desired state or user attributes if needed by adapter
                         // e.g., source system identifier, user attributes needed for account creation/update
                    }))
                };

                console.log(`[${serviceName}] Reconciliation: Calling Provisioning Service API to request provisioning for App "${application.name}", user ${provisioningPayload.appSpecificUserId}. Entitlements: ${provisioningPayload.entitlementsToGrant.map(e => e.appEntitlementId || e.iglmEntitlementId).join(', ')}.`);

                // Call the Provisioning Service API for granting access
                // This typically goes to the main /provision endpoint which handles grants/revokes based on desired state vs current state
                // OR, if the Prov Service has a dedicated grant endpoint, use that. Let's assume the main /provision endpoint for now,
                // sending only the items that are MISSING as entitlementsToGrant.
                const provisioningServiceApiUrl = options.serviceConfigs?.provisioningServiceApiUrl || "http://localhost:4005";

                try {
                    // Call the Provisioning Service API
                    // Assuming the /provision endpoint can handle entitlementsToGrant array
                     const response = await axios.post(`${provisioningServiceApiUrl}/provision`, provisioningPayload);

                     if (response.status === 202) {
                         console.log(`[${serviceName}] Reconciliation: Provisioning request accepted for App "${application.name}", user ${provisioningPayload.appSpecificUserId}. Task ID: ${response.data.taskId || 'N/A'}`);
                         // TODO: Log the task ID in ReconciliationResult?
                     } else {
                         console.error(`[${serviceName}] Reconciliation: Provisioning API for App "${application.name}" returned unexpected status ${response.status}. Response:`, response.data?.toString());
                         // TODO: Log/handle unexpected API response in ReconciliationResult
                     }
                } catch (apiError) {
                     console.error(`[${serviceName}] Reconciliation: Error calling Provisioning API for App "${application.name}", user ${provisioningPayload.appSpecificUserId}:`, apiError.message);
                     // TODO: Implement retry logic for API calls
                     // TODO: Log error in ReconciliationResult
                }
            } // End loop through apps for this user
            
        } // End loop through users needing grants


        console.log(`[${serviceName}] Reconciliation process completed.`);
        // Return final status and discrepancy summary
        // Include counts of triggered remediations?
        return {
            status: 'completed',
            discrepancies: discrepancies,
            remediationTriggered: {
                revocations: entitlementsToRevoke.length,
                grants: entitlementsToGrant.length
            }
        };


    } catch (reconciliationError) {
        // Catch any uncaught errors during the overall reconciliation process
        console.error(`[${serviceName}] Overall error during reconciliation for Discovery Run ID ${latestDiscoveryRunId}:`, reconciliationError);
        // TODO: Store critical error in a log or status for the reconciliation process itself.
        // TODO: Publish a critical reconciliation failure event?
        return { status: 'failed', error: reconciliationError.message, discrepancies: discrepancies, remediationTriggered: { revocations: 0, grants: 0 } };
    } finally {
       // Cleanup
       console.log(`[${serviceName}] Reconciliation process finished finally block.`);
    }
}


// Helper function to get a value from a nested object path (copy from provisioningLogic or use shared)
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


// Helper function to map IGLM User to App-Specific User ID using Provisioning Mapping Config
// This function is needed here to prepare the revocation payload and check for missing access.
function mapIglmUserToAppUserId(user, mappingConfig) {
    const serviceName = 'reconciliation-logic'; // Or pass serviceName
    // Check for the expected structure based on recent discussion
    const identifierMapping = mappingConfig?.mappingRules?.userIdentifierMapping;

    if (!user || typeof user !== 'object' || !identifierMapping || typeof identifierMapping !== 'object' || !identifierMapping.sourceField || typeof identifierMapping.sourceField !== 'string') {
        // console.warn(`[${serviceName}] mapIglmUserToAppUserId: Invalid input or missing userIdentifierMapping sourceField for app ${mappingConfig?.applicationId}.`);
        return null; // Cannot map if input is invalid or mapping rule is missing/malformed
    }

    const sourceField = identifierMapping.sourceField;

    let rawIdentifierValue;
    // Use the getNestedValue helper to extract the user attribute based on the mapping config sourceField
    rawIdentifierValue = getNestedValue(user, sourceField);


    if (rawIdentifierValue === null || rawIdentifierValue === undefined) {
        // This warning might be noisy if many users are missing a field, maybe make it debug level or log externally
        // console.warn(`[${serviceName}] mapIglmUserToAppUserId: Source field "${sourceField}" value is null/undefined on user ${user?.id} (${user?.hrmsId}) for app ${mappingConfig?.applicationId}. Cannot determine app identifier.`);
        return null; // User identifier attribute is missing for this user/mapping
    }

    // Just return the value as a string
    return String(rawIdentifierValue);
}

// Helper function to map IGLM Entitlement to App-Specific Entitlement ID using Provisioning Mapping Config
// This function is needed here to get the app-specific ID for checking existence in discovered state and for the revoke payload.
function mapIglmEntitlementToAppEntitlementId(iglmEntitlementId, mappingConfig) {
    const serviceName = 'reconciliation-logic'; // Or pass serviceName
    // Check for the expected structure based on recent discussion
    const entitlementMappings = mappingConfig?.mappingRules?.entitlementMappings;

    if (!entitlementMappings || typeof entitlementMappings !== 'object') {
        // console.warn(`[${serviceName}] mapIglmEntitlementToAppEntitlementId: Invalid input or missing entitlementMappings for app ${mappingConfig?.applicationId}.`);
        return null; // Cannot map if input is invalid or entitlement mappings are missing
    }

    // Direct lookup by IGLM Entitlement ID
    const entitlementRule = entitlementMappings[iglmEntitlementId];

    if (!entitlementRule || !entitlementRule.appEntitlementId) {
        // This means there's no provisioning mapping for this specific IGLM entitlement in this application
        // console.warn(`[reconciliation-logic] Warning: Provisioning mapping rule not found or missing appEntitlementId for IGLM Entitlement ${iglmEntitlementId} in app ${mappingConfig?.applicationId}. Cannot determine app-specific entitlement ID.`);
        return null; // Mapping rule not found or incomplete
    }

    return String(entitlementRule.appEntitlementId); // Return the app-specific ID as a string
}


// Helper function to trigger provisioning grants for missing access
// This function will be called in Step 5b
async function callProvisioningGrant(userId, appId, appSpecificUserId, grantItems, options) {
    const serviceName = 'reconciliation-logic';
    const provisioningServiceApiUrl = options.serviceConfigs?.provisioningServiceApiUrl || "http://localhost:4005";

    const provisioningPayload = {
        userId: userId, // IGLM User ID
        applicationId: appId, // Application ID
        appSpecificUserId: appSpecificUserId, // User ID as known by the target app
        entitlementsToGrant: grantItems.map(item => ({ // Map grant items
             iglmEntitlementId: item.iglmEntitlementId,
             appEntitlementId: item.appSpecificEntitlementId, // The actual ID needed by the adapter
             // Include other relevant details if needed by adapter
        }))
    };

     try {
        // Call the Provisioning Service API
        // Assuming the /provision endpoint handles entitlementsToGrant array
        const response = await axios.post(`${provisioningServiceApiUrl}/provision`, provisioningPayload);

        if (response.status === 202) {
            console.log(`[${serviceName}] Reconciliation: Provisioning request accepted for App ${appId}, user ${appSpecificUserId}. Task ID: ${response.data.taskId || 'N/A'}`);
            // TODO: Log the task ID in ReconciliationResult?
        } else {
            console.error(`[${serviceName}] Reconciliation: Provisioning API for App ${appId} returned unexpected status ${response.status}. Response:`, response.data?.toString());
            // TODO: Log/handle unexpected API response in ReconciliationResult
        }
    } catch (apiError) {
        console.error(`[${serviceName}] Reconciliation: Error calling Provisioning API for App ${appId}, user ${appSpecificUserId}:`, apiError.message);
        // TODO: Implement retry logic for API calls
        // TODO: Log error in ReconciliationResult
    }
}



// TODO: Implement retry logic and more robust error handling for Provisioning Service API calls.
// TODO: Implement publishing reconciliation events to MQ.


module.exports = {
    performReconciliation,
};