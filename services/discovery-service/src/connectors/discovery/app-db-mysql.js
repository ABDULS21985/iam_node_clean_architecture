// services/discovery-service/src/connectors/discovery/app-db-mysql.js
const mysql = require('mysql2/promise'); // npm install mysql2 in services/discovery-service

/**
 * Helper function to get a value from a nested object path.
 */
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}


/**
 * MySQL Database Discovery Connector Adapter.
 * Discovers user access from a MySQL database via SQL queries.
 *
 * Note: This adapter relies on a predefined discovery SQL query configuration.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service'; // Or pass serviceName from options
    console.log(`[MySQL DB Connector] Starting data discovery from MySQL DB.`);
    // Log config details carefully - remove password
    const connectionConfigForLog = { ...configDetails?.connection };
    if (connectionConfigForLog.password) connectionConfigForLog.password = '********';
    console.log(`[MySQL DB Connector] Config details (connection):`, connectionConfigForLog);
    console.log(`[MySQL DB Connector] Last Run Timestamp:`, lastRunTimestamp);


    let connection = null; // mysql2 connection instance or pool
    const discoveredRecords = []; // Array to hold standardized discovered access records

    try {
        // 1. Read Config and Validate
        const dbConfig = configDetails?.connection;
        const discoveryConfig = configDetails?.discovery; // Discovery specific config
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping; // How to map discovered data

        if (!dbConfig || !dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
            throw new Error("Invalid MySQL DB connector configuration: Missing connection details.");
        }
        if (!discoveryConfig || (!discoveryConfig.query && !discoveryConfig.incrementalQuery)) {
            throw new Error("Invalid MySQL DB connector configuration: Missing 'discovery.query' or 'discovery.incrementalQuery'.");
        }
         if (!discoveryMappingRules || !discoveryMappingRules.uniqueIdentifierSourceField || !discoveryMappingRules.entitlementIdentifierSourceField) {
             console.error("[MySQL DB Connector] Missing or incomplete Discovery Mapping Rules. Cannot standardize output.");
             throw new Error("Missing or incomplete Discovery Mapping Rules."); // Critical for interpreting results
         }

        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Field in raw data for app user ID
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Field in raw data for app entitlement ID
        const attributeMappingRules = discoveryMappingRules.attributeMapping || {}; // Rules for mapping raw attributes to metadata


        // 2. Establish Connection
        console.log(`[MySQL DB Connector] Connecting to MySQL database ${dbConfig.database}...`);
        try {
            // Use createPool for connection pooling in a multi-threaded scenario
            // For a single worker thread, a simple connection is fine, but a pool is more robust for multiple queries.
             connection = await mysql.createConnection(dbConfig); // Or get connection from a pool
             console.log(`[MySQL DB Connector] Successfully connected to MySQL.`);
        } catch (connError) {
            console.error('[MySQL DB Connector] Failed to connect to database:', connError.message);
            throw new Error(`MySQL DB connector failed to connect: ${connError.message}`); // Critical failure
        }


        // 3. Construct and Execute Discovery Query
        let query;
        let queryParams = []; // For prepared statement parameters (?)

        // Decide which query to run (incremental vs. full)
        // Check if incremental query is possible AND configured AND lastRunTimestamp is available
        if (lastRunTimestamp && discoveryConfig.incrementalQuery && discoveryConfig.timestampFieldForIncremental) {
            query = discoveryConfig.incrementalQuery;
            // MySQL uses '?' placeholders. Ensure the query uses '?' and provide parameters in an array.
            // Assuming the incremental query uses a single '?' placeholder for the timestamp.
            // The timestamp needs to be formatted correctly for MySQL, depending on the target column type (DATETIME, TIMESTAMP).
            // mysql2 handles Date objects reasonably well for binding.
             queryParams = [lastRunTimestamp];
             console.log(`[MySQL DB Connector] Running incremental discovery query since ${lastRunTimestamp.toISOString()}.`);
             // TODO: Validate that the query string actually contains '?' placeholders matching queryParams count
        } else if (discoveryConfig.query) {
            query = discoveryConfig.query; // Use the base query
            console.log('[MySQL DB Connector] Running full discovery query.');
             // Check if the base query *should* be filtered but isn't
             if (lastRunTimestamp && !discoveryConfig.incrementalQuery) {
                  console.warn('[MySQL DB Connector] lastRunTimestamp is available, but no incrementalQuery is configured. Performing full sync.');
             }
        } else {
             throw new Error("No valid discovery query ('query' or 'incrementalQuery') defined in config.");
        }

        // Execute the query using a prepared statement
        const [rows, fields] = await connection.execute(query, queryParams); // connection.execute is for prepared statements

        console.log(`[MySQL DB Connector] Fetched ${rows.length} raw records.`);


        // 4. Map Raw Query Results to Standardized Records
        // Iterate through the result rows (which are plain objects by default with mysql2)
        if (rows && rows.length > 0) {
             for (const rawRow of rows) {
                 // Map data from the database row using mapping rules
                 const appSpecificUserId = getNestedValue(rawRow, rawUserIdentifierField);
                 const appSpecificEntitlementId = getNestedValue(rawRow, rawEntitlementIdentifierField);

                 if (appSpecificUserId === undefined || appSpecificUserId === null || appSpecificEntitlementId === undefined || appSpecificEntitlementId === null) {
                      console.warn(`[MySQL DB Connector] Skipping raw row: Missing required identifiers (${rawUserIdentifierField} or ${rawEntitlementIdentifierField}) in raw data for Application "${application.name}".`, rawRow);
                      // TODO: Log raw record causing the skip
                      continue; // Skip this record
                 }

                 // Map other raw attributes to CurrentAppState metadata
                 const metadata = {};
                 for(const metaKey in attributeMappingRules) {
                      if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                           const rawField = attributeMappingRules[metaKey]; // e.g. "status_column"
                           metadata[metaKey] = getNestedValue(rawRow, rawField); // Get value from raw row using helper
                      }
                 }

                 // Add the mapped object to the array of standardized records
                 discoveredRecords.push({
                      appSpecificUserId: String(appSpecificUserId), // Ensure string type
                      appSpecificEntitlementId: String(appSpecificEntitlementId), // Ensure string type
                      // Optional: Add other relevant fields if available and mapped
                      // discoveredAt: new Date(), // Can be added here or in StateStorage
                      metadata: metadata
                 });
             }
        } else {
            console.warn(`[MySQL DB Connector] Discovery API response data is not a valid array. Cannot process.`);
            // Decide how to handle non-array response - treat as error or empty?
            // throw new Error("Discovery API response data is not a valid array."); // Treat as error
        }


        console.log(`[MySQL DB Connector] Mapped ${discoveredRecords.length} records to standardized format.`);


    } catch (error) {
        console.error('[MySQL DB Connector] Overall error during discovery:', error);
        throw error; // Re-throw for discoveryLogic
    } finally {
        // 5. Close Connection (or release from pool)
        if (connection) {
             try { await connection.end(); console.log('[MySQL DB Connector] DB connection closed.'); }
             catch(e) { console.error('[MySQL DB Connector] Error closing DB connection:', e); }
         }
    }

    // 6. Return Data
    return discoveredRecords; // Array of standardized records, ready for StateStorage
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
            return undefined;
        }
        current = current[part];
    }
    return current;
}


module.exports = {
    discoverAccess,
    // addtional methods if needed
};// services/discovery-service/src/connectors/discovery/app-db-mysql.js
const mysql = require('mysql2/promise'); // npm install mysql2 in services/discovery-service

/**
 * Helper function to get a value from a nested object path.
 */
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}


