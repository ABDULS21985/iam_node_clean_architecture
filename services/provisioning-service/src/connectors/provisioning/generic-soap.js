// services/provisioning-service/src/connectors/provisioning/generic-soap.js
// Using 'soap' library for example, but others like 'strong-soap' might be more modern.
// You will need to install: npm install soap
const soap = require('soap');
const { promisify } = require('util'); // Built-in Node.js module for promisifying

/**
 * Generic SOAP Provisioning Connector Adapter.
 * Manages access by making SOAP requests based on configured operations and message templates.
 *
 * Note: This is a generic adapter. Specific, complex SOAP APIs might require a dedicated adapter.
 * This implementation focuses on simple request/response patterns.
 */

/**
 * Applies the desired state (grant/revoke entitlements) for a user by making
 * predefined SOAP requests to a target SOAP service.
 * This method is called by provisioningLogic.js.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "wsdlUrl": "http://your-soap-service.com/service?wsdl", // Required: WSDL URL
 * "endpoint": "http://your-soap-service.com/service", // Optional: Explicit service endpoint if different from WSDL
 * "auth": { // Optional: Authentication details
 * "type": "basic", // e.g., "basic"
 * "username": "soapuser",
 * "password": "soappassword"
 * // TODO: Add support for other auth types (WS-Security etc.)
 * },
 * "operationTemplates": { // Required: Configuration for SOAP operations
 * "grant": {
 * // Operation configs keyed by iglmEntitlementId, or a 'default' operation config
 * "00000000-0000-0000-0000-000000000501": { // Example entitlement ID
 * "soapOperationName": "AssignRole", // Required: The name of the SOAP operation to call
 * "messageTemplate": { // Required: Template for the SOAP message body (XML or JS object structure)
 * "AssignRoleRequest": {
 * "UserId": ":userIdInApp", // Placeholder for userIdInApp
 * "RoleId": ":appEntitlementId" // Placeholder for appEntitlementId
 * // Add other parameters with their placeholders (e.g., ":metadata.department")
 * }
 * },
 * "successCriteria": { // Required: How to determine if the operation was successful
 * "responsePath": "AssignRoleResponse.ResultCode", // Path in the response to check
 * "expectedValue": "SUCCESS", // Expected value at the path
 * // OR "xpath": "//ns:ResultCode/text()", "expectedValue": "SUCCESS" // Using XPath if needed
 * // OR "checkFunction": "(response) => response.AssignRoleResponse.Success === true" // Custom function
 * },
 * "errorMessagePath": "AssignRoleResponse.ErrorMessage" // Optional: Path to extract error message on failure
 * },
 * "default": { // Default operation config for grant
 * "soapOperationName": "GrantAccess",
 * "messageTemplate": { "GrantAccessRequest": { "UserIdentifier": ":userIdInApp", "AccessItemId": ":appEntitlementId" } },
 * "successCriteria": { "responsePath": "GrantAccessResponse.Status", "expectedValue": "GRANTED" },
 * "errorMessagePath": "GrantAccessResponse.ErrorDescription"
 * }
 * },
 * "revoke": {
 * // Operation configs keyed by iglmEntitlementId, or a 'default' operation config
 * "00000000-0000-0000-0000-000000000501": {
 * "soapOperationName": "RemoveRole",
 * "messageTemplate": { "RemoveRoleRequest": { "UserId": ":userIdInApp", "RoleId": ":appEntitlementId" } },
 * "successCriteria": { "responsePath": "RemoveRoleResponse.ResultCode", "expectedValue": "SUCCESS" },
 * "errorMessagePath": "RemoveRoleResponse.ErrorMessage"
 * },
 * "default": { // Default operation config for revoke
 * "soapOperationName": "RevokeAccess",
 * "messageTemplate": { "RevokeAccessRequest": { "UserIdentifier": ":userIdInApp", "AccessItemId": ":appEntitlementId" } },
 * "successCriteria": { "responsePath": "RevokeAccessResponse.Status", "expectedValue": "REVOKED" },
 * "errorMessagePath": "RevokeAccessResponse.ErrorDescription"
 * }
 * }
 * // Add other adapter specific options
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * {
 * "userIdInApp": "...", // The user's identifier for the SOAP service
 * "entitlementsToGrant": [ // Array of entitlements to grant (mapped by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the value used as a parameter in the SOAP message template
 * ],
 * "entitlementsToRevoke": [ // Array of entitlements to revoke (if determined by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ... // appEntitlementId is the value used as a parameter in the SOAP message template
 * ]
 * }
 * @returns {Promise<object>} A promise resolving with the result of the provisioning operations.
 * Returns { success: boolean, operations: Array<{ entitlement: string, appEntitlementId?: string, status: 'granted'|'revoked'|'skipped'|'failed', message?: string, error?: string, soapOperation?: string, requestData?: any, responseData?: any }> }.
 * @throws {Error} If a critical configuration or SOAP client initialization error occurs.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    const serviceName = 'provisioning-service';
    console.log(`[Generic SOAP Connector] Applying desired state for user: ${appSpecificDesiredState?.userIdInApp || 'N/A'}`);
    // console.log(`[Generic SOAP Connector] Config details (excluding password):`, { ...configDetails, auth: { ...configDetails?.auth, password: '***' } }); // Log sensitive data carefully
    console.log(`[Generic SOAP Connector] Desired state (summary): Granting ${appSpecificDesiredState?.entitlementsToGrant?.length || 0}, Revoking ${appSpecificDesiredState?.entitlementsToRevoke?.length || 0}`);

    let soapClient = null; // soap client instance
    const operationResults = [];

    try {
        // --- 1. Validate Configuration and Input ---
        const { wsdlUrl, endpoint, auth, operationTemplates } = configDetails || {};

        const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState || {};

        if (!wsdlUrl) {
            throw new Error("Invalid Generic SOAP connector configuration: Missing 'wsdlUrl'.");
        }
        if (!operationTemplates || typeof operationTemplates !== 'object' || !operationTemplates.grant || typeof operationTemplates.grant !== 'object' || !operationTemplates.revoke || typeof operationTemplates.revoke !== 'object') {
             throw new Error("Invalid Generic SOAP connector configuration: Missing or invalid 'operationTemplates' structure (must have 'grant' and 'revoke' objects).");
        }
         if (!userIdInApp) {
              console.warn(`[Generic SOAP Connector] Invalid appSpecificDesiredState: Missing userIdInApp. Skipping all operations.`);
              operationResults.push({ entitlement: 'N/A', status: 'failed', message: 'Missing userIdInApp in desired state' });
              return { success: false, operations: operationResults };
         }

        // --- 2. Initialize SOAP Client ---
        console.log(`[Generic SOAP Connector] Initializing SOAP client for WSDL: ${wsdlUrl}...`);
        try {
             // Promisify soap.createClient for async/await
             const createClientAsync = promisify(soap.createClient);
             soapClient = await createClientAsync(wsdlUrl);

             // Set endpoint if specified
             if (endpoint) {
                 soapClient.setEndpoint(endpoint);
                 console.log(`[Generic SOAP Connector] Set SOAP endpoint to: ${endpoint}`);
             }

             // Set authentication if specified
             if (auth?.type === 'basic' && auth.username && auth.password) {
                 soapClient.setSecurity(new soap.BasicAuthSecurity(auth.username, auth.password));
                 console.log('[Generic SOAP Connector] Configured Basic Authentication.');
             }
             // TODO: Add logic for other security types (e.g., WS-Security)


             console.log('[Generic SOAP Connector] SOAP client initialized.');

             // You might inspect client.describe() here for debugging available services/ports/operations

        } catch (clientError) {
            console.error('[Generic SOAP Connector] Failed to initialize SOAP client:', clientError.message);
            throw new Error(`Generic SOAP connector failed to initialize client: ${clientError.message}`); // Critical failure
        }


         // --- Helper function to execute a single SOAP operation ---
         const executeSoapOperation = async (operationConfig, data, opType, opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId) => {
             const { soapOperationName, messageTemplate, successCriteria, errorMessagePath } = operationConfig || {};

             if (!soapOperationName || !messageTemplate || !successCriteria) {
                  console.warn(`[Generic SOAP Connector] ${opContext}: Skipping - Missing SOAP operation config (name, message template, or success criteria).`);
                   return { entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Incomplete SOAP operation config', iglmEntitlementId: iglmEntitlementId };
             }
             if (appEntitlementId === undefined || appEntitlementId === null) {
                  console.warn(`[Generic SOAP Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
                  return { entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId', iglmEntitlementId: iglmEntitlementId };
             }

             // Construct the SOAP message body using the template and data
             // This is a basic implementation. Complex templates might need a dedicated templating engine.
             // Assumes messageTemplate is a JS object structure that mirrors the desired SOAP body.
             const requestData = JSON.parse(JSON.stringify(messageTemplate)); // Deep clone template
             traverseAndSubstitute(requestData, { ...data, userIdInApp, appEntitlementId }); // Use helper to fill in placeholders

             console.log(`[Generic SOAP Connector] ${opContext}: Calling SOAP Operation "${soapOperationName}" with data:`, requestData);

             let responseData = null;
             let soapFault = null;
             let callError = null;

             try {
                 // Dynamically call the SOAP operation method on the client
                 if (typeof soapClient[soapOperationName] !== 'function') {
                      throw new Error(`SOAP operation "${soapOperationName}" not found on the client. Check WSDL and config.`);
                 }

                 // Promisify the specific SOAP client method call
                 const soapOperationAsync = promisify(soapClient[soapOperationName].bind(soapClient));

                 // Execute the SOAP call
                 // The 'result' is the response body as a JS object. 'rawResponse' is the raw XML. 'soapHeader' is the response header.
                 const [result, rawResponse, soapHeader] = await soapOperationAsync(requestData);
                 responseData = result; // Store the parsed response body

                 console.log(`[Generic SOAP Connector] ${opContext}: SOAP call successful. Response:`, responseData);
                 // console.log(`[Generic SOAP Connector] ${opContext}: Raw Response:\n`, rawResponse); // Uncomment for detailed debugging

                 // --- Determine Success based on successCriteria ---
                 let isSuccessful = false;
                 let successMessage = 'Operation successful';

                 if (successCriteria.checkFunction && typeof successCriteria.checkFunction === 'string') {
                      // Evaluate a custom function string (use with caution, potential security risk)
                      try {
                          // It's safer to define check functions within the adapter code itself or use a sandboxed environment
                          // For this example, we'll use a simple direct evaluation (NOT RECOMMENDED FOR PRODUCTION)
                          const checkFunc = eval(`(${successCriteria.checkFunction})`);
                          isSuccessful = checkFunc(responseData, rawResponse, soapHeader);
                          if (typeof isSuccessful !== 'boolean') {
                               console.warn(`[Generic SOAP Connector] ${opContext}: Success criteria checkFunction did not return a boolean.`);
                               isSuccessful = false; // Default to failed if function doesn't return boolean
                          }
                           successMessage = 'Custom success check passed';
                      } catch (evalError) {
                          console.error(`[Generic SOAP Connector] ${opContext}: Error evaluating success checkFunction:`, evalError);
                          isSuccessful = false; // Treat evaluation error as failure
                          successMessage = `Error evaluating success check: ${evalError.message}`;
                      }

                 } else if (successCriteria.responsePath) {
                     // Check a value at a specific path in the response object
                     const actualValue = getNestedValue(responseData, successCriteria.responsePath);
                     if (actualValue !== undefined) {
                         isSuccessful = (actualValue === successCriteria.expectedValue);
                         successMessage = `Response path "${successCriteria.responsePath}" value "${actualValue}" matches expected "${successCriteria.expectedValue}"`;
                     } else {
                         console.warn(`[Generic SOAP Connector] ${opContext}: Success criteria response path "${successCriteria.responsePath}" not found in response.`);
                         isSuccessful = false; // Path not found means failure
                         successMessage = `Success path "${successCriteria.responsePath}" not found in response`;
                     }

                 }
                 // TODO: Implement success criteria based on XPath or other methods

                 if (isSuccessful) {
                      return {
                           entitlement: iglmEntitlementName,
                           appEntitlementId: appEntitlementId,
                           status: opType, // 'granted' or 'revoked'
                           soapOperation: soapOperationName,
                           requestData: requestData,
                           responseData: responseData,
                           message: successMessage
                       };
                 } else {
                      // Operation called successfully, but application-level success criteria failed
                      const message = `SOAP operation "${soapOperationName}" succeeded but success criteria not met.`;
                      console.error(`[Generic SOAP Connector] ${opContext}: ${message}`);

                      // Attempt to extract a specific error message from the response if configured
                      let errorMessage = message;
                      if (errorMessagePath) {
                           const extractedError = getNestedValue(responseData, errorMessagePath);
                           if (extractedError) {
                               errorMessage = `SOAP operation failed: ${extractedError}`;
                           }
                      }

                      return {
                          entitlement: iglmEntitlementName,
                          appEntitlementId: appEntitlementId,
                          status: 'failed',
                          message: errorMessage,
                          soapOperation: soapOperationName,
                          requestData: requestData,
                          responseData: responseData // Include response for debugging
                       };
                 }

             } catch (soapErr) {
                 // Catch errors during the SOAP call itself (network issues, HTTP errors, SOAP faults)
                 console.error(`[Generic SOAP Connector] ${opContext}: Error during SOAP call:`, soapErr);
                 callError = soapErr;

                 // Check if it's a SOAP Fault
                 if (callError.response && callError.response.statusCode && callError.root && callError.root.Envelope && callError.root.Envelope.Body && callError.root.Envelope.Body.Fault) {
                     soapFault = callError.root.Envelope.Body.Fault;
                     console.error(`[Generic SOAP Connector] ${opContext}: Received SOAP Fault:`, soapFault);
                     // Attempt to extract fault string/detail for error message
                     const faultString = getNestedValue(soapFault, 'faultstring') || getNestedValue(soapFault, 'Fault.Reason.Text.#text') || JSON.stringify(soapFault);
                     return {
                         entitlement: iglmEntitlementName,
                         appEntitlementId: appEntitlementId,
                         status: 'failed',
                         message: `SOAP Fault received: ${faultString}`,
                         error: soapFault, // Store the full fault object
                         soapOperation: soapOperationName,
                         requestData: requestData,
                         responseData: callError.response.data ? callError.response.data.toString() : null // Store raw response data if available
                      };
                 } else {
                      // Other types of errors (network, HTTP non-fault)
                      return {
                          entitlement: iglmEntitlementName,
                          appEntitlementId: appEntitlementId,
                          status: 'failed',
                          message: `SOAP call failed: ${callError.message}`,
                          error: callError.message,
                          soapOperation: soapOperationName,
                          requestData: requestData,
                          responseData: callError.response?.data ? callError.response.data.toString() : null // Store raw response data if available
                      };
                 }
             }
         };


        // --- 3. Process Grants ---
        const grantsToProcess = entitlementsToGrant || [];
        console.log(`[Generic SOAP Connector] Processing ${grantsToProcess.length} entitlements to grant...`);
        for (const grantItem of grantsToProcess) {
            const { iglmEntitlementId, iglmEntitlementName, appEntitlementId } = grantItem;
            const opContext = `User "${userIdInApp}" grant "${iglmEntitlementName}" (${appEntitlementId})`;

            const operationConfig = operationTemplates.grant[iglmEntitlementId] || operationTemplates.grant.default;

             const result = await executeSoapOperation(operationConfig, { ...grantItem, userIdInApp }, 'granted', opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId);
            operationResults.push(result);
        }

        // --- 4. Process Revokes ---
        const revokesToProcess = entitlementsToRevoke || [];
        console.log(`[Generic SOAP Connector] Processing ${revokesToProcess.length} entitlements to revoke...`);
         for (const revokeItem of revokesToProcess) {
              const { iglmEntitlementId, iglmEntitlementName, appEntitlementId } = revokeItem;
              const opContext = `User "${userIdInApp}" revoke "${iglmEntitlementName}" (${appEntitlementId})`;

              const operationConfig = operationTemplates.revoke[iglmEntitlementId] || operationTemplates.revoke.default;

              const result = await executeSoapOperation(operationConfig, { ...revokeItem, userIdInApp }, 'revoked', opContext, iglmEntitlementName, appEntitlementId, iglmEntitlementId);
             operationResults.push(result);
         }


        // --- 5. Check Overall Operation Status and Return Summary ---
        const overallSuccess = !operationResults.some(op => op.status === 'failed');

        console.log(`[Generic SOAP Connector] Finished operations. Overall success: ${overallSuccess}. Results:`, operationResults.map(r => ({ entitlement: r.entitlement, status: r.status, appEntitlementId: r.appEntitlementId, soapOperation: r.soapOperation })));

        return { success: overallSuccess, operations: operationResults };

    } catch (error) {
        // Catch any critical errors that occurred before processing operations (config, client init)
        console.error('[Generic SOAP Connector] Overall error during applyDesiredState:', error);
        // No explicit client closing needed for 'soap' library typically, but can be added if using connection pools or similar
        // Re-throw the error so provisioningLogic can catch it and mark the task failed
        throw error;

    } finally {
        // --- 6. Cleanup ---
        // Always ensure the SOAP client connection is closed
        if (soapClient) { // Check if the client object was successfully initialized
             try {
                 // The 'soap' library manages HTTP connections internally.
                 // client.close() attempts to close the underlying HTTP agent's sockets.
                 // It might not be strictly necessary after every single call if the agent is reused,
                 // but explicit cleanup on task completion or service shutdown is good practice.
                 // For a client created per applyDesiredState call, closing here is appropriate.
                 soapClient.close(); // Use the close method for the soap client
                 console.log('[Generic SOAP Connector] SOAP client connection closed.');
             } catch (closeError) {
                  console.error('[Generic SOAP Connector] Error closing SOAP connection:', closeError);
                  // Log closing errors, but typically not critical enough to re-throw at this stage
             }
         } else {
              console.log('[Generic SOAP Connector] SOAP client was not initialized.');
         }
    }
}

/**
 * Helper function to traverse a JS object structure and substitute placeholders.
 * Placeholders are strings starting with ':' (e.g., ":userIdInApp").
 * Assumes placeholders appear as string values within the object structure.
 *
 * @param {object} obj - The object structure to traverse and modify in place.
 * @param {object} data - An object containing key-value pairs for substitution (keys like 'userIdInApp', 'appEntitlementId').
 */
function traverseAndSubstitute(obj, data) {
    if (obj === null || typeof obj !== 'object') {
        return; // Base case: not an object
    }

    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const value = obj[key];

            if (typeof value === 'string' && value.startsWith(':')) {
                // Found a potential placeholder
                const placeholderKey = value.substring(1); // Remove the leading ':'
                if (data.hasOwnProperty(placeholderKey)) {
                    // Found a matching key in the data, substitute the value
                    obj[key] = data[placeholderKey];
                } else {
                     console.warn(`[Generic SOAP Connector] Placeholder :${placeholderKey} found in message template but no corresponding key in provided data.`);
                     // Decide how to handle missing data - leave placeholder, set null/undefined?
                     // For now, leave it as is.
                }
            } else if (typeof value === 'object') {
                // Recursively traverse nested objects or arrays
                traverseAndSubstitute(value, data);
            }
             // Other primitive types (number, boolean) are left as is
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