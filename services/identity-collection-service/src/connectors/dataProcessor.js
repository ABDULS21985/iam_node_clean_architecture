// services/identity-collection-service/src/dataProcessor.js

// The models and mqService will be passed into the processDeltas function via options
// const { User } = models;
// const mqService = mqService;

/**
 * Applies mapping rules to a raw HRMS record and transforms it into the IGLM User model format.
 * This implementation uses the structure defined in the mappingRules JSONB.
 *
 * @param {object} rawRecord - A single record object from the HRMS data pull (e.g., { employee_id: 'e001', first_name: 'Alice', ... }).
 * @param {object} mappingRules - The mappingRules JSONB object from the MappingConfig.
 * Expected structure (example):
 * {
 * "attributeMappings": { // Direct field-to-field mappings
 * "firstName": "first_name",
 * "lastName": "last_name",
 * "email": "email", // HRMS field name
 * "hrmsId": "employee_id", // HRMS field name
 * "status": "job_status", // HRMS field name for status
 * "hireDate": "date_of_hire",
 * "exitDate": "termination_date",
 * "department": "department_name",
 * "title": "job_title",
 * "location": "job_location",
 * "mobileNumber": "mobile_number" // Example of adding mobile
 * },
 * "statusMapping": { // Map HRMS status values to IGLM status values
 * "Active": "active",
 * "On Leave": "active",
 * "Terminated": "exited",
 * "Pending Hire": "pending_joiner",
 * "Inactive": "inactive"
 * },
 * "metadataMapping": { // Map HRMS fields to nested keys in the IGLM User metadata JSONB
 * "personId": "person_id",
 * "middleName": "middle_name",
 * "supervisorHrmsId": "supervisor_id",
 * "gradeLevel": "grade"
 * // ... other fields for metadata
 * },
 * // Rules like joiner/leaver conditions, mover attributes might be used elsewhere (DeltaDetection, ProcessDeltas)
 * "metadata": { // General metadata about the mapping rules themselves
 * "sourceUniqueIdField": "employee_id", // Key name in raw HRMS data for unique ID
 * "statusHrmsField": "job_status" // Key name in raw HRMS data for status (redundant if in attributeMappings, but good to be explicit)
 * }
 * }
 * @returns {object|null} An object formatted according to the IGLM User model structure,
 * or null if a critical mapping fails (e.g., hrmsId missing).
 */
