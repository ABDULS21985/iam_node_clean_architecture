// services/provisioning-service/src/provisioningLogic.js

// Import shared services and models - Assuming these are initialized and passed in options
// const ConfigService = require('../shared/configService');
// const MqService = require('../shared/mqService');
// const models = require('../shared/models');

// ProvisioningAdapterLoader - Handles dynamic loading of connector adapters
// Assuming this module exists and has a method like loadAdapter(type)
// const ProvisioningAdapterLoader = require('./provisioningAdapterLoader');

// AccessMapper - Maps IGLM roles/entitlements to app entitlements based on mapping configs
// Assuming this module exists and has a method like mapRoleEntitlementsForUser(user, roles, appMappingConfig)
// This current logic does some of this mapping inline, but a dedicated module would be cleaner.
// const AccessMapper = require('./accessMapper');


/**
 * Helper function to get a value from a nested object path (e.g., 'metadata.sAMAccountName').
 * Handles null/undefined values along the path.
 *
 * @param {object} obj - The object to traverse.
 * @param {string} path - The dot-notation path (e.g., 'profile.email').
 * @returns {*} The value found at the path, or undefined if the path does not exist or inputs are invalid.
 */
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        // Use hasOwnProperty to avoid issues with prototype chain properties
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
             return undefined; // Path not found or hit a non-object/null
        }
        current = current[part];
    }
    return current;
}


/**
 * Determines the user identifier for a specific target application based on mapping configuration.
 * This identifier is what the target application's connector adapter will use to reference the user.
 *
 * @param {object} user - The IGLM User model instance.
 * @param {object} appMappingConfig - The application-specific MappingConfig (SourceType: Provisioning, TargetType: ApplicationEntitlements).
 * Expected appMappingConfig.mappingRules.userIdentifierMapping structure:
 * { "sourceField": "email", "targetFormat": "string" }
 * { "sourceField": "hrmsId", "targetFormat": "string" }
 * { "sourceField": "metadata.sAMAccountName", "targetFormat": "string" }
 * // TODO: Add support for more complex targetFormats (e.g., "dn", "emailFormat")
 * // TODO: Add support for lookup logic if the user identifier in the target app is not directly in the IGLM User model.
 * @returns {string|null} The user identifier string expected by the target application, or null if mapping fails or the source field value is missing.
 */
function determineAppUserIdentifier(user, appMappingConfig) {
    const serviceName = 'provisioning-service'; // Or pass service name
    // Validate basic inputs and the presence of the userIdentifierMapping rule
    if (!user || typeof user !== 'object' || !appMappingConfig || typeof appMappingConfig !== 'object' || !appMappingConfig.mappingRules || typeof appMappingConfig.mappingRules.userIdentifierMapping !== 'object') {
         console.error(`[${serviceName}] determineAppUserIdentifier: Invalid input or missing userIdentifierMapping rule in mapping config (ID: ${appMappingConfig?.id}).`);
         return null; // Indicate critical failure to determine identifier
    }

    const identifierMapping = appMappingConfig.mappingRules.userIdentifierMapping;
    const sourceField = identifierMapping.sourceField; // e.g., "email", "hrmsId", "metadata.sAMAccountName"
    const targetFormat = identifierMapping.targetFormat || 'string'; // Default to string format

    let rawIdentifierValue;

    // Retrieve the raw value from the user object based on the sourceField path
    if (sourceField && typeof sourceField === 'string') {
         rawIdentifierValue = getNestedValue(user, sourceField); // Use the helper for nested paths
    } else {
         console.error(`[${serviceName}] determineAppUserIdentifier: userIdentifierMapping rule for config ID ${appMappingConfig.id} has missing or invalid 'sourceField'.`);
         return null;
    }

    // Check if the raw value was found and is not null/undefined
    if (rawIdentifierValue === null || rawIdentifierValue === undefined) {
         console.error(`[${serviceName}] determineAppUserIdentifier: Source field "${sourceField}" value is null/undefined on user ${user.id} for mapping config ID ${appMappingConfig.id}. Cannot determine app identifier.`);
         return null; // Cannot determine identifier
    }

    // Apply targetFormat (currently only converts to string)
    // TODO: Implement logic for other targetFormats like 'dn', 'emailFormat', etc.
    let appUserId;
    switch (targetFormat) {
        case 'string':
        default:
            appUserId = String(rawIdentifierValue);
            break;
        // case 'dn':
        //     // Logic to construct DN from rawIdentifierValue and potentially other user attributes
        //     appUserId = constructDn(rawIdentifierValue, user, identifierMapping.dnTemplate);
        //     break;
        // case 'emailFormat':
        //     // Logic to format email, e.g., add domain if missing
        //     appUserId = formatEmail(rawIdentifierValue, identifierMapping.domain);
        //     break;
    }

    console.log(`[${serviceName}] determineAppUserIdentifier: Mapped user ${user.id} (source field "${sourceField}") to app ID "${appUserId}" for mapping config ID ${appMappingConfig.id}.`);
    return appUserId;
}


