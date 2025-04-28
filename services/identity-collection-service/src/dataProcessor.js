// services/identity-collection-service/src/dataProcessor.js

// The models and mqService will be passed into the processDeltas function via options
// const { User } = models; // Accessed via models parameter
// const mqService = mqService; // Accessed via mqService parameter

/**
 * List of actual column names in the IGLM User model, excluding DB-managed ones like id, createdAt, updatedAt.
 * This list is used to filter the mapped attributes to ensure only valid fields are set on the User object.
 * KEEP THIS LIST IN SYNC WITH YOUR User MODEL AND MIGRATION.
 */
const userModelAttributes = [
    'hrmsId', 'firstName', 'middleName', 'lastName', 'email', 'mobileNumber',
    'status', 'hireDate', 'exitDate', 'supervisorId', 'headOfOfficeId',
    'jobTitle', 'departmentId', 'departmentName', 'divisionId', 'divisionName',
    'officeId', 'officeName', 'gradeId', 'grade', 'partyId', 'jobStatus', // Added jobStatus, grade
    'jobLocationId', 'jobLocation', 'location', // Added jobLocationId, jobLocation, location
    'metadata' // metadata JSONB field
];


/**
 * Applies mapping rules to a raw HRMS record and transforms it into the IGLM User model format.
 * Handles attribute mapping, status mapping, and metadata mapping.
 * Validates presence of the unique identifier field.
 *
 * @param {object} rawRecord - A single record object from the HRMS data pull.
 * @param {object} mappingRules - The mappingRules JSONB object from the MappingConfig.
 * @param {string} sourceUniqueIdField - The name of the unique ID field in the raw HRMS data (e.g., 'employee_id').
 * @returns {object|null} An object formatted according to the IGLM User model structure,
 * or null if a critical mapping fails (e.g., unique ID missing or invalid).
 */
