// services/discovery-service/src/connectors/discovery/app-db-oracle.js
const oracledb = require('oracledb'); // You will need to install: npm install oracledb in services/discovery-service

// Configure oracledb properties (e.g., connection pool defaults) if needed
// oracledb.initOracleClient(); // Required if not using Instant Client in standard locations
// Set default fetch format to object for easier access to column names
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

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
 * Oracle Database Discovery Connector Adapter.
 * Discovers user access from an Oracle database via SQL queries.
 *
 * Note: This adapter relies on a predefined discovery SQL query configuration
 * to fetch raw access data.
 */

/**
 * Performs discovery against an Oracle database.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": { // Required: Oracle connection details
 * "user": "dbuser", // Required
 * "password": "dbpassword", // Required
 * "connectString": "your_oracle_connect_string" // Required (e.g., localhost:1521/servicename, or a TNS entry alias)
 * // Add other oracledb connection options (e.g., pool config if using pool, connectTimeout)
 * },
 * "discovery": { // Required: Discovery-specific configuration
 * "query": "SELECT user_id, role_id, assigned_date FROM app_user_roles", // Required: Full discovery query
 * "incrementalQuery": "SELECT user_id, role_id, assigned_date, updated_at FROM app_user_roles WHERE updated_at > :lastRunTimestamp", // Optional: Incremental query using :lastRunTimestamp bind parameter
 * "timestampFieldForIncremental": "updated_at" // Required if incrementalQuery is used: Name of the timestamp column used in the WHERE clause filter
 * // Add other discovery specific options (e.g., fetchArraySize)
 * }
 * // Add other adapter specific options
 * }
 * @param {object} mappingRules - The Discovery MappingConfig for this application (SourceType: Discovery, TargetType: DiscoveredStateMapping).
 * Expected mappingRules.mappingRules.discoveredStateMapping structure (example):
 * {
 * "uniqueIdentifierSourceField": "USER_ID", // Column name in SQL results for the user's ID in the target app (required, case-sensitive matching for Oracle)
 * "entitlementIdentifierSourceField": "ROLE_ID", // Column name in SQL results for the entitlement ID in the target app (required, case-sensitive matching)
 * "attributeMapping": { // Map columns from raw SQL results to CurrentAppState metadata (optional)
 * "assignedDate": "ASSIGNED_DATE", // Map raw 'ASSIGNED_DATE' column to metadata.assignedDate
 * "updatedAt": "UPDATED_AT", // Map raw 'UPDATED_AT' column to metadata.updatedAt
 * // Add other column mappings
 * }
 * // userMapping and entitlementMapping are handled by StateStorage.js, but referenced here for context.
 * // userMapping: { "sourceField": "USER_ID", "targetField": "hrmsId" },
 * // entitlementMapping: { "sourceField": "ROLE_ID", "targetField": "applicationEntitlementId" },
 * }
 * @param {string} lastRunTimestamp - ISO 8601 timestamp string of the previous successful discovery run (if available). Used for incremental sync.
 * @returns {Promise<Array<object>>} A promise resolving with an array of standardized raw discovered records, ready for StateStorage.js.
 * Returns Array<{ appSpecificUserId: string, appSpecificEntitlementId: string, metadata: object }>.
 * @throws {Error} If a critical configuration, database connection, or query execution failure occurs.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service'; // Or pass service name from options
    console.log(`[Oracle DB Discovery Connector] Starting data discovery from Oracle DB for application ${configDetails?.name}.`);
    // console.log(`[Oracle DB Discovery Connector] Config details (excluding password):`, { ...configDetails?.connection, password: '***' });
    console.log(`[Oracle DB Discovery Connector] Last Run Timestamp:`, lastRunTimestamp);

    let connection = null; // oracledb connection instance
    const discoveredRecords = []; // Array to hold standardized discovered access records

    try {
        // --- 1. Read Config and Validate ---
        const dbConfig = configDetails?.connection;
        const discoveryConfig = configDetails?.discovery;
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping;

        // Validate essential configuration
        if (!dbConfig?.user || !dbConfig?.password || !dbConfig?.connectString) {
            throw new Error("Invalid Oracle DB connector configuration: Missing connection details (user, password, connectString).");
        }
        if (!discoveryConfig || (!discoveryConfig.query && !discoveryConfig.incrementalQuery)) {
            throw new Error("Invalid Oracle DB connector configuration: Missing 'discovery.query' or 'discovery.incrementalQuery'. At least one query must be defined.");
        }
         // Validate essential mapping rules for processing query results
         if (!discoveryMappingRules?.uniqueIdentifierSourceField || !discoveryMappingRules?.entitlementIdentifierSourceField) {
             const missingField = !discoveryMappingRules?.uniqueIdentifierSourceField ? 'uniqueIdentifierSourceField' : 'entitlementIdentifierSourceField';
             throw new Error(`Invalid Discovery Mapping configuration: Missing essential field "${missingField}" in discoveredStateMapping rules.`);
         }
         // attributeMappingRules can be empty, so no strict check needed there, but ensure it's an object
         const attributeMappingRules = discoveryMappingRules.attributeMapping || {};


        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Column name in SQL results for app user ID
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Column name in SQL results for app entitlement ID


        // --- 2. Establish Connection ---
        console.log(`[Oracle DB Discovery Connector] Connecting to Oracle database...`);
        try {
            // In a production multi-threaded scenario, consider using a connection pool (await oracledb.createPool(dbConfig)).
            // For a single worker process per task, a single connection is usually sufficient but less resilient to connection drops.
            // Using getConnection here for simplicity in the example.
             const connectionOptions = {
                 // Add options like connectTimeout if supported by oracledb version/setup
                 // connectTimeout: 5000, // Example timeout
                 ...dbConfig // Spread other config properties (user, password, connectString)
             };
            connection = await oracledb.getConnection(connectionOptions);

             // Note: oracledb connections are typically not event emitters like pg or ldapjs for general errors
             // Errors usually manifest when executing a query.

            console.log(`[Oracle DB Connector] Successfully connected to Oracle.`);
        } catch (connError) {
            console.error('[Oracle DB Connector] Failed to connect to database:', connError.message);
            throw new Error(`Oracle DB connector failed to connect: ${connError.message}`); // Critical failure
        }


        // --- 3. Construct and Execute Discovery Query ---
        let query;
        let queryParams = {}; // For bind parameters (:paramName)

        // Decide which query to run (incremental vs. full)
        // Check if incremental query is configured AND lastRunTimestamp is available and valid
        const hasIncrementalConfig = discoveryConfig.incrementalQuery && discoveryConfig.timestampFieldForIncremental;
        let isIncrementalRun = false;

        if (lastRunTimestamp && hasIncrementalConfig) {
             try {
                 const lastRunDate = new Date(lastRunTimestamp);
                 // Check if the date is valid
                 if (isNaN(lastRunDate.getTime())) {
                     console.warn(`[Oracle DB Discovery Connector] Invalid lastRunTimestamp format received: "${lastRunTimestamp}". Performing full sync.`);
                      query = discoveryConfig.query; // Fallback to full query
                 } else {
                     // Use the incremental query and bind the timestamp parameter
                     query = discoveryConfig.incrementalQuery;
                     // oracledb handles binding Date objects correctly. The bind parameter name must match ':paramName' in the SQL.
                     // We assume the incremental query uses a bind parameter named :lastRunTimestamp.
                     queryParams = { lastRunTimestamp: lastRunDate };
                     isIncrementalRun = true;
                     console.log(`[Oracle DB Connector] Running incremental discovery query since ${lastRunDate.toISOString()}.`);
                     // TODO: Add a check that the incrementalQuery string contains the bind parameter name (e.g., ':lastRunTimestamp')
                     if (!query.includes(':lastRunTimestamp')) {
                          console.warn('[Oracle DB Connector] Incremental query configured but does not contain :lastRunTimestamp bind parameter. Timestamp will not be used for filtering. Performing query as written.');
                          queryParams = {}; // Clear parameters if not used by query string
                     }
                 }
             } catch (e) {
                 console.error('[Oracle DB Connector] Error processing lastRunTimestamp for incremental query, performing full sync:', e);
                 query = discoveryConfig.query; // Fallback to full query
             }
        } else if (discoveryConfig.query) {
             // No valid lastRunTimestamp or incremental config missing, run full query
             query = discoveryConfig.query;
             console.log('[Oracle DB Connector] Running full discovery query.');
              if (lastRunTimestamp && !hasIncrementalConfig) {
                   console.warn('[Oracle DB Connector] lastRunTimestamp is available, but no incrementalQuery/timestampFieldForIncremental is configured. Performing full sync.');
               }
        } else {
             // This case should be caught by initial validation, but as a safeguard
             throw new Error("No valid discovery query ('discovery.query' or 'discovery.incrementalQuery') defined in config.");
        }

        console.log(`[Oracle DB Discovery Connector] Executing query${isIncrementalRun ? ' (incremental)' : ' (full)'}: "${query}"`);

        let result;
        try {
            // Execute the query. outFormat is set globally, but can be overridden here.
            result = await connection.execute(query, queryParams); // outFormat: oracledb.OUT_FORMAT_OBJECT is default now

            console.log(`[Oracle DB Connector] Query executed successfully. Fetched ${result.rows.length} raw records.`);
        } catch (queryError) {
             console.error('[Oracle DB Connector] Error executing discovery query:', queryError.message);
             throw new Error(`Oracle DB connector failed to execute query: ${queryError.message}`); // Critical failure
        }


        // --- 4. Map Raw Query Results to Standardized Records ---
        // Iterate through the result rows (which are objects with column names matching aliases/names due to outFormat: OBJECT)
        if (result && Array.isArray(result.rows) && result.rows.length > 0) {
             const rawRowCount = result.rows.length;
             console.log(`[Oracle DB Connector] Mapping ${rawRowCount} raw rows to standardized records...`);

             for (const rawRow of result.rows) {
                 let appSpecificUserId = getNestedValue(rawRow, rawUserIdentifierField);
                 let appSpecificEntitlementId = getNestedValue(rawRow, rawEntitlementIdentifierField);

                 // Ensure extracted identifiers are not null/undefined and are strings
                 const cleanedAppSpecificUserId = (appSpecificUserId !== undefined && appSpecificUserId !== null) ? String(appSpecificUserId) : undefined;
                 const cleanedAppSpecificEntitlementId = (appSpecificEntitlementId !== undefined && appSpecificEntitlementId !== null) ? String(appSpecificEntitlementId) : undefined;

                 if (!cleanedAppSpecificUserId || !cleanedAppSpecificEntitlementId) {
                     console.warn(`[Oracle DB Connector] Skipping raw row: Missing required identifiers (User field "${rawUserIdentifierField}" or Entitlement field "${rawEntitlementIdentifierField}"). Raw data:`, rawRow);
                      // TODO: Log details of the skipped raw row if needed for debugging
                      continue; // Skip this record if identifiers are missing
                 }

                 // Map other raw attributes to CurrentAppState metadata
                 const metadata = {};
                  // Create a copy of the raw object data to pass to getNestedValue for attribute mapping
                  const rawAttributeData = { ...rawRow }; // Shallow clone is usually sufficient

                 for(const metaKey in attributeMappingRules) {
                      if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                          const rawField = attributeMappingRules[metaKey]; // e.g. "STATUS_COLUMN"
                          metadata[metaKey] = getNestedValue(rawAttributeData, rawField); // Get value from raw row
                      }
                 }
                  // Ensure metadata is a non-null object
                  if (typeof metadata !== 'object' || metadata === null) metadata = {};


                 // Add the mapped object to the array of standardized records
                 discoveredRecords.push({
                      appSpecificUserId: cleanedAppSpecificUserId, // User ID for the target app (string)
                      appSpecificEntitlementId: cleanedAppSpecificEntitlementId, // Entitlement ID for the target app (string)
                      // Optional: Add other relevant fields if available and mapped directly
                      // from the raw row without specific mapping rules if they are standard (less common).
                      // discoveredAt: new Date(), // This timestamp is added by StateStorage, not the connector
                      metadata: metadata // Other mapped attributes (JSONB)
                 });
             }
             console.log(`[Oracle DB Connector] Mapped ${discoveredRecords.length} standardized records.`);
        } else {
             console.log(`[Oracle DB Connector] Query returned no rows or data is not in expected format.`);
        }

    } catch (error) {
        console.error('[Oracle DB Discovery Connector] Overall error during discovery:', error);
        // Re-throw the error so the calling logic (DiscoveryLogic) can handle it
        throw error;
    } finally {
        // --- 5. Close Connection ---
        // Ensure the database connection is always closed if it was opened.
        if (connection) {
            try {
                 // If using a pool, release the connection: await connection.release();
                 await connection.close(); // Close the direct connection
                 console.log('[Oracle DB Connector] DB connection closed in finally block.');
            } catch (closeError) {
                 console.error('[Oracle DB Connector] Error closing DB connection in finally block:', closeError);
            }
         } else {
             console.log('[Oracle DB Connector] DB connection was not initialized or connected.');
         }
    }

    // --- 6. Return Data ---
    // The adapter returns the array of standardized records. StateStorage will handle storing them.
    return discoveredRecords;
}

// Helper function to get a value from a nested object path (copied locally for self-containment)
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


module.exports = {
    discoverAccess,
    // addtional methods if needed (e.g., discoverUsers, discoverEntitlements if using a different strategy)
};