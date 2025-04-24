// services/provisioning-service/src/connectors/provisioning/app-db-postgres.js
const { Client } = require('pg'); // Or other database library like 'pg-pool'

/**
 * PostgreSQL Database Provisioning Connector Adapter.
 * Manages access directly via SQL INSERT/UPDATE/DELETE.
 *
 * Note: This adapter relies on predefined SQL templates in the configuration
 * to perform provisioning actions (grant/revoke).
 */

/**
 * Applies the desired state (grant/revoke entitlements) for a user by executing
 * predefined SQL templates against a PostgreSQL database.
 * This method is called by provisioningLogic.js.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": {
 * "user": "dbuser",
 * "host": "dbhost",
 * "database": "dbname",
 * "password": "dbpassword",
 * "port": 5432
 * // ... other pg Client/Pool configuration options
 * },
 * "sqlTemplates": {
 * "grant": {
 * // Templates keyed by iglmEntitlementId, or a 'default' template
 * "entitlementId1": "INSERT INTO user_entitlements (user_id, entitlement_id, granted_date) VALUES ($1, $2, NOW());",
 * "default": "INSERT INTO user_group_memberships (user_identifier, group_identifier) VALUES ($1, $2);"
 * },
 * "revoke": {
 * // Templates keyed by iglmEntitlementId, or a 'default' template
 * "entitlementId1": "DELETE FROM user_entitlements WHERE user_id = $1 AND entitlement_id = $2;",
 * "default": "DELETE FROM user_group_memberships WHERE user_identifier = $1 AND group_identifier = $2;"
 * }
 * },
 * "userMapping": {
 * "userIdInAppParamIndex": 1 // Index of $ parameter in SQL templates for userIdInApp (default 1)
 * },
 * "entitlementMapping": {
 * "appEntitlementIdParamIndex": 2 // Index of $ parameter in SQL templates for appEntitlementId (default 2)
 * }
 * // ... other adapter specific options
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * {
 * "userIdInApp": "...", // The user's identifier for the application database
 * "entitlementsToGrant": [ // Array of entitlements to grant (mapped by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the value used in the SQL template (e.g., a group ID, role name)
 * ],
 * "entitlementsToRevoke": [ // Array of entitlements to revoke (if determined by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the value used in the SQL template
 * ]
 * }
 * @returns {Promise<object>} A promise resolving with the result of the provisioning operations.
 * Returns { success: boolean, operations: Array<{ entitlement: string, appEntitlementId?: string, status: 'granted'|'revoked'|'skipped'|'failed', message?: string, error?: string, dbResult?: { rowCount: number } }> }.
 * @throws {Error} If a critical configuration or database connection error occurs.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    const serviceName = 'provisioning-service';
    console.log(`[Postgres DB Connector] Applying desired state for user: ${appSpecificDesiredState?.userIdInApp || 'N/A'}`);
    // console.log(`[Postgres DB Connector] Config details (excluding password):`, { ...configDetails, connection: { ...configDetails?.connection, password: '***' } }); // Log sensitive data carefully
    console.log(`[Postgres DB Connector] Desired state (summary): Granting ${appSpecificDesiredState?.entitlementsToGrant?.length || 0}, Revoking ${appSpecificDesiredState?.entitlementsToRevoke?.length || 0}`);

    let client = null; // Or pool client
    const operationResults = []; // Collect results for each entitlement operation

    try {
        // --- 1. Validate Configuration and Input ---
        const dbConfig = configDetails?.connection;
        const sqlTemplates = configDetails?.sqlTemplates;
        const userMappingConfig = configDetails?.userMapping || {};
        const entitlementMappingConfig = configDetails?.entitlementMapping || {};

        const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState || {}; // Handle case where appSpecificDesiredState is null/undefined

        if (!dbConfig || !dbConfig.host || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
             throw new Error("Invalid Postgres DB connector configuration: Missing connection details (host, database, user, password).");
        }
        if (!sqlTemplates || !sqlTemplates.grant || !sqlTemplates.revoke) {
            throw new Error("Invalid Postgres DB connector configuration: Missing sqlTemplates (grant or revoke).");
        }
        if (!userIdInApp) {
             throw new Error("Invalid appSpecificDesiredState: Missing userIdInApp.");
        }

        const userIdInAppParamIndex = userMappingConfig.userIdInAppParamIndex ?? 1; // Default to $1
        const appEntitlementIdParamIndex = entitlementMappingConfig.appEntitlementIdParamIndex ?? 2; // Default to $2

        // --- 2. Establish Connection ---
        try {
             client = new Client(dbConfig); // Or get client from a pool
             await client.connect();
             console.log(`[Postgres DB Connector] Successfully connected to ${dbConfig.database}.`);
        } catch (connError) {
            console.error('[Postgres DB Connector] Failed to connect to database:', connError.message);
            throw new Error(`Postgres DB connector failed to connect: ${connError.message}`); // Critical failure
        }


        // --- 3. Process Grants ---
        const grantsToProcess = entitlementsToGrant || []; // Ensure it's an array even if null
        console.log(`[Postgres DB Connector] Processing ${grantsToProcess.length} entitlements to grant...`);
        for (const grantItem of grantsToProcess) {
            const { iglmEntitlementId, appEntitlementId, iglmEntitlementName } = grantItem;
            const opContext = `User "${userIdInApp}" grant "${iglmEntitlementName}" (${appEntitlementId})`;

            const grantTemplate = sqlTemplates.grant[iglmEntitlementId] || sqlTemplates.grant.default;

            if (!grantTemplate) {
                 console.warn(`[Postgres DB Connector] ${opContext}: Skipping - No SQL template found for IGLM ID "${iglmEntitlementId}" and no default 'grant' template.`);
                 operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing SQL template' });
                 continue;
            }
            if (appEntitlementId === undefined || appEntitlementId === null) {
                 console.warn(`[Postgres DB Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
                 operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId' });
                 continue;
            }

             console.log(`[Postgres DB Connector] ${opContext}: Running grant SQL...`);
             // Construct bind parameters array based on configured indices
             const params = [];
             params[userIdInAppParamIndex - 1] = userIdInApp; // Array index is 0-based
             params[appEntitlementIdParamIndex - 1] = appEntitlementId; // Array index is 0-based
             // Add checks/logic here if templates require more parameters

             try {
                 const result = await client.query(grantTemplate, params);
                 console.log(`[Postgres DB Connector] ${opContext}: Grant SQL successful. Rows affected: ${result.rowCount}.`);
                 // Consider rowCount > 0 as successful grant. If rowCount === 0, maybe it already existed?
                 // PostgreSQL unique constraint violation error code is '23505'
                 operationResults.push({
                    entitlement: iglmEntitlementName,
                    appEntitlementId: appEntitlementId,
                    status: result.rowCount > 0 ? 'granted' : 'skipped', // Treat 0 rows affected as skipped (likely already exists)
                    message: result.rowCount > 0 ? undefined : 'Already exists',
                    dbResult: { rowCount: result.rowCount }
                 });
             } catch (sqlError) {
                  // Check for specific error codes if needed (e.g., 23505 for unique violation - already exists)
                  if (sqlError.code === '23505') { // Unique violation
                      console.log(`[Postgres DB Connector] ${opContext}: User already has entitlement (unique constraint violation). Treating as skipped/success.`);
                       operationResults.push({
                           entitlement: iglmEntitlementName,
                           appEntitlementId: appEntitlementId,
                           status: 'skipped',
                           message: 'Already exists'
                       });
                  } else {
                      console.error(`[Postgres DB Connector] ${opContext}: Error running grant SQL:`, sqlError.message);
                       operationResults.push({
                           entitlement: iglmEntitlementName,
                           appEntitlementId: appEntitlementId,
                           status: 'failed',
                           error: sqlError.message
                       });
                  }
             }
        }

        // --- 4. Process Revokes ---
        const revokesToProcess = entitlementsToRevoke || []; // Ensure it's an array
        console.log(`[Postgres DB Connector] Processing ${revokesToProcess.length} entitlements to revoke...`);
        for (const revokeItem of revokesToProcess) {
             const { iglmEntitlementId, appEntitlementId, iglmEntitlementName } = revokeItem;
             const opContext = `User "${userIdInApp}" revoke "${iglmEntitlementName}" (${appEntitlementId})`;

             const revokeTemplate = sqlTemplates.revoke[iglmEntitlementId] || sqlTemplates.revoke.default;

             if (!revokeTemplate) {
                  console.warn(`[Postgres DB Connector] ${opContext}: Skipping - No SQL template found for IGLM ID "${iglmEntitlementId}" and no default 'revoke' template.`);
                  operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing SQL template' });
                  continue;
             }
             if (appEntitlementId === undefined || appEntitlementId === null) {
                  console.warn(`[Postgres DB Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
                  operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId' });
                  continue;
             }

             console.log(`[Postgres DB Connector] ${opContext}: Running revoke SQL...`);
             // Construct bind parameters array based on configured indices
             const params = [];
             params[userIdInAppParamIndex - 1] = userIdInApp; // Array index is 0-based
             params[appEntitlementIdParamIndex - 1] = appEntitlementId; // Array index is 0-based
             // Add checks/logic here if templates require more parameters

             try {
                  const result = await client.query(revokeTemplate, params);
                  console.log(`[Postgres DB Connector] ${opContext}: Revoke SQL successful. Rows affected: ${result.rowCount}.`);
                  // Consider rowCount > 0 as successful revoke. If rowCount === 0, maybe they didn't have it?
                   operationResults.push({
                       entitlement: iglmEntitlementName,
                       appEntitlementId: appEntitlementId,
                       status: result.rowCount > 0 ? 'revoked' : 'skipped', // Treat 0 rows affected as skipped (likely didn't have it)
                       message: result.rowCount > 0 ? undefined : 'Not found',
                       dbResult: { rowCount: result.rowCount }
                   });
             } catch (sqlError) {
                  // Depending on the SQL, errors might include foreign key violations, etc.
                  // You might add specific error code checks here if needed.
                  console.error(`[Postgres DB Connector] ${opContext}: Error running revoke SQL:`, sqlError.message);
                   operationResults.push({
                       entitlement: iglmEntitlementName,
                       appEntitlementId: appEntitlementId,
                       status: 'failed',
                       error: sqlError.message
                   });
             }
        }


        // --- 5. Check Overall Operation Status and Return Summary ---
        // Determine overall success based on whether ANY operation failed
        const overallSuccess = !operationResults.some(op => op.status === 'failed');

        console.log(`[Postgres DB Connector] Finished operations. Overall success: ${overallSuccess}. Results:`, operationResults);
        return { success: overallSuccess, operations: operationResults };

    } catch (error) {
        // Catch any errors that happened *before* processing operations (config, connection)
        console.error('[Postgres DB Connector] Overall error during applyDesiredState:', error);
         // Ensure the client is ended if connection failed before processing
        if (client) {
             try { client.end(); } catch(e) { console.error('[Postgres DB Connector] Error ending client after overall failure:', e); }
        }
        // Re-throw the error so provisioningLogic can catch it and mark the task failed
        throw error;

    } finally {
        // --- 6. Close Connection ---
        // Always ensure the client connection is ended
        if (client) {
             try {
                 await client.end(); // End the client connection (asynchronous)
                 console.log('[Postgres DB Connector] DB connection closed.');
             } catch (closeError) {
                  console.error('[Postgres DB Connector] Error closing DB connection:', closeError);
             }
         } else {
              console.log('[Postgres DB Connector] DB client was not initialized.');
         }
    }
}

module.exports = {
    applyDesiredState,
    // Optional: addtional methods like discoverUsers, discoverEntitlements if needed
};