function applyMapping(rawRecord, mappingRules, sourceUniqueIdField) {
    console.log("[DataProcessor] Applying mapping...");

    const iglmUser = {
        metadata: {} // Initialize metadata as an empty object
    };

    // Ensure mappingRules is valid
    if (!mappingRules || typeof mappingRules !== 'object') {
        console.error("[DataProcessor] Mapping Error: Invalid or null mappingRules provided.");
        return null; // Cannot map without rules
    }
     // Ensure raw record is valid
    if (!rawRecord || typeof rawRecord !== 'object') {
         console.error("[DataProcessor] Mapping Error: Invalid or null rawRecord provided.");
         return null; // Cannot map null/invalid record
    }


    const attrMaps = mappingRules.attributeMappings || {};
    const statusMap = mappingRules.statusMapping || {};
    const metaMaps = mappingRules.metadataMapping || {};
    // statusHrmsField is used to get the raw value for status mapping lookup
    const statusHrmsField = mappingRules.metadata?.statusSourceField || 'job_status'; // Use sourceStatusField from metadata


    // --- Find the target attribute name for the unique ID ---
    let uniqueIdTargetAttribute = null;
    for (const targetKey in attrMaps) {
        if (attrMaps[targetKey] === sourceUniqueIdField) {
            uniqueIdTargetAttribute = targetKey;
            break;
        }
    }

     // CRITICAL VALIDATION: Ensure the unique source ID maps to a target attribute
    if (!uniqueIdTargetAttribute) {
        console.error(`[DataProcessor] Mapping Error: User mapping rules do not contain an attributeMapping where the value is the sourceUniqueIdField ("${sourceUniqueIdField}"). This mapping is required.`);
         return null;
    }


    // --- Apply Attribute Mappings (and filter to valid model attributes) ---
    for (const iglmKey in attrMaps) {
        const hrmsKey = attrMaps[iglmKey];

        // Check if the target key is a valid attribute name in our User model
        if (!userModelAttributes.includes(iglmKey)) {
            console.warn(`[DataProcessor] Mapping Warning: Skipping mapping for unknown IGLM User attribute "${iglmKey}". Not found in userModelAttributes list.`);
            continue; // Skip this mapping if the target attribute doesn't exist
        }

        // Check if the raw HRMS record has the source key
        if (rawRecord.hasOwnProperty(hrmsKey)) {
            let rawValue = rawRecord[hrmsKey];

            // Handle specific type conversions/validations
            if (['hireDate', 'exitDate'].includes(iglmKey) && rawValue !== null) {
                const dateValue = new Date(rawValue);
                // Check if date conversion resulted in a valid date
                if (!isNaN(dateValue.getTime())) {
                    iglmUser[iglmKey] = dateValue;
                } else {
                    console.warn(`[DataProcessor] Mapping Warning: Invalid date value "${rawValue}" for HRMS field "${hrmsKey}" mapped to "${iglmKey}". Setting to null.`);
                    iglmUser[iglmKey] = null; // Set to null if date is invalid
                }
            } else {
                 // Assign value directly for other types
                 iglmUser[iglmKey] = rawValue;
            }
        } else {
            // If HRMS field is missing, set corresponding IGLM field to null (or undefined, depending on desired behavior)
             iglmUser[iglmKey] = null; // Explicitly set to null if source is missing
             // console.warn(`[DataProcessor] Mapping Warning: HRMS field "${hrmsKey}" not found in raw record for mapping to "${iglmKey}". Setting to null.`); // Optional warning
        }
    }

    // --- Apply Status Mapping ---
    const rawStatusValue = rawRecord.hasOwnProperty(statusHrmsField) ? rawRecord[statusHrmsField] : null;

    // Utility function to normalize HRMS status values
    function normalizeStatus(rawStatus, statusMap) {
        if (rawStatus === null || rawStatus === undefined) return 'unknown'; // Handle null/undefined raw status

        const cleanedStatus = String(rawStatus).trim(); // Ensure it's a string before trimming
        // Check for direct match first (case-sensitive)
        if (statusMap.hasOwnProperty(cleanedStatus)) {
             return statusMap[cleanedStatus];
        }
        // Optional: Check case-insensitive matches if needed
        // const lowerCaseStatus = cleanedStatus.toLowerCase();
        // for(const key in statusMap) {
        //      if (String(key).toLowerCase() === lowerCaseStatus) return statusMap[key];
        // }

        return 'unknown'; // Default if no mapping found
    }

    if (rawStatusValue !== null && rawStatusValue !== undefined) { // Check explicitly for null/undefined
        const mappedStatus = normalizeStatus(rawStatusValue, statusMap);
        iglmUser.status = mappedStatus;

        if (mappedStatus === 'unknown') {
            console.warn(`[DataProcessor] Mapping Warning: HRMS status value "${rawStatusValue}" for source field "${statusHrmsField}" not found in statusMapping. Setting IGLM status to 'unknown'.`);
        }
    } else {
        iglmUser.status = 'unknown';
        console.warn(`[DataProcessor] Mapping Warning: HRMS status field "${statusHrmsField}" not found or is null/undefined in raw record. Setting IGLM status to 'unknown'.`);
    }

    // --- Apply Metadata Mappings ---
    // Metadata is populated into the 'metadata' key of the iglmUser object, which is a JSONB column
    iglmUser.metadata = {}; // Ensure metadata is always initialized as an object

    for (const metaKey in metaMaps) {
        const hrmsKey = metaMaps[metaKey];
        if (rawRecord.hasOwnProperty(hrmsKey)) { // Check if the raw HRMS record has the source key
            const rawValue = rawRecord[hrmsKey];
            // Store the raw value directly in the metadata JSONB
             // Decide if you want to include nulls in metadata or omit them
            iglmUser.metadata[metaKey] = rawValue; // Include nulls
            // if (rawValue !== null && rawValue !== undefined) { // Omit nulls/undefined
            //      iglmUser.metadata[metaKey] = rawValue;
            // }

        } else {
            // If HRMS field is missing for metadata mapping, optionally set to null in metadata
            iglmUser.metadata[metaKey] = null; // Include missing fields as null in metadata
             // console.warn(`[DataProcessor] Mapping Warning: HRMS field "${hrmsKey}" not found in raw record for metadata mapping to "${metaKey}". Setting to null in metadata.`); // Optional warning
        }
    }

     // Ensure metadata is a valid JSONB object even if no mappings exist or source fields were missing
     if (typeof iglmUser.metadata !== 'object' || iglmUser.metadata === null) {
         iglmUser.metadata = {};
     }


    // --- CRITICAL VALIDATION: Ensure the unique ID value is present in the raw data ---
    // Get the actual value from the raw record using the source field name
    const uniqueIdValue = rawRecord.hasOwnProperty(sourceUniqueIdField) ? rawRecord[sourceUniqueIdField] : null;

    if (uniqueIdValue === null || uniqueIdValue === undefined || uniqueIdValue === '') { // Check for null, undefined, and empty string
        console.error(
            `[DataProcessor] Mapping Error: Raw HRMS record missing required unique ID value for source field "${sourceUniqueIdField}". ` +
            `Cannot map record. Record snippet: ${JSON.stringify(rawRecord).substring(0, 200)}...`
        );
        return null; // Critical failure: cannot map a record without its unique ID
    }

    // Set the hrmsId attribute on the IGLM User object using the value found and the target attribute name
    // This assumes sourceUniqueIdField ALWAYS maps to the 'hrmsId' attribute in the IGLM User model.
    // If sourceUniqueIdField could map to a *different* target attribute, you would need to use uniqueIdTargetAttribute here.
    // Based on your mapping structure ("hrmsId": "employee_id"), sourceUniqueIdField "employee_id" points to target "hrmsId".
    // So, we can directly assign the uniqueIdValue to iglmUser.hrmsId.
    iglmUser.hrmsId = String(uniqueIdValue); // Ensure hrmsId is a string as per model

    // At this point, iglmUser contains all mapped attributes (filtered to model columns),
    // the determined status, the metadata object, and the validated hrmsId.

    console.log(`[DataProcessor] Mapped record (HRMS ID: ${iglmUser.hrmsId}):`, iglmUser);
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
 * @returns {Promise<void>} Resolves when all deltas are processed.
 * @throws {Error} If critical setup issues occur (invalid mappingRules).
 */
async function processDeltas(deltas, mappingRules, models, mqService) {
    console.log("[DataProcessor] Starting delta processing...");
    const { User } = models; // Destructure User model

    // Ensure mappingRules is valid and contains essential metadata
    if (!mappingRules || typeof mappingRules !== 'object' || !mappingRules.metadata || !mappingRules.metadata.sourceUniqueIdField || !mappingRules.attributeMappings) { // Added check for attributeMappings
        console.error("[DataProcessor] Invalid or incomplete mappingRules provided. Missing metadata, sourceUniqueIdField, or attributeMappings.");
        throw new Error("Invalid or incomplete mappingRules provided to DataProcessor.");
    }
    const sourceUniqueIdField = mappingRules.metadata.sourceUniqueIdField; // Get the unique ID field name from source data


    // 1. Process Joiners
    console.log(`[DataProcessor] Processing ${deltas.joiners.length} Joiners...`);
    for (const rawJoiner of deltas.joiners) {
        // Get unique ID from raw data for logging context if possible
        const joinerHrmsId = (rawJoiner && typeof rawJoiner === 'object' && rawJoiner.hasOwnProperty(sourceUniqueIdField)) ? rawJoiner[sourceUniqueIdField] : 'N/A (Missing ID)';
        try {
            // Apply mapping to transform raw data
            // Pass sourceUniqueIdField to applyMapping for validation and hrmsId setting
            const iglmUserData = applyMapping(rawJoiner, mappingRules, sourceUniqueIdField);

            // Check if mapping was successful and produced a valid object with hrmsId
            if (!iglmUserData || !iglmUserData.hrmsId) {
                // applyMapping already logged the specific reason for failure
                console.error(`[DataProcessor] Skipping processing of Joiner record due to mapping failure (Raw HRMS ID: ${joinerHrmsId}).`);
                // TODO: Log specific record processing failure to a dedicated error log table
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
                     eventType: 'identity.joiner.new' // Use a more specific event type key standard
                };
                // publish is now resilient and waits for the channel internally
                await mqService.publish('identity.changes', 'joiner.new', joinerEventPayload);
                console.log(`[DataProcessor] Published 'joiner.new' event for User ID ${newUser.id}`);

            } else {
                // If not created, it means a User with this hrmsId already exists.
                // This could indicate a Mover that was processed as a Joiner or data inconsistency.
                // If the status is different from the HRMS data, it's a potential mover.
                 // Let's fetch the existing user to compare status if this happens
                 const existingUser = await User.findOne({ where: { hrmsId: iglmUserData.hrmsId } });
                 if(existingUser && existingUser.status !== iglmUserData.status) {
                      console.warn(`[DataProcessor] Joiner detected for HRMS ID ${iglmUserData.hrmsId} but User already exists with different status (${existingUser.status} -> ${iglmUserData.status}). Treating as Mover.`);
                      // TODO: Instead of skipping, potentially call the mover processing logic here
                      // For now, log and skip publishing joiner event.
                 } else {
                      console.warn(`[DataProcessor] Joiner detected for HRMS ID ${iglmUserData.hrmsId} but User already exists in DB with same status. Possible inconsistency or duplicate data.`);
                 }
                 // TODO: Log this inconsistency.
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
            // Pass sourceUniqueIdField to applyMapping
            const iglmUserData = applyMapping(rawMover, mappingRules, sourceUniqueIdField);

            if (!iglmUserData || !iglmUserData.hrmsId) {
                 // applyMapping already logged the specific reason
                console.error(`[DataProcessor] Skipping processing of Mover record due to mapping failure (Raw HRMS ID: ${moverHrmsId}).`);
                 // TODO: Log specific record processing failure
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

            // Compare existing user data with mapped incoming data to identify changed attributes
            // This requires a deeper comparison than just passing the mapped object to update.
            // DeltaDetection identified the record exists in both snapshots but is different.
            // Now we find the *specific* changes based on mapped attributes.

             const changes = {};
             let statusChanged = false;
             const fieldsToCompare = userModelAttributes.filter(attr => attr !== 'metadata'); // Compare direct attributes
             // Assuming 'metadata' comparison is done by DeltaDetection at a high level
             // Detailed metadata changes could be compared here too if needed for event payload

            for (const field of fieldsToCompare) {
                // Use mapped data for incoming value, existing user data for current value
                 const incomingValue = iglmUserData[field];
                 const currentValue = existingUser[field];

                 // Simple comparison (handle null/undefined vs '')
                 const incomingStr = (incomingValue === null || incomingValue === undefined) ? '' : String(incomingValue);
                 const currentStr = (currentValue === null || currentValue === undefined) ? '' : String(currentValue);

                 // Note: Deeper comparison needed for dates, numbers, JSONB if simple string comparison is insufficient.
                 // Dates should be compared by timestamp: dateValue1?.getTime() === dateValue2?.getTime()
                 // JSONB needs deep object comparison.

                 if (field === 'status') {
                     if (incomingValue !== currentValue) { // Direct comparison for status enum
                         statusChanged = true;
                         changes[field] = { from: currentValue, to: incomingValue };
                     }
                 } else if (incomingStr !== currentStr) {
                    // For other fields, if string representations differ
                     changes[field] = { from: currentValue, to: incomingValue };
                 }
            }
            // Check if metadata JSONB changed (simple shallow comparison)
            if (JSON.stringify(iglmUserData.metadata) !== JSON.stringify(existingUser.metadata)) {
                 changes.metadata = { from: existingUser.metadata, to: iglmUserData.metadata };
                 // TODO: Implement deep object comparison for metadata if detailed changes are needed
            }

            // Only update and publish if actual changes were detected *after* mapping
            if (Object.keys(changes).length > 0) {
                 console.log(`[DataProcessor] Detected changes for User ID ${existingUser.id}:`, changes);

                 // Update existing User in our database
                 // Pass the mapped data. Sequelize will only update fields present in the object.
                 // Note: This updates ALL changed mapped fields, including status.
                 const [updateCount, updatedUsers] = await User.update(iglmUserData, { // Use mapped data for update payload
                     where: { id: existingUser.id }, // Update by internal ID
                     returning: true // Return the updated user instance(s)
                 });

                 if (updateCount > 0 && updatedUsers && updatedUsers[0]) {
                     const updatedUser = updatedUsers[0];
                     console.log(`[DataProcessor] Updated User in DB: ID ${updatedUser.id}, HRMS ID ${updatedUser.hrmsId}`);

                     // Publish Mover event to MQ
                     const moverEventPayload = {
                         userId: updatedUser.id,
                         hrmsId: updatedUser.hrmsId,
                         userData: updatedUser.toJSON(), // Send the updated IGLM User object
                          changedAttributes: changes, // Include the identified changes
                         timestamp: new Date(),
                          eventType: 'identity.mover.update' // Specific event type
                     };
                     // publish is now resilient and waits for the channel internally
                     await mqService.publish('identity.changes', 'mover.update', moverEventPayload);
                     console.log(`[DataProcessor] Published 'mover.update' event for User ID ${updatedUser.id}`);

                 } else {
                     // This is unexpected if existingUser was found - indicates update failed or user disappeared concurrently.
                     console.error(`[DataProcessor] CRITICAL ERROR: Failed to update User in DB for HRMS ID ${iglmUserData.hrmsId}. Update count was 0 after finding user.`);
                     // TODO: Log this critical error.
                 }
            } else {
                 console.log(`[DataProcessor] No significant mapped changes detected for Mover HRMS ID ${iglmUserData.hrmsId}. Skipping DB update and event publish.`);
            }


        } catch (error) {
             console.error(`[DataProcessor] Error processing Mover HRMS ID ${moverHrmsId}:`, error);
             // TODO: Log this specific error
        }
    }

    // 3. Process Leavers
    console.log(`[DataProcessor] Processing ${deltas.leavers.length} Leavers...`);
    for (const rawLeaver of deltas.leavers) {
         // Get unique ID from raw data (this raw data is from the PREVIOUS snapshot)
         // Need to use the uniqueIdTargetAttribute to get the ID from the mapped previous data
        // Or get the sourceUniqueIdField from the raw previous data
        const leaverHrmsId = (rawLeaver && typeof rawLeaver === 'object' && rawLeaver.hasOwnProperty(sourceUniqueIdField)) ? rawLeaver[sourceUniqueIdField] : 'N/A (Missing ID)';

         try {
             // Find existing User in our database by HRMS ID
             // Leavers are identified by *absence* in the new snapshot, so we find them in our DB
             const existingUser = await User.findOne({ where: { hrmsId: leaverHrmsId } });

             if (!existingUser) {
                 // This is a critical inconsistency: Leaver detected (absent in source), but User not in our DB.
                 console.error(`[DataProcessor] CRITICAL INCONSISTENCY: Leaver detected for HRMS ID ${leaverHrmsId} but no existing User found in DB. Cannot process exit.`);
                 // TODO: Log this critical inconsistency, potentially alert.
                 continue; // Skip processing this leaver
             }

             // Update existing User status to 'exited' and set exitDate
             // Ensure the status isn't already 'exited' if multiple leaver events are processed.
             if (existingUser.status !== 'exited') {
                 console.log(`[DataProcessor] Processing Leaver: Updating User to 'exited' for HRMS ID ${leaverHrmsId}`);
                 const [updateCount, updatedUsers] = await User.update({
                     status: 'exited',
                     // Set exit date to now. Getting the exact historical termination_date from the rawLeaver (previous snapshot)
                     // could be tricky if the source system doesn't include it once they are terminated.
                     // Setting to now is a common pragmatic approach.
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
                          userData: updatedUser.toJSON(), // Send the final IGLM User object (now exited)
                         timestamp: new Date(),
                         eventType: 'identity.leaver.exit' // Specific event type
                     };
                     // publish is now resilient and waits for the channel internally
                     await mqService.publish('identity.changes', 'leaver.exit', leaverEventPayload);
                     console.log(`[DataProcessor] Published 'leaver.exit' event for User ID ${updatedUser.id}`);
                 } else {
                     // This is unexpected if existingUser was found and status wasn't exited
                     console.error(`[DataProcessor] CRITICAL ERROR: Failed to update User status to 'exited' for HRMS ID ${leaverHrmsId}. Update count was 0 after finding user.`);
                     // TODO: Log this critical error.
                 }

             } else {
                 console.log(`[DataProcessor] User with HRMS ID ${leaverHrmsId} is already marked as 'exited'. Skipping DB update and event publish.`);
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