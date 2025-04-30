// services/provisioning-service/src/provisioningLogic.js

// Import Node.js core path module
const path = require('path');

// Import shared services and models - Assuming these are initialized and passed in options
// const ConfigService = require('../shared/configService'); // Accessed via options.configService
// const MqService = require('../shared/mqService'); // Accessed via options.mqService
// const models = require('../shared/models'); // Accessed via options.models
// const TemporaryStorage = require('../shared/temporaryStorage'); // Accessed via options.temporaryStorage


// --- Adapter Cleanup Registry ---
// Set to store asynchronous cleanup functions provided by adapters that manage connections/resources.
// Each adapter module that needs graceful shutdown should register its cleanup function here.
const adapterCleanupFunctions = new Set();

/**
 * Allows a provisioning adapter module to register an asynchronous cleanup function.
 * This function will be called during ProvisioningLogic shutdown.
 * Adapter modules that manage connection pools or other long-lived resources should use this.
 * @param {Function} cleanupFunc - An async function that performs cleanup (e.g., closing connection pools).
 */
const registerCleanup = (cleanupFunc) => {
    if (typeof cleanupFunc === 'function') {
        adapterCleanupFunctions.add(cleanupFunc);
        // console.log(`[ProvisioningLogic] Registered cleanup function.`); // Optional debug log
    } else {
        // console.warn(`[ProvisioningLogic] Attempted to register non-function as cleanup.`); // Optional warn log
    }
};
// --- End Adapter Cleanup Registry ---


// Helper function to get a value from a nested object path (copied locally)
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
 * @param {object} logger - Logger instance.
 * Expected appMappingConfig.mappingRules.userIdentifierMapping structure:
 * { "sourceField": "email", "targetFormat": "string" }
 * { "sourceField": "hrmsId", "targetFormat": "string" }
 * { "sourceField": "metadata.sAMAccountName", "targetFormat": "string" }
 * // TODO: Add support for more complex targetFormats (e.g., "dn", "emailFormat")
 * // TODO: Add support for lookup logic if the user identifier in the target app is not directly in the IGLM User model.
 * @returns {string|null} The user identifier string expected by the target application, or null if mapping fails or the source field value is missing.
 */
function determineAppUserIdentifier(user, appMappingConfig, logger) {
    const serviceName = 'provisioning-service'; // Or get from logger default meta
    // Validate basic inputs and the presence of the userIdentifierMapping rule
    if (!user || typeof user !== 'object' || !appMappingConfig || typeof appMappingConfig !== 'object' || !appMappingConfig.mappingRules || typeof appMappingConfig.mappingRules.userIdentifierMapping !== 'object') {
        logger.error(`determineAppUserIdentifier: Invalid input or missing userIdentifierMapping rule in mapping config (ID: ${appMappingConfig?.id}).`, { userId: user?.id, mappingId: appMappingConfig?.id }); // Include IDs in logs
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
        logger.error(`determineAppUserIdentifier: userIdentifierMapping rule for config ID ${appMappingConfig.id} has missing or invalid 'sourceField'.`, { userId: user.id, mappingId: appMappingConfig.id, sourceFieldRule: identifierMapping.sourceField });
        return null;
    }

    // Check if the raw value was found and is not null/undefined/empty string
    if (rawIdentifierValue === null || rawIdentifierValue === undefined || String(rawIdentifierValue).trim() === '') { // Added check for empty string after trimming
        logger.error(`determineAppUserIdentifier: Source field "${sourceField}" value is missing, null, undefined, or empty on user ${user.id} for mapping config ID ${appMappingConfig.id}. Cannot determine app identifier.`, { userId: user.id, mappingId: appMappingConfig.id, sourceField: sourceField, rawValue: rawIdentifierValue });
        return null; // Cannot determine identifier
    }

    // Apply targetFormat (currently only converts to string)
    // TODO: Implement logic for other targetFormats like 'dn', 'emailFormat', etc.
    let appUserId;
    switch (targetFormat) {
        case 'string':
        default:
            appUserId = String(rawIdentifierValue).trim(); // Trim whitespace from the string value
            break;
        // case 'dn':
        //     // Logic to construct DN from rawIdentifierValue and potentially other user attributes
        //     // Need user object and maybe dnTemplate from identifierMapping rule
        //     // Example: const dnTemplate = identifierMapping.dnTemplate; // e.g., "cn={0},ou=users,dc=example,dc=com"
        //     // appUserId = constructDn(rawIdentifierValue, user, dnTemplate); // Requires a constructDn helper
        //     throw new Error(`Unsupported targetFormat: ${targetFormat}`); // Fail if format not implemented
        // case 'emailFormat':
        //     // Logic to format email, e.g., add domain if missing
        //     // Need format details like domain from identifierMapping rule
        //     // Example: const domain = identifierMapping.domain; // e.g., "@example.com"
        //     // appUserId = formatEmail(rawIdentifierValue, domain); // Requires a formatEmail helper
        //     throw new Error(`Unsupported targetFormat: ${targetFormat}`); // Fail if format not implemented
    }

    // Optional: Validate the resulting appUserId format if needed (e.g., regex for sAMAccountName)
    // if (targetFormat === 'string' && !/^[a-zA-Z0-9._-]+$/.test(appUserId)) {
    //     logger.warn(`determineAppUserIdentifier: Resulting app user ID "${appUserId}" for user ${user.id} appears invalid for target format 'string'. Check mapping source field and target system requirements.`);
    //     // Depending on policy, might return null here instead of the potentially invalid ID.
    // }


    logger.info(`determineAppUserIdentifier: Mapped user ${user.id} (source field "${sourceField}") to app ID "${appUserId}" for mapping config ID ${appMappingConfig.id}.`, { userId: user.id, mappingId: appMappingConfig.id, sourceField: sourceField, appUserId: appUserId });
    return appUserId;
}


/**
 * Performs the actual asynchronous provisioning work for a given task.
 * This function is called by the MQ worker process when a new task message is received.
 *
 * @param {string} taskId - The ID (UUID) of the Provisioning Task to process.
 * @param {object} options - Options including shared services and models, passed from the worker.
 * @param {object} options.configService - The initialized ConfigService instance.
 * @param {object} options.mqService - The initialized MqService instance (for status events).
 * @param {object} options.models - Sequelize models object ({ User, Application, Entitlement, Role, RoleEntitlementMapping, ConnectorConfig, MappingConfig, ProvisioningTask, ... }).
 * @param {object} options.temporaryStorage - The initialized TemporaryStorage instance.
 * @param {object} options.logger - Logger instance.
 * @returns {Promise<void>} Resolves when the task processing is complete (success or failure handled internally).
 * @throws {Error} Throws critical errors that the worker should catch to potentially retry the message (e.g., transient DB/MQ issues when loading task/user). Non-critical provisioning errors should be handled, logged, and reflected in task status/results/errorDetails.
 */
