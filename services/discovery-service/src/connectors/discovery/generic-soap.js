// services/discovery-service/src/connectors/discovery/generic-soap.js
const soap = require('soap'); // npm install soap in services/discovery-service
const { promisify } = require('util'); // Built-in

/**
 * Helper function to get a value from a nested object path.
 */
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}


/**
 * Generic SOAP Service Discovery Connector Adapter.
 * Discovers user access from an application via SOAP API calls.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service';
    console.log(`[Generic SOAP Connector] Starting data discovery.`);
    // console.log(`[Generic SOAP Connector] Config details (excluding auth):`, { ...configDetails?.soap, auth: { ...configDetails?.soap?.auth, password: '***' } }); // Log carefully
    console.log(`[Generic SOAP Connector] Last Run Timestamp:`, lastRunTimestamp);

    let soapClient = null; // soap client instance
    const discoveredRecords = []; // Array to hold standardized discovered access records

    try {
        // 1. Read Config and Validate
        const soapConfig = configDetails?.soap;
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping; // How to map discovered data

        if (!soapConfig || !soapConfig.wsdlUrl || !soapConfig.endpointUrl) throw new Error("Invalid SOAP connector configuration: Missing wsdlUrl or endpointUrl.");
        if (!soapConfig.discoveryOperations || typeof soapConfig.discoveryOperations !== 'object') throw new Error("Invalid SOAP connector configuration: Missing or invalid 'discoveryOperations' config.");
         if (!discoveryMappingRules || !discoveryMappingRules.uniqueIdentifierSourceField || !discoveryMappingRules.entitlementIdentifierSourceField || !discoveryMappingRules.commandOutputMapping) { // Use commandOutputMapping key for SOAP too
             console.error("[Generic SOAP Connector] Missing or incomplete Discovery Mapping Rules. Cannot standardize output.");
             throw new Error("Missing or incomplete Discovery Mapping Rules."); // Critical for interpreting results
         }

        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Field name *after parsing* XML
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Field name *after parsing* XML
        const attributeMappingRules = discoveryMappingRules.attributeMapping || {}; // Rules for mapping raw attributes to metadata
        const commandOutputMapping = discoveryMappingRules.commandOutputMapping; // Rules for parsing SOAP response XML


        // 2. Initialize SOAP Client
        console.log(`[Generic SOAP Connector] Initializing SOAP client for WSDL: ${soapConfig.wsdlUrl}...`);
        try {
             const createClientAsync = promisify(soap.createClient);
             soapClient = await createClientAsync(soapConfig.wsdlUrl);

             // Set endpoint if specified
             soapClient.setEndpoint(soapConfig.endpointUrl);

             // Set authentication if specified (Basic, WS-Security etc.)
             const authConfig = soapConfig.auth;
             if (authConfig?.type === 'basic' && authConfig.username && authConfig.password) {
                 soapClient.setSecurity(new soap.BasicAuthSecurity(authConfig.username, authConfig.password));
                  console.log('[Generic SOAP Connector] Configured Basic Authentication.');
             }
             // TODO: Add logic for other security types (WS-Security)


             console.log('[Generic SOAP Connector] SOAP client initialized.');
             // You might inspect client.describe() here for debugging available services/ports/operations

         } catch (clientError) {
             console.error('[Generic SOAP Connector] Failed to initialize SOAP client:', clientError.message);
             throw new Error(`Generic SOAP connector failed to initialize client: ${clientError.message}`); // Critical failure
         }


        // 3. Execute Discovery SOAP Calls
        // This depends heavily on the SOAP API structure.
        // It might involve multiple calls: list users, then for each user, get permissions.
        // Or a single call that returns user + access data.
        // The configDetails.soap.discoveryOperations defines which operations to call.

        let rawDiscoveredData = []; // Array to hold raw data extracted from responses

        // Assuming the config defines operations like listUsers or listAllUserAccess
        const discoveryOperationConfig = soapConfig.discoveryOperations.listUserAccess; // Example config key

        if (!discoveryOperationConfig || !discoveryOperationConfig.soapOperationName || !discoveryOperationConfig.messageTemplate || !discoveryOperationConfig.resultMapping) {
             throw new Error("Invalid SOAP connector configuration: Missing or incomplete 'listUserAccess' discovery operation config.");
        }

        // Prepare the request data using the template
        const requestDataTemplate = discoveryOperationConfig.messageTemplate;
        const requestData = JSON.parse(JSON.stringify(requestDataTemplate)); // Deep clone template
        // Substitute placeholders in requestData (e.g., for incremental timestamp)
        // Need a helper for recursive object placeholder substitution if needed
        // requestData = traverseAndSubstitute(requestData, { lastRunTimestamp: lastRunTimestamp });


        console.log(`[Generic SOAP Connector] Calling SOAP Operation "${discoveryOperationConfig.soapOperationName}"...`);
        // console.log(`[Generic SOAP Connector] Request data:`, requestData); // Log request data carefully


        try {
            // Call the SOAP operation (using Promisified client method)
            // The result is the response body as a JS object. rawResponse is XML. soapHeader is header.
             const soapOperationAsync = promisify(soapClient[discoveryOperationConfig.soapOperationName].bind(soapClient)); // Get and promisify the method
             const [result, rawResponse, soapHeader] = await soapOperationAsync(requestData);
             const responseData = result; // Store the parsed response body

             console.log(`[Generic SOAP Connector] SOAP call successful. Response:`, responseData);
             // console.log(`[Generic SOAP Connector] Raw Response:\n`, rawResponse);

            // Process the SOAP response based on resultMapping config
            // This requires knowing the response structure and how to extract the list of records and their fields.
            const resultMapping = discoveryOperationConfig.resultMapping;
             if (!resultMapping || !resultMapping.recordsPath || !resultMapping.recordMapping) {
                  console.error(`[Generic SOAP Connector] Missing or incomplete 'resultMapping' config for operation "${discoveryOperationConfig.soapOperationName}". Cannot process results.`);
                  throw new Error(`Missing or incomplete 'resultMapping' config.`);
             }


             // Extract the array of raw records from the response body using recordsPath
             const rawRecordsArray = getNestedValue(responseData, resultMapping.recordsPath);

             if (!Array.isArray(rawRecordsArray)) {
                 console.error(`[Generic SOAP Connector] Response path "${resultMapping.recordsPath}" did not yield an array (${typeof rawRecordsArray}). Cannot process results.`);
                  throw new Error(`SOAP response path did not yield an array.`);
             }

            // Map each raw record from the array to a standardized format using recordMapping
             const recordMappingRules = resultMapping.recordMapping;
             if (!recordMappingRules) {
                 console.error(`[Generic SOAP Connector] Missing 'recordMapping' config for operation "${discoveryOperationConfig.soapOperationName}". Cannot process results.`);
                 throw new Error(`Missing 'recordMapping' config.`);
             }

             for (const rawRecord of rawRecordsArray) {
                 const appSpecificUserId = getNestedValue(rawRecord, rawUserIdentifierField);
                 const appSpecificEntitlementId = getNestedValue(rawRecord, rawEntitlementIdentifierField);

                 if (appSpecificUserId === undefined || appSpecificUserId === null || appSpecificEntitlementId === undefined || appSpecificEntitlementId === null) {
                      console.warn(`[Generic SOAP Connector] Skipping raw record from response: Missing required identifiers.`, rawRecord);
                      // TODO: Log raw record causing the skip
                      continue;
                 }

                 // Map other raw attributes to CurrentAppState metadata using attributeMappingRules
                 const metadata = {};
                 for(const metaKey in attributeMappingRules) {
                      if (Object.prototype.hasOwnProperty.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                           const rawField = attributeMappingRules[metaKey];
                           metadata[metaKey] = getNestedValue(rawRecord, rawField); // Get value from raw record
                      }
                 }


                 discoveredRecords.push({
                      appSpecificUserId: String(appSpecificUserId), // Ensure string type
                      appSpecificEntitlementId: String(appSpecificEntitlementId), // Ensure string type
                      // Optional: Add other relevant fields if available and mapped
                      discoveredAt: new Date(), // Timestamp of this discovery run (or use a timestamp from raw data if available)
                      metadata: metadata
                 });
             }

             console.log(`[Generic SOAP Connector] Mapped ${discoveredRecords.length} records from SOAP response.`);


        } catch (soapError) {
            console.error(`[Generic SOAP Connector] Error during SOAP call "${discoveryOperationConfig.soapOperationName}":`, soapError);
             // soapError might contain fault details
            throw new Error(`SOAP discovery call failed for operation "${discoveryOperationConfig.soapOperationName}": ${soapError.message}`); // Critical failure

        }


    } catch (error) {
        console.error('[Generic SOAP Connector] Overall error during discovery:', error);
        throw error; // Re-throw
    } finally {
        // 5. Cleanup
        if (soapClient) {
             try { soapClient.close(); console.log('[Generic SOAP Connector] SOAP client closed.'); }
             catch(e) { console.error('[Generic SOAP Connector] Error closing SOAP client:', e); }
         }
    }

    // 6. Return Data
    return discoveredRecords; // Array of standardized records, ready for StateStorage
}

// Helper function to get a value from a nested object path (copy or use shared)
function getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object' || !path || typeof path !== 'string') {
        return undefined;
    }
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}


module.exports = {
    discoverAccess,
    // addtional methods if needed
};