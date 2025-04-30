// services/identity-collection-service/src/connectors/identity-collection/hrms-db-postgres.js

// Dependencies: Make sure 'pg' is installed in the identity-collection-service
// npm install pg

const { Client } = require('pg'); // Import the Client class from pg

/**
 * Helper function to get a value from a nested object path.
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
 * NOTE: Based on logs, this seems to contain 'mappingRules' at the top level.
 * Expected structure being received (based on logs):
 * {
 * "metadata": { ... },
 * "mappingRules": { // Configuration seems nested under here
 * "connection": { // Required: PostgreSQL connection details
 * "host": "...", // Required
 * "port": ..., // Optional, default 5432
 * "database": "...", // Required
 * "user": "...", // Required
 * "password": "...", // Required
 * "connectionTimeoutMillis": ..., // Optional
 * "idleTimeoutMillis": ... // Optional
 * },
 * "query": "SELECT ... FROM ... WHERE ...", // Required if no incrementalQuery
 * "incrementalQuery": "SELECT ... FROM ... WHERE update_timestamp > $1", // Optional
 * "timestampFieldForIncremental": "update_timestamp" // Required if using incrementalQuery
 * }
 * }
 * @param {object} mappingRulesParam - The User Mapping Config (passed for context, distinct from configDetails.mappingRules).
 * @param {Date|null} lastRunTimestamp - The end time of the last successful collection run.
 * @returns {Promise<Array<object>>} A promise resolving with an array of HRMS records.
 * @throws {Error} If configuration is invalid, connection fails, or query fails.
 */
