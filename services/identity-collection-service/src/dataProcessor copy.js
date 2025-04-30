// services/identity-collection-service/src/dataProcessor.js

// The models and mqService will be passed into the processDeltas function via options
// The logger will also be passed as a dependency.

/**
 * List of actual column names in the IGLM User model, excluding DB-managed ones like id, createdAt, updatedAt.
 * This list is used to filter the mapped attributes to ensure only valid fields are set on the User object.
 * KEEP THIS LIST IN SYNC WITH YOUR User MODEL AND MIGRATION.
 * Note: 'id', 'createdAt', 'updatedAt' are typically managed by Sequelize/DB and should not be in this list for mapping incoming data.
 */
const userModelAttributes = [
    'hrmsId', 'firstName', 'middleName', 'lastName', 'email', 'mobileNumber',
    'status', 'hireDate', 'exitDate', 'supervisorId', 'headOfOfficeId',
    'jobTitle', 'departmentId', 'departmentName', 'divisionId', 'divisionName',
    'officeId', 'officeName', 'gradeId', 'grade', 'partyId', 'jobStatus',
    'jobLocationId', 'jobLocation', 'location',
    'metadata' // metadata JSONB field
];

/**
 * Performs a simple deep equality check for objects and arrays.
 * Useful for comparing JSONB fields like metadata.
 * NOTE: This is a basic implementation. May not handle all complex cases (e.g., circular references, specific object types).
 *
 * @param {*} obj1 - The first object/value to compare.
 * @param {*} obj2 - The second object/value to compare.
 * @returns {boolean} True if deeply equal, false otherwise.
 */
function deepEqual(obj1, obj2) {
    // Strict equality first (handles primitives, null, undefined)
    if (obj1 === obj2) {
        return true;
    }

    // Check if both are objects (and not null)
    if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
        return false;
    }

    // Check if they are arrays and compare elements
    if (Array.isArray(obj1) && Array.isArray(obj2)) {
        if (obj1.length !== obj2.length) {
            return false;
        }
        for (let i = 0; i < obj1.length; i++) {
            if (!deepEqual(obj1[i], obj2[i])) {
                return false;
            }
        }
        return true;
    }

    // Check if they are objects and compare properties
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);

    if (keys1.length !== keys2.length) {
        return false;
    }

    for (const key of keys1) {
        if (!Object.prototype.hasOwnProperty.call(obj2, key) || !deepEqual(obj1[key], obj2[key])) {
            return false;
        }
    }

    return true;
}


/**
 * Applies mapping rules to a raw HRMS record and transforms it into the IGLM User model format.
 * Handles attribute mapping, status mapping, and metadata mapping.
 * Validates presence of the unique identifier field.
 *
 * @param {object} rawRecord - A single record object from the HRMS data pull.
 * @param {object} mappingRules - The mappingRules JSONB object from the MappingConfig.
 * @param {string} sourceUniqueIdField - The name of the unique ID field in the raw HRMS data (e.g., 'employee_id').
 * @param {object} logger - Logger instance.
 * @returns {object|null} An object formatted according to the IGLM User model structure,
 * or null if a critical mapping fails (e.g., unique ID missing or invalid).
 */
