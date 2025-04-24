// services/provisioning-service/src/connectors/provisioning/app-db-mysql.js
const mysql = require('mysql2/promise'); // You will need to install: npm install mysql2

/**
 * MySQL Database Provisioning Connector Adapter.
 * Manages access directly via SQL INSERT/UPDATE/DELETE for MySQL databases.
 *
 * Note: This adapter relies on predefined SQL templates and uses MySQL's prepared statement syntax (?).
 */

/**
 * Applies the desired state (grant/revoke entitlements) for a user by executing
 * predefined SQL templates against a MySQL database.
 * This method is called by provisioningLogic.js.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": { // Required: MySQL connection details
 * "host": "dbhost", // Required
 * "port": 3306, // Optional, default 3306
 * "database": "dbname", // Required
 * "user": "dbuser", // Required
 * "password": "dbpassword", // Required
 * // Add other mysql2 connection options (e.g., waitForConnections, connectionLimit for pool)
 * },
 * "sqlTemplates": { // Required: SQL templates for actions
 * "grant": {
 * // Templates keyed by iglmEntitlementId, or a 'default' template
 * "00000000-0000-0000-0000-000000000301": "INSERT INTO portal_user_groups (user_id, group_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id=user_id", // Example group grant (uses INSERT IGNORE or ON DUPLICATE KEY for idempotency)
 * "default": "INSERT INTO app_access (user_id, item_id) VALUES (?, ?)" // Example generic grant
 * },
 * "revoke": {
 * // Templates keyed by iglmEntitlementId, or a 'default' template
 * "00000000-0000-0000-0000-000000000301": "DELETE FROM portal_user_groups WHERE user_id = ? AND group_id = ?", // Example group revoke
 * "default": "DELETE FROM app_access WHERE user_id = ? AND item_id = ?" // Example generic revoke
 * }
 * },
 * // Define mapping for placeholder positions/order used in SQL templates (?)
 * "parameterMapping": { // Use an array or object mapping if parameter order varies
 * "grant": { // Mapping for grant templates
 * "default": ["userIdInApp", "appEntitlementId"] // For default grant, param 1 is userIdInApp, param 2 is appEntitlementId
 * // Add mappings for specific entitlement IDs if param order/fields differ
 * // "00000000-0000-0000-0000-000000000301": ["userIdInApp", "appEntitlementId"] // Explicit mapping for this ID
 * },
 * "revoke": { // Mapping for revoke templates
 * "default": ["userIdInApp", "appEntitlementId"]
 * // "00000000-0000-0000-0000-000000000301": ["userIdInApp", "appEntitlementId"]
 * }
 * },
 * "successRowCounts": { // Optional: Define what rowCount values indicate success
 * "grant": [1, 2], // INSERT can return 1 (new row) or 2 (ON DUPLICATE KEY)
 * "revoke": [1] // Typically 1 row deleted
 * },
 * "ignoreErrors": { // Optional: Specific MySQL errors to ignore (e.g., duplicate entry on grant, no rows affected on revoke)
 * "grant": [{ code: 1062, sqlState: '23000' }], // Example: ER_DUP_ENTRY (Duplicate entry for primary key)
 * "revoke": [{ rowCount: 0 }] // Example: Ignore if 0 rows were affected (user wasn't a member) - Handled by successRowCounts check too
 * }
 * // Add other adapter specific options
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * {
 * "userIdInApp": "...", // The user's identifier for the MySQL database
 * "entitlementsToGrant": [ // Array of entitlements to grant (mapped by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the value used as a parameter in the SQL template
 * ],
 * "entitlementsToRevoke": [ // Array of entitlements to revoke (if determined by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the value used as a parameter in the SQL template
 * ]
 * }
 * @returns {Promise<object>} A promise resolving with the result of the provisioning operations.
 * Returns { success: boolean, operations: Array<{ entitlement: string, appEntitlementId?: string, status: 'granted'|'revoked'|'skipped'|'failed', message?: string, error?: string, sql?: string, dbResult?: { rowCount: number, insertId?: number, ... } }> }.
 * @throws {Error} If a critical configuration or database connection error occurs.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    const serviceName = 'provisioning-service';
    console.log(`[MySQL DB Connector] Applying desired state for user: ${appSpecificDesiredState?.userIdInApp || 'N/A'}`);
    // console.log(`[MySQL DB Connector] Config details (excluding password):`, { ...configDetails, connection: { ...configDetails?.connection, password: '***' } }); // Log sensitive data carefully
    console.log(`[MySQL DB Connector] Desired state (summary): Granting ${appSpecificDesiredState?.entitlementsToGrant?.length || 0}, Revoking ${appSpecificDesiredState?.entitlementsToRevoke?.length || 0}`);

    let connection = null; // mysql2 connection instance or pool
    const operationResults = [];

    try {
        // --- 1. Validate Configuration and Input ---
        const dbConfig = configDetails?.connection;
        const sqlTemplates = configDetails?.sqlTemplates;
        const parameterMapping = configDetails?.parameterMapping || {};
        const successRowCounts = configDetails?.successRowCounts || { grant: [1, 2], revoke: [1] }; // Default MySQL INSERT IGNORE/ON DUPLICATE KEY can affect 1 or 2 rows
        const ignoreErrors = configDetails?.ignoreErrors || {};

        const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState || {};

        if (!dbConfig || !dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
            throw new Error("Invalid MySQL DB connector configuration: Missing connection details (host, database, user, password).");
        }
         if (!sqlTemplates || typeof sqlTemplates !== 'object' || !sqlTemplates.grant || typeof sqlTemplates.grant !== 'object' || !sqlTemplates.revoke || typeof sqlTemplates.revoke !== 'object') {
            throw new Error("Invalid MySQL DB connector configuration: Missing or invalid 'sqlTemplates' structure (must have 'grant' and 'revoke' objects).");
        }
        if (!userIdInApp) {
             console.warn(`[MySQL DB Connector] Invalid appSpecificDesiredState: Missing userIdInApp. Skipping all operations.`);
             operationResults.push({ entitlement: 'N/A', status: 'failed', message: 'Missing userIdInApp in desired state' });
             return { success: false, operations: operationResults };
        }


        // --- 2. Establish Connection ---
        console.log(`[MySQL DB Connector] Connecting to MySQL database ${dbConfig.database}...`);
        try {
            // For pool: connection = await mysql.createPool(dbConfig).getConnection();
            connection = await mysql.createConnection(dbConfig);
            console.log(`[MySQL DB Connector] Successfully connected to MySQL.`);
        } catch (connError) {
            console.error('[MySQL DB Connector] Failed to connect to database:', connError.message);
            throw new Error(`MySQL DB connector failed to connect: ${connError.message}`); // Critical failure
        }

        // --- Helper function to execute a single SQL template ---
        const executeSqlTemplate = async (template, data, paramMapConfig, opType, opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId) => {
             if (!template) {
                  console.warn(`[MySQL DB Connector] ${opContext}: Skipping - No SQL template found.`);
                   return { entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing SQL template', iglmEntitlementId: iglmEntitlementId };
             }
              if (appEntitlementId === undefined || appEntitlementId === null) {
                   console.warn(`[MySQL DB Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
                   return { entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId', iglmEntitlementId: iglmEntitlementId };
              }

             // Construct parameters array based on the parameter mapping configuration
             const params = [];
             if (Array.isArray(paramMapConfig)) {
                 // If mapping is an array, use the field names in order
                 for (const fieldName of paramMapConfig) {
                      params.push(getNestedValue(data, fieldName)); // Use helper
                 }
             } else {
                 // Default parameter mapping: assume $1 is userIdInApp, $2 is appEntitlementId
                 // Note: MySQL uses '?' not '$'
                 params.push(data.userIdInApp);
                 params.push(data.appEntitlementId);
                 console.warn(`[MySQL DB Connector] ${opContext}: Using default parameter mapping [userIdInApp, appEntitlementId] for template. Define 'parameterMapping.${opType}.default' or for specific entitlement ID for explicit mapping.`);
             }


             console.log(`[MySQL DB Connector] ${opContext}: Executing SQL: "${template}" with params:`, params);

             try {
                 // Execute the prepared statement
                 const [rows, fields] = await connection.execute(template, params); // connection.execute returns [rows, fields]

                 // For INSERT/UPDATE/DELETE, rows is an object with affectedRows, insertId etc.
                 const result = rows;
                 console.log(`[MySQL DB Connector] ${opContext}: SQL successful. Rows affected: ${result.affectedRows}.`);

                  // Determine status based on affectedRows and successRowCounts configuration
                  const expectedRowCounts = successRowCounts[opType] || [1];
                  const isSuccessful = expectedRowCounts.includes(result.affectedRows);

                   if (isSuccessful) {
                        return {
                            entitlement: iglmEntitlementName,
                            appEntitlementId: appEntitlementId,
                            status: opType, // 'granted' or 'revoked'
                            sql: template,
                            dbResult: { rowCount: result.affectedRows, insertId: result.insertId, ...result } // Include all result properties
                        };
                   } else {
                       // Command succeeded without error but didn't affect expected rows
                       const message = `${opType} command affected ${result.affectedRows} rows, expected ${expectedRowCounts.join(',')}.`;
                       console.warn(`[MySQL DB Connector] ${opContext}: ${message}`);
                        // Check if 0 rows affected should be ignored (common for revoke where user wasn't member)
                       const ignoreZeroRows = ignoreErrors[opType]?.some(ignoredErr => ignoredErr.rowCount === 0);
                       if (ignoreZeroRows && result.affectedRows === 0) {
                            console.warn(`[MySQL DB Connector] ${opContext}: Ignoring 0 rows affected as per config. Treating as skipped.`);
                             return {
                                entitlement: iglmEntitlementName,
                                appEntitlementId: appEntitlementId,
                                status: 'skipped',
                                message: 'Not found or already in desired state', // More user-friendly message
                                sql: template,
                                dbResult: { rowCount: result.affectedRows }
                            };
                       } else {
                           return {
                                entitlement: iglmEntitlementName,
                                appEntitlementId: appEntitlementId,
                                status: 'failed', // Mark as failed if row count unexpected and not ignored
                                message: message,
                                sql: template,
                                dbResult: { rowCount: result.affectedRows }
                            };
                       }
                   }

             } catch (sqlError) {
                 console.error(`[MySQL DB Connector] ${opContext}: Error running SQL:`, sqlError.message);

                  // Check if this error should be ignored based on configuration
                  const errorsToIgnore = ignoreErrors[opType] || [];
                  const shouldIgnore = errorsToIgnore.some(ignoredErr =>
                       (ignoredErr.code === undefined || ignoredErr.code === sqlError.errno) && // Check MySQL error number (errno)
                       (ignoredErr.sqlState === undefined || ignoredErr.sqlState === sqlError.sqlState) && // Check SQLSTATE
                       (ignoredErr.messageSubstring === undefined || sqlError.message.includes(ignoredErr.messageSubstring)) // Check message substring
                  );

                  if (shouldIgnore) {
                       console.warn(`[MySQL DB Connector] ${opContext}: Ignoring known error (Code: ${sqlError.errno}). Treating as skipped/success.`);
                       return {
                           entitlement: iglmEntitlementName,
                           appEntitlementId: appEntitlementId,
                           status: 'skipped', // Treat ignored error as skipped
                           message: `Ignored error: ${sqlError.message}`,
                           error: sqlError.message,
                           sql: template
                       };
                  } else {
                       // Unhandled error - mark as failed
                       return {
                           entitlement: iglmEntitlementName,
                           appEntitlementId: appEntitlementId,
                           status: 'failed',
                           message: `SQL error: ${sqlError.message}`,
                           error: sqlError.message,
                           sql: template
                       };
                  }
             }
        };


        // --- 3. Process Grants ---
        const grantsToProcess = entitlementsToGrant || [];
        console.log(`[MySQL DB Connector] Processing ${grantsToProcess.length} entitlements to grant...`);
        for (const grantItem of grantsToProcess) {
            const { iglmEntitlementId, iglmEntitlementName, appEntitlementId } = grantItem;
            const opContext = `User "${userIdInApp}" grant "${iglmEntitlementName}" (${appEntitlementId})`;

            const grantTemplate = sqlTemplates.grant[iglmEntitlementId] || sqlTemplates.grant.default;
            const paramMapConfig = parameterMapping.grant?.[iglmEntitlementId] || parameterMapping.grant?.default;

             const result = await executeSqlTemplate(grantTemplate, { ...grantItem, userIdInApp }, paramMapConfig, 'granted', opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId);
            operationResults.push(result);
        }

        // --- 4. Process Revokes ---
        const revokesToProcess = entitlementsToRevoke || [];
        console.log(`[MySQL DB Connector] Processing ${revokesToProcess.length} entitlements to revoke...`);
        for (const revokeItem of revokesToProcess) {
            const { iglmEntitlementId, iglmEntitlementName, appEntitlementId } = revokeItem;
            const opContext = `User "${userIdInApp}" revoke "${iglmEntitlementName}" (${appEntitlementId})`;

            const revokeTemplate = sqlTemplates.revoke[iglmEntitlementId] || sqlTemplates.revoke.default;
            const paramMapConfig = parameterMapping.revoke?.[iglmEntitlementId] || parameterMapping.revoke?.default;

             const result = await executeSqlTemplate(revokeTemplate, { ...revokeItem, userIdInApp }, paramMapConfig, 'revoked', opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId);
            operationResults.push(result);
        }


        // --- 5. Check Overall Operation Status and Return Summary ---
        const overallSuccess = !operationResults.some(op => op.status === 'failed');

        console.log(`[MySQL DB Connector] Finished operations. Overall success: ${overallSuccess}. Results:`, operationResults.map(r => ({ entitlement: r.entitlement, status: r.status, appEntitlementId: r.appEntitlementId })));

        return { success: overallSuccess, operations: operationResults };

    } catch (error) {
        // Catch any critical errors that occurred before processing operations (config, connection)
        console.error('[MySQL DB Connector] Overall error during applyDesiredState:', error);
        // Ensure the database connection is closed if it was opened
        if (connection) {
            try { await connection.end(); console.log('[MySQL DB Connector] DB connection closed after overall error.'); }
            catch(e) { console.error('[MySQL DB Connector] Error closing DB connection after overall error:', e); }
        }
         // Re-throw the error so provisioningLogic can catch it and mark the task failed
        throw error;

    } finally {
        // --- 6. Close Connection ---
        // Ensure the database connection is always closed if it was opened.
        if (connection) {
             try {
                 await connection.end(); // Close the connection (or release from pool)
                 console.log('[MySQL DB Connector] DB connection closed in finally block.');
             } catch (closeError) {
                 console.error('[MySQL DB Connector] Error closing DB connection in finally block:', closeError);
             }
         } else {
             console.log('[MySQL DB Connector] DB connection was not initialized.');
         }
    }
}

// Helper function to get a value from a nested object path (copy from provisioningLogic)
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
    applyDesiredState,
    // Optional methods: discoverUsers, discoverEntitlements
};