async function processProvisioningTask(taskId, options) {
    // Destructure options for easier access to dependencies
    const { configService, mqService, models, temporaryStorage, logger } = options; // Added temporaryStorage and logger
    // Access models explicitly
    const { User, Application, Entitlement, Role, RoleEntitlementMapping, ConnectorConfig, MappingConfig, ProvisioningTask } = models;

    const serviceName = 'provisioning-service'; // Service identifier (can also get from logger.defaultMeta)

    let task; // Variable to hold the ProvisioningTask log entry
    let user; // Variable to hold the IGLM User model instance
    const applicationProvisioningResults = {}; // Track success/failure and results per application {appId: { status: 'success'|'failed'|'skipped', result: {...}, error?: {...} }}
    const errorsPerApplication = {}; // Collect detailed errors per application {appId: { message?: string, stack?: string, operations?: [...] }}
    let overallTaskStatus = 'failed'; // Default to failed if not completed


    try {
        logger.info(`Starting processing for task ID: ${taskId}`, { taskId });

        // 1. Load the Provisioning Task details from the database
        try {
            task = await ProvisioningTask.findByPk(taskId);
        } catch (dbError) {
            logger.error(`Database error loading task ${taskId}:`, dbError);
            // This is a critical error - likely a transient DB issue. Throw to trigger retry at MQ worker level.
            throw new Error(`Database error loading task ${taskId}: ${dbError.message}`);
        }

        if (!task) {
            logger.error(`Task not found with ID ${taskId}. Cannot process.`, { taskId });
            errorsPerApplication['system'] = { message: 'Task not found in DB' }; // Attribute error to system
            overallTaskStatus = 'failed';
            // Task record doesn't exist, so we can't update its status in the DB.
            // We might need to publish a separate critical error event or rely on external monitoring.
            // For now, just log and return. The worker should NACK and potentially move to DLQ.
            // A task not found probably implies a race condition or data loss. NACK false, false is safest.
            return;
        }

        // Check task status - only process pending or in_progress tasks.
        // 'retrying' status could be handled by the worker itself using DLQ.
        // 'cancelled' status is handled by checking the status and not processing.
        if (task.status !== 'pending' && task.status !== 'in_progress') { // Don't process 'completed', 'failed', 'cancelled' here
             logger.warn(`Task ${taskId} is already in status '${task.status}'. Skipping processing.`, { taskId, status: task.status });
             // If the task status is 'retrying' (set by a DLQ process), the worker might requeue it, and we'd re-enter here.
             // The logic below should be idempotent to handle retries of in_progress tasks.
            return; // Exit if not in a processable state
        }

        // Extract task type and original payload
        taskPayload = task.desiredState?.payload;
        taskType = task.desiredState?.type;

        if (!taskType || !taskPayload) {
             // Malformed task payload in DB
             logger.error(`Malformed desiredState in task ${taskId}: Missing type or payload.`, { taskId, desiredState: task.desiredState });
             errorsPerApplication['system'] = { message: 'Malformed task payload in DB: Missing type or payload' };
             overallTaskStatus = 'failed';
             // Attempt to update task status immediately as we cannot proceed
             await task.update({ status: overallTaskStatus, endTime: new Date(), errorDetails: errorsPerApplication }).catch(dbErr => logger.error(`Database error updating task ${taskId} status to 'failed' due to malformed payload:`, dbErr));
             // Publish status update
             await publishTaskStatusEvent(task.id, overallTaskStatus, errorsPerApplication, applicationProvisioningResults, task.userId, user?.hrmsId, mqService, logger).catch(mqErr => logger.error(`Failed to publish task status event for ${taskId}:`, mqErr));
             return; // Exit processing
        }

        // Update task status to 'in_progress' if it's pending
        // This prevents multiple workers processing the same task concurrently
        if (task.status === 'pending') {
            // Use update method for atomic update and optimistic locking if needed
            try {
                 await task.update({ status: 'in_progress', startTime: new Date() });
                 logger.info(`Task ${taskId} status updated to 'in_progress'.`, { taskId, status: 'in_progress' });
            } catch (updateError) {
                 logger.error(`Database error updating task ${taskId} status to 'in_progress':`, updateError);
                 // This is a critical error - likely transient DB issue. Throw to trigger retry.
                 // The task status might remain 'pending' which is okay for a retry.
                 throw new Error(`Database error updating task status to in_progress: ${updateError.message}`);
            }
        } else { // status is 'in_progress' - implies this is a retry/resume
            logger.info(`Task ${taskId} found in status 'in_progress'. Assuming retry/resume.`, { taskId, status: 'in_progress' });
            // TODO: Implement logic for resuming an interrupted task if necessary.
            // This might involve checking existing results in task.results to avoid re-processing succeeded apps.
        }


        // 2. Load User and related data (Roles, RoleEntitlementMappings) from Core DB
        // This is needed for GRANT tasks to determine desired entitlements from roles.
        // For REVOKE tasks triggered by Reconciliation, the payload might already have the needed context.
        // Load anyway for consistency and access to user details for logging/mapping.
        if (!User || !Role || !Entitlement || !RoleEntitlementMapping || !Application) {
            logger.error('One or more required models are not available in ProvisioningLogic.');
            throw new Error("Required models not available.");
        }
        try {
            user = await User.findByPk(task.userId, {
                include: { // Include necessary associations to get roles and their mapped entitlements
                    model: Role, as: 'roles', through: { attributes: ['assignmentDate', 'unassignmentDate'] },
                    include: {
                        model: Entitlement, as: 'entitlements', through: { model: RoleEntitlementMapping, attributes: ['assignmentType', 'metadata'] },
                        include: { model: Application, as: 'application' } // Include the Application for each Entitlement
                    }
                }
            });
        } catch (dbError) {
            logger.error(`Database error loading User and associations for task ${taskId} (UserID: ${task.userId}):`, dbError);
             // This is a critical error - likely a transient DB issue. Throw to trigger retry.
            throw new Error(`Database error loading user data for task ${taskId}: ${dbError.message}`);
        }


        if (!user && task.userId !== null) { // User not found, and task expected one (not an orphan task)
            logger.error(`User not found in IGLM DB for task ${taskId} (UserID: ${task.userId}). Cannot proceed.`, { taskId, userId: task.userId });
            errorsPerApplication['system'] = { message: 'User not found in IGLM DB' }; // Attribute error to system
            overallTaskStatus = 'failed';
            // Update task status immediately as we cannot proceed
            await task.update({ status: overallTaskStatus, endTime: new Date(), errorDetails: errorsPerApplication }).catch(dbErr => logger.error(`Database error updating task ${taskId} status to 'failed' due to user not found:`, dbErr));
             // Publish status update
            await publishTaskStatusEvent(task.id, overallTaskStatus, errorsPerApplication, applicationProvisioningResults, task.userId, user?.hrmsId, mqService, logger).catch(mqErr => logger.error(`Failed to publish task status event for ${taskId}:`, mqErr));
            return; // Exit processing
        } else if (!user && task.userId === null) {
             // This is an ORPHANED ACCOUNT task, which is valid (user exists in target but not IGLM)
             logger.warn(`Task ${taskId} is for an orphaned account (UserID is null). Proceeding with application-specific context from payload.`, { taskId });
             // User object will be null, rely on payload for app user ID and context.
        } else { // User found (for grant tasks or non-orphan revoke tasks)
             logger.info(`Loaded user ${user.hrmsId} (ID: ${user.id}) with current roles and entitlements for task ${taskId}.`, { taskId, userId: user.id, userHrmsId: user.hrmsId });
        }


        // 3. Determine Affected Applications and relevant Entitlements to Grant/Revoke
        // The map will store lists of IGLM Entitlement details that need granting/revoking, grouped by Application ID.
        const applicationsToProcessMap = new Map(); // { appId: { application: ApplicationModel, entitlementsToGrant: [], entitlementsToRevoke: [] } }

        if (taskType === 'grant') {
            // --- Logic for GRANT tasks (derive desired entitlements from roles) ---
            const desiredRoleNames = taskPayload.roles || []; // Ensure it's an array
            logger.info(`Task ${taskId} is a GRANT task. Analyzing desired roles: ${desiredRoleNames.join(', ')}`, { taskId, desiredRoles: desiredRoleNames });

            // Iterate through the desired role names from the task's payload (received via API)
            for (const desiredRoleName of desiredRoleNames) {
                // Find the Role model among the user's *loaded* roles (includes associations to entitlements/apps)
                const role = user?.roles ? user.roles.find(r => r.name === desiredRoleName) : null; // Use optional chaining as user might be null for orphan tasks (though grant tasks usually have a user)

                if (role) {
                    // For each found desired role, collect its mapped entitlements
                    if (role.entitlements && Array.isArray(role.entitlements)) {
                        for (const roleEntitlement of role.entitlements) {
                            const entitlement = roleEntitlement; // This is the IGLM Entitlement model instance
                            const application = entitlement.application; // The associated Application model instance

                            if (application) {
                                const appEntry = applicationsToProcessMap.get(application.id);
                                if (!appEntry) {
                                    // Initialize entry for this application
                                    applicationsToProcessMap.set(application.id, { application: application, entitlementsToGrant: [], entitlementsToRevoke: [] });
                                }
                                // Add the IGLM Entitlement object and mapping attributes to the entitlementsToGrant list for this application
                                applicationsToProcessMap.get(application.id).entitlementsToGrant.push({
                                    iglmEntitlementId: entitlement.id,
                                    iglmEntitlementName: entitlement.name,
                                    applicationId: application.id, // Include app ID for clarity
                                    applicationName: application.name,
                                    applicationEntitlementId: entitlement.applicationEntitlementId, // Include app-specific ID from Entitlement model
                                    assignmentType: roleEntitlement.RoleEntitlementMapping.assignmentType, // From RoleEntitlementMapping
                                    metadata: roleEntitlement.RoleEntitlementMapping.metadata // From RoleEntitlementMapping
                                });
                            } else {
                                logger.warn(`Entitlement "${entitlement.name}" mapped to role "${role.name}" for task ${taskId} is missing Application details. Skipping.`, { taskId, roleId: role.id, entitlementId: entitlement.id });
                                // TODO: Log this as a skipped operation for the task result?
                            }
                        }
                    } else if (role) {
                        logger.warn(`Role "${role.name}" (ID: ${role.id}) for task ${taskId} has no associated entitlements or entitlements property is not an array. Skipping.`, { taskId, roleId: role.id });
                        // TODO: Log this as a skipped role for the task result?
                    } else { // Role name from payload not found among user's loaded roles (or user is null, which is unexpected for grant tasks)
                        logger.warn(`Desired role "${desiredRoleName}" for task ${taskId} not found among user's loaded roles for user ${user?.hrmsId} (ID: ${user?.id}). Cannot process entitlements for this role.`, { taskId, userId: user?.id, roleName: desiredRoleName });
                        // TODO: Log this as a skipped role for the task result?
                    }
                } else { // Role not found in the DB at all
                    logger.warn(`Desired role "${desiredRoleName}" for task ${taskId} not found in IGLM DB. Cannot process entitlements for this role.`, { taskId, roleName: desiredRoleName });
                     // TODO: Log this as a skipped role for the task result?
                }
            }
            logger.info(`Determined entitlements to grant based on desired roles. Total unique applications affected: ${applicationsToProcessMap.size}.`, { taskId, appsCount: applicationsToProcessMap.size });


            // For grant tasks, entitlementsToRevoke lists are initially empty.
            // Revocation logic (identifying entitlements to remove) is handled by Reconciliation.


        } else if (taskType === 'revoke') {
            // --- Logic for REVOKE tasks (use explicit list from payload) ---
            const entitlementsToRevokeFromPayload = taskPayload.entitlementsToRevoke || []; // Expected array of { iglmEntitlementId?, appSpecificEntitlementId, applicationId, appSpecificUserId?, ... }
            const userIdFromPayload = taskPayload.userId; // User ID from revoke payload (could be null for orphans)
            const appSpecificUserIdFromPayload = taskPayload.appSpecificUserId; // App-specific user ID from revoke payload (especially for orphans)


            if (!Array.isArray(entitlementsToRevokeFromPayload) || entitlementsToRevokeFromPayload.length === 0) {
                // Malformed revoke task payload - Should be caught and marked failed before this point in server.js API
                // Adding a check here for robustness in case worker gets a bad task from DB
                logger.error(`Revoke task ${taskId} has missing or empty 'entitlementsToRevoke' array in payload. Cannot process.`, { taskId, payload: taskPayload });
                errorsPerApplication['system'] = { message: 'Malformed revoke task payload in DB: Missing or empty entitlementsToRevoke array' };
                overallTaskStatus = 'failed';
                await task.update({ status: overallTaskStatus, endTime: new Date(), errorDetails: errorsPerApplication }); // Update DB status
                await publishTaskStatusEvent(task.id, overallTaskStatus, errorsPerApplication, applicationProvisioningResults, task.userId, user?.hrmsId, mqService, logger).catch(mqErr => logger.error(`Failed to publish task status event for ${taskId}:`, mqErr)); // Publish event
                return; // Exit processing
            }
            logger.info(`Task ${taskId} is a REVOKE task. Processing explicit revocation for user ID ${userIdFromPayload || 'N/A'} with ${entitlementsToRevokeFromPayload.length} entitlements.`, { taskId, userId: userIdFromPayload, revokeCount: entitlementsToRevokeFromPayload.length });

            // Iterate through the explicit list of entitlements to revoke from the payload (from Reconciliation)
            for (const revokeItem of entitlementsToRevokeFromPayload) {
                // Ensure each item has the minimum required fields for a revoke operation
                if (!revokeItem || !revokeItem.applicationId || !revokeItem.appSpecificEntitlementId || !revokeItem.appSpecificUserId) { // appSpecificUserId is required for revoke
                    logger.warn(`Skipping malformed revoke item in payload for task ${taskId}. Missing applicationId, appSpecificEntitlementId, or appSpecificUserId.`, { taskId, revokeItem });
                    // Log this specific malformed item as a partial error for the task result
                    errorsPerApplication[revokeItem?.applicationId || 'unknown_app'] = errorsPerApplication[revokeItem?.applicationId || 'unknown_app'] || { message: 'Partial failure due to malformed revoke item in payload.', operations: [] };
                    errorsPerApplication[revokeItem?.applicationId || 'unknown_app'].operations.push({
                         status: 'skipped', message: 'Malformed revoke item in payload', item: revokeItem // Include the item for context
                    });
                    continue; // Skip to the next item in the payload
                }

                // Ensure the application for this revoke item is in the map
                // Need to load the application details to add it to the map if not already present.
                if (!applicationsToProcessMap.has(revokeItem.applicationId)) {
                    const app = await Application.findByPk(revokeItem.applicationId);
                    if (app) {
                        applicationsToProcessMap.set(app.id, { application: app, entitlementsToGrant: [], entitlementsToRevoke: [] }); // Initialize grant/revoke arrays
                    } else {
                        logger.error(`Revoke item for unknown Application ID ${revokeItem.applicationId} in payload for task ${taskId}. Skipping revoke for this item.`, { taskId, appId: revokeItem.applicationId });
                        // Log this specific error for the task result
                        errorsPerApplication[revokeItem.applicationId] = errorsPerApplication[revokeItem.applicationId] || { message: `Application ID ${revokeItem.applicationId} not found for revoke item.` };
                        continue; // Skip this revoke item if app not found
                    }
                }

                // Add the item to the entitlementsToRevoke list for the corresponding application
                // Store relevant details needed by the adapter
                applicationsToProcessMap.get(revokeItem.applicationId).entitlementsToRevoke.push({
                    iglmEntitlementId: revokeItem.iglmEntitlementId, // Might be null
                    iglmEntitlementName: revokeItem.iglmEntitlementName, // Might be null
                    appSpecificEntitlementId: revokeItem.appSpecificEntitlementId, // Required for revoke
                    applicationId: revokeItem.applicationId,
                    appSpecificUserId: revokeItem.appSpecificUserId, // Required for revoke (especially orphans)
                    // Include any other context from the original revoke payload item needed by the adapter
                    context: { ...revokeItem } // Store the full item as context for adapter
                });
            } // End loop through entitlementsToRevokeFromPayload
            logger.info(`Determined entitlements to revoke based on task payload. Total unique applications affected: ${applicationsToProcessMap.size}.`, { taskId, appsCount: applicationsToProcessMap.size });

            // For revoke tasks, entitlementsToGrant should be explicitly empty.


        } else {
            // Unknown task type - Should be caught and marked failed before this point in server.js API
            // Adding a check here for robustness in case worker gets a bad task from DB
            logger.error(`Unknown task type in desiredState for task ${taskId}: "${taskType}". Cannot process.`, { taskId, taskType: taskType, desiredState: task.desiredState });
            errorsPerApplication['system'] = { message: `Unknown task type: "${taskType}"` };
            overallTaskStatus = 'failed';
            await task.update({ status: overallTaskStatus, endTime: new Date(), errorDetails: errorsPerApplication }); // Update DB status
            await publishTaskStatusEvent(task.id, overallTaskStatus, errorsPerApplication, applicationProvisioningResults, task.userId, user?.hrmsId, mqService, logger).catch(mqErr => logger.error(`Failed to publish task status event for ${taskId}:`, mqErr)); // Publish event
            return; // Exit processing
        }


        // --- Orchestrate Provisioning per Application ---
        // Loop through the applications identified for processing (map built based on task type)
        let allApplicationsSucceeded = true; // Flag to determine overall task status

        for (const [appId, appDetails] of applicationsToProcessMap.entries()) {
            const application = appDetails.application; // Application model instance
            const entitlementsToGrant = appDetails.entitlementsToGrant; // Array of { iglmEntitlementId, ..., appEntitlementId, mappingDetails: {...} }
            const entitlementsToRevoke = appDetails.entitlementsToRevoke; // Array of { iglmEntitlementId?, appSpecificEntitlementId, ..., context: {...} }
            let appProvisioningStatus = 'failed'; // Status for this application

            logger.info(`Processing ${taskType} task for Application "${application.name}" (ID: ${application.id}). Grants: ${entitlementsToGrant.length}, Revokes: ${entitlementsToRevoke.length}`, { taskId: taskId, appId: appId, appName: application.name, grantsCount: entitlementsToGrant.length, revokesCount: entitlementsToRevoke.length });

            // Skip calling the adapter if there's nothing to process (grant or revoke) for this app
            if (entitlementsToGrant.length === 0 && entitlementsToRevoke.length === 0) {
                logger.warn(`No entitlements to process (grant or revoke) for Application "${application.name}". Skipping adapter call.`, { taskId: taskId, appId: appId, appName: application.name });
                applicationProvisioningResults[appId] = { status: 'skipped', message: 'No entitlements to process' };
                // Note: overallTaskStatus remains true if all apps are skipped or succeed.
                continue; // Skip to next application in the loop
            }

            let appConnectorConfig;
            let appMappingConfig; // Mapping from IGLM Entitlement ID -> App-specific Entitlement ID/Action
            let adapterCallResult = null; // Store the raw result from the adapter


            try {
                // Load the Provisioning Connector Config for this application using ConfigService
                // Get config ID from the Application model
                const connectorId = application.connectorId;
                 if (!connectorId) {
                    throw new Error(`Application "${application.name}" (ID: ${application.id}) has no connectorId configured.`);
                }
                // Clear cache using the config ID (assuming configService supports loading/clearing by ID)
                // If not, you might need to load by ID, then by Name/Type using the cacheKey function.
                // Let's load by ID first for robustness and then use name/type for logging/cache.
                 const connectorLookup = await ConfigService.sequelize.models.ConnectorConfig.findByPk(connectorId);
                 if (!connectorLookup) {
                     throw new Error(`Provisioning Connector Config not found for ID: ${connectorId} linked to Application "${application.name}".`);
                 }
                 // Now clear cache using the name/type and reload from the robust ConfigService cache
                 // Need to pass serviceType and type to loadConnectorConfig
                 const specificConnectorCacheKey = configService.connectorCacheKey(connectorLookup.name, connectorLookup.serviceType, connectorLookup.type);
                 configService.clearCache(specificConnectorCacheKey);
                 appConnectorConfig = await configService.loadConnectorConfig(connectorLookup.name, connectorLookup.serviceType, connectorLookup.type); // Reload using the loader/cache logic

                if (!appConnectorConfig) { // Final check after robust load
                    throw new Error(`Provisioning Connector Config "${connectorLookup.name}" (ID: ${connectorId}) linked to Application "${application.name}" failed to load robustly.`);
                }

                if (appConnectorConfig.serviceType !== 'Provisioning') {
                    logger.warn(`Connector Config "${appConnectorConfig.name}" (ID: ${appConnectorConfig.id}) linked to Application "${application.name}" is not marked as serviceType 'Provisioning'. This might be a configuration error.`, { taskId: taskId, appId: appId, connectorId: appConnectorConfig.id });
                }
                logger.info(`Loaded App Connector Config: "${appConnectorConfig.name}" (Type: "${appConnectorConfig.type}")`, { taskId: taskId, appId: appId, connectorId: appConnectorConfig.id, connectorType: appConnectorConfig.type });


                // Load the Application-specific Mapping Config (IGLM Entitlement ID -> App Entitlement ID/Action) using ConfigService
                // Assumed MappingConfig entry with sourceType: 'Provisioning', sourceId: application.id, targetType: 'ApplicationEntitlements'
                // Clear cache using the sourceId and targetType for this mapping
                const mappingCacheKey = configService.mappingCacheKey(null, 'Provisioning', 'ApplicationEntitlements', null, application.id); // Mapping key using sourceType, targetType, sourceId
                configService.clearCache(mappingCacheKey);
                appMappingConfig = await configService.loadMappingConfig(null, 'Provisioning', 'ApplicationEntitlements', null, application.id); // Load by sourceType, targetType, sourceId

                // If no specific mapping config, rely on Entitlement.applicationEntitlementId and default adapter logic
                 const entitlementMappings = (appMappingConfig?.mappingRules?.entitlementMappings) || {}; // { iglmEntitlementId: { appEntitlementId: '...', sqlTemplateName: '...', ... } }
                 const userIdentifierMapping = (appMappingConfig?.mappingRules?.userIdentifierMapping) || {}; // { sourceField: '...', targetFormat: '...' }
                 const defaultGrantTemplateName = appMappingConfig?.mappingRules?.defaultGrantTemplateName;
                 const defaultRevokeTemplateName = appMappingConfig?.mappingRules?.defaultRevokeTemplateName;
                 const defaultOperationType = appMappingConfig?.mappingRules?.defaultOperationType; // For adapters like LDAP

                 if (!appMappingConfig) {
                     logger.warn(`App Entitlement Mapping Config not found for Application "${application.name}" (SourceType: Provisioning, SourceId: ${application.id}, TargetType: ApplicationEntitlements). Relying on Entitlement model data and default adapter logic.`, { taskId: taskId, appId: appId });
                 } else {
                      logger.info(`Loaded App Entitlement Mapping Config for Application "${application.name}". Using ${Object.keys(entitlementMappings).length} explicit entitlement mappings.`, { taskId: taskId, appId: appId, mappingId: appMappingConfig.id, mappingsCount: Object.keys(entitlementMappings).length });
                 }


                // Dynamically load the correct Provisioning Connector adapter code
                // Assuming adapters are in ./connectors/provisioning/ and file name matches ConnectorConfig.type
                let connectorModule;
                try {
                     // Use require relative to the current file's directory
                     const adapterModulePath = path.join(__dirname, `./connectors/provisioning/${appConnectorConfig.type}`);
                     connectorModule = require(adapterModulePath); // Fallback to direct require if loader not used
                     // TODO: If using a dedicated adapter loader, use it here and ensure it handles caching/initialization/shutdown registration
                     // connectorModule = await provisioningAdapterLoader.loadAdapter(appConnectorConfig.type, appConnectorConfig.configuration); // Example loader call
                } catch (loaderError) {
                    logger.error(`Failed to load provisioning adapter module "${appConnectorConfig.type}".`, { taskId: taskId, appId: appId, connectorType: appConnectorConfig.type, error: loaderError.message, stack: loaderError.stack });
                    throw new Error(`Failed to load provisioning adapter module "${appConnectorConfig.type}": ${loaderError.message}`); // Re-throw
                }

                // Adapter needs a standard interface like applyDesiredState
                if (!connectorModule || typeof connectorModule.applyDesiredState !== 'function') {
                    logger.error(`Provisioning Connector adapter module "${appConnectorConfig.type}" found but missing applyDesiredState function.`, { taskId: taskId, appId: appId, connectorType: appConnectorConfig.type });
                    throw new Error(`Provisioning Connector adapter module "${appConnectorConfig.type}" found but missing applyDesiredState function.`); // Re-throw
                }
                logger.info(`Loaded provisioning adapter module: "${appConnectorConfig.type}".`, { taskId: taskId, appId: appId, connectorType: appConnectorConfig.type });


                // --- Prepare App-Specific Desired State for the Adapter ---
                // The entitlementsToGrant and entitlementsToRevoke lists are already populated based on task type before this loop

                // Determine the user identifier recognized by the target app using the mapping rule
                 // Pass logger to the helper function
                const userIdFromIglmUser = user ? determineAppUserIdentifier(user, appMappingConfig, logger) : null; // <-- Pass logger, optional chaining for user
                // If this is a REVOKE task for an ORPHANED account, the userIdFromIglmUser will be null.
                // Use the appSpecificUserId provided in the REVOKE task payload instead.
                const finalUserIdInApp = (taskType === 'revoke' && taskPayload.appSpecificUserId) ? String(taskPayload.appSpecificUserId) : userIdFromIglmUser; // Ensure string

                if (finalUserIdInApp === null) {
                     // This is a critical error for this specific application - cannot provision if user ID is unknown
                     const errorMsg = `Cannot determine final user identifier for Application "${application.name}" (ID: ${application.id}) for user ${user?.hrmsId} / task payload (type: ${taskType}).`;
                     logger.error(errorMsg, { taskId: taskId, userId: user?.id, appId: appId, taskType: taskType, taskPayloadUserId: taskPayload.userId, taskPayloadAppUserId: taskPayload.appSpecificUserId });
                     throw new Error(errorMsg); // Re-throw
                }


                 // Map IGLM Entitlements to App-specific entitlements for granting and revoking
                 // The lists entitlementsToGrant and entitlementsToRevoke are already populated based on task type before this loop
                 // Now, map them using the application-specific mapping config (appMappingConfig)
                 const finalAppEntitlementsToGrantForAdapter = [];
                 const finalAppEntitlementsToRevokeForAdapter = [];

                 // --- Map Grants List for Adapter ---
                 if (entitlementsToGrant && Array.isArray(entitlementsToGrant)) {
                     for (const item of entitlementsToGrant) { // items are { iglmEntitlementId, iglmEntitlementName, assignmentType, metadata, applicationId, applicationName, applicationEntitlementId }
                          if (item.applicationId !== application.id) continue; // Ensure we only process entitlements for the current application

                          // Get mapped details from the app mapping config, falling back to defaults
                          const mappedDetails = entitlementMappings[item.iglmEntitlementId] || {};

                          // Get the actual app-specific ID, falling back to the Entitlement model if not in mapping
                          let actualAppEntitlementId = mappedDetails.appEntitlementId;
                          if (!actualAppEntitlementId && item.applicationEntitlementId) { // Fallback to app-specific ID from IGLM Entitlement model
                               actualAppEntitlementId = item.applicationEntitlementId;
                          }

                          if (!actualAppEntitlementId) {
                               logger.warn(`Entitlement "${item.iglmEntitlementName}" (ID: ${item.iglmEntitlementId}) has no appEntitlementId in model or mapping config for App "${application.name}". Skipping grant.`, { taskId: taskId, appId: appId, iglmEntitlementId: item.iglmEntitlementId });
                               applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_success', result: { operations: [] } };
                               applicationProvisioningResults[appId].result.operations.push({
                                   entitlement: item.iglmEntitlementName || 'Unknown Entitlement',
                                   status: 'skipped',
                                   message: 'Missing appEntitlementId in config/model',
                                   iglmEntitlementId: item.iglmEntitlementId
                               });
                               continue; // Skip this entitlement for the adapter call
                          }

                          // Determine the specific SQL template name or operation type for this entitlement grant
                          const specificGrantTemplate = mappedDetails.sqlTemplateName || defaultGrantTemplateName;
                          const specificGrantOperationType = mappedDetails.operationType || defaultOperationType; // Fallback to default op type

                          if (!specificGrantTemplate && !specificGrantOperationType) {
                               logger.warn(`Entitlement "${item.iglmEntitlementName}" (ID: ${item.iglmEntitlementId}, App ID: ${actualAppEntitlementId}) has no grant template/operation type defined in mapping config and no default for App "${application.name}". Skipping grant.`, { taskId: taskId, appId: appId, iglmEntitlementId: item.iglmEntitlementId, appEntitlementId: actualAppEntitlementId });
                               applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_success', result: { operations: [] } };
                               applicationProvisioningResults[appId].result.operations.push({
                                   entitlement: item.iglmEntitlementName || 'Unknown Entitlement',
                                   appEntitlementId: actualAppEntitlementId,
                                   status: 'skipped',
                                   message: 'Missing SQL template/operation type in config',
                                   iglmEntitlementId: item.iglmEntitlementId
                               });
                               continue;
                          }

                          // Construct the object for this specific entitlement grant for the adapter
                          finalAppEntitlementsToGrantForAdapter.push({
                              iglmEntitlementId: item.iglmEntitlementId,
                              iglmEntitlementName: item.iglmEntitlementName,
                              appEntitlementId: actualAppEntitlementId, // The actual ID used by the target app
                              assignmentType: item.assignmentType, // From RoleEntitlementMapping metadata
                              metadata: item.metadata, // From RoleEntitlementMapping metadata
                              mappingDetails: { // Include details from the app mapping config relevant to the adapter
                                   sqlTemplateName: specificGrantTemplate,
                                   operationType: specificGrantOperationType,
                                   // Add any other relevant mapping details needed by the adapter from mappedDetails
                                   ...mappedDetails // Include all mapped details
                              }
                          });
                     } // End loop through entitlementsToGrant
                 }


                 // --- Map Revokes List for Adapter ---
                 if (entitlementsToRevoke && Array.isArray(entitlementsToRevoke)) {
                     for (const item of entitlementsToRevoke) { // items are { iglmEntitlementId?, appSpecificEntitlementId, applicationId, appSpecificUserId?, ...other_context_from_payload }
                          // item.applicationId == application.id check already done when building the map
                          // For revoke tasks, the payload directly provides app-specific IDs.
                          // We still need the mapping config for revoke templates/operations.
                          // Look up mapping details by IGLM Entitlement ID if available, otherwise use app ID
                          const mappedDetails = item.iglmEntitlementId ? (entitlementMappings[item.iglmEntitlementId] || {}) : {};

                          const actualAppEntitlementId = item.appSpecificEntitlementId; // Revoke payload *must* provide the app-specific ID
                          const actualAppSpecificUserId = item.appSpecificUserId; // Revoke payload *must* provide the app-specific User ID


                          if (!actualAppEntitlementId || !actualAppSpecificUserId) { // Check both required revoke identifiers
                               logger.warn(`Revoke item missing required 'appSpecificEntitlementId' or 'appSpecificUserId' in payload for App "${application.name}". Skipping revoke.`, { taskId: taskId, appId: appId, revokeItem: item });
                                applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_failure', result: { operations: [] } }; // Use partial_failure for skipped revokes
                                applicationProvisioningResults[appId].result.operations.push({
                                   entitlement: item.iglmEntitlementName || item.appSpecificEntitlementId || 'Unknown Entitlement',
                                   status: 'skipped',
                                   message: 'Missing appSpecificEntitlementId or appSpecificUserId in payload',
                                   // Don't include the item itself in error details if sensitive
                                });
                               continue;
                          }

                          // Determine the specific SQL template name or operation type for this entitlement revoke
                          // Prioritize revoke-specific template from mapping, then general template, then default revoke, then default grant
                          const specificRevokeTemplate = mappedDetails.revokeSqlTemplateName || mappedDetails.sqlTemplateName || defaultRevokeTemplateName || defaultGrantTemplateName;
                          const specificRevokeOperationType = mappedDetails.revokeOperationType || mappedDetails.operationType || defaultOperationType;


                          if (!specificRevokeTemplate && !specificRevokeOperationType) {
                               logger.warn(`Revoke entitlement (App ID: ${actualAppEntitlementId}) has no revoke template/operation type defined in mapping config and no default for App "${application.name}". Skipping revoke.`, { taskId: taskId, appId: appId, appEntitlementId: actualAppEntitlementId });
                                applicationProvisioningResults[appId] = applicationProvisioningResults[appId] || { status: 'partial_failure', result: { operations: [] } };
                                applicationProvisioningResults[appId].result.operations.push({
                                   appSpecificEntitlementId: actualAppEntitlementId,
                                   entitlement: item.iglmEntitlementName || 'Unknown Entitlement',
                                   status: 'skipped',
                                   message: 'Missing revoke SQL template/operation type in config',
                                   iglmEntitlementId: item.iglmEntitlementId
                                });
                                continue;
                           }

                            // Construct the object for this specific entitlement revoke for the adapter
                           finalAppEntitlementsToRevokeForAdapter.push({
                               iglmEntitlementId: item.iglmEntitlementId, // Might be null
                               iglmEntitlementName: item.iglmEntitlementName, // Might be null
                               appSpecificEntitlementId: actualAppEntitlementId, // Required for revoke
                               applicationId: item.applicationId,
                               appSpecificUserId: actualAppSpecificUserId, // Required for revoke
                               mappingDetails: { // Include details relevant to the adapter
                                    sqlTemplateName: specificRevokeTemplate,
                                    operationType: specificRevokeOperationType,
                                    // Add any other relevant mapping details needed by the adapter from mappedDetails
                                    ...mappedDetails // Include all mapped details
                               },
                               // Include any other context from the original revoke payload item needed by the adapter
                               context: { ...item } // Store the full item as context for adapter
                           });
                        } // End loop through entitlementsToRevoke
                    }


                    // Pass both grant and revoke lists to the adapter
                 const appSpecificDesiredState = {
                      userIdInApp: finalUserIdInApp, // The user identifier for this app (could be derived or from revoke payload)
                      entitlementsToGrant: finalAppEntitlementsToGrantForAdapter, // Filtered list of entitlements to grant
                      entitlementsToRevoke: finalAppEntitlementsToRevokeForAdapter // List of entitlements to revoke
                 };

                  // Log the state being sent to the adapter
                  logger.info(`Prepared app-specific desired state for Application "${application.name}"`, {
                      taskId: taskId,
                      userId: user?.id || task?.userId, // Use user ID if loaded, fallback to task ID
                        userHrmsId: user?.hrmsId || null,
                      userIdInApp: appSpecificDesiredState.userIdInApp,
                      appName: application.name,
                      grantsCount: appSpecificDesiredState.entitlementsToGrant.length,
                      revokesCount: appSpecificDesiredState.entitlementsToRevoke.length,
                      // Log samples of specific IDs being sent, but be mindful of log verbosity
                      // grantAppEntitlementIds: appSpecificDesiredState.entitlementsToGrant.map(e => e.appEntitlementId),
                      // revokeAppEntitlementIds: appSpecificDesiredState.entitlementsToRevoke.map(e => e.appEntitlementId)
                  });

                  // Call the connector adapter's primary method (applyDesiredState)
                  // Pass the connector config.configuration (connection details etc.) and the prepared app-specific desired state
                  adapterCallResult = await connectorModule.applyDesiredState(appConnectorConfig.configuration, appSpecificDesiredState);
                  logger.info(`Adapter call complete for Application "${application.name}". Result summary:`, { taskId: taskId, appId: appId, appName: application.name, success: adapterCallResult?.success, totalOps: adapterCallResult?.operations?.length, failedOps: adapterCallResult?.operations?.filter(op => op.status === 'failed').length });

                  // We'll store the adapter's full result in the applicationProvisioningResults for the task log
                  applicationProvisioningResults[appId] = { status: adapterCallResult?.success ? 'success' : 'failed', result: adapterCallResult };

                  // If the adapter reported overall failure or any individual operation failed, mark overall task as failed
                  if (!adapterCallResult?.success || (adapterCallResult?.operations && adapterCallResult.operations.some(op => op.status === 'failed'))) {
                       allApplicationsSucceeded = false; // Mark overall task as failed
                       // Aggregate individual operation errors from the adapter result if any
                       if (adapterCallResult?.operations?.some(op => op.status === 'failed')) {
                            errorsPerApplication[appId] = errorsPerApplication[appId] || { message: `Some operations failed for ${application.name}.`, operations: [] };
                            errorsPerApplication[appId].operations.push(...adapterCallResult.operations.filter(op => op.status === 'failed').map(op => ({
                                entitlement: op.entitlement, appEntitlementId: op.appEntitlementId, status: op.status, message: op.message, error: op.error
                            })));
                       } else if (!adapterCallResult?.success) {
                            // Adapter reported overall failure but no operation details
                            errorsPerApplication[appId] = errorsPerApplication[appId] || { message: `Adapter reported overall failure for ${application.name}, no operation details.` };
                        }

                  }


             } catch (appProvisioningError) {
                  // Catch errors during config/mapping loading, adapter loading, user ID mapping, or the adapter call itself (if not caught by adapter's try/catch)
                  logger.error(`Critical error provisioning Application "${application.name}" (ID: ${appId}) for user ${user?.hrmsId || task?.userId || 'N/A'}.`, { taskId: taskId, userId: user?.id, appId: appId, error: appProvisioningError.message, stack: appProvisioningError.stack }); // Log user ID from task if user object is null
                  applicationProvisioningResults[appId] = { status: 'failed', error: { message: appProvisioningError.message, stack: appProvisioningError.stack } };
                  errorsPerApplication[appId] = { message: appProvisioningError.message, stack: appProvisioningError.stack }; // Store error details
                  allApplicationsSucceeded = false; // Mark overall task as failed if any app fails
             }
         } // End loop through applicationsToProcessMap


         // --- Finalize Task Status and Reporting ---
         overallTaskStatus = allApplicationsSucceeded ? 'completed' : 'failed';

         // 4. Update the ProvisioningTask entry (status, end time, results, errors).
         // Reload the task first to ensure we have the latest version in case its status was updated concurrently (e.g., cancellation)
         const taskToUpdate = await ProvisioningTask.findByPk(taskId);
          if (taskToUpdate) {
              // Only update status if it's still in_progress or pending/retrying (prevents overwriting externally set 'cancelled')
              if (taskToUpdate.status === 'in_progress' || taskToUpdate.status === 'pending' || taskToUpdate.status === 'retrying') {
                  // Ensure errorDetails and results objects exist before spreading
                  const currentErrorDetails = taskToUpdate.errorDetails || {};
                  const currentResults = taskToUpdate.results || {};

                  await taskToUpdate.update({
                      status: overallTaskStatus, // 'completed' or 'failed'
                      endTime: new Date(),
                      results: applicationProvisioningResults, // Store results per application
                      errorDetails: errorsPerApplication // Store collected errors per application
                  });
                  logger.info(`Task ${taskId} status updated to '${overallTaskStatus}'.`, { taskId: taskId, status: overallTaskStatus });

              } else {
                   logger.warn(`Task ${taskId} status was changed externally to '${taskToUpdate.status}'. Skipping final status update.`);
                   // TODO: Log this event (e.g., task was cancelled while processing)
              }
          } else {
               console.error(`CRITICAL ERROR: Task ${taskId} not found in DB when trying to finalize.`);
               // TODO: Implement alerting for this critical failure (task record disappeared).
          }


         // 5. Publish status updates to the Message Queue
         // This allows other services or a monitoring system to react to task completion/failure
         // Publish using the *final* determined status
         const taskCompletedEventPayload = {
             taskId: taskId,
             userId: taskToUpdate?.userId || null, // IGLM User ID from updated task record (more reliable)
             // userHrmsId: user?.hrmsId || null, // If user object available earlier, could include HRMS ID
             applicationId: taskToUpdate?.applicationId || null, // Include Application ID if known
             status: overallTaskStatus, // Use the determined overall status ('completed' or 'failed')
             results: applicationProvisioningResults, // Include detailed results
             errorDetails: errorsPerApplication, // Include detailed errors
             timestamp: new Date(),
             correlationId: taskToUpdate?.metadata?.correlationId || null // Pass correlation ID from task metadata
         };
         // Publish to a topic like 'provisioning.task.completed' or 'provisioning.task.failed'
          // A single topic with status in the routing key is flexible: provisioning.task.<status>
          const routingKey = `task.${overallTaskStatus}`; // e.g., task.completed, task.failed
         // MqService.publish is resilient and waits for the channel internally
         await mqService.publish('provisioning.task.status', routingKey, taskCompletedEventPayload).catch(mqErr => logger.error(`Failed to publish 'provisioning.task.status' MQ event for task ${taskId}:`, mqErr));
         logger.info(`Published 'provisioning.task.status' event with routing key '${routingKey}' for task ${taskId}.`, { taskId, routingKey: routingKey });


     } catch (processError) {
         // Catch any uncaught errors that occur during the entire task processing logic *before* the finalization step
         // These are errors that crashed the processing *outside* of the expected error handling within the loop.
         logger.error(`Uncaught error during task processing for task ${taskId || 'N/A'}. Attempting to mark task failed.`, { taskId: taskId || 'N/A', error: processError.message, stack: processError.stack });

         // Attempt to update task status to failed due to uncaught error
         try {
              // Reload the task first to ensure we don't overwrite a cancellation
              const taskToUpdate = await ProvisioningTask.findByPk(taskId);
              const uncaughtErrorDetails = { message: processError.message, stack: processError.stack };

              // Only update status if it's still in a processing state or pending/retrying
              if (taskToUpdate && (taskToUpdate.status === 'in_progress' || taskToUpdate.status === 'pending' || taskToUpdate.status === 'retrying')) {
                  // Ensure errorDetails and results objects exist before spreading
                  const currentErrorDetails = taskToUpdate.errorDetails || {};
                  const currentResults = taskToUpdate.results || {};

                  await taskToUpdate.update({
                      status: 'failed', // Mark as failed due to uncaught error
                      endTime: new Date(),
                      errorDetails: { ...currentErrorDetails, uncaught: uncaughtErrorDetails }, // Include any collected errors + uncaught error
                      results: currentResults // Include any results collected before error
                  });
                  logger.warn(`Task ${taskId} status updated to 'failed' due to uncaught error.`);

                   // Also publish a failed status event
                   const failedEventPayload = {
                       taskId: taskId,
                       userId: taskToUpdate.userId, // Use user ID from task record
                       status: 'failed',
                       results: currentResults,
                       errorDetails: { ...currentErrorDetails, uncaught: uncaughtErrorDetails },
                       timestamp: new Date(),
                        correlationId: taskToUpdate.metadata?.correlationId || null // Pass correlation ID from task metadata
                   };
                   // MqService.publish is resilient and waits for the channel internally
                   await mqService.publish('provisioning.task.status', 'task.failed', failedEventPayload).catch(mqErr => logger.error(`Failed to publish 'task.failed' MQ event for task ${taskId}:`, mqErr));
                   logger.info(`Published 'provisioning.task.status' event with routing key 'task.failed' for task ${taskId} after uncaught error.`, { taskId });

              } else if (taskToUpdate) {
                  logger.warn(`Task ${taskId} status was changed externally to '${taskToUpdate.status}' before uncaught error handling.`);
                  // TODO: Log this event (e.g., task was cancelled while processing)
              } else {
                   logger.error(`CRITICAL ERROR: Task ${taskId} not found in DB when trying to mark failed after uncaught error.`);
                   // This is a severe issue - task vanished. Need external monitoring/alerting.
              }
         } catch (updateErr) {
              logger.error(`CRITICAL ERROR: failed to update task ${taskId} status and publish event after uncaught error:`, updateErr);
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
       logger.info(`Task processing for ${taskId || 'N/A'} completed final cleanup.`, { taskId: taskId || 'N/A' }); // Log task ID if known
    }
}

/**
 * Helper function to publish a task status event to the message queue.
 * Encapsulates the MQ publish call details.
 */
async function publishTaskStatusEvent(taskId, status, errorDetails, results, userId, userHrmsId, mqService, logger) {
    const eventPayload = {
        taskId: taskId,
        userId: userId,
        userHrmsId: userHrmsId,
        status: status, // 'completed', 'failed', etc.
        results: results, // Details of results per application
        errorDetails: errorDetails, // Details of errors per application/operation
        timestamp: new Date()
    };
    // Publish to a topic like 'provisioning.task.status' with status in the routing key
    const routingKey = `task.${status}`; // e.g., task.completed, task.failed

    // MqService.publish is resilient and waits for the channel internally
    await mqService.publish('provisioning.task.status', routingKey, eventPayload);
    // Logger is passed in options
    logger.info(`Published 'provisioning.task.status' event with routing key '${routingKey}' for task ${taskId}.`, { taskId: taskId, routingKey: routingKey });
}


// Placeholder for a shutdown method if ProvisioningLogic manages connection pools
// This method would be called by the server during graceful shutdown.
const shutdown = async () => {
    const serviceName = 'provisioning-service'; // Or get from logger default meta
    logger.info(`${serviceName}: ProvisioningLogic shutdown initiated.`);
    // TODO: Implement logic here to close any active connection pools or resources managed by ProvisioningLogic or its adapters.
    // This might involve iterating through loaded adapters or a dedicated manager.
    // Example: if (adapterPoolManager) { await adapterPoolManager.closeAllPools(); }
    logger.info(`${serviceName}: ProvisioningLogic shutdown complete.`);
};


// Export the main worker function and the shutdown method
module.exports = {
    processProvisioningTask, // Export the main worker function
    determineAppUserIdentifier, // Export if needed for unit testing
    shutdown, // Export the shutdown method for server graceful shutdown
};