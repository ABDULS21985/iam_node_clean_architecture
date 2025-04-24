// services/provisioning-service/src/connectors/provisioning/ad-ldap.js

// You will need to install an LDAP library: npm install ldapjs (if not already done)
const ldap = require('ldapjs');

/**
 * Active Directory / LDAP Provisioning Connector Adapter.
 * Manages user accounts and group memberships in an LDAP directory.
 *
 * Note: This implementation focuses on adding/removing users from groups.
 * More complex operations (creating users, updating attributes) would require
 * additional logic and potentially different adapter methods.
 */

/**
 * Applies the desired state (grant/revoke entitlements) for a user in the LDAP directory.
 * This method is called by provisioningLogic.js.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "connection": {
 * "url": "ldap://your-ldap-server:389", // LDAP server URL (required)
 * "bindDn": "cn=BindUser,dc=example,dc=com", // DN to bind with (required)
 * "bindPassword": "yoursecurepassword"       // Password for binding (required)
 * },
 * "userMapping": {
 * "userDnTemplate": "cn=:userIdInApp,ou=Users,dc=example,dc=com", // Template to construct user DN from userIdInApp
 * // OR "userIdInAppIsDn": true // If userIdInApp is already the full user DN
 * },
 * // Add other LDAP specific options like connectTimeout, requestTimeout, strictDN etc.
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * {
 * "userIdInApp": "...", // The user's identifier for AD/LDAP (e.g., sAMAccountName, userPrincipalName, or full DN)
 * "entitlementsToGrant": [ // Array of entitlements to grant (mapped by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the LDAP Group DN for group memberships
 * ],
 * "entitlementsToRevoke": [ // Array of entitlements to revoke (if determined by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the LDAP Group DN for group memberships
 * ]
 * }
 * @returns {Promise<object>} A promise resolving with the result of the provisioning operations.
 * Returns { success: boolean, operations: Array<{ entitlement: string, status: 'granted'|'revoked'|'skipped'|'failed', message?: string, error?: string, appEntitlementId?: string }> }.
 * @throws {Error} If a critical configuration or connection/bind failure occurs.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    const serviceName = 'provisioning-service'; // Or pass service name from options
    console.log(`[AD/LDAP Connector] Applying desired state for user: ${appSpecificDesiredState?.userIdInApp || 'N/A'}`);
    // console.log(`[AD/LDAP Connector] Config details (excluding password):`, { ...configDetails, connection: { url: configDetails?.connection?.url, bindDn: configDetails?.connection?.bindDn }}); // Log sensitive data carefully
    console.log(`[AD/LDAP Connector] Desired state (summary): Granting ${appSpecificDesiredState?.entitlementsToGrant?.length || 0}, Revoking ${appSpecificDesiredState?.entitlementsToRevoke?.length || 0}`);


    let client = null; // ldapjs client instance
    const operationResults = []; // Collect results for each entitlement operation

    try {
        // --- 1. Validate Configuration and Input ---
        const connConfig = configDetails?.connection;
        const userMappingConfig = configDetails?.userMapping; // Get user mapping part of configDetails
        if (!connConfig || !connConfig.url || !connConfig.bindDn || !connConfig.bindPassword) {
             throw new Error("Invalid AD/LDAP connector configuration: Missing connection details (url, bindDn, bindPassword).");
        }
         const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState || {}; // Handle case where appSpecificDesiredState is null/undefined
         if (!userIdInApp) {
             throw new Error("Invalid appSpecificDesiredState: Missing userIdInApp.");
         }

         // Determine the user's full DN for LDAP operations
         let userDn;
         if (userMappingConfig?.userDnTemplate) {
              // Use the template to construct the DN
              userDn = userMappingConfig.userDnTemplate.replace(':userIdInApp', userIdInApp);
              if (userDn === userMappingConfig.userDnTemplate) {
                  // Placeholder substitution didn't happen - likely issue with template or userIdInApp format
                  console.warn(`[AD/LDAP Connector] User DN template "${userMappingConfig.userDnTemplate}" did not replace ':userIdInApp' with "${userIdInApp}". Result: "${userDn}". Proceeding, but check template.`);
              }
         } else if (userMappingConfig?.userIdInAppIsDn === true) {
              // Assume userIdInApp is already the full DN
              userDn = userIdInApp;
         } else {
              // Default assumption or error - cannot determine user DN
               console.error(`[AD/LDAP Connector] Cannot determine user DN for userIdInApp "${userIdInApp}". Missing userMapping or userDnTemplate/userIdInAppIsDn config.`);
               throw new Error(`AD/LDAP connector requires user DN mapping configuration.`);
         }
         console.log(`[AD/LDAP Connector] Determined user DN: "${userDn}"`);


        // --- 2. Establish LDAP Connection and Bind ---
        // Use createClient options for timeouts (connectTimeout, requestTimeout etc.), reconnects
        try {
             client = ldap.createClient({ url: connConfig.url, connectTimeout: 5000, // Example timeout
                // Add other ldapjs client options here
             });

             // Add event listeners for connection errors
             client.on('error', (err) => {
                 console.error('[AD/LDAP Connector] LDAP client error:', err);
                 // This catches connection errors after client creation but before/during operations
                 // Ensure these errors are somehow reflected in the operation results or task status
             });
              client.on('timeout', (err) => {
                  console.error('[AD/LDAP Connector] LDAP client timeout:', err);
              });


             // Bind asynchronously
             await new Promise((resolve, reject) => {
                  client.bind(connConfig.bindDn, connConfig.bindPassword, (err) => {
                      if (err) {
                          console.error('[AD/LDAP Connector] LDAP bind failed:', err);
                          reject(err); // Reject the promise on bind failure
                      }
                      else resolve(); // Resolve on successful bind
                  });
             });
             console.log(`[AD/LDAP Connector] Successfully bound to LDAP server: ${connConfig.url}`);

        } catch (bindError) {
             // Catch errors during client creation or initial bind
             console.error('[AD/LDAP Connector] Failed to connect or bind to LDAP server:', bindError);
             if (client) { try { client.destroy(); } catch(e) { console.error('[AD/LDAP Connector] Error destroying client after bind failure:', e); } }
             throw new Error(`AD/LDAP connector failed to connect or bind: ${bindError.message}`); // Critical failure
        }


        // --- 3. Perform Operations (Grant/Revoke Entitlements) ---
        // Note: Processing grants and revokes in separate loops is common.
        // Order might matter depending on logic (e.g., add to groups before removing from others).
        // This implementation processes grants first, then revokes.

        // Process entitlements to grant (e.g., add user to groups)
        const grantsToProcess = appSpecificDesiredState.entitlementsToGrant || []; // Ensure it's an array even if null
        console.log(`[AD/LDAP Connector] Processing ${grantsToProcess.length} entitlements to grant...`);
        for (const grantItem of grantsToProcess) {
             const { appEntitlementId, iglmEntitlementName } = grantItem; // appEntitlementId is the LDAP Group DN
             const opContext = `User "${userIdInApp}" grant "${iglmEntitlementName}" (${appEntitlementId})`;

             if (!appEntitlementId) {
                  console.warn(`[AD/LDAP Connector] ${opContext}: Skipping - Missing appEntitlementId (Group DN).`);
                  operationResults.push({ entitlement: iglmEntitlementName, status: 'skipped', message: 'Missing Group DN', appEntitlementId: appEntitlementId });
                  continue;
             }

             console.log(`[AD/LDAP Connector] ${opContext}: Adding member "${userDn}" to group "${appEntitlementId}"...`);
             try {
                  // Construct the change object to add the user's DN to the group's member attribute
                  const change = new ldap.Change({
                       operation: 'add',
                       modification: { member: userDn } // Assuming 'member' attribute for group members
                  });

                  // Perform the LDAP modify operation on the group entry
                  await new Promise((resolve, reject) => {
                       client.modify(appEntitlementId, change, (err) => { // Modify the group entry (appEntitlementId is the group DN)
                           if (err) {
                                // Handle specific LDAP errors gracefully if possible
                                // ConstraintViolationError (code 19) with message "MEMBER_ALREADY_EXISTS" is common for already a member
                                if (err.name === 'ConstraintViolationError' && err.message.includes('MEMBER_ALREADY_EXISTS')) {
                                     console.log(`[AD/LDAP Connector] ${opContext}: User is already a member. Treating as skipped/success.`);
                                     operationResults.push({ entitlement: iglmEntitlementName, status: 'skipped', message: 'Already a member', appEntitlementId: appEntitlementId });
                                     return resolve(); // Treat as success/skipped and resolve
                                }
                               // Reject for other errors
                               console.error(`[AD/LDAP Connector] ${opContext}: LDAP modify error -`, err);
                               return reject(err);
                           } else {
                                // Success
                                console.log(`[AD/LDAP Connector] ${opContext}: Successfully added member.`);
                                operationResults.push({ entitlement: iglmEntitlementName, status: 'granted', appEntitlementId: appEntitlementId });
                                resolve(); // Resolve on successful modify
                           }
                       });
                  });

             } catch (opError) {
                  // Catch errors during the individual modify operation promise
                  console.error(`[AD/LDAP Connector] ${opContext}: Error processing operation:`, opError);
                  operationResults.push({ entitlement: iglmEntitlementName, status: 'failed', error: opError.message, appEntitlementId: appEntitlementId });
                  // Continue processing other entitlements even if one fails (collect failures)
             }
        }

        // Process entitlements to revoke (e.g., remove user from groups)
        const revokesToProcess = appSpecificDesiredState.entitlementsToRevoke || []; // Ensure it's an array
        console.log(`[AD/LDAP Connector] Processing ${revokesToProcess.length} entitlements to revoke...`);
        for (const revokeItem of revokesToProcess) {
             const { appEntitlementId, iglmEntitlementName } = revokeItem; // appEntitlementId is the LDAP Group DN
             const opContext = `User "${userIdInApp}" revoke "${iglmEntitlementName}" (${appEntitlementId})`;

             if (!appEntitlementId) {
                  console.warn(`[AD/LDAP Connector] ${opContext}: Skipping - Missing appEntitlementId (Group DN).`);
                  operationResults.push({ entitlement: iglmEntitlementName, status: 'skipped', message: 'Missing Group DN', appEntitlementId: appEntitlementId });
                  continue;
             }
             console.log(`[AD/LDAP Connector] ${opContext}: Removing member "${userDn}" from group "${appEntitlementId}"...`);
             try {
                  // Construct the change object to remove the user's DN from the group's member attribute
                  const change = new ldap.Change({
                       operation: 'delete',
                       modification: { member: userDn } // Assuming 'member' attribute
                  });

                  // Perform the LDAP modify operation on the group entry
                  await new Promise((resolve, reject) => {
                       client.modify(appEntitlementId, change, (err) => {
                           if (err) {
                                // Handle specific LDAP errors gracefully
                                // ConstraintViolationError (code 19) with message "NO_SUCH_ATTRIBUTE" (or similar depending on LDAP server) is common for not a member
                                if (err.name === 'ConstraintViolationError' && err.message.includes('NO_SUCH_ATTRIBUTE')) {
                                     console.log(`[AD/LDAP Connector] ${opContext}: User is not a member. Treating as skipped/success.`);
                                     operationResults.push({ entitlement: iglmEntitlementName, status: 'skipped', message: 'Not a member', appEntitlementId: appEntitlementId });
                                     return resolve(); // Treat as success/skipped
                                }
                                console.error(`[AD/LDAP Connector] ${opContext}: LDAP modify error -`, err);
                                return reject(err); // Reject for other errors
                           } else {
                                console.log(`[AD/LDAP Connector] ${opContext}: Successfully removed member.`);
                                operationResults.push({ entitlement: iglmEntitlementName, status: 'revoked', appEntitlementId: appEntitlementId });
                                resolve(); // Resolve on successful modify
                           }
                       });
                  });

             } catch (opError) {
                  console.error(`[AD/LDAP Connector] ${opContext}: Error processing operation:`, opError);
                  operationResults.push({ entitlement: iglmEntitlementName, status: 'failed', error: opError.message, appEntitlementId: appEntitlementId });
             }
        }


        // --- 4. Check Overall Operation Status and Return Summary ---
        // Determine overall success based on whether ANY operation failed
        const overallSuccess = !operationResults.some(op => op.status === 'failed');

        console.log(`[AD/LDAP Connector] Finished operations. Overall success: ${overallSuccess}. Results:`, operationResults);
        return { success: overallSuccess, operations: operationResults };

    } catch (error) {
        // Catch any errors that happened *before* processing operations (config, connection, bind)
        console.error('[AD/LDAP Connector] Overall error during applyDesiredState:', error);
        // Ensure the client is destroyed if connection/bind failed
        if (client) {
            try { client.destroy(); } catch(e) { console.error('[AD/LDAP Connector] Error destroying client after overall failure:', e); }
        }
        // Re-throw the error so provisioningLogic can catch it and mark the task failed
        throw error;

    } finally {
        // --- 5. Close Connection ---
        // Always ensure the client connection is unbound and destroyed
        if (client) {
             try {
                 client.unbind(); // Unbind from LDAP (asynchronous)
                 client.destroy(); // Destroy the client (closes connection)
                 console.log('[AD/LDAP Connector] LDAP connection unbound and client destroyed.');
             } catch (closeError) {
                 console.error('[AD/LDAP Connector] Error closing LDAP connection:', closeError);
             }
         } else {
              console.log('[AD/LDAP Connector] LDAP client was not initialized.');
         }
    }
}


// Helper function to determine the user's full DN for LDAP operations.
// This is needed internally by the adapter. It uses the userMapping part of the connector config.
// Assumes userMappingConfig has userDnTemplate or indicates userIdInApp is the DN.
/* Moved inline near where userDn is determined
function determineLdapUserDn(userIdInApp, userMappingConfig, configDetails) {
    if (!userIdInApp) return null;
    if (userMappingConfig?.userIdInAppIsDn) return userIdInApp;
    if (userMappingConfig?.userDnTemplate) return userMappingConfig.userDnTemplate.replace(':userIdInApp', userIdInApp);
    // Fallback or error if no mapping rule
    console.error(`[AD/LDAP Connector] Cannot determine user DN for userIdInApp "${userIdInApp}". No user mapping config.`);
    return null;
}
*/


module.exports = {
    applyDesiredState,
    // addtional methods like createUser, deleteUser, discoverUsers, discoverEntitlements if needed
};