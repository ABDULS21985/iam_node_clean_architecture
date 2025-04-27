// services/identity-collection-service/src/connectors/identity-collection/hrms-db-postgres.js

// You will need to install the pg library in the Identity Collection Service directory:
// cd services/identity-collection-service
// npm install pg
// cd src/connectors/identity-collection

const { Client } = require('pg'); // Import the Client class from pg

/**
 * Helper function to get a value from a nested object path (copy from provisioningLogic or use shared utility if available).
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
 * PostgreSQL HRMS Database Connector Adapter.
 * Connects to a PostgreSQL database to pull HRMS data.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure (based on your config script data):
 * {
 * "dbType": "postgres", // Specify database type for the adapter (used for routing)
 * "connection": { // Required: PostgreSQL connection details
 * "host": "...", // Required
 * "port": ..., // Optional, default 5432
 * "database": "...", // Required
 * "user": "...", // Required
 * "password": "...", // Required
 * // Add other pg Client/Pool configuration options (e.g., connectTimeoutMillis, idleTimeoutMillis)
 * },
 * "query": "SELECT ... FROM ... WHERE ...", // Required: The full or base query
 * // Optional fields for incremental pulls:
 * // "incrementalQuery": "SELECT ... FROM ... WHERE update_timestamp_field > $1", // Query with $1 placeholder
 * // "timestampFieldForIncremental": "update_timestamp_field" // The HRMS field used for incremental
 * // Add other adapter specific options
 * }
 * @param {object} mappingRules - The User Mapping Config (HRMS -> IGLM User). Not strictly needed for raw data collection, but included for context.
 * @param {Date|null} lastRunTimestamp - The end time of the last successful collection run.
 * Used for incremental pulls if supported by configDetails.
 * @returns {Promise<Array<object>>} A promise resolving with an array of HRMS records (objects).
 * @throws {Error} If configuration is invalid, connection fails, query fails, or data is invalid.
 */