/**
 * MySQL Database Discovery Connector Adapter.
 * Discovers user access from a MySQL database via SQL queries.
 *
 * Note: This adapter relies on a predefined discovery SQL query configuration.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service'; // Or pass serviceName from options
    console.log(`[MySQL DB Connector] Starting data discovery from MySQL DB.`);
    // Log config details carefully - remove password
    const connectionConfigForLog = { ...configDetails?.connection };
    if (connectionConfigForLog.password) connectionConfigForLog.password = '********';
    console.log(`[MySQL DB Connector] Config details (connection):`, connectionConfigForLog);
    console.log(`[MySQL DB Connector] Last Run Timestamp:`, lastRunTimestamp);


    let connection = null; // mysql2 connection instance or pool
    const discoveredRecords = []; // Array to hold standardized discovered access records

    try {
        // 1. Read Config and Validate
        const dbConfig = configDetails?.connection;
        const discoveryConfig = configDetails?.discovery; // Discovery specific config
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping; // How to map discovered data

        if (!dbConfig || !dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
            throw new Error("Invalid MySQL DB connector configuration: Missing connection details.");
        }
        if (!discoveryConfig || (!discoveryConfig.query && !discoveryConfig.incrementalQuery)) {
            throw new Error("Invalid MySQL DB connector configuration: Missing 'discovery.query' or 'discovery.incrementalQuery'.");
        }
         if (!discoveryMappingRules || !discoveryMappingRules.uniqueIdentifierSourceField || !discoveryMappingRules.entitlementIdentifierSourceField) {
             console.error("[MySQL DB Connector] Missing or incomplete Discovery Mapping Rules. Cannot standardize output.");
             throw new Error("Missing or incomplete Discovery Mapping Rules."); // Critical for interpreting results
         }

        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Field in raw data for app user ID
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Field in raw data for app entitlement ID
        const attributeMappingRules = discoveryMappingRules.attributeMapping || {}; // Rules for mapping raw attributes to metadata


        // 2. Establish Connection
        console.log(`[MySQL DB Connector] Connecting to MySQL database ${dbConfig.database}...`);
        try {
            // Use createPool for connection pooling in a multi-threaded scenario
            // For a single worker thread, a simple connection is fine, but a pool is more robust for multiple queries.
             connection = await mysql.createConnection(dbConfig); // Or get connection from a pool
             console.log(`[MySQL DB Connector] Successfully connected to MySQL.`);
        } catch (connError) {
            console.error('[MySQL DB Connector] Failed to connect to database:', connError.message);
            throw new Error(`MySQL DB connector failed to connect: ${connError.message}`); // Critical failure
        }


        // 3. Construct and Execute Discovery Query
        let query;
        let queryParams = []; // For prepared statement parameters (?)

        // Decide which query to run (incremental vs. full)
        // Check if incremental query is possible AND configured AND lastRunTimestamp is available
        if (lastRunTimestamp && discoveryConfig.incrementalQuery && discoveryConfig.timestampFieldForIncremental) {
            query = discoveryConfig.incrementalQuery;
            // MySQL uses '?' placeholders. Ensure the query uses '?' and provide parameters in an array.
            // Assuming the incremental query uses a single '?' placeholder for the timestamp.
            // The timestamp needs to be formatted correctly for MySQL, depending on the target column type (DATETIME, TIMESTAMP).
            // mysql2 handles Date objects reasonably well for binding.
             queryParams = [lastRunTimestamp];
             console.log(`[MySQL DB Connector] Running incremental discovery query since ${lastRunTimestamp.toISOString()}.`);
             // TODO: Validate that the query string actually contains '?' placeholders matching queryParams count
        } else if (discoveryConfig.query) {
            query = discoveryConfig.query; // Use the base query
            console.log('[MySQL DB Connector] Running full discovery query.');
             // Check if the base query *should* be filtered but isn't
             if (lastRunTimestamp && !discoveryConfig.incrementalQuery) {
                  console.warn('[MySQL DB Connector] lastRunTimestamp is available, but no incrementalQuery is configured. Performing full sync.');
             }
        } else {
             throw new Error("No valid discovery query ('query' or 'incrementalQuery') defined in config.");
        }

        // Execute the query using a prepared statement
        const [rows, fields] = await connection.execute(query, queryParams); // connection.execute is for prepared statements

        console.log(`[MySQL DB Connector] Fetched ${rows.length} raw records.`);


        // 4. Map Raw Query Results to Standardized Records
        // Iterate through the result rows (which are plain objects by default with mysql2)
        if (rows && rows.length > 0) {
             for (const rawRow of rows) {
                 // Map data from the database row using mapping rules
                 const appSpecificUserId = getNestedValue(rawRow, rawUserIdentifierField);
                 const appSpecificEntitlementId = getNestedValue(rawRow, rawEntitlementIdentifierField);

                 if (appSpecificUserId === undefined || appSpecificUserId === null || appSpecificEntitlementId === undefined || appSpecificEntitlementId === null) {
                      console.warn(`[MySQL DB Connector] Skipping raw row: Missing required identifiers (${rawUserIdentifierField} or ${rawEntitlementIdentifierField}) in raw data for Application "${application.name}".`, rawRow);
                      // TODO: Log raw record causing the skip
                      continue; // Skip this record
                 }

                 // Map other raw attributes to CurrentAppState metadata
                 const metadata = {};
                 for(const metaKey in attributeMappingRules) {
                      if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                           const rawField = attributeMappingRules[metaKey]; // e.g. "status_column"
                           metadata[metaKey] = getNestedValue(rawRow, rawField); // Get value from raw row using helper
                      }
                 }

                 // Add the mapped object to the array of standardized records
                 discoveredRecords.push({
                      appSpecificUserId: String(appSpecificUserId), // Ensure string type
                      appSpecificEntitlementId: String(appSpecificEntitlementId), // Ensure string type
                      // Optional: Add other relevant fields if available and mapped
                      // discoveredAt: new Date(), // Can be added here or in StateStorage
                      metadata: metadata
                 });
             }
        } else {
            console.warn(`[MySQL DB Connector] Discovery API response data is not a valid array. Cannot process.`);
            // Decide how to handle non-array response - treat as error or empty?
            // throw new Error("Discovery API response data is not a valid array."); // Treat as error
        }


        console.log(`[MySQL DB Connector] Mapped ${discoveredRecords.length} records to standardized format.`);


    } catch (error) {
        console.error('[MySQL DB Connector] Overall error during discovery:', error);
        throw error; // Re-throw for discoveryLogic
    } finally {
        // 5. Close Connection (or release from pool)
        if (connection) {
             try { await connection.end(); console.log('[MySQL DB Connector] DB connection closed.'); }
             catch(e) { console.error('[MySQL DB Connector] Error closing DB connection:', e); }
         }
    }

    // 6. Return Data
    return discoveredRecords; // Array of standardized records, ready for StateStorage
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
            return undefined;
        }
        current = current[part];
    }
    return current;
}


module.exports = {
    discoverAccess,
    // addtional methods if needed
};