async function collectData(configDetails, mappingRulesParam, lastRunTimestamp) { // Renamed mappingRules -> mappingRulesParam for clarity
    const serviceName = 'identity-collection-service'; // Or derive from context
    console.log(`[HRMS-Postgres Connector] Starting data collection from PostgreSQL DB.`);

    // --- *** FIX: Access properties nested under mappingRules *** ---
    const dbConfig = configDetails?.mappingRules?.connection;
    const collectionQuery = configDetails?.mappingRules?.query;
    const incrementalQuery = configDetails?.mappingRules?.incrementalQuery;
    const timestampFieldForIncremental = configDetails?.mappingRules?.timestampFieldForIncremental;
    // --- *** END FIX *** ---


    // --- Detailed logging for debugging config issues ---
    console.log(`[HRMS-Postgres Connector] Debugging received configDetails:`, JSON.stringify(configDetails, null, 2));
    // --- *** FIX: Log the correctly extracted dbConfig *** ---
    console.log(`[HRMS-Postgres Connector] Debugging extracted dbConfig (configDetails?.mappingRules?.connection):`, JSON.stringify(dbConfig, null, 2));
    // --- *** END FIX *** ---

    let client = null; // pg Client instance
    let rawData = []; // Array to hold fetched records

    try {
        // --- 1. Read Config and Validate ---
        // Check essential connection details (using the correctly accessed dbConfig)
        if (!dbConfig?.host || !dbConfig?.database || !dbConfig?.user || !dbConfig?.password) {
             // --- *** FIX: Updated error message source path *** ---
            throw new Error("Invalid PostgreSQL connection configuration provided (missing host, database, user, or password in 'mappingRules.connection' object).");
             // --- *** END FIX *** ---
        }

        // Validate query configuration (using correctly accessed query strings)
        if (!collectionQuery && !incrementalQuery) {
             // --- *** FIX: Updated error message source path *** ---
            throw new Error("Invalid PostgreSQL query configuration. Need 'query' or 'incrementalQuery' in the 'mappingRules' object.");
             // --- *** END FIX *** ---
        }

        // --- 2. Establish Database Connection ---
        console.log(`[HRMS-Postgres Connector] Connecting to PostgreSQL database ${dbConfig.database} on ${dbConfig.host}...`);
        try {
            // Create client options, spreading dbConfig and adding defaults
            const clientOptions = {
                connectionTimeoutMillis: dbConfig.connectionTimeoutMillis || 5000, // Default 5s
                idleTimeoutMillis: dbConfig.idleTimeoutMillis || 30000, // Default 30s
                ...dbConfig // Spread host, port, user, password, database, etc.
            };
            client = new Client(clientOptions);

            // Add error listener for asynchronous client-level errors
            client.on('error', (err) => {
                console.error('[HRMS-Postgres Connector] PostgreSQL client error:', err);
            });

            // Connect to the database
            await client.connect();
            console.log('[HRMS-Postgres Connector] Successfully connected to PostgreSQL DB.');

        } catch (connError) {
            console.error('[HRMS-Postgres Connector] Failed to connect to database:', connError.message);
            throw new Error(`PostgreSQL connection failed: ${connError.message}`);
        }

        // --- 3. Construct and Execute Query ---
        let query;
        let queryParams = [];
        let isIncrementalRun = false;

        // Decide which query to run
        const hasIncrementalConfig = incrementalQuery && timestampFieldForIncremental;

        if (lastRunTimestamp && hasIncrementalConfig) {
            try {
                const lastRunDate = new Date(lastRunTimestamp);
                if (isNaN(lastRunDate.getTime())) {
                    console.warn(`[HRMS-Postgres Connector] Invalid lastRunTimestamp format: "${lastRunTimestamp}". Performing full sync.`);
                    if (!collectionQuery) throw new Error("Cannot fallback to full sync: 'mappingRules.query' is missing.");
                    query = collectionQuery;
                } else {
                    query = incrementalQuery;
                    queryParams = [lastRunDate];
                    isIncrementalRun = true;
                    console.log(`[HRMS-Postgres Connector] Running incremental query using timestamp > ${lastRunDate.toISOString()}.`);
                    if (!query.includes('$1')) {
                         console.warn('[HRMS-Postgres Connector] Incremental query configured but does not contain $1 placeholder. Parameter might not be used correctly by the query.');
                    }
                }
            } catch (e) {
                console.error('[HRMS-Postgres Connector] Error processing lastRunTimestamp for incremental query, performing full sync:', e);
                 if (!collectionQuery) throw new Error("Cannot fallback to full sync: 'mappingRules.query' is missing.");
                query = collectionQuery;
            }
        } else {
             if (!collectionQuery) throw new Error("Cannot perform sync: 'mappingRules.query' is missing in configuration.");
             query = collectionQuery;
             console.log('[HRMS-Postgres Connector] Running base (full) query.');
             if (lastRunTimestamp && !hasIncrementalConfig) {
                 console.warn('[HRMS-Postgres Connector] lastRunTimestamp available, but no incrementalQuery/timestampFieldForIncremental in mappingRules configured. Performing full sync.');
             }
        }

        console.log(`[HRMS-Postgres Connector] Executing query${isIncrementalRun ? ' (incremental)' : ' (full)'}: "${query}"`);
        if (queryParams.length > 0) {
            console.log(`[HRMS-Postgres Connector] With parameters:`, queryParams);
        }

        // Execute the query using the client
        const result = await client.query(query, queryParams);

        // Process results
        if (result && Array.isArray(result.rows)) {
            rawData = result.rows;
            console.log(`[HRMS-Postgres Connector] Fetched ${rawData.length} records.`);
        } else {
            console.warn('[HRMS-Postgres Connector] Query returned no rows or unexpected result structure.');
            rawData = [];
        }

    } catch (error) {
        console.error('[HRMS-Postgres Connector] Error during data collection:', error);
        const errorMessage = error.code ? `Code ${error.code}: ${error.message}` : error.message;
        // Make error more specific if it's the known validation error
        if (error.message.startsWith('Invalid PostgreSQL connection configuration') || error.message.startsWith('Invalid PostgreSQL query configuration')) {
             throw new Error(`Configuration Error: ${error.message}`);
        }
        // Otherwise, assume it's a DB operation error
        throw new Error(`PostgreSQL HRMS data collection failed: ${errorMessage}`);

    } finally {
        // --- 4. Close Connection ---
        if (client) {
            try {
                await client.end();
                console.log('[HRMS-Postgres Connector] PostgreSQL DB connection closed.');
            } catch (closeError) {
                console.error('[HRMS-Postgres Connector] Error closing PostgreSQL DB connection:', closeError);
            }
        }
    }

    // --- 5. Return Data ---
    return rawData;
}

// --- Module Export ---
module.exports = {
    collectData,
    getNestedValue // Exporting helper in case it's useful elsewhere, though not used internally now
};