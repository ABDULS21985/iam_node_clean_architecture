// services/discovery-service/src/connectors/discovery/generic-rest-api.js
const axios = require('axios'); // You will need to install: npm install axios in services/discovery-service
const { URLSearchParams } = require('url'); // Built-in Node.js module for x-www-form-urlencoded


// In a real project, consider moving shared utilities like this
// to a dedicated shared utility file and importing it.
/**
 * Helper function to get a value from a nested object path (e.g., 'metadata.sAMAccountName').
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
 * Generic REST API Discovery Connector Adapter.
 * Discovers user access from an application via REST API calls.
 *
 * This adapter relies on configurable endpoints, authentication methods,
 * and data mapping rules to interact with a generic REST API.
 */

/**
 * Performs discovery against a REST API endpoint.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "api": { // Required: API configuration
 * "baseUrl": "https://your-rest-api.com/v1", // Required
 * "authentication": { // Optional: Authentication configuration
 * "type": "apiKey" | "oauth2" | "basic",
 * "header": "X-API-Key", // Required for type 'apiKey' or 'basic' if not standard Authorization
 * "value": "your-api-key", // Required for type 'apiKey'
 * "username": "apiuser", // Required for type 'basic'
 * "password": "apipassword", // Required for type 'basic'
 * "tokenUrl": "https://auth.com/oauth2/token", // Required for type 'oauth2'
 * "clientId": "your-client-id", // Required for type 'oauth2'
 * "clientSecret": "your-client-secret" // Required for type 'oauth2'
 * // TODO: Add support for other OAuth2 flows (password, authorization code)
 * // TODO: Add support for refreshing tokens
 * },
 * "endpoints": { // Required: API endpoints configuration
 * "discoverAccess": { // Required: Endpoint for discovering access data
 * "path": "/usersWithEntitlements", // Required: Endpoint path relative to baseUrl
 * "method": "GET" | "POST", // Optional, default GET
 * "params": { "isActive": true }, // Optional: Default query parameters
 * "body": { "query": {} }, // Optional: Request body for POST/PUT methods
 * // Add other axios request config options (timeout, headers etc.)
 * "headers": { "Accept": "application/json" }
 * }
 * // Add other endpoint definitions if needed (e.g., getUserDetails, getEntitlementDetails)
 * },
 * "pagination": { // Optional: Configuration for handling pagination in API responses
 * "type": "offset" | "cursor" | "link_header", // e.g., 'offset' for offset/limit params
 * "paramNames": { "offset": "offset", "limit": "limit" }, // Param names for offset/limit type
 * "pageSize": 100, // Default page size for offset/limit
 * "responsePath": { // Paths in the response to find pagination info
 * "nextPage": "next_page_url", // For link_header or cursor types
 * "totalRecords": "total", // Optional: For tracking progress
 * "records": "items" // Path to the actual array of records (duplicate of resultMapping.recordsPath, but can be here)
 * }
 * // TODO: Add logic for handling different pagination response formats
 * },
 * "discovery": { // Optional: Adapter-specific discovery configuration
 * "incrementalQuery": true, // Set to true if the API supports incremental sync
 * "timestampFieldForIncremental": "last_updated_after", // Query param name for incremental filter
 * "timestampFormatForIncremental": "iso8601" // Format for the timestamp param, e.g., "iso8601", "unix_timestamp"
 * }
 * // Add other adapter specific options
 * }
 * @param {object} mappingRules - The Discovery MappingConfig for this application (SourceType: Discovery, TargetType: DiscoveredStateMapping).
 * Expected mappingRules.mappingRules.discoveredStateMapping structure:
 * {
 * "uniqueIdentifierSourceField": "userId", // Path in raw record for the user's ID in the target app (required)
 * "entitlementIdentifierSourceField": "entitlementId", // Path in raw record for the entitlement ID in the target app (required)
 * "recordsPath": "data.items", // Path in the overall API response to the array of raw records (required)
 * "attributeMapping": { // Map paths in raw record to CurrentAppState metadata (optional)
 * "status": "status", // Map raw 'status' path to metadata.status
 * "lastLogin": "last_login", // Map raw 'last_login' path to metadata.lastLogin
 * // Add other attribute mappings
 * }
 * // userMapping and entitlementMapping are handled by StateStorage.js, but referenced here for context.
 * // userMapping: { "sourceField": "userId", "targetField": "email" },
 * // entitlementMapping: { "sourceField": "entitlementId", "targetField": "applicationEntitlementId" },
 * }
 * @param {string} lastRunTimestamp - ISO 8601 timestamp string of the previous successful discovery run (if available). Used for incremental sync.
 * @returns {Promise<Array<object>>} A promise resolving with an array of standardized raw discovered records, ready for StateStorage.js.
 * Returns Array<{ appSpecificUserId: string, appSpecificEntitlementId: string, metadata: object }>.
 * @throws {Error} If a critical configuration or API call failure occurs.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service'; // Or pass service name from options
    console.log(`[Generic REST Connector] Starting data discovery for application ${configDetails?.name}.`);
    // console.log(`[Generic REST Connector] Config details (excluding secrets):`, { ...configDetails?.api, authentication: { type: configDetails?.api?.authentication?.type, ... (configDetails?.api?.authentication?.header && { header: configDetails.api.authentication.header }), ... (configDetails?.api?.authentication?.tokenUrl && { tokenUrl: configDetails.api.authentication.tokenUrl }) } }); // Log carefully
    console.log(`[Generic REST Connector] Last Run Timestamp:`, lastRunTimestamp);


    const allDiscoveredRecords = []; // Array to hold all standardized discovered records across pages

    try {
        // --- 1. Read Config and Validate ---
        const apiConfig = configDetails?.api;
        const paginationConfig = configDetails?.pagination; // Optional pagination config
        const discoverySpecificConfig = configDetails?.discovery; // Optional discovery specific config
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping; // How to map raw data

        // Validate essential configuration
        if (!apiConfig?.baseUrl || !apiConfig?.endpoints) {
             throw new Error("Invalid REST connector configuration: Missing 'api.baseUrl' or 'api.endpoints'.");
        }
        const discoverEndpointConfig = apiConfig.endpoints.discoverAccess;
        if (!discoverEndpointConfig?.path) {
             throw new Error("Invalid REST connector configuration: Missing 'api.endpoints.discoverAccess.path'.");
        }
        // Validate essential mapping rules for parsing API response
        if (!discoveryMappingRules?.uniqueIdentifierSourceField || !discoveryMappingRules?.entitlementIdentifierSourceField || !discoveryMappingRules?.recordsPath) {
            const missingField = !discoveryMappingRules?.uniqueIdentifierSourceField ? 'uniqueIdentifierSourceField' :
                                 !discoveryMappingRules?.entitlementIdentifierSourceField ? 'entitlementIdentifierSourceField' : 'recordsPath';
            throw new Error(`Invalid Discovery Mapping configuration: Missing essential field "${missingField}" in discoveredStateMapping rules.`);
        }
         // attributeMappingRules can be empty, so no strict check needed there, but ensure it's an object
         const attributeMappingRules = discoveryMappingRules.attributeMapping || {};


        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Path in raw record for app user ID
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Path in raw record for app entitlement ID
        const recordsPath = discoveryMappingRules.recordsPath; // Path in the overall API response to the array


        // --- 2. Handle Authentication (if any) ---
        let authToken = null;
        const headers = discoverEndpointConfig.headers || {}; // Start with headers from endpoint config
        const authConfig = apiConfig.authentication;

        if (authConfig?.type === 'apiKey' && authConfig.header && authConfig.value) {
             headers[authConfig.header] = authConfig.value;
             console.log('[Generic REST Connector] Using API Key authentication.');
        } else if (authConfig?.type === 'basic' && authConfig.username && authConfig.password) {
            // Axios supports basic auth directly, but setting header manually works too
            headers['Authorization'] = 'Basic ' + Buffer.from(authConfig.username + ':' + authConfig.password).toString('base64');
            console.log('[Generic REST Connector] Using Basic Authentication.');
        } else if (authConfig?.type === 'oauth2' && authConfig.tokenUrl && authConfig.clientId && authConfig.clientSecret) {
             console.log('[Generic REST Connector] Using OAuth2 Client Credentials flow.');
             try {
                 // Perform OAuth2 token request
                  const tokenRequestBody = new URLSearchParams({
                      grant_type: 'client_credentials',
                      client_id: authConfig.clientId,
                      client_secret: authConfig.clientSecret,
                      // Add scope or other params if needed by API from authConfig.params
                      ...(authConfig.params || {})
                  }).toString();

                 const tokenResponse = await axios.post(authConfig.tokenUrl, tokenRequestBody, {
                     headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                     // Add any other token request headers from authConfig.tokenHeaders
                     // ...(authConfig.tokenHeaders || {})
                 });
                 // Assuming token is in response.data.access_token and type is Bearer
                 authToken = tokenResponse.data.access_token;
                 const tokenType = tokenResponse.data.token_type || 'Bearer'; // Default to Bearer
                 headers['Authorization'] = `${tokenType} ${authToken}`;
                 console.log('[Generic REST Connector] Successfully obtained OAuth2 token.');

             } catch (authError) {
                 console.error('[Generic REST Connector] OAuth2 token request failed:', authError.message);
                 // Log response data if available for debugging
                 if (authError.response?.data) {
                      console.error('[Generic REST Connector] OAuth2 token request failed response data:', authError.response.data);
                 }
                 throw new Error(`OAuth2 authentication failed: ${authError.message}`); // Critical auth failure
             }
        } else {
             console.warn('[Generic REST Connector] No authentication configuration provided or recognized. Proceeding without auth headers.');
             // Proceed without auth headers
        }


        // --- 3. Execute Discovery API Call(s) and Collect Raw Data ---
        // Handle pagination if configured. Loop through pages until no more records are returned or a 'next page' indicator is missing.

        let currentPageUrl = `${apiConfig.baseUrl}${discoverEndpointConfig.path}`; // Start with the base endpoint
        let currentPageParams = discoverEndpointConfig.params || {}; // Start with default params
        let page = 1;

        // Add timestamp parameter for incremental if configured and valid
        const isIncrementalRun = discoverySpecificConfig?.incrementalQuery === true && discoverySpecificConfig?.timestampFieldForIncremental && lastRunTimestamp;
        let incrementalTimestampValue = null;
        if (isIncrementalRun) {
             try {
                 const lastRunDate = new Date(lastRunTimestamp);
                 if (isNaN(lastRunDate.getTime())) {
                     console.warn(`[Generic REST Connector] Invalid lastRunTimestamp format received: "${lastRunTimestamp}". Ignoring incremental sync.`);
                      isIncrementalRun = false; // Disable incremental sync
                 } else {
                     // Format timestamp based on configuration (default ISO 8601)
                     const timestampFormat = discoverySpecificConfig.timestampFormatForIncremental || 'iso8601';
                     switch (timestampFormat) {
                         case 'iso8601':
                         default:
                             incrementalTimestampValue = lastRunDate.toISOString();
                             break;
                         case 'unix_timestamp':
                             incrementalTimestampValue = Math.floor(lastRunDate.getTime() / 1000); // Seconds
                             break;
                         // TODO: Add other formatters if needed
                     }
                     // Add the timestamp parameter to the initial request params
                     currentPageParams[discoverySpecificConfig.timestampFieldForIncremental] = incrementalTimestampValue;
                     console.log(`[Generic REST Connector] Using incremental sync parameter: ${discoverySpecificConfig.timestampFieldForIncremental}=${incrementalTimestampValue} (Format: ${timestampFormat}).`);
                 }
             } catch (e) {
                 console.error('[Generic REST Connector] Error processing lastRunTimestamp for incremental query, ignoring incremental sync:', e);
                 isIncrementalRun = false; // Disable incremental sync
             }
        }


        do {
            console.log(`[Generic REST Connector] Fetching page ${page} from ${currentPageUrl}...`);
             // Add pagination parameters if configured (e.g., for offset/limit type)
             if (paginationConfig?.type === 'offset' && paginationConfig?.paramNames?.offset && paginationConfig?.paramNames?.limit) {
                 const offsetParam = paginationConfig.paramNames.offset;
                 const limitParam = paginationConfig.paramNames.limit;
                 const pageSize = paginationConfig.pageSize || 100;

                 currentPageParams[offsetParam] = (page - 1) * pageSize;
                 currentPageParams[limitParam] = pageSize;
                  console.log(`[Generic REST Connector] Using pagination params: ${offsetParam}=${currentPageParams[offsetParam]}, ${limitParam}=${currentPageParams[limitParam]}`);
             }
             // TODO: Implement other pagination types (cursor, link header parsing)


            let response;
            try {
                // Execute the API call for the current page
                response = await axios.get(currentPageUrl, {
                     headers: headers, // Include auth and other headers
                     params: currentPageParams, // Include query parameters (default + incremental + pagination)
                     method: discoverEndpointConfig.method || 'GET', // Use configured method
                     // Add body for POST/PUT if needed
                     ...(discoverEndpointConfig.method !== 'GET' && discoverEndpointConfig.body && { data: discoverEndpointConfig.body }),
                     // Add other axios options from endpoint config (e.g., timeout)
                     ...(discoverEndpointConfig || {}) // Spread endpoint config, axios will pick up supported properties
                });

                // Check for successful HTTP status code (axios throws for non-2xx by default)
                if (response.status < 200 || response.status >= 300) {
                    console.error(`[Generic REST Connector] API returned non-2xx status: ${response.status}`, response.data);
                     // This should ideally be caught by axios's error handling, but adding defensive check
                     throw new Error(`API returned status ${response.status}`);
                }

                // Process raw data from the current page's response
                 const rawApiData = response.data;

                // Extract the array of raw records using the configured path
                 const rawRecordsArray = getNestedValue(rawApiData, recordsPath);

                 if (!Array.isArray(rawRecordsArray)) {
                     console.warn(`[Generic REST Connector] Raw data path "${recordsPath}" did not yield a valid array from API response for page ${page}. Stopping pagination.`);
                     break; // Stop if the data is not in the expected array format
                 }

                console.log(`[Generic REST Connector] Fetched ${rawRecordsArray.length} records from page ${page}.`);


                // --- 4. Map Raw API Output to Standardized Records ---
                // Iterate through the raw records from the current page
                for (const rawRecord of rawRecordsArray) {
                     // Map fields from the raw record object using the recordMapping rules
                     let appSpecificUserId = getNestedValue(rawRecord, rawUserIdentifierField);
                     let appSpecificEntitlementId = getNestedValue(rawRecord, rawEntitlementIdentifierField);

                      // Ensure extracted identifiers are not null/undefined and are strings
                     const cleanedAppSpecificUserId = (appSpecificUserId !== undefined && appSpecificUserId !== null) ? String(appSpecificUserId) : undefined;
                     const cleanedAppSpecificEntitlementId = (appSpecificEntitlementId !== undefined && appSpecificEntitlementId !== null) ? String(appSpecificEntitlementId) : undefined;

                     if (!cleanedAppSpecificUserId || !cleanedAppSpecificEntitlementId) {
                         console.warn(`[Generic REST Connector] Skipping raw record from page ${page}: Missing required identifiers after mapping (User path "${rawUserIdentifierField}" or Entitlement path "${rawEntitlementIdentifierField}"). Raw data subset:`, { userIdRaw: appSpecificUserId, entitlementIdRaw: appSpecificEntitlementId, rawRecordKeys: Object.keys(rawRecord).slice(0, 5) }); // Log keys for context
                          // TODO: Log the full raw record causing the skip if needed for debugging (be mindful of sensitive data)
                          continue; // Skip this record
                     }

                     // Map other raw attributes to CurrentAppState metadata using attributeMappingRules
                     const metadata = {};
                      // Create a copy of the raw object data to pass to getNestedValue for attribute mapping
                      const rawAttributeData = { ...rawRecord }; // Shallow clone is usually sufficient

                     for(const metaKey in attributeMappingRules) {
                          if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                              const rawField = attributeMappingRules[metaKey]; // e.g. "status"
                              metadata[metaKey] = getNestedValue(rawAttributeData, rawField); // Get value from raw record
                          }
                     }
                      // Ensure metadata is a non-null object
                      if (typeof metadata !== 'object' || metadata === null) metadata = {};


                     // Add to the array of standardized records collected across all pages
                     allDiscoveredRecords.push({
                          appSpecificUserId: cleanedAppSpecificUserId, // User ID for the target app (string)
                          appSpecificEntitlementId: cleanedAppSpecificEntitlementId, // Entitlement ID for the target app (string)
                          // Optional: Add other relevant fields if available and mapped directly
                          // from the raw record without specific mapping rules if they are standard (less common).
                          // discoveredAt: new Date(), // This timestamp is typically added by StateStorage, not the connector
                          metadata: metadata // Other mapped attributes (JSONB)
                     });
                 } // End loop through raw records on current page

                 // Increment page counter for the next request
                 page++;

                 // Determine if there are more pages to fetch based on pagination config and response
                 let hasMorePages = false;
                 if (paginationConfig?.type === 'offset') {
                      // For offset/limit, check if the number of records returned equals the page size
                      // Or if the response indicates total records and we haven't fetched them all
                      const pageSize = paginationConfig.pageSize || 100;
                      if (rawRecordsArray.length === pageSize) {
                          // Assume there might be more pages if a full page was returned
                          hasMorePages = true;
                          // If totalRecords path is available, make a more accurate check
                          if (paginationConfig.responsePath?.totalRecords) {
                               const totalRecords = getNestedValue(rawApiData, paginationConfig.responsePath.totalRecords);
                               if (totalRecords !== undefined && totalRecords !== null) {
                                   hasMorePages = (page - 1) * pageSize + rawRecordsArray.length < totalRecords;
                                    console.log(`[Generic REST Connector] Pagination check: Total Records: ${totalRecords}, Fetched so far: ${allDiscoveredRecords.length}, More pages? ${hasMorePages}`);
                               }
                          }
                      } else {
                           // Less than a full page, assume this is the last page
                           hasMorePages = false;
                           console.log(`[Generic REST Connector] Pagination check: Last page (${rawRecordsArray.length} records, page size ${pageSize}).`);
                      }

                 } else if (paginationConfig?.type === 'cursor' && paginationConfig?.responsePath?.nextPage) {
                      // For cursor-based, check for a next page indicator/cursor in the response
                      const nextPageValue = getNestedValue(rawApiData, paginationConfig.responsePath.nextPage);
                      if (nextPageValue) {
                          hasMorePages = true;
                           // Update the URL or parameters for the next request based on the cursor value
                           // This logic is highly API-specific. Example: update a 'cursor' param
                           if (paginationConfig.paramNames?.cursor) {
                               currentPageParams[paginationConfig.paramNames.cursor] = nextPageValue;
                                console.log(`[Generic REST Connector] Using next cursor: ${nextPageValue}`);
                           } else {
                                // If no specific cursor param name, assume the next page value IS the next URL
                                currentPageUrl = nextPageValue;
                                currentPageParams = {}; // Clear old params if using full new URL
                                console.log(`[Generic REST Connector] Using next page URL: ${currentPageUrl}`);
                           }
                      } else {
                          hasMorePages = false;
                          console.log(`[Generic REST Connector] Pagination check: No next page indicator found.`);
                      }
                 }
                 // TODO: Implement pagination for 'link_header' or other types


             } catch (pageApiCallError) {
                 console.error(`[Generic REST Connector] Error fetching page ${page} from ${currentPageUrl}:`, pageApiCallError.message);
                 // Decide whether to stop fetching pages or try to continue.
                 // For now, we'll stop and throw, as a failed page might mean missing data.
                 throw new Error(`Failed to fetch page ${page}: ${pageApiCallError.message}`);
             }

        } while (hasMorePages); // Continue looping as long as there are more pages


        console.log(`[Generic REST Connector] Finished fetching all pages. Total raw records collected: ${allDiscoveredRecords.length}.`);


    } catch (error) {
        console.error('[Generic REST Connector] Overall error during discovery:', error);
        // Re-throw the error so the calling logic (DiscoveryLogic) can handle it
        throw error;
    } finally {
        // --- 5. Cleanup ---
        // Axios typically manages HTTP connections internally. No explicit connection
        // closing is usually required per discovery run.
        // If you were using a connection pool or custom agent, cleanup might be needed here.
        console.log('[Generic REST Connector] Finally block reached. No explicit client cleanup needed for `axios`.');
    }

    // --- 6. Return Data ---
    // The adapter returns the array of standardized records. StateStorage will handle storing them.
    return allDiscoveredRecords;
}

// Helper function to get a value from a nested object path (copied locally for self-containment)
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
    discoverAccess,
    // addtional methods if needed (e.g., discoverUsers, discoverEntitlements if discovery is separate)
};