async function collectData(configDetails, mappingRules, lastRunTimestamp) { // This is around line 40
    const serviceName = 'identity-collection-service'; // Or pass service name from options
    console.log(`[HRMS-Postgres Connector] Starting data collection from PostgreSQL DB.`);

    // Extract dbConfig from configDetails.configuration. It should be configDetails.connection based on setupConfigs.js
    // Correcting based on setupConfigs.js structure: configDetails is the 'configuration' object.
    const dbConfig = configDetails?.connection; // Extract connection details

    // --- Add this detailed logging ---
    console.log(`[HRMS-Postgres Connector] Debugging received configDetails:`, JSON.stringify(configDetails, null, 2));
    console.log(`[HRMS-Postgres Connector] Debugging extracted dbConfig (configDetails?.connection):`, JSON.stringify(dbConfig, null, 2));
    console.log(`[HRMS-Postgres Connector] Debugging validation checks (checking dbConfig?):`);
    console.log(`[HRMS-Postgres Connector] !dbConfig?.host:`, !dbConfig?.host);
    console.log(`[HRMS-Postgres Connector] !dbConfig?.database:`, !dbConfig?.database);
    console.log(`[HRMS-Postgres Connector] !dbConfig?.user:`, !dbConfig?.user);
    console.log(`[HRMS-Postgres Connector] !dbConfig?.password:`, !dbConfig?.password);
    console.log(`[HRMS-Postgres Connector] Combined validation result (checking dbConfig?):`, (!dbConfig?.host || !dbConfig?.database || !dbConfig?.user || !dbConfig?.password));
    // --- End logging ---

    let client = null; // pg Client instance
    let rawData = []; // Array to hold fetched records

    try {
        // --- 1. Read Config and Validate ---
        // Check essential connection details first, using the extracted dbConfig
        if (!dbConfig?.host || !dbConfig?.database || !dbConfig?.user || !dbConfig?.password) { // This is line ~43 - the line the error pointed to
            throw new Error("Invalid PostgreSQL connection configuration provided."); // Throw specific error
        }

        // Validate query configuration
        const collectionQuery = configDetails?.query; // SQL query string for full collection
        const incrementalQuery = configDetails?.incrementalQuery; // SQL query for incremental collection
        const timestampFieldForIncremental = configDetails?.timestampFieldForIncremental; // Timestamp field in HRMS DB

         if (!collectionQuery && !incrementalQuery) {
              throw new Error("Invalid PostgreSQL query configuration. Need 'query' or 'incrementalQuery'.");
         }

        // uniqueIdFieldInHRMS is used by DataProcessor, not strictly needed by the adapter for raw data collection
        // const uniqueIdFieldInHRMS = configDetails?.uniqueIdFieldInHRMS;
        // if (!uniqueIdFieldInHRMS) {
        //   console.warn("[HRMS-Postgres Connector] 'uniqueIdFieldInHRMS' not specified in configDetails. DataProcessor must get this from MappingConfig.");
        // }


        // --- 2. Establish Database Connection ---
        console.log(`[HRMS-Postgres Connector] Connecting to PostgreSQL database ${dbConfig.database}...`);
        try {
            // Create a new pg Client instance using connection details from dbConfig
            // Pass connectTimeoutMillis from dbConfig if present
             const clientOptions = {
                 connectionTimeoutMillis: dbConfig.connectionTimeoutMillis || 5000, // Default 5s
                 idleTimeoutMillis: dbConfig.idleTimeoutMillis || 30000, // Default 30s
                 ...dbConfig // Spread other config properties (host, port, user, password, database)
             };
            client = new Client(clientOptions);

             // Add error listener for client-level errors (e.g., connection lost)
             client.on('error', (err) => {
                 console.error('[HRMS-Postgres Connector] PostgreSQL client error:', err);
                 // This listener catches errors after connection.
                 // The main query execution below will also catch errors and throw.
             });

            // Connect to the database
            await client.connect();
            console.log('[HRMS-Postgres Connector] Successfully connected to PostgreSQL DB.');


        } catch (connError) {
            console.error('[HRMS-Postgres Connector] Failed to connect to database:', connError.message);
            // Re-throw error to be caught by the main try/catch block and logged in CollectionRun
            throw new Error(`PostgreSQL HRMS data collection failed: ${connError.message}`); // Re-throw with context

        }


        // --- 3. Construct and Execute Query ---
        let query;
        let queryParams = []; // Array for query parameters ($1, $2, etc.)

        // Decide which query to run (incremental vs. full)
        // Check if incremental query is configured AND lastRunTimestamp is available and valid
        const hasIncrementalConfig = incrementalQuery && configDetails.timestampFieldForIncremental;
        let isIncrementalRun = false;

        if (lastRunTimestamp && hasIncrementalConfig) {
             try {
                 const lastRunDate = new Date(lastRunTimestamp);
                 if (isNaN(lastRunDate.getTime())) {
                     console.warn(`[HRMS-Postgres Connector] Invalid lastRunTimestamp format received: "${lastRunTimestamp}". Performing full sync.`);
                      query = collectionQuery; // Fallback to full query
                 } else {
                     query = incrementalQuery;
                     queryParams = [lastRunDate];
                     isIncrementalRun = true;
                     console.log(`[HRMS-Postgres Connector] Running incremental query since ${lastRunDate.toISOString()}.`);
                     // Ensure query uses $1 for the parameter
                     if (!query.includes('$1')) {
                         console.warn('[HRMS-Postgres Connector] Incremental query configured but does not contain $1 placeholder. Parameter will not be used.');
                     }
                 }
             } catch (e) {
                 console.error('[HRMS-Postgres Connector] Error processing lastRunTimestamp for incremental query, performing full sync:', e);
                 query = collectionQuery; // Fallback to full query
             }
        } else if (collectionQuery) {
             // No valid lastRunTimestamp or incremental config missing, run full query
             query = collectionQuery;
             console.log('[HRMS-Postgres Connector] Running base (full) query.');
              if (lastRunTimestamp && !hasIncrementalConfig) {
                   console.warn('[HRMS-Postgres Connector] lastRunTimestamp is available, but no incrementalQuery/timestampFieldForIncremental is configured. Performing full sync.');
               }
        } else {
             throw new Error("No valid query ('query' or 'incrementalQuery') found in configuration.");
        }

        console.log(`[HRMS-Postgres Connector] Executing query${isIncrementalRun ? ' (incremental)' : ' (full)'}: "${query}"`);

        // Execute the query using the client
        const result = await client.query(query, queryParams);

        // Process results
        if (result && Array.isArray(result.rows)) { // Check if rows is an array
            rawData = result.rows; // Collect all rows
             console.log(`[HRMS-Postgres Connector] Fetched ${rawData.length} records.`);
        } else {
             console.warn('[HRMS-Postgres Connector] Query returned no rows or unexpected result structure.');
             rawData = []; // Ensure rawData is an empty array
        }


    } catch (error) {
        console.error('[HRMS-Postgres Connector] Error during data collection:', error);
        // Re-throw the error so collectionLogic can catch and log it in CollectionRun
        // Add context about the connector type
        throw new Error(`PostgreSQL HRMS data collection failed: ${error.message}`);

    } finally {
        // --- 4. Close Connection ---
        // Ensure the database connection is always closed if it was opened.
        if (client) {
            try {
                 await client.end(); // Close the connection
                 console.log('[HRMS-Postgres Connector] PostgreSQL DB connection closed.');
            } catch (closeError) {
                 console.error('[HRMS-Postgres Connector] Error closing PostgreSQL DB connection:', closeError);
                 // Log closing errors but don't necessarily prevent returning data or throwing the main error
            }
        }
    }

    // --- 5. Return Data ---
    // The adapter returns the array of raw data objects. DataProcessor will handle mapping and processing.
    return rawData; // Return the array of fetched records
}

// Helper function to get a value from a nested object path (copy from provisioningLogic or use shared utility if available).
// This helper is needed if HRMS query results have nested structures, though typical SQL results are flat.
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


// --- Module Export ---
module.exports = {
    collectData, // Export the main collection function
    // addtional methods if needed (e.g., testConnection)
};