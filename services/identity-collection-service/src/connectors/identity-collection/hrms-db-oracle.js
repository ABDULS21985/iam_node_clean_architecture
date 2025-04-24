// services/identity-collection-service/src/connectors/identity-collection/hrms-db-oracle.js

// You will need to install the Oracle database driver: npm install oracledb
// Also requires Oracle Instant Client libraries installed on the system/container.
const oracledb = require('oracledb');

// Configure oracledb properties if needed (e.g., externalAuth, pool defaults)
// oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT; // Fetch rows as objects

/**
 * Oracle HRMS Connector Adapter.
 * Connects to an Oracle database to pull HRMS data.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": { // Oracle connection properties
 * "user": "hrms_read_user",
 * "password": "your_secure_password",
 * "connectString": "your_oracle_connection_string_tns_or_easyconnect" // e.g., "hostname:port/service_name"
 * // ... other oracle connection options
 * },
 * "queryConfig": { // Details about the query to run
 * "baseQuery": "SELECT person_id, employee_id, first_name, ... FROM HRMS_USERS_TABLE", // Base query
 * "incrementalQuery": "SELECT person_id, employee_id, first_name, ... FROM HRMS_USERS_TABLE WHERE last_updated_at > :lastRunTimestamp", // Query with placeholder for incremental
 * "uniqueIdField": "employee_id", // The HRMS field to use as unique ID
 * "timestampFieldForIncremental": "last_updated_at" // The HRMS field used for incremental
 * // ... other query options
 * }
 * }
 * @param {Date|null} lastRunTimestamp - The end time of the last successful collection run.
 * Used for incremental pulls if supported by queryConfig.
 * @returns {Promise<Array<object>>} A promise resolving with an array of HRMS records (objects).
 * @throws {Error} If connection fails, query fails, or data is invalid.
 */
async function collectData(configDetails, lastRunTimestamp) {
    console.log(`[HRMS-Oracle Connector] Starting data collection from Oracle DB.`);

    let connection;
    let result;
    const hrmsRecords = []; // Array to hold fetched records

    try {
        // --- 1. Validate Configuration ---
        const { connection: connConfig, queryConfig } = configDetails;
        if (!connConfig || !connConfig.user || !connConfig.password || !connConfig.connectString) {
             throw new Error("Invalid Oracle connection configuration provided.");
        }
         if (!queryConfig || (!queryConfig.baseQuery && !queryConfig.incrementalQuery) || !queryConfig.uniqueIdField) {
              throw new Error("Invalid Oracle query configuration provided. Need baseQuery or incrementalQuery and uniqueIdField.");
         }


        // --- 2. Establish Database Connection ---
        // Consider using a connection pool for better performance if many concurrent runs are possible (less likely for scheduled collection)
        connection = await oracledb.getConnection(connConfig);
        console.log('[HRMS-Oracle Connector] Successfully connected to Oracle DB.');


        // --- 3. Construct and Execute Query ---
        let query;
        let bindParams = {}; // Object for bind parameters

        // Decide which query to run (incremental vs. full)
        if (lastRunTimestamp && queryConfig.incrementalQuery && queryConfig.timestampFieldForIncremental) {
            query = queryConfig.incrementalQuery;
            // Format timestamp for Oracle binding (Oracle DATE or TIMESTAMP)
            // Adjust format based on actual HRMS column type
            bindParams = {
                 lastRunTimestamp: lastRunTimestamp // Pass Date object directly or format string
                 // Oracle binding needs ':bind_param_name' in the SQL string
                 // e.g., "... WHERE last_updated_at > :lastRunTimestamp"
            };
            console.log(`[HRMS-Oracle Connector] Running incremental query since ${lastRunTimestamp.toISOString()}.`);
        } else if (queryConfig.baseQuery) {
            query = queryConfig.baseQuery;
             console.log('[HRMS-Oracle Connector] Running base (full) query.');
        } else {
             throw new Error("No valid query (baseQuery or incrementalQuery) found in configuration.");
        }

        // Execute the query
        // Options might include fetchInfo, outFormat etc.
        result = await connection.execute(
            query,
            bindParams,
            // Options for execute (e.g., { outFormat: oracledb.OUT_FORMAT_OBJECT, resultSet: true })
            {
                outFormat: oracledb.OUT_FORMAT_OBJECT // Fetch rows as objects
            }
        );

        // Process results
        if (result && result.rows) {
            hrmsRecords.push(...result.rows); // Collect all rows
             console.log(`[HRMS-Oracle Connector] Fetched ${result.rows.length} records.`);
        } else {
             console.warn('[HRMS-Oracle Connector] Query returned no rows or unexpected result structure.');
        }


    } catch (error) {
        console.error('[HRMS-Oracle Connector] Error during data collection:', error);
        // Re-throw the error so collectionLogic can catch and log it in CollectionRun
        throw new Error(`Oracle HRMS data collection failed: ${error.message}`);

    } finally {
        // --- 4. Close Connection ---
        if (connection) {
            try {
                await connection.close();
                 console.log('[HRMS-Oracle Connector] Oracle DB connection closed.');
            } catch (closeError) {
                 console.error('[HRMS-Oracle Connector] Error closing Oracle DB connection:', closeError);
                 // Log closing errors but don't necessarily prevent returning data or throwing the main error
            }
        }
    }

    // --- 5. Return Data ---
    // Validate structure? Ensure uniqueIdField exists in records? collectionLogic does some of this.
    return hrmsRecords; // Return the array of fetched records
}

module.exports = {
    collectData,
};