function applyMapping(rawRecord, mappingRules) {
    console.log("[DataProcessor] Applying mapping...");

    const iglmUser = {
        metadata: {} // Initialize metadata as an empty object
    };

    // Ensure mappingRules is valid
     if (!mappingRules || typeof mappingRules !== 'object') {
         console.error("[DataProcessor] Mapping Error: Invalid or null mappingRules provided.");
         return null; // Cannot map without rules
     }


    const attrMaps = mappingRules.attributeMappings || {};
    const statusMap = mappingRules.statusMapping || {};
    const metaMaps = mappingRules.metadataMapping || {};
    // Get crucial field names from mapping metadata with fallbacks
    const sourceUniqueIdField = mappingRules.metadata?.sourceUniqueIdField || attrMaps.hrmsId || 'employee_id';
    const statusHrmsField = mappingRules.metadata?.statusHrmsField || attrMaps.status || 'job_status';


    // --- Apply Attribute Mappings ---
    for (const iglmKey in attrMaps) {
        // Ensure the target IGLM key is a valid attribute name in our User model (basic check)
        // If User model ever changes, this list needs update
    const userModelAttributes = [
        'hrmsId', 'firstName', 'middleName', 'lastName', 'email', 'mobileNumber',
        'status', 'hireDate', 'exitDate', 'supervisorId', 'headOfOfficeId',
        'jobTitle', 'departmentId', 'departmentName', 'divisionId', 'divisionName',
        'officeId', 'officeName', 'gradeId', 'grade', 'partyId', 'jobStatus',
        'jobLocationId', 'jobLocation', 'location', 'metadata'
    ];// Add 'mobileNumber' if you added it to model
        if (!userModelAttributes.includes(iglmKey)) {
             console.warn(`[DataProcessor] Mapping Warning: Skipping mapping for unknown IGLM User attribute in applyMapping: ${iglmKey}`);
             continue;
        }

        const hrmsKey = attrMaps[iglmKey];
        // Check if the raw HRMS record is valid and has the source key
        if (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(hrmsKey)) {
            const rawValue = rawRecord[hrmsKey];

            // TODO: Add more sophisticated type conversion/validation here based on mapping config if needed
            // Handle dates specifically: attempt to convert if not null
             if (['hireDate', 'exitDate'].includes(iglmKey) && rawValue !== null) {
                 const dateValue = new Date(rawValue);
                 if (!isNaN(dateValue.getTime())) { // Check if date conversion resulted in a valid date
                      iglmUser[iglmKey] = dateValue;
                 } else {
                      console.warn(`[DataProcessor] Mapping Warning: Invalid date value "${rawValue}" for HRMS field "${hrmsKey}" mapped to "${iglmKey}". Setting to null.`);
                      iglmUser[iglmKey] = null; // Set to null if date is invalid
                 }
             } else if (rawValue !== null) {
                // Direct assignment for non-date, non-null values
                 iglmUser[iglmKey] = rawValue;
             } else {
                 // Set to null if the raw value is null
                 iglmUser[iglmKey] = null;
             }
        } else {
            // If HRMS field is missing, set corresponding IGLM field to null
            iglmUser[iglmKey] = null;
            // console.warn(`[DataProcessor] Mapping Warning: HRMS field "${hrmsKey}" not found in raw record for mapping to "${iglmKey}". Setting to null.`);
        }
    }

        // --- Apply Status Mapping (Using the specific status field) ---
    const rawStatusValue = (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(statusHrmsField)) 
    ? rawRecord[statusHrmsField] 
    : null;

    // Utility function to normalize HRMS status values
    function normalizeStatus(rawStatus, statusMap) {
    if (!rawStatus) return 'unknown';

    const cleanedStatus = rawStatus.trim();
    const lowerCaseStatus = cleanedStatus.toLowerCase();
    const upperCaseStatus = cleanedStatus.toUpperCase();

    return statusMap[cleanedStatus] || statusMap[lowerCaseStatus] || statusMap[upperCaseStatus] || 'unknown';
    }

    if (rawStatusValue !== null) {
    const mappedStatus = normalizeStatus(rawStatusValue, statusMap);
    iglmUser.status = mappedStatus;

    if (mappedStatus === 'unknown') {
        console.warn(`[DataProcessor] Mapping Warning: HRMS status value "${rawStatusValue}" not found in statusMapping. Setting IGLM status to 'unknown'.`);
    }
    } else {
    iglmUser.status = 'unknown';
    console.warn(`[DataProcessor] Mapping Warning: HRMS status field "${statusHrmsField}" not found or is null in raw record. Setting IGLM status to 'unknown'.`);
    }

    // --- Apply Metadata Mappings ---
    iglmUser.metadata = {}; // Ensure initialization as object
    for (const metaKey in metaMaps) {
    const hrmsKey = metaMaps[metaKey];
    if (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(hrmsKey)) {
        const rawValue = rawRecord[hrmsKey];
        if (rawValue !== null) {
            iglmUser.metadata[metaKey] = rawValue;
        } else {
            iglmUser.metadata[metaKey] = null; // Optional: could omit nulls if needed
        }
    }
    }

    // Validate metadata is object even if no mappings exist
    if (typeof iglmUser.metadata !== 'object' || iglmUser.metadata === null) {
    iglmUser.metadata = {};
    }

    // === Final Touches & Validation of Unique ID ===
    // metadata.sourceUniqueIdField is the *logical* key (e.g. "hrmsId")
    // attrMaps maps that logical key to the real raw column (e.g. "employee_id")
    const logicalIdKey = sourceUniqueIdField;
    const rawIdKey     = attrMaps[logicalIdKey] || logicalIdKey;

    if (
    rawRecord.hasOwnProperty(rawIdKey) &&
    rawRecord[rawIdKey] !== null
    ) {
    iglmUser.hrmsId = rawRecord[rawIdKey];
    } else {
    console.error(
        `[DataProcessor] Mapping Error: Missing unique ID column "${rawIdKey}" `
        + `(logical="${logicalIdKey}") or its value is null.`
    );
    return null;
    }


    // // --- Final Touches & Validation ---
    // // Validate presence of essential unique ID field
    // if (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(sourceUniqueIdField) && rawRecord[sourceUniqueIdField] !== null) {
    // iglmUser.hrmsId = rawRecord[sourceUniqueIdField];
    // } else {
    // console.error(`[DataProcessor] Mapping Error: Raw HRMS record missing required unique ID field "${sourceUniqueIdField}" or its value is null. Cannot map record.`);
    // return null; // Critical failure: cannot continue mapping
    // }


    // // --- Apply Status Mapping (Using the specific status field) ---
    // // Get the raw status value using the configured statusHrmsField
    // const rawStatusValue = (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(statusHrmsField)) ? rawRecord[statusHrmsField] : null;

    // if (rawStatusValue !== null) {
    //     // Look up the raw HRMS status value in the statusMapping
    //     const mappedStatus = statusMap[rawStatusValue];
    //     // Assign mapped status if found, otherwise 'unknown'
    //     iglmUser.status = mappedStatus !== undefined ? mappedStatus : 'unknown';
    //     if (mappedStatus === undefined) {
    //          console.warn(`[DataProcessor] Mapping Warning: HRMS status value "${rawStatusValue}" not found in statusMapping. Setting IGLM status to 'unknown'.`);
    //     }
    // } else {
    //     // If the HRMS status field is missing or null, default to 'unknown'
    //      iglmUser.status = 'unknown';
    //      console.warn(`[DataProcessor] Mapping Warning: HRMS status field "${statusHrmsField}" not found or is null in raw record. Setting IGLM status to 'unknown'.`);
    // }


    // // --- Apply Metadata Mappings ---
    // iglmUser.metadata = {}; // Re-initialize metadata to ensure it's an object even if empty
    // for (const metaKey in metaMaps) {
    //     const hrmsKey = metaMaps[metaKey];
    //     if (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(hrmsKey)) {
    //         const rawValue = rawRecord[hrmsKey];
    //         // TODO: Add type conversion/validation for metadata fields if needed
    //         if (rawValue !== null) {
    //              iglmUser.metadata[metaKey] = rawValue;
    //         } else {
    //              // Optionally set to null or omit if raw value is null
    //              iglmUser.metadata[metaKey] = null;
    //         }
    //     } else {
    //          // Optionally set to null or omit if HRMS field is missing
    //          // iglmUser.metadata[metaKey] = null;
    //          // console.warn(`[DataProcessor] Mapping Warning: HRMS field "${hrmsKey}" not found in raw record for metadata mapping to "${metaKey}".`);
    //     }
    // }

    //  // Ensure metadata is a valid JSONB object if some mappings failed or if it remained empty
    //  // Ensure it's always an object, even if empty
    // if (typeof iglmUser.metadata !== 'object' || iglmUser.metadata === null) {
    //      iglmUser.metadata = {};
    // }


    // // --- Final Touches & Validation ---
    // // Ensure the essential hrmsId field is correctly set based on the configured unique ID field
    // // This is critical for finding users in the DB.
    // if (rawRecord !== null && typeof rawRecord === 'object' && rawRecord.hasOwnProperty(sourceUniqueIdField) && rawRecord[sourceUniqueIdField] !== null) {
    //     iglmUser.hrmsId = rawRecord[sourceUniqueIdField];
    // } else {
    //     // This is a critical error: cannot map a record without its unique ID.
    //     // Return null to indicate mapping failure for this record.
    //     console.error(`[DataProcessor] Mapping Error: Raw HRMS record missing required unique ID field "${sourceUniqueIdField}" or its value is null. Cannot map record.`);
    //     return null; // Indicate mapping failure for this record
    // }

    // TODO: Add validation against IGLM User model schema if strict validation is needed
    // const { User } = models; // You would need to get models if doing schema validation here
    // try { await User.validate(iglmUser); } catch(e) { console.error("Validation error", e); return null; }


    // Filter out keys from the temporary 'iglmUser' object that are not actual columns in our User model.
    // This prevents accidentally trying to insert/update fields that don't exist.
    // List all attributes *defined in the User model's init method* (excluding DB-managed id, createdAt, updatedAt)
    // Ensure this list matches the User model definition exactly.
    const userModelAttributes = ['hrmsId', 'firstName', 'lastName', 'email', 'status', 'hireDate', 'exitDate', 'department', 'title', 'location', 'mobileNumber', 'metadata']; // Add/Verify all your User model attributes

    const finalIglmUser = {};
    for (const field of userModelAttributes) {
        if (iglmUser.hasOwnProperty(field)) {
             finalIglmUser[field] = iglmUser[field];
        } else {
            // Optionally set to null if missing from mapping result but required by model
            // finalIglmUser[field] = null; // Uncomment if you want missing mapped fields to be null explicitly
        }
    }

    // Ensure metadata is always an object, even if empty after filtering/population
     finalIglmUser.metadata = finalIglmUser.metadata || {};


    console.log(`[DataProcessor] Mapped record (HRMS ID: ${finalIglmUser.hrmsId}):`, finalIglmUser);
    return finalIglmUser; // Return the final mapped and filtered object
}


