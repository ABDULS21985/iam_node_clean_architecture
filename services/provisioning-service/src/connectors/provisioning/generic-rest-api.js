// services/provisioning-service/src/connectors/provisioning/generic-rest-api.js

// You will need to install an HTTP client library: npm install axios (or node-fetch)
const axios = require('axios');

/**
 * Generic REST API Provisioning Connector Adapter.
 * Manages access in applications via REST API calls.
 */

/**
 * Applies the desired state (grant/revoke entitlements) for a user via REST API.
 * This method is called by provisioningLogic.js.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "baseUrl": "https://api.example.com/v1",
 * "authentication": { "type": "apiKey", "header": "X-API-Key", "value": "..." } or { "type": "oauth2", "tokenUrl": "...", "clientId": "...", "clientSecret": "..." }
 * "endpoints": { // Define different API calls needed
 * "grantEntitlement": { "method": "POST", "path": "/users/:userId/entitlements", "body": { "entitlementId": ":appEntitlementId" } },
 * "revokeEntitlement": { "method": "DELETE", "path": "/users/:userId/entitlements/:appEntitlementId" },
 * // ... other operations like createUser, deleteUser if needed by desiredState
 * }
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * {
 * "userIdInApp": "...", // The user's identifier for this API (e.g., email, API specific ID)
 * "entitlementsToGrant": [ // Array of entitlements to grant (mapped by ProvisioningLogic)
 * { "iglmEntitlementId": "...", "appEntitlementId": "...", "assignmentType": "...", "metadata": "...", "mappingDetails": {...} },
 * ...
 * ],
 * // "entitlementsToRevoke": [...] // If revocation logic is implemented
 * }
 * @returns {Promise<object>} A promise resolving with the result of the provisioning operations.
 * @throws {Error} If the operation fails.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    console.log(`[Generic REST Connector] Applying desired state for user: ${appSpecificDesiredState.userIdInApp}`);
    console.log(`[Generic REST Connector] Config details (excluding auth):`, { ...configDetails, authentication: { type: configDetails?.authentication?.type, ... (configDetails?.authentication?.header && { header: configDetails.authentication.header }), ... (configDetails?.authentication?.tokenUrl && { tokenUrl: configDetails.authentication.tokenUrl }) }}); // Log sensitive data carefully
    console.log(`[Generic REST Connector] Desired state:`, appSpecificDesiredState);

    // --- 1. Validate Configuration and Input ---
    const { baseUrl, authentication, endpoints } = configDetails;
    if (!baseUrl || !endpoints) {
         throw new Error("Invalid Generic REST connector configuration: Missing baseUrl or endpoints.");
    }
     const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState;
     if (!userIdInApp) {
         throw new Error("Invalid appSpecificDesiredState: Missing userIdInApp.");
     }
     if (!endpoints.grantEntitlement && entitlementsToGrant?.length > 0) {
          console.warn("[Generic REST Connector] No 'grantEntitlement' endpoint defined in config, but entitlementsToGrant provided.");
          // Decide policy: error, skip grants?
     }
     // TODO: Add checks for revokeEndpoint if entitlementsToRevoke exist


    // --- 2. Handle Authentication ---
    let authToken = null;
    const headers = {};

    if (authentication?.type === 'apiKey' && authentication.header && authentication.value) {
        headers[authentication.header] = authentication.value;
        console.log(`[Generic REST Connector] Using API Key authentication (${authentication.header}).`);
    } else if (authentication?.type === 'oauth2' && authentication.tokenUrl && authentication.clientId && authentication.clientSecret) {
        console.log(`[Generic REST Connector] Using OAuth2 Client Credentials flow.`);
        try {
            // Perform OAuth2 token request
            const tokenResponse = await axios.post(authentication.tokenUrl, new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: authentication.clientId,
                client_secret: authentication.clientSecret,
                // Add scope or other params if needed by API
            }).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            authToken = tokenResponse.data.access_token; // Assuming token is in access_token
            // Determine token type (Bearer, etc.) from response if needed, default to Bearer
            headers['Authorization'] = `Bearer ${authToken}`;
            console.log('[Generic REST Connector] Successfully obtained OAuth2 token.');

        } catch (authError) {
            console.error('[Generic REST Connector] OAuth2 token request failed:', authError.message);
             throw new Error(`OAuth2 authentication failed: ${authError.message}`); // Critical auth failure
        }
    } else {
         console.warn('[Generic REST Connector] No authentication configuration provided or recognized.');
         // Proceed without auth headers
    }


    // --- 3. Perform Operations (Grant/Revoke Entitlements) ---
    const operationResults = [];

    // Process entitlements to grant
    const grantEndpointConfig = endpoints?.grantEntitlement;
    if (grantEndpointConfig && entitlementsToGrant?.length > 0) {
         console.log(`[Generic REST Connector] Processing ${entitlementsToGrant.length} entitlements to grant...`);

         for (const grantItem of entitlementsToGrant) {
             const { appEntitlementId, iglmEntitlementName } = grantItem; // appEntitlementId is the ID used by this API
             if (!appEntitlementId) {
                  console.warn(`[Generic REST Connector] Skipping grant for entitlement "${iglmEntitlementName}": Missing appEntitlementId.`);
                  operationResults.push({ entitlement: iglmEntitlementName, status: 'skipped', message: 'Missing App Entitlement ID' });
                  continue;
             }

             console.log(`[Generic REST Connector] Granting entitlement "${appEntitlementId}" for user "${userIdInApp}"...`);

             try {
                 // Construct the URL and request body/params for this specific grant operation
                 // Use a helper function to substitute placeholders like :userId, :appEntitlementId in paths/bodies
                 const { url, method, body, params } = buildApiRequestDetails(grantEndpointConfig, { userId: userIdInApp, appEntitlementId: appEntitlementId, ...grantItem }); // Need to implement buildApiRequestDetails helper

                 if (!url) {
                     console.error(`[Generic REST Connector] Failed to build API URL for grant entitlement "${appEntitlementId}". Skipping.`);
                     operationResults.push({ entitlement: iglmEntitlementName, status: 'failed', error: 'Failed to build API request details' });
                     continue;
                 }

                 // Make the API call using axios
                 const response = await axios({
                     method: method || 'POST', // Default to POST if not specified
                     url: `${baseUrl}${url}`, // Combine baseUrl with endpoint path
                     headers: headers, // Include authentication headers
                     data: body, // Request body for POST/PUT
                     params: params, // Query parameters
                 });

                 // Check response status code for success (e.g., 200, 201, 204)
                 if (response.status >= 200 && response.status < 300) {
                     console.log(`[Generic REST Connector] Successfully granted entitlement "${appEntitlementId}". Status: ${response.status}`);
                     operationResults.push({ entitlement: iglmEntitlementName, status: 'granted', result: { status: response.status, data: response.data } });
                 } else {
                     console.error(`[Generic REST Connector] API returned non-success status ${response.status} for grant entitlement "${appEntitlementId}". Response:`, response.data);
                     operationResults.push({ entitlement: iglmEntitlementName, status: 'failed', error: `API returned status ${response.status}`, response: response.data });
                     allApplicationsSucceeded = false; // If any grant fails, overall app status is failed
                 }

             } catch (apiCallError) {
                 console.error(`[Generic REST Connector] Error calling API for grant entitlement "${appEntitlementId}" for user "${userIdInApp}":`, apiCallError.message);
                 operationResults.push({ entitlement: iglmEntitlementName, status: 'failed', error: apiCallError.message, response: apiCallError.response?.data });
                 allApplicationsSucceeded = false; // If any grant fails, overall app status is failed
             }
         }
    }


    // TODO: Process entitlements to revoke (Similar logic using 'revokeEntitlement' endpoint)


    // --- 4. Return Results ---
    // Summarize overall success/failure based on operationResults
    const overallSuccess = !operationResults.some(op => op.status === 'failed');

    return { success: overallSuccess, operations: operationResults };
}


// Helper function to build API request details from endpoint config and dynamic data
// TODO: Implement this helper function
function buildApiRequestDetails(endpointConfig, data) {
    // endpointConfig might be { method: 'POST', path: '/users/:userId/entitlements', body: { entitlementId: ':appEntitlementId' } }
    // data might be { userId: 'user123', appEntitlementId: 'groupABC', otherAttr: '...' }

    let url = endpointConfig.path;
    let body = endpointConfig.body ? JSON.parse(JSON.stringify(endpointConfig.body)) : undefined; // Deep copy body template
    let params = endpointConfig.params ? JSON.parse(JSON.stringify(endpointConfig.params)) : undefined; // Deep copy params template

    // Simple placeholder substitution for path and body/params
    if (url) {
        for (const key in data) {
            const placeholder = `:${key}`;
            if (url.includes(placeholder)) {
                url = url.replace(placeholder, data[key]);
            }
        }
    }

    if (body) {
        for (const key in data) {
            const placeholder = `:${key}`;
            // Recursive substitution in body object (simple string replace for now)
            let bodyString = JSON.stringify(body);
            if (bodyString.includes(placeholder)) {
                 bodyString = bodyString.replace(new RegExp(placeholder, 'g'), data[key]);
                 body = JSON.parse(bodyString); // Parse back to object
            }
        }
    }

     // TODO: Implement substitution for params if needed

     return { url, method: endpointConfig.method, body, params };
}


module.exports = {
    applyDesiredState,
    // addtional methods like createUser, deleteUser, discoverUsers, discoverEntitlements if needed
};