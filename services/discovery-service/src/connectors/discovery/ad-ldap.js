// services/discovery-service/src/connectors/discovery/ad-ldap.js

const ldap = require('ldapjs'); // npm install ldapjs

// In a real project, consider moving shared utilities like this
// to a dedicated shared utility file and importing it.
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
 * Active Directory / LDAP Discovery Connector Adapter.
 * Discovers user access (e.g., group memberships) from an LDAP directory.
 *
 * This implementation focuses on searching users and reading their attributes,
 * particularly group memberships like 'memberOf'.
 */

/**
 * Performs discovery against an AD/LDAP directory.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": { // Required: LDAP connection details
 * "url": "ldap://your-ldap-server:389", // Required
 * "bindDn": "cn=BindUser,dc=example,dc=com", // Required
 * "bindPassword": "yoursecurepassword" // Required
 * // Add other ldapjs client options here (e.g., connectTimeout, requestTimeout, tlsOptions)
 * },
 * "search": { // Required: LDAP search configuration
 * "userSearchBase": "ou=Users,dc=example,dc=com", // Required: Base DN for user search
 * "userSearchFilter": "(objectClass=user)", // Required: LDAP filter for users
 * "userSearchAttributes": ["dn", "sAMAccountName", "userPrincipalName", "memberOf", "mail", "displayName"], // Required: Attributes to fetch
 * "userSearchScope": "sub" | "one" | "base", // Optional, default 'sub'
 * "sizeLimit": 0, // Optional, default 0 (no limit)
 * "timeLimit": 10, // Optional, default 10 seconds
 * "timestampAttributeForIncremental": "modifyTimestamp" // Optional: Attribute name for incremental sync filter
 * // Add other search options
 * }
 * // Add other adapter specific options
 * }
 * @param {object} mappingRules - The Discovery MappingConfig for this application (SourceType: Discovery, TargetType: DiscoveredStateMapping).
 * Expected mappingRules.mappingRules.discoveredStateMapping structure (example):
 * {
 * "uniqueIdentifierSourceField": "sAMAccountName", // Field in raw LDAP entry for the user's ID in the target app (e.g., sAMAccountName, userPrincipalName, dn) (required)
 * "entitlementIdentifierSourceField": "memberOf", // Field in raw LDAP entry for the entitlement ID (e.g., 'memberOf', 'member') (required)
 * "attributeMapping": { // Map attributes from raw data to CurrentAppState metadata (optional)
 * "displayName": "displayName", // Map raw 'displayName' to metadata.displayName
 * "email": "mail", // Map raw 'mail' to metadata.email
 * // Add other attribute mappings
 * }
 * // userMapping and entitlementMapping are handled by StateStorage.js, but referenced here for field names.
 * // userMapping: { "sourceField": "sAMAccountName", "targetField": "email" },
 * // entitlementMapping: { "sourceField": "memberOf", "targetField": "applicationEntitlementId" },
 * }
 * @param {string} lastRunTimestamp - ISO 8601 timestamp of the previous successful discovery run (if available). Used for incremental sync.
 * @returns {Promise<Array<object>>} A promise resolving with an array of standardized raw discovered records, ready for StateStorage.js.
 * Returns Array<{ appSpecificUserId: string, appSpecificEntitlementId: string, discoveredAt: Date, metadata: object }>.
 * @throws {Error} If a critical configuration, connection, bind, or search failure occurs.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service'; // Or pass service name from options
    console.log(`[AD/LDAP Discovery Connector] Starting data discovery for application ${configDetails?.name}.`);

    let client = null; // ldapjs client instance
    const rawDiscoveredEntries = []; // Array to hold raw LDAP entry objects

    try {
        // --- 1. Read Config and Validate ---
        const connConfig = configDetails?.connection;
        const searchConfig = configDetails?.search;
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping; // How to map raw data

        // Validate essential configuration
        if (!connConfig?.url || !connConfig?.bindDn || !connConfig?.bindPassword) {
             throw new Error("Invalid LDAP connection configuration: Missing url, bindDn, or bindPassword.");
        }
        if (!searchConfig?.userSearchBase || !searchConfig?.userSearchFilter || !searchConfig?.userSearchAttributes || !Array.isArray(searchConfig.userSearchAttributes) || searchConfig.userSearchAttributes.length === 0) {
             throw new Error("Invalid LDAP search configuration: Missing userSearchBase, userSearchFilter, or userSearchAttributes (must be non-empty array).");
        }
        // Validate essential mapping rules for processing search results
        if (!discoveryMappingRules?.uniqueIdentifierSourceField || !discoveryMappingRules?.entitlementIdentifierSourceField) {
            const missingField = !discoveryMappingRules?.uniqueIdentifierSourceField ? 'uniqueIdentifierSourceField' : 'entitlementIdentifierSourceField';
            throw new Error(`Invalid Discovery Mapping configuration: Missing essential field "${missingField}" in discoveredStateMapping rules.`);
        }

        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Field in raw data for app user ID
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Field in raw data for app entitlement ID
        const attributeMappingRules = discoveryMappingRules.attributeMapping || {}; // Rules for mapping raw attributes to metadata


        // --- 2. Establish LDAP Connection and Bind ---
        console.log(`[AD/LDAP Discovery Connector] Attempting to connect to ${connConfig.url}...`);
        try {
             // Use createClient options from configDetails.connection if provided
             const clientOptions = {
                 url: connConfig.url,
                 connectTimeout: connConfig.connectTimeout || 5000, // Default 5s
                 requestTimeout: connConfig.requestTimeout || 10000, // Default 10s
                 // Add other options like tlsOptions if needed
                 ...connConfig
             };
             client = ldap.createClient(clientOptions);

             // Add a generic error listener for client-level errors
             client.on('error', (err) => {
                 console.error('[AD/LDAP Discovery Connector] LDAP client error:', err);
                 // This catches errors not tied to a specific operation.
                 // Depending on the error, you might need more sophisticated handling (e.g., attempt reconnect).
             });

             // Bind asynchronously
             console.log(`[AD/LDAP Discovery Connector] Binding as ${connConfig.bindDn}...`);
             await new Promise((resolve, reject) => {
                  client.bind(connConfig.bindDn, connConfig.bindPassword, (err) => {
                      if (err) {
                          console.error('[AD/LDAP Discovery Connector] LDAP bind failed:', err);
                          reject(err); // Reject the promise on bind failure
                      } else {
                          resolve(); // Resolve on successful bind
                      }
                  });
             });
             console.log(`[AD/LDAP Discovery Connector] Successfully bound to LDAP server.`);

        } catch (bindError) {
             console.error(`[AD/LDAP Discovery Connector] Failed to connect or bind:`, bindError);
             // Ensure client is destroyed on connection/bind failure
             if (client) { try { client.destroy(); } catch(e) { console.error('[AD/LDAP Discovery Connector] Error destroying client after bind failure:', e); } }
             throw new Error(`LDAP Discovery connector failed to connect or bind: ${bindError.message}`); // Critical failure
        }


        // --- 3. Perform Search Operation and Collect Raw Data ---
        const userSearchBase = searchConfig.userSearchBase;
        const userSearchFilter = searchConfig.userSearchFilter;
        const userSearchAttributes = searchConfig.userSearchAttributes;
        const userSearchScope = searchConfig.userSearchScope || 'sub'; // Default 'sub'
        const sizeLimit = searchConfig.sizeLimit || 0; // Default 0 (no limit)
        const timeLimit = searchConfig.timeLimit || 10; // Default 10 seconds

        const userSearchOptions = {
             filter: userSearchFilter,
             scope: userSearchScope,
             attributes: userSearchAttributes,
             sizeLimit: sizeLimit,
             timeLimit: timeLimit
             // Add other ldapjs search options from configDetails.search
             // paged: { pageSize: 250 } // Example: Enable pagination if needed and supported
        };

        // --- Handle Incremental Sync Filter ---
        // LDAP filters are strings. Constructing a valid incremental filter depends heavily
        // on the specific LDAP server (OpenLDAP, Active Directory) and the attribute used
        // for timestamps (e.g., modifyTimestamp, whenChanged). Active Directory uses specific
        // Generalized Time format or integer-based timestamps (like AD timestamp).
        // This is complex and requires specific knowledge of the target LDAP schema and timestamp format.
        const timestampAttributeForIncremental = searchConfig.timestampAttributeForIncremental;
        let effectiveSearchFilter = userSearchFilter; // Start with the base filter

        if (lastRunTimestamp && timestampAttributeForIncremental) {
             console.warn(`[AD/LDAP Discovery Connector] Attempting incremental sync using attribute "${timestampAttributeForIncremental}" and last run timestamp ${lastRunTimestamp}.`);
             try {
                  // Example (conceptual) of adding a timestamp filter.
                  // This WILL LIKELY NEED ADJUSTMENT based on the actual LDAP server and timestamp format.
                  // Converting ISO 8601 to LDAP Generalized Time format (YYYYMMDDHHMMSS.Z)
                  const lastRunDate = new Date(lastRunTimestamp);
                  // Check if the date is valid
                  if (isNaN(lastRunDate.getTime())) {
                       console.error(`[AD/LDAP Discovery Connector] Invalid lastRunTimestamp format received: "${lastRunTimestamp}". Performing full sync.`);
                       effectiveSearchFilter = userSearchFilter; // Revert to full filter
                   } else {
                       // This formatting is highly dependent on the attribute and server.
                       // Active Directory typically uses 'whenChanged' which is Generalized Time.
                       // OpenLDAP often uses 'modifyTimestamp' which is also Generalized Time.
                       // Ensure the date object is correctly formatted for the LDAP server.
                       // Example Generalized Time (YYYYMMDDHHMMSS.Z) - need to handle milliseconds/timezone carefully.
                       // ldapjs might handle serialization for certain filters, but direct string manipulation is common.
                       // const formattedTimestamp = formatTimestampForLdap(lastRunDate, timestampAttributeForIncremental); // Custom helper needed

                       // A simple timestamp filter might look like:
                       // `(${timestampAttributeForIncremental}>=${formattedTimestamp})`
                       // Combining with the base filter using AND ('&'):
                       // `&(${userSearchFilter})(${timestampAttributeForIncremental}>=${formattedTimestamp})`

                       // For now, log a warning and perform full sync unless a specific filter template is provided.
                       // A better approach would be a config option like `incrementalFilterTemplate`.
                       console.warn('[AD/LDAP Discovery Connector] LDAP incremental sync timestamp filtering is complex and not fully implemented generically. Performing full sync.');
                       effectiveSearchFilter = userSearchFilter; // Revert to full filter
                   }

             } catch (e) {
                 console.error('[AD/LDAP Discovery Connector] Error preparing incremental filter, performing full sync:', e);
                 effectiveSearchFilter = userSearchFilter; // Revert to full filter
             }
        }
        userSearchOptions.filter = effectiveSearchFilter; // Use the determined filter


        console.log(`[AD/LDAP Discovery Connector] Searching users in "${userSearchBase}" with filter "${userSearchOptions.filter}", scope "${userSearchOptions.scope}"...`);

        // Execute the search and collect entries
        const searchPromise = new Promise((resolve, reject) => {
             const entries = [];
             const search = client.search(userSearchBase, userSearchOptions); // Get the search object

             search.on('searchEntry', (entry) => {
                 // Collect each user entry found
                 if (entry.object) {
                     // Clean potential null bytes from attribute values if present (common in some directory exports)
                     const cleanedObject = cleanNullBytes(entry.object);
                     entries.push(cleanedObject); // entry.object is the JS object representation
                 } else {
                      console.warn('[AD/LDAP Discovery Connector] Received searchEntry with missing object property.');
                 }
             });

              search.on('searchReference', (referral) => {
                  // Handle referrals if necessary (e.g., following them)
                  console.log('[AD/LDAP Discovery Connector] Received searchReference:', referral.uris);
              });

             search.on('error', (searchErr) => {
                 console.error('[AD/LDAP Discovery Connector] LDAP search result stream error:', searchErr);
                 // Errors during the search *stream* (e.g., connection dropped)
                 reject(searchErr);
             });

             search.on('end', (result) => {
                 // Search finished
                 if (result.status !== 0) {
                     // Non-zero status indicates an LDAP error during search (e.g., size limit exceeded - 4, time limit - 3, auth - 49)
                     console.error('[AD/LDAP Discovery Connector] LDAP search finished with non-zero status:', result.status, result.errorMessage);
                     // Check for specific statuses if some should be treated differently (e.g., sizeLimit exceeded might still yield partial results)
                     // For now, treat any non-zero status as a search failure.
                      reject(new Error(`LDAP search finished with status ${result.status}: ${result.errorMessage}`));
                 } else {
                     // Status 0 means success
                     console.log(`[AD/LDAP Discovery Connector] LDAP search successful. Found ${entries.length} entries.`);
                     resolve(entries); // Resolve with the collected entries
                 }
             });

        });

        rawDiscoveredEntries.push(...await searchPromise); // Execute the search promise and collect results

        console.log(`[AD/LDAP Discovery Connector] Collected ${rawDiscoveredEntries.length} raw LDAP entries.`);


        // --- 4. Process Raw LDAP Entries and Create Standardized Records ---
        // Iterate through the raw LDAP entry objects
        const standardizedRecords = [];
        const userEntryCount = rawDiscoveredEntries.length;

        for (const rawEntryObject of rawDiscoveredEntries) {
             // Extract user ID from the entry using the configured field name
             // Ensure the extracted user ID is a string and clean null bytes/trim whitespace
             const appSpecificUserIdRaw = getNestedValue(rawEntryObject, rawUserIdentifierField);
             const appSpecificUserId = (typeof appSpecificUserIdRaw === 'string' ? appSpecificUserIdRaw.trim() : String(appSpecificUserIdRaw || '')).replace(/\0/g, ''); // Clean null bytes, trim, ensure string

             if (!appSpecificUserId) {
                 console.warn(`[AD/LDAP Discovery Connector] Skipping LDAP entry: Missing or empty user ID field ("${rawUserIdentifierField}"). Raw entry object:`, rawEntryObject);
                  // TODO: Log raw entry causing the skip more detail if needed for debugging
                  continue; // Skip this entry if user ID is missing or empty
             }

             // Extract entitlements (e.g., group memberships from 'memberOf' attribute)
             // The rawEntitlementIdentifierField points to the attribute containing entitlements (e.g., 'memberOf')
             const rawEntitlementsRaw = getNestedValue(rawEntryObject, rawEntitlementIdentifierField); // This should be an array or a single value

             // Ensure rawEntitlements is handled as an array of strings
             let entitlementValues = [];
             if (Array.isArray(rawEntitlementsRaw)) {
                 entitlementValues = rawEntitlementsRaw.map(String).map(s => s.replace(/\0/g, '').trim()).filter(s => s.length > 0); // Ensure strings, clean, trim, filter empty
             } else if (rawEntitlementsRaw !== undefined && rawEntitlementsRaw !== null && String(rawEntitlementsRaw).trim().length > 0) {
                 entitlementValues = [String(rawEntitlementsRaw).replace(/\0/g, '').trim()]; // Handle single non-empty value
             }
             // If entitlementValues is empty, it means the user has no entries for the configured entitlement attribute.


             // Create a standardized record for *each* entitlement found for this user
             // If a user has no entitlements for the specified attribute, they won't generate any records here.
             // This is usually fine for access discovery; StateStorage can handle users without any entries.
             for (const rawEntitlementValue of entitlementValues) {
                  const appSpecificEntitlementId = rawEntitlementValue; // The cleaned raw entitlement value is the appSpecificEntitlementId

                  // Map other attributes from the entry to CurrentAppState metadata
                  const metadata = {};
                   // Create a copy of the raw object data to pass to getNestedValue for attribute mapping
                   const rawAttributeData = { ...rawEntryObject }; // Shallow clone is usually sufficient unless attributes are deeply nested objects

                  for(const metaKey in attributeMappingRules) {
                       if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                           const rawField = attributeMappingRules[metaKey];
                           metadata[metaKey] = getNestedValue(rawAttributeData, rawField); // Get value from raw entry object
                       }
                  }

                  // Add to the array of standardized records
                  standardizedRecords.push({
                       appSpecificUserId: appSpecificUserId, // User ID for the target app (cleaned string)
                       appSpecificEntitlementId: appSpecificEntitlementId, // Entitlement ID for the target app (cleaned string, e.g., Group DN)
                       // Optional: Add other relevant fields if available and mapped
                       // discoveredAt: new Date(), // This timestamp is added by StateStorage, not the connector
                       metadata: metadata // Other mapped attributes (JSONB)
                  });
             }

             // Log if a user entry was processed but yielded no entitlement records
             if (entitlementValues.length === 0 && rawDiscoveredEntries.length > 0) {
                  console.log(`[AD/LDAP Discovery Connector] Processed user "${appSpecificUserId}" but found no entries for entitlement attribute "${rawEntitlementIdentifierField}". No standardized records generated for this user.`);
             }
        }

        console.log(`[AD/LDAP Discovery Connector] Parsed ${userEntryCount} LDAP entries. Generated ${standardizedRecords.length} standardized records.`);

        // --- 5. Return Data ---
        return standardizedRecords; // Array of standardized records, ready for StateStorage

    } catch (error) {
        console.error('[AD/LDAP Discovery Connector] Overall error during discovery:', error);
        // Re-throw the error so the calling logic (DiscoveryLogic) can handle it
        throw error;
    } finally {
        // --- 6. Close Connection ---
        // Ensure the LDAP client connection is unbound and destroyed
        if (client) {
             try {
                 // It's good practice to unbind before destroying, though destroy might handle it.
                 // Unbind is asynchronous, but we don't need to await it in finally if destroying immediately after.
                 client.unbind(() => {
                     console.log('[AD/LDAP Discovery Connector] LDAP client unbound.');
                     client.destroy(); // Destroy the client (closes connection)
                     console.log('[AD/LDAP Discovery Connector] LDAP client destroyed.');
                 });
             } catch (closeError) {
                 console.error('[AD/LDAP Discovery Connector] Error closing LDAP connection in finally block:', closeError);
             }
         } else {
             console.log('[AD/LDAP Discovery Connector] LDAP client was not initialized.');
         }
    }
}

// Helper function to clean null bytes from an object's string values
function cleanNullBytes(obj) {
    if (obj === null || typeof obj !== 'object') {
        if (typeof obj === 'string') {
            return obj.replace(/\0/g, ''); // Remove null bytes from strings
        }
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => cleanNullBytes(item)); // Recurse for array elements
    }

    const cleaned = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            cleaned[key] = cleanNullBytes(obj[key]); // Recurse for object properties
        }
    }
    return cleaned;
}


module.exports = {
    discoverAccess,
    // addtional methods if needed (e.g., discoverEntitlements - if discovery is separate from access)
};