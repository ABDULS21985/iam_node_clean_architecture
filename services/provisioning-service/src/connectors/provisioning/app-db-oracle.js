// services/provisioning-service/src/connectors/provisioning/app-db-oracle.js
const oracledb = require('oracledb'); // You will need to install: npm install oracledb

// Configure oracledb properties (e.g., connection pool defaults) if needed
// oracledb.initOracleClient(); // Required if not using Instant Client in standard locations
// oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT; // Fetch rows as objects by default

/**
 * Helper function to get a value from a nested object path (e.g., 'metadata.sAMAccountName').
 */
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


/**
 * Helper function to execute a single SQL command template against the Oracle database.
 */
async function executeSqlTemplate(connection, template, data, opType, opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId, placeholderMapping, successRowCounts, ignoreErrors) {
    const serviceName = 'provisioning-service'; // Need to pass serviceName or context from caller

    if (!template) {
        console.warn(`[Oracle DB Connector] ${opContext}: Skipping - No SQL template found.`);
        return { entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing SQL template', iglmEntitlementId: iglmEntitlementId };
    }
     if (appEntitlementId === undefined || appEntitlementId === null) {
         console.warn(`[Oracle DB Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
         return { entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId', iglmEntitlementId: iglmEntitlementId };
     }


    // Construct bind parameters object based on placeholderMapping
    const bindParams = {};
    // Add standard placeholders first
    bindParams['userId'] = data.userIdInApp; // Standard placeholder mapping
    bindParams['appEntitlementId'] = appEntitlementId; // Standard placeholder mapping

    // Add parameters defined in the placeholderMapping config
     for (const placeholderKey in placeholderMapping) {
         const dataField = placeholderMapping[placeholderKey]; // e.g., "metadata.departmentId"
         bindParams[placeholderKey] = getNestedValue(data, dataField); // Get value from data (which includes grantItem/revokeItem + userIdInApp)
     }


    console.log(`[Oracle DB Connector] ${opContext}: Executing SQL: "${template}" with params:`, bindParams);

    try {
        const result = await connection.execute(template, bindParams, { autoCommit: true, outFormat: oracledb.OUT_FORMAT_OBJECT }); // outFormat needed if selecting data, useful for debugging. autoCommit true for simple ops.

        console.log(`[Oracle DB Connector] ${opContext}: SQL successful. Rows affected: ${result.rowsAffected}.`);

        // Determine status based on rowCount and successRowCounts configuration
        const expectedRowCounts = successRowCounts[opType] || [1]; // Default expected is 1 row affected
        const isSuccessful = expectedRowCounts.includes(result.rowsAffected);

        if (isSuccessful) {
            return {
                entitlement: iglmEntitlementName,
                appEntitlementId: appEntitlementId,
                status: opType, // 'granted' or 'revoked'
                sql: template,
                bindParams: bindParams, // Include params for debugging
                dbResult: { rowsAffected: result.rowsAffected }
            };
        } else {
            // Command succeeded without error but didn't affect expected rows
            // This might mean it already existed (grant) or didn't exist (revoke)
            const message = `${opType} command affected ${result.rowsAffected} rows, expected ${expectedRowCounts.join(',')}. Treating as skipped/no change.`;
            console.warn(`[Oracle DB Connector] ${opContext}: ${message}`);
            return {
                entitlement: iglmEntitlementName,
                appEntitlementId: appEntitlementId,
                status: 'skipped', // Treat unexpected row count as skipped/no change
                message: message,
                sql: template,
                bindParams: bindParams,
                dbResult: { rowsAffected: result.rowsAffected }
            };
        }


    } catch (sqlError) {
        console.error(`[Oracle DB Connector] ${opContext}: Error running SQL:`, sqlError.message);

         // Check if this error should be ignored based on configuration (Oracle error numbers, SQLSTATE, message substrings)
         const errorsToIgnore = ignoreErrors[opType] || [];
         const shouldIgnore = errorsToIgnore.some(ignoredErr =>
             (ignoredErr.code === undefined || ignoredErr.code === sqlError.errorNum) && // Check Oracle error number (sqlError.errorNum)
             (ignoredErr.sqlState === undefined || ignoredErr.sqlState === sqlError.sqlState) && // Check SQLSTATE (sqlError.sqlState)
             (ignoredErr.messageSubstring === undefined || sqlError.message.includes(ignoredErr.messageSubstring)) // Check message substring
         );

         if (shouldIgnore) {
             console.warn(`[Oracle DB Connector] ${opContext}: Ignoring known error (Code: ${sqlError.errorNum || 'N/A'}). Treating as skipped/success.`);
             return {
                 entitlement: iglmEntitlementName,
                 appEntitlementId: appEntitlementId,
                 status: 'skipped', // Treat ignored error as skipped
                 message: `Ignored error: ${sqlError.message}`,
                 error: sqlError.message, // Store the error message
                 sql: template,
                 bindParams: bindParams,
                 dbErrorDetails: { code: sqlError.errorNum, sqlState: sqlError.sqlState } // Store specific DB error codes
             };
         } else {
             // Unhandled error - mark as failed
             console.error(`[Oracle DB Connector] ${opContext}: Unhandled SQL error.`, sqlError); // Log full error object for unhandled ones
             return {
                 entitlement: iglmEntitlementName,
                 appEntitlementId: appEntitlementId,
                 status: 'failed',
                 message: `SQL error: ${sqlError.message}`,
                 error: sqlError.message,
                 sql: template,
                 bindParams: bindParams,
                 dbErrorDetails: { code: sqlError.errorNum, sqlState: sqlError.sqlState }
             };
         }
    }
}


/**
 * Oracle Database Provisioning Connector Adapter.
 * Manages access directly via SQL INSERT/UPDATE/DELETE for Oracle databases.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": { // Required: Oracle connection details (user, password, connectString)
 * ...
 * },
 * "sqlTemplates": { // Required: SQL templates for actions
 * "grant": { "[IGLM Entitlement ID]": "...", "default": "..." },
 * "revoke": { "[IGLM Entitlement ID]": "...", "default": "..." }
 * },
 * "placeholderMapping": { "userId": "userIdInApp", "groupId": "appEntitlementId", ... }, // Maps SQL placeholders to data fields
 * "successRowCounts": { "grant": [1], "revoke": [1] }, // Expected rows affected for success
 * "ignoreErrors": { "grant": [{ code: 1, ... }], "revoke": [{ code: 100, ... }] } // Errors to ignore
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * { "userIdInApp": "...", "entitlementsToGrant": [...], "entitlementsToRevoke": [...] }
 * @returns {Promise<object>} Returns { success: boolean, operations: Array<{ ... }> }.
 * @throws {Error} If a critical configuration or database connection error occurs.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    const serviceName = 'provisioning-service'; // Need to pass serviceName or context from options

    // console.log(`[Oracle DB Connector] Applying desired state for user: ${appSpecificDesiredState?.userIdInApp || 'N/A'}`);
    // console.log(`[Oracle DB Connector] Desired state (summary): Granting ${appSpecificDesiredState?.entitlementsToGrant?.length || 0}, Revoking ${appSpecificDesiredState?.entitlementsToRevoke?.length || 0}`);

    let connection = null; // oracledb connection instance
    const operationResults = []; // Collect results for each entitlement operation

    try {
        // 1. Read Config and Validate
        const dbConfig = configDetails?.connection;
        const sqlTemplates = configDetails?.sqlTemplates;
        const placeholderMapping = configDetails?.placeholderMapping || {};
        const successRowCounts = configDetails?.successRowCounts || {};
        const ignoreErrors = configDetails?.ignoreErrors || {};

        const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState || {};

        if (!dbConfig || !dbConfig.user || !dbConfig.password || !dbConfig.connectString) {
             throw new Error("Invalid Oracle DB connector configuration: Missing connection details (user, password, connectString).");
        }
        if (!sqlTemplates || typeof sqlTemplates !== 'object' || !sqlTemplates.grant || typeof sqlTemplates.grant !== 'object' || !sqlTemplates.revoke || typeof sqlTemplates.revoke !== 'object') {
             throw new Error("Invalid Oracle DB connector configuration: Missing or invalid 'sqlTemplates' structure (must have 'grant' and 'revoke' objects).");
        }
        if (!userIdInApp) {
            // This scenario is likely caught by provisioningLogic, but adding defense here
             console.warn(`[Oracle DB Connector] Invalid appSpecificDesiredState: Missing userIdInApp. Skipping all operations.`);
             operationResults.push({ entitlement: 'N/A', status: 'failed', message: 'Missing userIdInApp in desired state' });
             return { success: false, operations: operationResults }; // Return early
        }

        // 2. Establish Connection
        console.log(`[Oracle DB Connector] Connecting to Oracle database...`);
        try {
            // Consider using a connection pool (oracledb.createPool) for better performance in high-concurrency scenarios
            // For a single-threaded Node.js service like this, a single connection might be simpler initially.
            connection = await oracledb.getConnection(dbConfig);
            console.log(`[Oracle DB Connector] Successfully connected to Oracle.`);
        } catch (connError) {
            console.error('[Oracle DB Connector] Failed to connect to database:', connError.message);
            throw new Error(`Oracle DB connector failed to connect: ${connError.message}`); // Critical failure
        }

        // 3. Process Grants
        const grantsToProcess = entitlementsToGrant || []; // Ensure it's an array
        console.log(`[Oracle DB Connector] Processing ${grantsToProcess.length} entitlements to grant...`);
        for (const grantItem of grantsToProcess) {
            const { iglmEntitlementId, iglmEntitlementName } = grantItem;
            const opContext = `User "${userIdInApp}" grant "${iglmEntitlementName}" (${grantItem.appEntitlementId})`; // Use grantItem.appEntitlementId for context if available

            // Determine the correct SQL template based on IGLM Entitlement ID or default
            const grantTemplate = sqlTemplates.grant[iglmEntitlementId] || sqlTemplates.grant.default;

            // Execute the SQL using the helper function
            const result = await executeSqlTemplate(connection, grantTemplate, { ...grantItem, userIdInApp }, 'granted', opContext, iglmEntitlementName, grantItem.appEntitlementId, iglmEntitlementId, placeholderMapping, successRowCounts, ignoreErrors);
            operationResults.push(result);
        }

        // 4. Process Revokes
        const revokesToProcess = entitlementsToRevoke || [];
        console.log(`[Oracle DB Connector] Processing ${revokesToProcess.length} entitlements to revoke...`);
        for (const revokeItem of revokesToProcess) {
            const { iglmEntitlementId, iglmEntitlementName } = revokeItem;
            const opContext = `User "${userIdInApp}" revoke "${iglmEntitlementName}" (${revokeItem.appEntitlementId})`;

            // Determine the correct SQL template based on IGLM Entitlement ID or default
            const revokeTemplate = sqlTemplates.revoke[iglmEntitlementId] || sqlTemplates.revoke.default;

            // Execute the SQL using the helper function
            const result = await executeSqlTemplate(connection, revokeTemplate, { ...revokeItem, userIdInApp }, 'revoked', opContext, iglmEntitlementName, revokeItem.appEntitlementId, iglmEntitlementId, placeholderMapping, successRowCounts, ignoreErrors);
            operationResults.push(result);
        }


        // 5. Check Overall Operation Status and Return Summary
        // Determine overall success based on whether ANY operation failed
        const overallSuccess = !operationResults.some(op => op.status === 'failed');

        console.log(`[Oracle DB Connector] Finished operations. Overall success: ${overallSuccess}. Results:`, operationResults.map(r => ({ entitlement: r.entitlement, status: r.status, appEntitlementId: r.appEntitlementId }))); // Log a summary

        return { success: overallSuccess, operations: operationResults };

    } catch (error) {
        // Catch any critical errors that occurred before processing operations (config, connection)
        console.error('[Oracle DB Connector] Overall error during applyDesiredState:', error);
        // Ensure the database connection is closed if it was opened
        if (connection) {
            try { await connection.close(); console.log('[Oracle DB Connector] DB connection closed after overall error.'); }
            catch(e) { console.error('[Oracle DB Connector] Error closing DB connection after overall error:', e); }
        }
        // Re-throw the error so provisioningLogic can catch it and mark the task failed
        throw error;

    } finally {
        // 6. Close Connection
        // Ensure the database connection is always closed if it was opened.
        if (connection) {
            try {
                await connection.close(); // Close the connection (or release from pool)
                console.log('[Oracle DB Connector] DB connection closed in finally block.');
            } catch (closeError) {
                console.error('[Oracle DB Connector] Error closing DB connection in finally block:', closeError);
            }
        } else {
            console.log('[Oracle DB Connector] DB connection was not initialized.');
        }
    }
}


module.exports = {
    applyDesiredState,
    // Optional methods: discoverUsers, discoverEntitlements
};