function applyMapping(rawRecord, mappingRules, sourceUniqueIdField, logger) { // <-- Accept logger
    logger.debug("[DataProcessor] Applying mapping...");

    const iglmUser = {
        metadata: {} // Initialize metadata as an empty object
    };

    // Ensure mappingRules is valid
    if (!mappingRules || typeof mappingRules !== 'object') {
        logger.error("[DataProcessor] Mapping Error: Invalid or null mappingRules provided."); // <-- Use logger
        return null; // Cannot map without rules
    }
    // Ensure raw record is valid
    if (!rawRecord || typeof rawRecord !== 'object') {
        logger.error("[DataProcessor] Mapping Error: Invalid or null rawRecord provided."); // <-- Use logger
        return null; // Cannot map null/invalid record
    }


    const attrMaps = mappingRules.attributeMappings || {};
    const statusMap = mappingRules.statusMapping || {};
    const metaMaps = mappingRules.metadataMapping || {};
    // statusHrmsField is used to get the raw value for status mapping lookup
    const statusHrmsField = mappingRules.metadata?.statusSourceField || 'job_status'; // Use sourceStatusField from metadata


    // --- Find the target attribute name for the unique ID ---
    // This is primarily for validation; the actual value mapping happens below for hrmsId
    let uniqueIdTargetAttribute = null;
    for (const targetKey in attrMaps) {
        if (attrMaps[targetKey] === sourceUniqueIdField) {
            uniqueIdTargetAttribute = targetKey;
            break;
        }
    }

    // CRITICAL VALIDATION: Ensure the unique source ID maps to a target attribute
    // And ensure the sourceUniqueIdField is provided
    if (!sourceUniqueIdField || !uniqueIdTargetAttribute) { // <-- Added check for sourceUniqueIdField presence
        logger.error(`[DataProcessor] Mapping Error: Critical mapping configuration missing. sourceUniqueIdField ("${sourceUniqueIdField}") is not defined or not found as a value in attributeMappings.`); // <-- Use logger
        return null;
    }


    // --- Apply Attribute Mappings (and filter to valid model attributes) ---
    for (const iglmKey in attrMaps) {
        const hrmsKey = attrMaps[iglmKey];

        // Check if the target key is a valid attribute name in our User model
        if (!userModelAttributes.includes(iglmKey)) {
            logger.warn(`[DataProcessor] Mapping Warning: Skipping mapping for unknown IGLM User attribute "${iglmKey}". Not found in userModelAttributes list.`, { iglmKey, hrmsKey }); // <-- Use logger, add context
            continue; // Skip this mapping if the target attribute doesn't exist
        }

        // Check if the raw HRMS record has the source key
        if (rawRecord.hasOwnProperty(hrmsKey)) {
            let rawValue = rawRecord[hrmsKey];

            // Handle specific type conversions/validations
            if (['hireDate', 'exitDate'].includes(iglmKey) && rawValue !== null) {
                 // Attempt to parse dates robustly
                 const dateValue = (rawValue instanceof Date && !isNaN(rawValue)) ? rawValue : (rawValue !== null && rawValue !== undefined && rawValue !== '') ? new Date(rawValue) : null; // Added checks for null/empty before new Date

                // Check if date conversion resulted in a valid date, or if original was null/empty
                if (dateValue === null || (dateValue instanceof Date && !isNaN(dateValue.getTime()))) {
                    iglmUser[iglmKey] = dateValue; // Assign the Date object or null
                } else {
                    logger.warn(`[DataProcessor] Mapping Warning: Invalid date value "${rawValue}" for HRMS field "${hrmsKey}" mapped to "${iglmKey}". Setting to null.`); // <-- Use logger
                    iglmUser[iglmKey] = null; // Set to null if date is invalid
                }
            } else {
                 // Assign value directly for other types (strings, numbers, booleans, null, etc.)
                 iglmUser[iglmKey] = rawValue;
            }
        } else {
            // If HRMS field is missing, set corresponding IGLM field to null
            iglmUser[iglmKey] = null; // Explicitly set to null if source is missing
             // logger.debug(`[DataProcessor] Mapping Debug: HRMS field "${hrmsKey}" not found in raw record for mapping to "${iglmKey}". Setting to null.`); // Optional debug
        }
    }

    // --- Apply Status Mapping ---
    const rawStatusValue = rawRecord.hasOwnProperty(statusHrmsField) ? rawRecord[statusHrmsField] : null;

    // Utility function to normalize HRMS status values
    // Defined inside applyMapping as it uses statusMap from this scope
    function normalizeStatus(rawStatus, statusMap, logger) { // <-- Accept logger
        if (rawStatus === null || rawStatus === undefined || String(rawStatus).trim() === '') { // Check for empty string status
            logger.debug('[DataProcessor] normalizeStatus: Raw status is null/undefined/empty. Defaulting to "unknown".'); // <-- Use logger
            return 'unknown'; // Handle null/undefined/empty raw status
        }

        const cleanedStatus = String(rawStatus).trim(); // Ensure it's a string before trimming
        // Check for direct match first (case-sensitive)
        if (statusMap.hasOwnProperty(cleanedStatus)) {
             logger.debug(`[DataProcessor] normalizeStatus: Matched raw status "${rawStatus}" to IGLM status "${statusMap[cleanedStatus]}".`); // <-- Use logger
            return statusMap[cleanedStatus];
        }
        // Optional: Check case-insensitive matches if needed - ensure statusMap keys are strings
        // for(const key in statusMap) {
        //     if (String(key).toLowerCase() === cleanedStatus.toLowerCase()) {
        //          logger.debug(`[DataProcessor] normalizeStatus: Matched raw status "${rawStatus}" case-insensitively to "${key}", mapped to "${statusMap[key]}".`); // <-- Use logger
        //          return statusMap[key];
        //     }
        // }

        logger.warn(`[DataProcessor] normalizeStatus: No mapping found for raw status value "${rawStatus}". Defaulting to "unknown".`); // <-- Use logger
        return 'unknown'; // Default if no mapping found
    }

    // Apply normalization and mapping
    if (rawStatusValue !== null && rawStatusValue !== undefined) { // Check explicitly for null/undefined
        const mappedStatus = normalizeStatus(rawStatusValue, statusMap, logger); // <-- Pass logger
        iglmUser.status = mappedStatus;

        if (mappedStatus === 'unknown') {
            logger.warn(`[DataProcessor] Mapping Warning: HRMS status value "${rawStatusValue}" for source field "${statusHrmsField}" not found in statusMapping. Setting IGLM status to 'unknown'.`, { rawStatus: rawStatusValue, statusHrmsField: statusHrmsField }); // <-- Use logger
        }
    } else {
        iglmUser.status = 'unknown';
        logger.warn(`[DataProcessor] Mapping Warning: HRMS status field "${statusHrmsField}" not found or is null/undefined in raw record. Setting IGLM status to 'unknown'.`); // <-- Use logger
    }

    // --- Apply Metadata Mappings ---
    // Metadata is populated into the 'metadata' key of the iglmUser object, which is a JSONB column
    iglmUser.metadata = {}; // Ensure metadata is always initialized as an object (redundant but safe)

    for (const metaKey in metaMaps) {
        const hrmsKey = metaMaps[metaKey];
        if (rawRecord.hasOwnProperty(hrmsKey)) { // Check if the raw HRMS record has the source key
            const rawValue = rawRecord[hrmsKey];
            // Store the raw value directly in the metadata JSONB
            // Decide if you want to include nulls in metadata or omit them. Including is safer for preserving source data shape.
             iglmUser.metadata[metaKey] = rawValue; // Include nulls

        } else {
            // If HRMS field is missing for metadata mapping, include it as null in metadata
            iglmUser.metadata[metaKey] = null; // Include missing fields as null in metadata
             // logger.debug(`[DataProcessor] Mapping Debug: HRMS field "${hrmsKey}" not found in raw record for metadata mapping to "${metaKey}". Setting to null in metadata.`); // Optional debug
        }
    }

    // Ensure metadata is a valid JSONB object even if no mappings exist or source fields were missing
    // This check is needed if metadataMapping was empty or all source fields were missing
    if (typeof iglmUser.metadata !== 'object' || iglmUser.metadata === null) {
        iglmUser.metadata = {};
    }


    // --- CRITICAL VALIDATION: Ensure the unique ID value is present in the raw data ---
    // Get the actual value from the raw record using the source field name defined in mappingRules.metadata
    const uniqueIdValue = rawRecord.hasOwnProperty(sourceUniqueIdField) ? rawRecord[sourceUniqueIdField] : null;

    if (uniqueIdValue === null || uniqueIdValue === undefined || String(uniqueIdValue).trim() === '') { // Check for null, undefined, and empty string after trim
        logger.error( // <-- Use logger
            `[DataProcessor] Mapping Error: Raw HRMS record missing required unique ID value for source field "${sourceUniqueIdField}". ` +
            `Cannot map record. Record snippet: ${JSON.stringify(rawRecord).substring(0, 200)}...`
        );
        return null; // Critical failure: cannot map a record without its unique ID
    }

    // Set the hrmsId attribute on the IGLM User object using the value found and the target attribute name
    // This assumes sourceUniqueIdField ALWAYS maps to the 'hrmsId' attribute in the IGLM User model.
    // Based on your mapping structure ("hrmsId": "employee_id"), sourceUniqueIdField "employee_id" points to target "hrmsId".
    // So, we can directly assign the uniqueIdValue to iglmUser.hrmsId.
    iglmUser.hrmsId = String(uniqueIdValue).trim(); // Ensure hrmsId is a string and trim whitespace

    // At this point, iglmUser contains all mapped attributes (filtered to model columns),
    // the determined status, the metadata object, and the validated hrmsId.

    logger.debug(`[DataProcessor] Mapped record (HRMS ID: ${iglmUser.hrmsId}):`, iglmUser); // <-- Use logger
    return iglmUser; // Return the final mapped object
}