/**
 * Performs the actual asynchronous provisioning work for a given task.
 * This function is called by the MQ worker process when a new task message is received.
 *
 * @param {string} taskId - The ID (UUID) of the Provisioning Task to process.
 * @param {object} options - Options including shared services and models, passed from the worker.
 * @param {object} options.configService - The initialized ConfigService instance.
 * @param {object} options.mqService - The initialized MqService instance.
 * @param {object} options.models - Sequelize models object ({ User, Application, Entitlement, Role, RoleEntitlementMapping, ConnectorConfig, MappingConfig, ProvisioningTask, ... }).
 * @param {object} options.provisioningAdapterLoader - Instance of the ProvisioningAdapterLoader.
 * @returns {Promise<void>} Resolves when the task processing is complete (success or failure handled internally).
 * @throws {Error} Throws critical errors that the worker should catch to potentially retry the message (e.g., transient DB/MQ issues). Non-critical provisioning errors should be handled and logged within the function.
 */
async function processProvisioningTask(taskId, options) {
    // Destructure options for easier access to dependencies
    const { configService, mqService, models, provisioningAdapterLoader } = options;
    // Access models explicitly
    const { User, Application, Entitlement, Role, RoleEntitlementMapping, ConnectorConfig, MappingConfig, ProvisioningTask } = models;

    const serviceName = 'provisioning-service'; // Service identifier

    let task; // Variable to hold the ProvisioningTask log entry
    let user;
    const applicationProvisioningResults = {}; // Track success/failure and results per application
    const errorsPerApplication = {}; // Collect detailed errors per application
    let overallTaskStatus = 'failed'; // Default to failed if not completed


    try {
        console.log(`[${serviceName}] processProvisioningTask: Starting processing for task ID: ${taskId}`);

        // 1. Load the Provisioning Task details from the database
        task = await ProvisioningTask.findByPk(taskId);
        if (!task) {
            console.error(`[${serviceName}] processProvisioningTask: Task not found with ID ${taskId}. Cannot process.`);
            // TODO: Publish a critical error event? Or log to a dedicated error tracking?
            return; // Nothing more to do if the task record doesn't exist
        }

        // Check task status - only process pending or retrying tasks, maybe allow in_progress for retry logic
        if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'retrying') {
             console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} is already ${task.status}. Skipping processing.`);
             return;
        }

        // Update task status to 'in_progress' if it's pending/retrying
        // This prevents multiple workers processing the same task concurrently
        if (task.status === 'pending' || task.status === 'retrying') {
             // Use update method for atomic update and optimistic locking if needed
             await task.update({ status: 'in_progress', startTime: task.status === 'pending' ? new Date() : task.startTime }); // Update start time only if pending
             console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} status updated to 'in_progress'.`);
        } else {
             console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} found in status 'in_progress'. Assuming retry/resume.`);
             // TODO: Implement logic for resuming an interrupted task if necessary.
             // This might involve checking existing results in task.results to avoid re-processing succeeded apps.
        }


        // 2. Load User and related data (Roles, RoleEntitlementMappings) from Core DB
        // Need to include associations to get roles and their mapped entitlements
        try {
             user = await User.findByPk(task.userId, {
                 include: {
                     model: Role, // Include associated Roles
                     as: 'roles', // Alias defined in User model association
                     through: { attributes: ['assignmentDate', 'unassignmentDate'] }, // Include join table attributes from UserRole
                     include: {
                         model: Entitlement, // Include associated Entitlements for each Role
                         as: 'entitlements', // Alias defined in Role model association
                         through: { model: RoleEntitlementMapping, attributes: ['assignmentType', 'metadata'] }, // Include join table attributes from RoleEntitlementMapping
                         include: {
                             model: Application, // Include the Application for each Entitlement
                             as: 'application' // Alias defined in Entitlement model association
                         }
                     }
                 }
             });
        } catch (dbError) {
             console.error(`[${serviceName}] processProvisioningTask: Database error loading User and associations for task ${taskId}:`, dbError);
             // This is a critical error - likely a transient DB issue. Throw to trigger retry.
             throw new Error(`Database error loading user data: ${dbError.message}`);
        }


        if (!user) {
             console.error(`[${serviceName}] processProvisioningTask: User not found in IGLM DB for task ${taskId} (UserID: ${task.userId}).`);
             errorsPerApplication['system'] = { message: 'User not found in IGLM DB' }; // Attribute error to system
             overallTaskStatus = 'failed';
             // Update task status immediately as we cannot proceed
             await task.update({ status: overallTaskStatus, endTime: new Date(), errorDetails: errorsPerApplication });
             return; // Exit processing
        }
        console.log(`[${serviceName}] processProvisioningTask: Loaded user ${user.hrmsId} (ID: ${user.id}) with current roles and entitlements.`);


        // 3. Determine Affected Applications and relevant Entitlements to Grant/Revoke
        // We need to determine the *desired* state (what entitlements *should* the user have based on the task's desired roles)
        // and the *current* state (what entitlements the user *currently* has in each target application).
        // The difference between desired and current state dictates what needs to be granted or revoked.

        // Identify all unique Applications associated with the desired roles' entitlements from the task's desiredState
        const desiredRoleNames = task.desiredState.roles || []; // Ensure it's an array
        const applicationsToProcessMap = new Map(); // Map to store unique applications and the entitlements *needed* for the desired roles

        console.log(`[${serviceName}] processProvisioningTask: Analyzing desired roles for user ${user.id}: ${desiredRoleNames.join(', ')}`);

        // Iterate through the desired role names from the task's payload
        for (const desiredRoleName of desiredRoleNames) {
             // Find the Role model among the user's *loaded* roles (includes associations to entitlements/apps)
             const role = user.roles ? user.roles.find(r => r.name === desiredRoleName) : null;

              if (role) {
                 // For each found desired role, collect its mapped entitlements
                  if (role.entitlements && Array.isArray(role.entitlements)) {
                      for (const roleEntitlement of role.entitlements) {
                          const entitlement = roleEntitlement;
                          const application = entitlement.application;

                           if (application) {
                               // Add the application to the map if not already present
                               if (!applicationsToProcessMap.has(application.id)) {
                                   applicationsToProcessMap.set(application.id, { application: application, entitlementsToGrant: [], entitlementsToRevoke: [] }); // Initialize grant/revoke arrays
                               }
                               // Add the IGLM Entitlement object and mapping attributes to the entitlementsToGrant list for this application
                               applicationsToProcessMap.get(application.id).entitlementsToGrant.push({
                                    iglmEntitlementId: entitlement.id,
                                    iglmEntitlementName: entitlement.name,
                                    // The app-specific entitlement ID and template name/operation type will be looked up later
                                    // using the application's specific Provisioning Mapping config.
                                    assignmentType: roleEntitlement.RoleEntitlementMapping.assignmentType, // From RoleEntitlementMapping
                                    metadata: roleEntitlement.RoleEntitlementMapping.metadata // From RoleEntitlementMapping
                               });
                           } else {
                                console.warn(`[${serviceName}] processProvisioningTask: Entitlement "${entitlement.name}" mapped to role "${role.name}" for task ${taskId} is missing Application details.`);
                           }
                       }
                   } else {
                        console.warn(`[${serviceName}] processProvisioningTask: Role "${role.name}" (ID: ${role.id}) for task ${taskId} has no associated entitlements or entitlements property is not an array.`);
                   }
              } else {
                  console.warn(`[${serviceName}] processProvisioningTask: Desired role "${desiredRoleName}" for task ${taskId} not found in IGLM DB for user ${user.hrmsId}. Cannot process entitlements for this role.`);
              }
        }
        console.log(`[${serviceName}] processProvisioningTask: Determined entitlements to potentially grant based on desired roles. Total unique applications affected: ${applicationsToProcessMap.size}.`);

        // --- Determine Entitlements to Revoke ---
        // This is the most complex part and requires knowledge of the user's *current* state in the target applications.
        // The typical flow involves:
        // a) Running a Discovery/Reconciliation process periodically to get the *current* state of entitlements for all users in target apps.
        // b) Storing this current state in the IGLM database (e.g., in a UserEntitlement table or similar).
        // c) Comparing the *desired* state (from the task's roles) with the *current* state from Discovery.
        // d) Any entitlement the user *currently* has but *should not* have based on the desired roles needs to be revoked.

        // Placeholder for revoke logic:
        // TODO: Implement actual logic to determine entitlements to revoke.
        // This would likely involve:
        // 1. Loading the user's *current* entitlements in each target application (e.g., from a UserEntitlement table populated by Discovery).
        // 2. Identifying all entitlements the user *should* have in each app based on the task's desired roles (this is essentially the `entitlementsToGrant` list we built).
        // 3. Comparing the current list with the desired list. Entitlements in the current list but *not* in the desired list are candidates for revocation.
        // 4. Populate the `entitlementsToRevoke` array for each application in the `applicationsToProcessMap`.
        console.warn(`[${serviceName}] processProvisioningTask: Entitlement revocation logic is not fully implemented and currently skips determining entitlements to revoke.`);


        // --- Orchestrate Provisioning per Application ---
        let allApplicationsSucceeded = true; // Flag to determine overall task status

        for (const [appId, appDetails] of applicationsToProcessMap.entries()) {
             const application = appDetails.application;
             const entitlementsToGrant = appDetails.entitlementsToGrant; // Array of { iglmEntitlementId, iglmEntitlementName, assignmentType, metadata }
             const entitlementsToRevoke = appDetails.entitlementsToRevoke; // Array to be populated by revoke logic

             console.log(`[${serviceName}] processProvisioningTask: Processing for Application "${application.name}" (ID: ${application.id}) for user ${user.hrmsId}. Grants: ${entitlementsToGrant.length}, Revokes: ${entitlementsToRevoke.length}`);

             // Skip calling the adapter if there's nothing to process (grant or revoke) for this app
             if (entitlementsToGrant.length === 0 && entitlementsToRevoke.length === 0) {
                  console.log(`[${serviceName}] processProvisioningTask: No entitlements to process (grant or revoke) for Application "${application.name}". Skipping adapter call.`);
                  applicationProvisioningResults[appId] = { status: 'skipped', message: 'No entitlements to process' };
                  continue; // Skip to next application in the loop
             }


             let appConnectorConfig;
             let appMappingConfig; // Mapping from IGLM Entitlement ID -> App-specific Entitlement ID/Action
             let provisioningResult = null;

             try {
                 // Load the Provisioning Connector Config for this application
                 if (!application.connectorId) {
                     throw new Error(`Application "${application.name}" (ID: ${application.id}) has no connectorId configured.`);
                 }
                 appConnectorConfig = await ConnectorConfig.findByPk(application.connectorId);
                 if (!appConnectorConfig) {
                     throw new Error(`Provisioning Connector Config not found for ID: ${application.connectorId} linked to Application "${application.name}".`);
                 }
                  if (appConnectorConfig.serviceType !== 'Provisioning') {
                       console.warn(`[${serviceName}] processProvisioningTask: Connector Config "${appConnectorConfig.name}" (ID: ${appConnectorConfig.id}) linked to Application "${application.name}" is not marked as serviceType 'Provisioning'. This might be a configuration error.`);
                  }
                 console.log(`[${serviceName}] processProvisioningTask: Loaded App Connector Config: "${appConnectorConfig.name}" (Type: "${appConnectorConfig.type}")`);


                 // Load the Application-specific Mapping Config (IGLM Entitlement ID -> App Entitlement ID/Action)
                 // Assumed MappingConfig entry with sourceType: 'Provisioning', sourceId: application.id, targetType: 'ApplicationEntitlements'
                 appMappingConfig = await MappingConfig.findOne({
                      where: {
                          sourceType: 'Provisioning', // Mapping used for provisioning
                          sourceId: application.id, // Linked to this specific application ID
                          targetType: 'ApplicationEntitlements', // Type of mapping
                          // TODO: Add environment filter if configs are environment-specific
                      }
                 });
                  // If no specific mapping config, rely on Entitlement.applicationEntitlementId and default adapter logic
                  const entitlementMappings = (appMappingConfig?.mappingRules?.entitlementMappings) || {};
                  const userIdentifierMapping = (appMappingConfig?.mappingRules?.userIdentifierMapping) || {}; // Get user ID mapping rule
                  const defaultGrantTemplateName = appMappingConfig?.mappingRules?.defaultGrantTemplateName;
                  const defaultRevokeTemplateName = appMappingConfig?.mappingRules?.defaultRevokeTemplateName;
                  const defaultOperationType = appMappingConfig?.mappingRules?.defaultOperationType; // For adapters like LDAP

                 console.log(`[${serviceName}] processProvisioningTask: Loaded App Entitlement Mapping Config for Application "${application.name}" (exists: ${!!appMappingConfig}). Using ${Object.keys(entitlementMappings).length} explicit entitlement mappings.`);


                 // Dynamically load the correct Provisioning Connector adapter code
                 // Assuming adapters are in ./connectors/provisioning/ and file name matches ConnectorConfig.type
                 // Use the ProvisioningAdapterLoader (if implemented)
                 let connectorModule;
                 try {
                      // connectorModule = await provisioningAdapterLoader.loadAdapter(appConnectorConfig.type); // Use the loader if available
                      connectorModule = require(`./connectors/provisioning/${appConnectorConfig.type}`); // Fallback to direct require
                 } catch (loaderError) {
                     throw new Error(`Failed to load provisioning adapter module "${appConnectorConfig.type}": ${loaderError.message}`);
                 }

                 // Adapter needs a standard interface like applyDesiredState
                 if (!connectorModule || typeof connectorModule.applyDesiredState !== 'function') {
                     throw new Error(`Provisioning Connector adapter module "${appConnectorConfig.type}" found but missing applyDesiredState function.`);
                 }
                 console.log(`[${serviceName}] processProvisioningTask: Loaded provisioning adapter module: "${appConnectorConfig.type}".`);


                 // --- Prepare App-Specific Desired State for the Adapter ---

                 // Determine the user identifier recognized by the target app using the mapping rule
                 const userIdInApp = determineAppUserIdentifier(user, appMappingConfig);
                 if (userIdInApp === null) {
                      // This is a critical error for this specific application
                      throw new Error(`Cannot determine user identifier for Application "${application.name}" (ID: ${application.id}) for user ${user.hrmsId} using configured mapping.`);
                 }


                 // Map IGLM Entitlements to App-specific entitlements for granting
                 const appEntitlementsToGrantForAdapter = [];
                 for (const item of entitlementsToGrant) {
                      const iglmEntitlement = item; // item is already the simplified entitlement object structure { iglmEntitlementId, iglmEntitlementName, assignmentType, metadata }
                      const mappedEntitlementDetails = entitlementMappings[iglmEntitlement.iglmEntitlementId] || {
                           appEntitlementId: item.appEntitlementId, // Fallback from input payload if present (less ideal)
                           sqlTemplateName: defaultGrantTemplateName, // Fallback to default template name from mapping config
                           operationType: defaultOperationType // Fallback to default operation type from mapping config
                       }; // Fallback to applicationEntitlementId from Entitlement model if needed? This requires fetching the Entitlement model here.
                       // To avoid refetching Entitlement model, the AccessMapper (or previous logic) should include applicationEntitlementId in the item.

                       // Refetch Entitlement model to get applicationEntitlementId if not in mapping
                        let actualAppEntitlementId = mappedEntitlementDetails.appEntitlementId;
                        if (!actualAppEntitlementId) {
                             // If appEntitlementId isn't in the mapping config, try to get it from the Entitlement model itself
                             const fullEntitlementDetails = await Entitlement.findByPk(iglmEntitlement.iglmEntitlementId);
                             if (fullEntitlementDetails) {
                                 actualAppEntitlementId = fullEntitlementDetails.applicationEntitlementId;
                             }
                        }

                       if (!actualAppEntitlementId) {
                             console.warn(`[${serviceName}] processProvisioningTask: Entitlement "${iglmEntitlement.iglmEntitlementName}" (ID: ${iglmEntitlement.iglmEntitlementId}) has no appEntitlementId in model or mapping config for App "${application.name}". Skipping grant.`);
                             // Log this as a skipped operation at the application level result
                             applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_success', result: { operations: [] } };
                             applicationProvisioningResults[appId].result.operations.push({
                                 entitlement: iglmEntitlement.iglmEntitlementName,
                                 status: 'skipped',
                                 message: 'Missing appEntitlementId in config/model',
                                 iglmEntitlementId: iglmEntitlement.iglmEntitlementId
                             });
                             continue; // Skip this entitlement for the adapter call
                       }

                        // Determine the specific SQL template name or operation type for this entitlement grant
                        const specificGrantTemplate = mappedEntitlementDetails.sqlTemplateName || defaultGrantTemplateName;
                        const specificGrantOperationType = mappedEntitlementDetails.operationType || defaultOperationType; // For adapters like LDAP

                        if (!specificGrantTemplate && !specificGrantOperationType) {
                            console.warn(`[${serviceName}] processProvisioningTask: Entitlement "${iglmEntitlement.iglmEntitlementName}" (ID: ${iglmEntitlement.iglmEntitlementId}) has no SQL template name or operation type defined in mapping config and no default for App "${application.name}". Skipping grant.`);
                             applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_success', result: { operations: [] } };
                             applicationProvisioningResults[appId].result.operations.push({
                                 entitlement: iglmEntitlement.iglmEntitlementName,
                                 status: 'skipped',
                                 message: 'Missing SQL template/operation type in config',
                                 iglmEntitlementId: iglmEntitlement.iglmEntitlementId,
                                 appEntitlementId: actualAppEntitlementId
                             });
                            continue;
                        }


                       // Construct the object for this specific entitlement for the adapter
                       appEntitlementsToGrantForAdapter.push({
                           iglmEntitlementId: iglmEntitlement.iglmEntitlementId,
                           iglmEntitlementName: iglmEntitlement.iglmEntitlementName,
                           appEntitlementId: actualAppEntitlementId, // The actual ID used by the target app
                           assignmentType: iglmEntitlement.assignmentType, // From RoleEntitlementMapping
                           metadata: iglmEntitlement.metadata, // From RoleEntitlementMapping
                           mappingDetails: { // Include details from the app mapping config relevant to the adapter
                                sqlTemplateName: specificGrantTemplate,
                                operationType: specificGrantOperationType,
                                // Add any other relevant mapping details needed by the adapter
                                ...mappedEntitlementDetails
                           }
                       });
                 }


                 // Map IGLM Entitlements to App-specific entitlements for revoking
                 // TODO: Implement this logic based on comparing desired state vs current state (from Discovery/Reconciliation)
                 const appEntitlementsToRevokeForAdapter = [];
                 /*
                 // Placeholder logic if current state was available (e.g., from user.currentAppEntitlements loaded via Discovery)
                 const currentAppEntitlements = user.currentAppEntitlements?.[appId] || []; // Assuming current entitlements stored per app
                 const desiredAppEntitlementIds = new Set(appEntitlementsToGrantForAdapter.map(e => e.appEntitlementId));

                 for (const currentEntitlement of currentAppEntitlements) {
                     // Assuming currentEntitlement has { appEntitlementId, iglmEntitlementId, ... }
                     if (!desiredAppEntitlementIds.has(currentEntitlement.appEntitlementId)) {
                         // This entitlement is currently assigned but not desired based on roles
                         const mappedEntitlementDetails = entitlementMappings[currentEntitlement.iglmEntitlementId] || {
                              appEntitlementId: currentEntitlement.appEntitlementId, // Use current state's app ID
                              revokeSqlTemplateName: defaultRevokeTemplateName, // Fallback to default revoke template
                              revokeOperationType: defaultOperationType // Fallback to default revoke op type
                         };

                         // Determine the specific SQL template name or operation type for this entitlement revoke
                          const specificRevokeTemplate = mappedEntitlementDetails.revokeSqlTemplateName || mappedEntitlementDetails.sqlTemplateName || defaultRevokeTemplateName; // Fallback to grant template if no specific revoke
                          const specificRevokeOperationType = mappedEntitlementDetails.revokeOperationType || mappedEntitlementDetails.operationType || defaultOperationType; // Fallback to grant op type

                          if (!specificRevokeTemplate && !specificRevokeOperationType) {
                              console.warn(`[${serviceName}] processProvisioningTask: Entitlement "${currentEntitlement.iglmEntitlementName || currentEntitlement.appEntitlementId}" (ID: ${currentEntitlement.iglmEntitlementId}) has no revoke template/operation type defined in mapping config and no default for App "${application.name}". Skipping revoke.`);
                               applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_success', result: { operations: [] } };
                               applicationProvisioningResults[appId].result.operations.push({
                                  entitlement: currentEntitlement.iglmEntitlementName || currentEntitlement.appEntitlementId,
                                  appEntitlementId: currentEntitlement.appEntitlementId,
                                  status: 'skipped',
                                  message: 'Missing revoke SQL template/operation type in config',
                                  iglmEntitlementId: currentEntitlement.iglmEntitlementId
                              });
                             continue;
                          }


                         appEntitlementsToRevokeForAdapter.push({
                             iglmEntitlementId: currentEntitlement.iglmEntitlementId,
                             iglmEntitlementName: currentEntitlement.iglmEntitlementName, // Might be null if only app ID is known
                             appEntitlementId: currentEntitlement.appEntitlementId,
                              mappingDetails: { // Include details relevant to the adapter
                                sqlTemplateName: specificRevokeTemplate,
                                operationType: specificRevokeOperationType,
                                // Add any other relevant mapping details needed by the adapter
                                ...mappedEntitlementDetails // Include all mapped details
                             }
                         });
                     }
                 }
                 */


                 const appSpecificDesiredState = {
                      userIdInApp: userIdInApp, // The user identifier for this app
                      entitlementsToGrant: appEntitlementsToGrantForAdapter, // Filtered list of entitlements to grant
                      entitlementsToRevoke: appEntitlementsToRevokeForAdapter // List of entitlements to revoke (empty for now)
                 };

                  // Log the state being sent to the adapter
                  console.log(`[${serviceName}] processProvisioningTask: Prepared app-specific desired state for Application "${application.name}":`, {
                      userIdInApp: appSpecificDesiredState.userIdInApp,
                      grantsCount: appSpecificDesiredState.entitlementsToGrant.length,
                      revokesCount: appSpecificDesiredState.entitlementsToRevoke.length,
                      grantAppEntitlementIds: appSpecificDesiredState.entitlementsToGrant.map(e => e.appEntitlementId),
                      revokeAppEntitlementIds: appSpecificDesiredState.entitlementsToRevoke.map(e => e.appEntitlementId) // Will be empty until revoke logic implemented
                  });


                  // Call the connector adapter's primary method
                  // Pass the connector config.configuration and the prepared app-specific desired state for the user
                  provisioningResult = await connectorModule.applyDesiredState(appConnectorConfig.configuration, appSpecificDesiredState);
                  console.log(`[${serviceName}] processProvisioningTask: Adapter call complete for Application "${application.name}". Result:`, provisioningResult);

                  // Adapter is expected to return a result object indicating success/failure for each operation
                  // Example result: { success: boolean, operations: Array<{ entitlement: string, status: 'granted'|'revoked'|'skipped'|'failed', message?: string, error?: string, appEntitlementId?: string, ...other_adapter_specific_details }> }
                  // We'll store the adapter's full result in the applicationProvisioningResults
                  applicationProvisioningResults[appId] = { status: provisioningResult?.success ? 'success' : 'failed', result: provisioningResult };
                  if (!provisioningResult?.success) {
                       allApplicationsSucceeded = false; // Mark overall task as failed if the adapter reports overall failure for this app
                       // If the adapter didn't provide detailed errors in its result, add a generic one
                       if (!provisioningResult?.operations?.some(op => op.status === 'failed')) {
                           errorsPerApplication[appId] = { message: `Adapter reported overall failure for ${application.name}, but no specific operation errors. Check adapter logs.` };
                       }
                  }

                  // Also aggregate individual operation errors from the adapter result
                  if (provisioningResult?.operations) {
                       const failedOperations = provisioningResult.operations.filter(op => op.status === 'failed');
                       if (failedOperations.length > 0) {
                            errorsPerApplication[appId] = errorsPerApplication[appId] || {}; // Initialize if needed
                            errorsPerApplication[appId].operations = failedOperations.map(op => ({
                                entitlement: op.entitlement,
                                appEntitlementId: op.appEntitlementId,
                                message: op.message,
                                error: op.error
                            }));
                            allApplicationsSucceeded = false; // Ensure overall task is failed if individual operations failed
                       }
                  }


             } catch (appProvisioningError) {
                  // Catch errors during config/mapping loading, adapter loading, user ID mapping, or the adapter call itself
                  console.error(`[${serviceName}] processProvisioningTask: Error provisioning Application "${application.name}" (ID: ${appId}) for user ${user.hrmsId}:`, appProvisioningError);
                  applicationProvisioningResults[appId] = { status: 'failed', error: { message: appProvisioningError.message, stack: appProvisioningError.stack } };
                  errorsPerApplication[appId] = { message: appProvisioningError.message, stack: appProvisioningError.stack }; // Store error details
                  allApplicationsSucceeded = false; // Mark overall task as failed if any app fails
             }
         } // End loop through applicationsToProcessMap


         // --- Finalize Task Status and Reporting ---
         overallTaskStatus = allApplicationsSucceeded ? 'completed' : 'failed';

         // 4. Update the ProvisioningTask entry (status, end time, results).
         // Reload the task first to ensure we have the latest version in case its status was updated concurrently (e.g., cancellation)
         const taskToUpdate = await ProvisioningTask.findByPk(taskId);
          if (taskToUpdate) {
              // Only update status if it's still in_progress or pending/retrying (prevents overwriting externally set 'cancelled')
              if (taskToUpdate.status === 'in_progress' || taskToUpdate.status === 'pending' || taskToUpdate.status === 'retrying') {
                  await taskToUpdate.update({
                      status: overallTaskStatus, // 'completed' or 'failed'
                      endTime: new Date(),
                      results: applicationProvisioningResults, // Store results per application
                      errorDetails: errorsPerApplication // Store collected errors per application
                  });
                  console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} status updated to '${overallTaskStatus}'.`);
              } else {
                   console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} status was changed externally to '${taskToUpdate.status}'. Skipping final status update.`);
                   // TODO: Log this event (e.g., task was cancelled while processing)
              }
          } else {
               console.error(`[${serviceName}] processProvisioningTask: CRITICAL ERROR: Task ${taskId} not found in DB when trying to finalize.`);
               // TODO: Implement alerting for this critical failure (task record disappeared).
          }


         // 5. Publish status updates to the Message Queue
         // This allows other services or a monitoring system to react to task completion/failure
         // Publish using the *final* determined status
         const taskCompletedEventPayload = {
             taskId: taskId,
             userId: user.id, // IGLM User ID
             userHrmsId: user.hrmsId, // Include HRMS ID for easier tracking
             status: overallTaskStatus, // Use the determined overall status ('completed' or 'failed')
             results: applicationProvisioningResults, // Include detailed results
             errorDetails: errorsPerApplication, // Include detailed errors
             timestamp: new Date()
         };
         // Publish to a topic like 'provisioning.task.completed' or 'provisioning.task.failed'
          // A single topic with status in the routing key is flexible: provisioning.task.<status>
          const routingKey = `task.${overallTaskStatus}`; // e.g., task.completed, task.failed
         await mqService.publish('provisioning.task.status', routingKey, taskCompletedEventPayload);
         console.log(`[${serviceName}] processProvisioningTask: Published 'provisioning.task.status' event with routing key '${routingKey}' for task ${taskId}.`);


     } catch (processError) {
         // Catch any uncaught errors that occur during the entire task processing logic *before* the finalization step
         console.error(`[${serviceName}] processProvisioningTask: Uncaught error during task processing for task ${taskId}:`, processError);

         // Attempt to update task status to failed due to uncaught error
         try {
              const taskToUpdate = await ProvisioningTask.findByPk(taskId);
              const uncaughtErrorDetails = { message: processError.message, stack: processError.stack };

              if (taskToUpdate && taskToUpdate.status !== 'failed' && taskToUpdate.status !== 'completed' && taskToUpdate.status !== 'cancelled') {
                  await taskToUpdate.update({
                      status: 'failed', // Mark as failed due to uncaught error
                      endTime: new Date(),
                      errorDetails: { ...errorsPerApplication, uncaught: uncaughtErrorDetails }, // Include any collected errors + uncaught error
                      results: applicationProvisioningResults // Include any results collected before error
                  });
                   console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} status updated to 'failed' due to uncaught error.`);

                   // Also publish a failed status event
                   const failedEventPayload = {
                       taskId: taskId,
                       userId: taskToUpdate.userId, // Use user ID from task if user object not fully loaded
                       status: 'failed',
                       results: applicationProvisioningResults,
                       errorDetails: { ...errorsPerApplication, uncaught: uncaughtErrorDetails },
                       timestamp: new Date()
                   };
                   await mqService.publish('provisioning.task.status', 'task.failed', failedEventPayload).catch(mqErr => console.error(`[${serviceName}] processProvisioningTask: Failed to publish 'task.failed' MQ event for task ${taskId}:`, mqErr));

              } else if (taskToUpdate) {
                  console.log(`[${serviceName}] processProvisioningTask: Task ${taskId} status was changed externally to '${taskToUpdate.status}' before uncaught error handling.`);
              } else {
                   console.error(`[${serviceName}] processProvisioningTask: CRITICAL ERROR: Task ${taskId} not found when trying to mark failed after uncaught error.`);
                   // This is a severe issue - task vanished. Need external monitoring/alerting.
              }
         } catch (updateErr) {
              console.error(`[${serviceName}] processProvisioningTask: CRITICAL ERROR failed to update task ${taskId} status and publish event after uncaught error:`, updateErr);
              // This is the worst case - task failed and we couldn't log or signal it properly.
              // External monitoring is essential here.
         }

         // Re-throw the error. The worker receiving the MQ message should catch this and handle retries (e.g., NACK the message).
         throw processError;

    } finally {
       // The finally block runs regardless of whether an error was thrown or not.
       // Database connections (via ConfigService and models) and MQ connections (via mqService)
       // are typically managed by the service's main process or worker framework, not closed per task.
       // Adapter-specific connections are managed within the adapter modules themselves (like the LDAP and DB adapters shown previously).
       console.log(`[${serviceName}] processProvisioningTask: Task processing for ${taskId} completed final cleanup.`);
    }
}


// Export the main worker function
module.exports = {
    processProvisioningTask, // Export the main worker function
    // Export helper functions if they need to be unit tested directly, otherwise keep them internal
    // getNestedValue,
    // determineAppUserIdentifier,
};