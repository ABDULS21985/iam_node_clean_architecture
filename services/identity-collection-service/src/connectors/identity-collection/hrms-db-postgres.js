// services/identity-collection-service/src/connectors/identity-collection/hrms-db-postgres.js

// You will need to install the pg library in the Identity Collection Service directory:
// cd services/identity-collection-service
// npm install pg
// cd src/connectors/identity-collection

const { Client } = require('pg'); // Import the Client class from pg

/**
 * PostgreSQL HRMS Database Connector Adapter.
 * Connects to a PostgreSQL database to pull HRMS data.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure (based on your config script data):
 * {
 * "dbType": "postgres",
 * "host": "...",
 * "port": ...,
 * "database": "...",
 * "user": "...",
 * "password": "...",
 * "query": "SELECT ... FROM ... WHERE ...", // The full or base query
 * "uniqueIdFieldInHRMS": "...", // The HRMS field name used as unique ID
 * // Optional fields for incremental pulls:
 * // "incrementalQuery": "SELECT ... FROM ... WHERE update_timestamp_field > $1", // Query with $1 placeholder
 * // "timestampFieldForIncremental": "update_timestamp_field" // The HRMS field used for incremental
 * }
 * @param {Date|null} lastRunTimestamp - The end time of the last successful collection run.
 * Used for incremental pulls if supported by configDetails.
 * @returns {Promise<Array<object>>} A promise resolving with an array of HRMS records (objects).
 * @throws {Error} If connection fails, query fails, or data is invalid.
 */
async function collectData(configDetails, lastRunTimestamp) {
    console.log(`[HRMS-Postgres Connector] Starting data collection from PostgreSQL DB.`);

    let client;
    const hrmsRecords = []; // Array to hold fetched records

    try {
        // --- 1. Validate Configuration ---
        if (!configDetails || !configDetails.host || !configDetails.port || !configDetails.database || !configDetails.user || !configDetails.password) {
             throw new Error("Invalid PostgreSQL connection configuration provided.");
        }
         if (!configDetails.query && !configDetails.incrementalQuery) {
              throw new Error("Invalid PostgreSQL query configuration. Need 'query' or 'incrementalQuery'.");
         }
         if (!configDetails.uniqueIdFieldInHRMS) {
             console.warn("[HRMS-Postgres Connector] 'uniqueIdFieldInHRMS' not specified in config. DataProcessor uses this from MappingConfig metadata.");
              // This specific adapter might not strictly *need* uniqueIdFieldInHRMS, but it's good practice to log if it's missing.
         }


        // --- 2. Establish Database Connection ---
        // Create a new pg Client instance using connection details from configDetails
        client = new Client({
            host: configDetails.host,
            port: configDetails.port,
            database: configDetails.database,
            user: configDetails.user,
            password: configDetails.password,
            // Add ssl: true if connecting with SSL
        });

        // Connect to the database
        await client.connect();
        console.log('[HRMS-Postgres Connector] Successfully connected to PostgreSQL DB.');


        // --- 3. Construct and Execute Query ---
        let query;
        let queryParams = []; // Array for query parameters ($1, $2, etc.)

        // Decide which query to run (incremental vs. full)
        // Check if incremental query is possible AND configured AND lastRunTimestamp is available
        if (lastRunTimestamp && configDetails.incrementalQuery && configDetails.timestampFieldForIncremental) {
            query = configDetails.incrementalQuery;
            // Add the lastRunTimestamp as the first parameter ($1)
            // pg Client handles Date objects correctly for binding
            queryParams = [lastRunTimestamp];
            console.log(`[HRMS-Postgres Connector] Running incremental query since ${lastRunTimestamp.toISOString()}.`);
             // TODO: Add logging or check if the HRMS query string actually uses $1
        } else if (configDetails.query) {
            query = configDetails.query; // Use the base query
            console.log('[HRMS-Postgres Connector] Running base (full) query.');
             // Check if the base query *should* be filtered but isn't
             if (lastRunTimestamp && !configDetails.incrementalQuery) {
                  console.warn('[HRMS-Postgres Connector] lastRunTimestamp is available, but no incrementalQuery is configured. Performing full sync.');
             }
        } else {
             throw new Error("No valid query ('query' or 'incrementalQuery') found in configuration.");
        }

        // Execute the query
        const result = await client.query(query, queryParams);

        // Process results
        if (result && result.rows) {
            hrmsRecords.push(...result.rows); // Collect all rows
             console.log(`[HRMS-Postgres Connector] Fetched ${result.rows.length} records.`);
        } else {
             console.warn('[HRMS-Postgres Connector] Query returned no rows or unexpected result structure.');
        }


    } catch (error) {
        console.error('[HRMS-Postgres Connector] Error during data collection:', error);
        // Re-throw the error so collectionLogic can catch and log it in CollectionRun
        // Add context about the connector type
        throw new Error(`PostgreSQL HRMS data collection failed: ${error.message}`);

    } finally {
        // --- 4. Close Connection ---
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
    // The data structure returned should be an Array of Objects, where object keys match SQL column names (pg Client does this by default)
    return hrmsRecords; // Return the array of fetched records
}

module.exports = {
    collectData,
};