/**
 * Processes the detected deltas (Joiners, Movers, Leavers).
 * Applies mapping, updates the database, and publishes MQ events.
 *
 * @param {{joiners: Array<object>, movers: Array<object>, leavers: Array<object>}} deltas - Object containing delta records (raw HRMS data).
 * @param {object} mappingRules - The mappingRules JSONB from the MappingConfig.
 * @param {object} models - Sequelize models object ({ User, ... }).
 * @param {object} mqService - The initialized MqService instance.
 * @returns {Promise<void>} Resolves when all deltas are processed.
 * @throws {Error} If critical setup issues occur (invalid mappingRules).
 */
async function processDeltas(deltas, mappingRules, models, mqService) {
    console.log("[DataProcessor] Starting delta processing...");
    const { User } = models; // Destructure User model

    // Ensure mappingRules is valid and contains essential metadata
    if (!mappingRules || typeof mappingRules !== 'object' || !mappingRules.metadata || !mappingRules.metadata.sourceUniqueIdField) {
        console.error("[DataProcessor] Invalid or incomplete mappingRules provided. Missing metadata or sourceUniqueIdField.");
        throw new Error("Invalid or incomplete mappingRules provided to DataProcessor.");
    }
     const sourceUniqueIdField = mappingRules.metadata.sourceUniqueIdField; // Get the unique ID field name


    // 1. Process Joiners
    console.log(`[DataProcessor] Processing ${deltas.joiners.length} Joiners...`);
    for (const rawJoiner of deltas.joiners) {
        // Get unique ID from raw data for logging context if possible
        const joinerHrmsId = (rawJoiner && typeof rawJoiner === 'object' && rawJoiner.hasOwnProperty(sourceUniqueIdField)) ? rawJoiner[sourceUniqueIdField] : 'N/A (Missing ID)';
        try {
            // Apply mapping to transform raw data
            const iglmUserData = applyMapping(rawJoiner, mappingRules);

            // Check if mapping was successful and produced a valid object with hrmsId
            if (!iglmUserData || !iglmUserData.hrmsId) {
                 console.error(`[DataProcessor] Failed to map Joiner record (Raw HRMS ID: ${joinerHrmsId}). Skipping.`);
                 // TODO: Log specific record mapping failure to a dedicated error log table
                 continue; // Skip this record if mapping failed
            }

            console.log(`[DataProcessor] Processing mapped Joiner: HRMS ID ${iglmUserData.hrmsId}`);

            // Create new User in our database
            // Use findOrCreate here to handle potential race conditions or retries
            const [newUser, created] = await User.findOrCreate({
                 where: { hrmsId: iglmUserData.hrmsId }, // Look up by HRMS ID
                 defaults: iglmUserData // Data to use if creating
            });

            if (created) {
                 console.log(`[DataProcessor] Created new User in DB: ID ${newUser.id}, HRMS ID ${newUser.hrmsId}`);

                 // Publish Joiner event to MQ ONLY if the user was actually created
                 const joinerEventPayload = {
                     userId: newUser.id,
                     hrmsId: newUser.hrmsId,
                     userData: newUser.toJSON(), // Send the created IGLM User object
                     timestamp: new Date(),
                      eventType: 'joiner.new' // Explicit event type in payload
                 };
                 await mqService.publish('identity.changes', 'joiner.new', joinerEventPayload);
                 console.log(`[DataProcessor] Published 'joiner.new' event for User ID ${newUser.id}`);

            } else {
                 // If not created, it means a User with this hrmsId already exists.
                 // This could indicate a Mover that was processed as a Joiner or data inconsistency.
                 console.warn(`[DataProcessor] Joiner detected for HRMS ID ${iglmUserData.hrmsId} but User already exists in DB. Possible Mover or inconsistency.`);
                 // TODO: Log this inconsistency. Maybe trigger a Mover process instead?
                 // For now, skip publishing 'joiner.new' if user already exists.
            }


        } catch (error) {
            console.error(`[DataProcessor] Error processing Joiner HRMS ID ${joinerHrmsId}:`, error);
            // TODO: Log this specific error to a dedicated processing error log table
        }
    }

    // 2. Process Movers
    console.log(`[DataProcessor] Processing ${deltas.movers.length} Movers...`);
    for (const rawMover of deltas.movers) {
        const moverHrmsId = (rawMover && typeof rawMover === 'object' && rawMover.hasOwnProperty(sourceUniqueIdField)) ? rawMover[sourceUniqueIdField] : 'N/A (Missing ID)';
        try {
            // Apply mapping to transform raw data
            const iglmUserData = applyMapping(rawMover, mappingRules);

             if (!iglmUserData || !iglmUserData.hrmsId) {
                 console.error(`[DataProcessor] Failed to map Mover record (Raw HRMS ID: ${moverHrmsId}). Skipping.`);
                  // TODO: Log specific record mapping failure
                 continue; // Skip this record if mapping failed
            }
            console.log(`[DataProcessor] Processing mapped Mover: HRMS ID ${iglmUserData.hrmsId}`);

            // Find existing User in our database by HRMS ID
            const existingUser = await User.findOne({ where: { hrmsId: iglmUserData.hrmsId } });

            if (!existingUser) {
                // This is a critical inconsistency: Mover detected, but User not in our DB.
                console.error(`[DataProcessor] CRITICAL INCONSISTENCY: Mover detected for HRMS ID ${iglmUserData.hrmsId} but no existing User found in DB. Cannot update.`);
                // TODO: Log this critical inconsistency, potentially alert, maybe trigger a Joiner process?
                continue; // Skip processing this mover
            }

            // Store original user data before update for comparison (optional, for detailed event payload)
            // const originalUserData = existingUser.toJSON();

            // Update existing User in our database
            // Use the mapped data. Sequelize's update method merges data based on model attributes.
            // Only fields present in iglmUserData and the model will be considered for update.
            const [updateCount, updatedUsers] = await User.update(iglmUserData, {
                 where: { id: existingUser.id }, // Update by internal ID
                 returning: true // Return the updated user instance(s)
            });

            if (updateCount > 0 && updatedUsers && updatedUsers[0]) {
                const updatedUser = updatedUsers[0];
                console.log(`[DataProcessor] Updated User in DB: ID ${updatedUser.id}, HRMS ID ${updatedUser.hrmsId}`);

                // TODO: Compare originalUserData with updatedUser to find *what* specific attributes changed
                // and include that in the event payload if needed by downstream services.

                // Publish Mover event to MQ
                const moverEventPayload = {
                     userId: updatedUser.id,
                     hrmsId: updatedUser.hrmsId,
                     userData: updatedUser.toJSON(), // Send the updated IGLM User object
                     // changedAttributes: { ... } // TODO: Add specific changes here
                     timestamp: new Date(),
                     eventType: 'mover.update' // Explicit event type in payload
                 };
                await mqService.publish('identity.changes', 'mover.update', moverEventPayload);
                console.log(`[DataProcessor] Published 'mover.update' event for User ID ${updatedUser.id}`);

            } else {
                 // This is unexpected if existingUser was found - indicates update failed or user disappeared concurrently.
                 console.error(`[DataProcessor] CRITICAL ERROR: Failed to update User in DB for HRMS ID ${iglmUserData.hrmsId}. Update count was 0.`);
                 // TODO: Log this critical error.
            }


        } catch (error) {
             console.error(`[DataProcessor] Error processing Mover HRMS ID ${moverHrmsId}:`, error);
             // TODO: Log this specific error
        }
    }

    // 3. Process Leavers
    console.log(`[DataProcessor] Processing ${deltas.leavers.length} Leavers...`);
    for (const rawLeaver of deltas.leavers) {
         // Get unique ID from raw data (from previous snapshot)
         const leaverHrmsId = (rawLeaver && typeof rawLeaver === 'object' && rawLeaver.hasOwnProperty(sourceUniqueIdField)) ? rawLeaver[sourceUniqueIdField] : 'N/A (Missing ID)';
         try {
             // Map the leaver record (typically from previous snapshot) to get core IDs/attributes
             // This mapped data might be useful for the event payload, but we primarily need the hrmsId.
             const iglmUserData = applyMapping(rawLeaver, mappingRules); // Map the last known state


             if (!iglmUserData || !iglmUserData.hrmsId) {
                 console.error(`[DataProcessor] Failed to map Leaver record (Raw HRMS ID: ${leaverHrmsId}). Skipping.`);
                  // TODO: Log specific record mapping failure
                 continue; // Skip this record if mapping failed
            }
              console.log(`[DataProcessor] Processing Leaver: HRMS ID ${iglmUserData.hrmsId}`);


            // Find existing User in our database by HRMS ID
            const existingUser = await User.findOne({ where: { hrmsId: iglmUserData.hrmsId } });

            if (!existingUser) {
                 // This is a critical inconsistency: Leaver detected, but User not in our DB.
                 console.error(`[DataProcessor] CRITICAL INCONSISTENCY: Leaver detected for HRMS ID ${iglmUserData.hrmsId} but no existing User found in DB. Cannot update status.`);
                 // TODO: Log this critical inconsistency, potentially alert.
                 continue; // Skip processing this leaver
            }

            // Update existing User status to 'exited' and set exitDate
            // We should only update status and exitDate here, not other attributes based on old data.
            // Ensure the status isn't already 'exited' if multiple leaver events are processed.
            if (existingUser.status !== 'exited') {
                 const [updateCount, updatedUsers] = await User.update({
                     status: 'exited',
                     // Set exit date to now, or try to get it from HRMS data if available in rawLeaver (less common for leavers by absence)
                     exitDate: new Date()
                 }, {
                     where: { id: existingUser.id }, // Update by internal ID
                     returning: true
                 });

                 if (updateCount > 0 && updatedUsers && updatedUsers[0]) {
                     const updatedUser = updatedUsers[0];
                     console.log(`[DataProcessor] Updated User in DB to 'exited': ID ${updatedUser.id}, HRMS ID ${updatedUser.hrmsId}`);

                     // Publish Leaver event to MQ ONLY if the status changed to exited
                     const leaverEventPayload = {
                          userId: updatedUser.id,
                          hrmsId: updatedUser.hrmsId,
                          userData: updatedUser.toJSON(), // Send the updated IGLM User object
                          timestamp: new Date(),
                          eventType: 'leaver.exit' // Explicit event type in payload
                      };
                     await mqService.publish('identity.changes', 'leaver.exit', leaverEventPayload);
                     console.log(`[DataProcessor] Published 'leaver.exit' event for User ID ${updatedUser.id}`);
                 } else {
                      // This is unexpected if existingUser was found and status wasn't exited
                      console.error(`[DataProcessor] CRITICAL ERROR: Failed to update User status to 'exited' for HRMS ID ${iglmUserData.hrmsId}. Update count was 0.`);
                       // TODO: Log this critical error.
                 }

            } else {
                console.log(`[DataProcessor] User with HRMS ID ${iglmUserData.hrmsId} is already marked as 'exited'. Skipping update and event publish.`);
            }


        } catch (error) {
            console.error(`[DataProcessor] Error processing Leaver HRMS ID ${leaverHrmsId}:`, error);
            // TODO: Log this specific error
        }
    }

    console.log("[DataProcessor] Delta processing completed.");
}


// The applyMapping function is internal to this module

module.exports = {
  processDeltas,
};