/**
 * Processes the detected deltas (Joiners, Movers, Leavers).
 * Applies mapping, updates the database, and publishes MQ events.
 *
 * @param {{joiners: Array<object>, movers: Array<object>, leavers: Array<object>}} deltas - Object containing delta records (raw HRMS data).
 * @param {object} mappingRules - The mappingRules JSONB object from the MappingConfig.
 * @param {object} models - Sequelize models object ({ User, ... }).
 * @param {object} mqService - The initialized MqService instance.
 * @param {object} logger - Logger instance.
 * @returns {Promise<void>} Resolves when all deltas are processed.
 * @throws {Error} If critical setup issues occur (invalid mappingRules).
 */
async function processDeltas(deltas, mappingRules, models, mqService, logger) { // <-- Accept logger
    logger.info("[DataProcessor] Starting delta processing..."); // <-- Use logger
    const { User } = models; // Destructure User model

    // Ensure mappingRules is valid and contains essential metadata for processing
    if (!mappingRules || typeof mappingRules !== 'object' || !mappingRules.metadata || !mappingRules.metadata.sourceUniqueIdField || !mappingRules.attributeMappings || !mappingRules.statusMapping) { // Added check for statusMapping
        logger.error("[DataProcessor] Invalid or incomplete mappingRules provided. Missing metadata, sourceUniqueIdField, attributeMappings, or statusMapping."); // <-- Use logger
        throw new Error("Invalid or incomplete mappingRules provided to DataProcessor.");
    }
    const sourceUniqueIdField = mappingRules.metadata.sourceUniqueIdField; // Get the unique ID field name from source data


    // 1. Process Joiners
    logger.info(`[DataProcessor] Processing ${deltas.joiners.length} Joiners...`); // <-- Use logger
    for (const rawJoiner of deltas.joiners) {
        // Get unique ID from raw data for logging context if possible
        const joinerHrmsId = (rawJoiner && typeof rawJoiner === 'object' && rawJoiner.hasOwnProperty(sourceUniqueIdField)) ? String(rawJoiner[sourceUniqueIdField]).trim() : 'N/A (Missing ID)'; // <-- Ensure string and trim
        logger.debug(`[DataProcessor] Attempting to process raw Joiner record with HRMS ID: ${joinerHrmsId}`); // <-- Use logger

        try {
            // Apply mapping to transform raw data
            // Pass sourceUniqueIdField and logger to applyMapping
            const iglmUserData = applyMapping(rawJoiner, mappingRules, sourceUniqueIdField, logger); // <-- Pass logger

            // Check if mapping was successful and produced a valid object with hrmsId
            if (!iglmUserData || !iglmUserData.hrmsId) {
                // applyMapping already logged the specific reason for failure
                logger.error(`[DataProcessor] Skipping processing of Joiner record due to mapping failure (Raw HRMS ID: ${joinerHrmsId}).`); // <-- Use logger
                // TODO: Log specific record processing failure to a dedicated error log table or system
                continue; // Skip this record if mapping failed
            }

            logger.debug(`[DataProcessor] Mapped Joiner data: HRMS ID ${iglmUserData.hrmsId}`, iglmUserData); // <-- Use logger

            // Create new User in our database
            // Use findOrCreate here to handle potential race conditions or retries, keyed by hrmsId
            const [newUser, created] = await User.findOrCreate({
                where: { hrmsId: iglmUserData.hrmsId }, // Look up by HRMS ID
                defaults: iglmUserData // Data to use if creating
            });

            if (created) {
                logger.info(`[DataProcessor] Created new User in DB: ID ${newUser.id}, HRMS ID ${newUser.hrmsId}`); // <-- Use logger

                // Publish Joiner event to MQ ONLY if the user was actually created
                const joinerEventPayload = {
                    userId: newUser.id,
                    hrmsId: newUser.hrmsId,
                    userData: newUser.toJSON(), // Send the created IGLM User object
                    timestamp: new Date(),
                    eventType: 'identity.joiner.new' // Use a standard event type key
                };
                // mqService.publish is resilient and waits for the channel internally
                await mqService.publish('identity.changes', 'joiner.new', joinerEventPayload).catch(publishErr => {
                     // Log publish errors specifically, but don't re-throw to avoid blocking delta processing
                     logger.error(`[DataProcessor] Error publishing 'joiner.new' event for User ID ${newUser.id} (HRMS ID: ${newUser.hrmsId}):`, publishErr); // <-- Use logger, add hrmsId
                     // TODO: Handle MQ publish failure - retry? Store and retry later? Alert?
                });
                logger.info(`[DataProcessor] Published 'joiner.new' event for User ID ${newUser.id} (HRMS ID: ${newUser.hrmsId})`); // <-- Use logger, add hrmsId

            } else {
                // If not created, it means a User with this hrmsId already exists.
                // This could indicate a Mover that was processed as a Joiner or data inconsistency.
                // If the status is different from the HRMS data, it's a potential mover.
                // Let's fetch the existing user to compare status if this happens
                 const existingUser = await User.findOne({ where: { hrmsId: iglmUserData.hrmsId } }); // Fetch the user that already exists
                 if(existingUser) { // Ensure existing user was found (should be, since findOrCreate didn't create)
                      if(existingUser.status !== iglmUserData.status) {
                           logger.warn(`[DataProcessor] Joiner detected for HRMS ID ${iglmUserData.hrmsId} but User already exists with different status (${existingUser.status} -> ${iglmUserData.status}). Treating as Mover/Update.`, { hrmsId: iglmUserData.hrmsId, oldStatus: existingUser.status, newStatus: iglmUserData.status, userId: existingUser.id }); // <-- Use logger, add user id
                           // TODO: Instead of skipping, potentially process this as a Mover event here,
                           // or rely on the next run's Mover detection to pick it up. Relying on the next run is simpler.
                      } else {
                           logger.warn(`[DataProcessor] Joiner detected for HRMS ID ${iglmUserData.hrmsId} but User already exists in DB with same status. Possible data inconsistency or duplicate event.`, { hrmsId: iglmUserData.hrmsId, status: existingUser.status, userId: existingUser.id }); // <-- Use logger, add user id
                      }
                 } else {
                      // This scenario shouldn't happen with findOrCreate logic if 'created' is false, but log as a safeguard.
                      logger.error(`[DataProcessor] findOrCreate for Joiner HRMS ID ${iglmUserData.hrmsId} reported 'created' false, but user not found in subsequent lookup. Potential race condition or DB issue.`); // <-- Use logger
                 }
                // TODO: Log this inconsistency more formally.
            }

        } catch (error) {
            logger.error(`[DataProcessor] Error processing Joiner HRMS ID ${joinerHrmsId}:`, error); // <-- Use logger
            // TODO: Log this specific error to a dedicated processing error log table or system
        }
    }

    // 2. Process Movers
    logger.info(`[DataProcessor] Processing ${deltas.movers.length} Movers...`); // <-- Use logger
    for (const rawMover of deltas.movers) {
        const moverHrmsId = (rawMover && typeof rawMover === 'object' && rawMover.hasOwnProperty(sourceUniqueIdField)) ? String(rawMover[sourceUniqueIdField]).trim() : 'N/A (Missing ID)'; // <-- Ensure string and trim
        logger.debug(`[DataProcessor] Attempting to process raw Mover record with HRMS ID: ${moverHrmsId}`); // <-- Use logger

        try {
            // Apply mapping to transform raw data
            // Pass sourceUniqueIdField and logger to applyMapping
            const iglmUserData = applyMapping(rawMover, mappingRules, sourceUniqueIdField, logger); // <-- Pass logger

            if (!iglmUserData || !iglmUserData.hrmsId) {
                // applyMapping already logged the specific reason
                logger.error(`[DataProcessor] Skipping processing of Mover record due to mapping failure (Raw HRMS ID: ${moverHrmsId}).`); // <-- Use logger
                // TODO: Log specific record processing failure
                continue; // Skip this record if mapping failed
            }
            logger.debug(`[DataProcessor] Mapped Mover data: HRMS ID ${iglmUserData.hrmsId}`, iglmUserData); // <-- Use logger

            // Find existing User in our database by HRMS ID
            const existingUser = await User.findOne({ where: { hrmsId: iglmUserData.hrmsId } });

            if (!existingUser) {
                // This is a critical inconsistency: Mover detected (exists in both snapshots but data differs), but User not in our DB.
                logger.error(`[DataProcessor] CRITICAL INCONSISTENCY: Mover detected for HRMS ID ${iglmUserData.hrmsId} but no existing User found in DB. Cannot update.`, { hrmsId: iglmUserData.hrmsId }); // <-- Use logger
                // TODO: Log this critical inconsistency, potentially alert, maybe trigger a Joiner process?
                continue; // Skip processing this mover
            }

            // Compare existing user data with mapped incoming data to identify changed attributes
            const changes = {};
            const fieldsToCompare = userModelAttributes.filter(attr => attr !== 'metadata'); // Compare direct attributes

            for (const field of fieldsToCompare) {
                 const incomingValue = iglmUserData[field];
                 const currentValue = existingUser[field]; // Get value from the existing DB model instance

                // Compare values. Special handling for dates and potential nulls/undefined.
                 if (field === 'hireDate' || field === 'exitDate') {
                      // Compare Date objects by timestamp, handling nulls
                      const incomingTimestamp = incomingValue instanceof Date ? incomingValue.getTime() : null;
                      const currentTimestamp = currentValue instanceof Date ? currentValue.getTime() : null;
                      if (incomingTimestamp !== currentTimestamp) {
                           changes[field] = { from: currentValue, to: incomingValue };
                      }
                 } else if (field === 'metadata') {
                      // Metadata is handled separately below with deepEqual
                      continue; // Skip metadata here
                 }
                 else {
                     // Simple equality comparison for other types. Handle null/undefined vs empty string consistently if needed,
                     // but direct comparison is often sufficient if data types are consistent.
                      if (incomingValue !== currentValue) {
                         changes[field] = { from: currentValue, to: incomingValue };
                      }
                 }
            }

            // Check if metadata JSONB changed using deep comparison
             // Both existingUser.metadata and iglmUserData.metadata should be objects or null
             const existingMetadata = existingUser.metadata || {}; // Treat null as empty object for comparison
             const incomingMetadata = iglmUserData.metadata || {}; // Treat null as empty object for comparison

             if (!deepEqual(existingMetadata, incomingMetadata)) { // <-- Use deepEqual helper
                 changes.metadata = { from: existingUser.metadata, to: iglmUserData.metadata }; // Store original/new values
                 logger.debug(`[DataProcessor] Detected metadata changes for User ID ${existingUser.id}.`); // <-- Use logger
             }


            // Only update and publish if actual changes were detected *after* mapping
            if (Object.keys(changes).length > 0) {
                logger.info(`[DataProcessor] Detected changes for User ID ${existingUser.id} (HRMS ID ${existingUser.hrmsId}):`, changes); // <-- Use logger

                // Update existing User in our database
                // Pass the mapped data. Sequelize will only update fields present in the object.
                // Note: This updates ALL changed mapped fields, including status.
                const [updateCount, updatedUsers] = await User.update(iglmUserData, { // Use mapped data for update payload
                    where: { id: existingUser.id }, // Update by internal ID
                    returning: true // Return the updated user instance(s)
                });

                if (updateCount > 0 && updatedUsers && updatedUsers[0]) {
                    const updatedUser = updatedUsers[0];
                    logger.info(`[DataProcessor] Updated User in DB: ID ${updatedUser.id}, HRMS ID ${updatedUser.hrmsId}`); // <-- Use logger

                    // Publish Mover event to MQ
                    const moverEventPayload = {
                        userId: updatedUser.id,
                        hrmsId: updatedUser.hrmsId,
                        userData: updatedUser.toJSON(), // Send the updated IGLM User object
                         changes: changes, // Include the identified changes in the event payload
                        timestamp: new Date(),
                        eventType: 'identity.mover.update' // Specific event type
                    };
                    // mqService.publish is resilient and waits for the channel internally
                    await mqService.publish('identity.changes', 'mover.update', moverEventPayload).catch(publishErr => {
                         // Log publish errors specifically
                         logger.error(`[DataProcessor] Error publishing 'mover.update' event for User ID ${updatedUser.id} (HRMS ID: ${updatedUser.hrmsId}):`, publishErr); // <-- Use logger, add hrmsId
                         // TODO: Handle MQ publish failure - retry? Store and retry later? Alert?
                    });
                    logger.info(`[DataProcessor] Published 'mover.update' event for User ID ${updatedUser.id} (HRMS ID: ${updatedUser.hrmsId})`); // <-- Use logger, add hrmsId

                } else {
                    // This is unexpected if existingUser was found - indicates update failed or user disappeared concurrently.
                    logger.error(`[DataProcessor] CRITICAL ERROR: Failed to update User in DB for HRMS ID ${iglmUserData.hrmsId}. Update count was 0 after finding user.`, { hrmsId: iglmUserData.hrmsId, existingUserId: existingUser.id }); // <-- Use logger
                    // TODO: Log this critical error.
                }
            } else {
                logger.debug(`[DataProcessor] No significant mapped changes detected for Mover HRMS ID ${iglmUserData.hrmsId}. Skipping DB update and event publish.`); // <-- Use logger
            }


        } catch (error) {
            logger.error(`[DataProcessor] Error processing Mover HRMS ID ${moverHrmsId}:`, error); // <-- Use logger
            // TODO: Log this specific error to a dedicated processing error log table or system
        }
    }

    // 3. Process Leavers
    logger.info(`[DataProcessor] Processing ${deltas.leavers.length} Leavers...`); // <-- Use logger
    for (const rawLeaver of deltas.leavers) {
        // Get unique ID from raw data (this raw data is from the PREVIOUS snapshot)
        // Need to use the uniqueIdTargetAttribute to get the ID from the mapped previous data
        // Or get the sourceUniqueIdField from the raw previous data (safer, as mapping isn't applied to leavers for state)
        const leaverHrmsId = (rawLeaver && typeof rawLeaver === 'object' && rawLeaver.hasOwnProperty(sourceUniqueIdField)) ? String(rawLeaver[sourceUniqueIdField]).trim() : 'N/A (Missing ID)'; // <-- Ensure string and trim
         logger.debug(`[DataProcessor] Attempting to process raw Leaver record (previous snapshot) with HRMS ID: ${leaverHrmsId}`); // <-- Use logger

        try {
            // Find existing User in our database by HRMS ID
            // Leavers are identified by *absence* in the new snapshot, so we find them in our DB
            const existingUser = await User.findOne({ where: { hrmsId: leaverHrmsId } });

            if (!existingUser) {
                // This is a critical inconsistency: Leaver detected (absent in source), but User not in our DB.
                logger.error(`[DataProcessor] CRITICAL INCONSISTENCY: Leaver detected for HRMS ID ${leaverHrmsId} but no existing User found in DB. Cannot process exit.`); // <-- Use logger
                // TODO: Log this critical inconsistency, potentially alert.
                continue; // Skip processing this leaver
            }

            // Update existing User status to 'exited' and set exitDate
            // Ensure the status isn't already 'exited' if multiple leaver events are processed.
            if (existingUser.status !== 'exited') {
                logger.info(`[DataProcessor] Processing Leaver: Updating User to 'exited' for HRMS ID ${leaverHrmsId} (Current status: ${existingUser.status}).`); // <-- Use logger
                const [updateCount, updatedUsers] = await User.update({
                    status: 'exited',
                    // Set exit date to now. Getting the exact historical termination_date from the rawLeaver (previous snapshot)
                    // could be tricky if the source system doesn't include it once they are terminated.
                    // Setting to now is a common pragmatic approach.
                    exitDate: new Date()
                }, {
                    where: { id: existingUser.id }, // Update by internal ID
                    returning: true // Return the updated user instance(s)
                });

                if (updateCount > 0 && updatedUsers && updatedUsers[0]) {
                    const updatedUser = updatedUsers[0];
                    logger.info(`[DataProcessor] Updated User in DB to 'exited': ID ${updatedUser.id}, HRMS ID ${updatedUser.hrmsId}`); // <-- Use logger

                    // Publish Leaver event to MQ ONLY if the status changed to exited
                    const leaverEventPayload = {
                        userId: updatedUser.id,
                        hrmsId: updatedUser.hrmsId,
                        userData: updatedUser.toJSON(), // Send the final IGLM User object (now exited)
                        timestamp: new Date(),
                        eventType: 'identity.leaver.exit' // Specific event type
                    };
                    // mqService.publish is resilient and waits for the channel internally
                    await mqService.publish('identity.changes', 'leaver.exit', leaverEventPayload).catch(publishErr => {
                         // Log publish errors specifically
                         logger.error(`[DataProcessor] Error publishing 'leaver.exit' event for User ID ${updatedUser.id} (HRMS ID: ${updatedUser.hrmsId}):`, publishErr); // <-- Use logger, add hrmsId
                         // TODO: Handle MQ publish failure - retry? Store and retry later? Alert?
                    });
                    logger.info(`[DataProcessor] Published 'leaver.exit' event for User ID ${updatedUser.id} (HRMS ID: ${updatedUser.hrmsId})`); // <-- Use logger, add hrmsId

                } else {
                    // This is unexpected if existingUser was found and status wasn't exited
                    logger.error(`[DataProcessor] CRITICAL ERROR: Failed to update User status to 'exited' for HRMS ID ${leaverHrmsId}. Update count was 0 after finding user.`, { hrmsId: leaverHrmsId, existingUserId: existingUser.id }); // <-- Use logger
                    // TODO: Log this critical error.
                }

            } else {
                logger.debug(`[DataProcessor] User with HRMS ID ${leaverHrmsId} is already marked as 'exited'. Skipping DB update and event publish.`); // <-- Use logger
            }


        } catch (error) {
            logger.error(`[DataProcessor] Error processing Leaver HRMS ID ${leaverHrmsId}:`, error); // <-- Use logger
            // TODO: Log this specific error to a dedicated processing error log table or system
        }
    }

    logger.info("[DataProcessor] Delta processing completed."); // <-- Use logger
}


// The applyMapping function is internal to this module

module.exports = {
    processDeltas,
    // applyMapping // Not exporting applyMapping as it's an internal helper
    // Export deepEqual for testing if needed, otherwise keep internal
    // deepEqual
};