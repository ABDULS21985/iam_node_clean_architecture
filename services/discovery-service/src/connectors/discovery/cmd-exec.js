// services/discovery-service/src/connectors/discovery/cmd-exec.js
const { exec } = require('child_process'); // Built-in Node.js module for local execution

// For remote execution over SSH: npm install ssh2
const { Client: SSHClient } = require('ssh2'); // Renamed to avoid conflict

// Import the command output parser helper (Assumes this file exists and exports a parse function)
const commandOutputParser = require('./commandOutputParser'); // Adjust path if needed

// In a real project, consider moving shared utilities like these
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
 * Helper function to substitute placeholders in a string template.
 * Placeholders are identified by a colon prefix (e.g., ":userIdInApp").
 * Performs basic sanitization, but robust sanitization depends on the command and data.
 *
 * @param {string} template - The command template string with placeholders.
 * @param {object} data - An object containing key-value pairs for substitution.
 * @returns {string} The string with placeholders replaced by corresponding data values.
 */
function substitutePlaceholders(template, data) {
      if (!template || typeof template !== 'string') return template;
      let result = template;
      // Sort keys by length descending to replace longer placeholders first
      const keys = Object.keys(data).sort((a, b) => b.length - a.length);

      for (const key of keys) {
          const placeholder = `:${key}`; // Example placeholder format
          const value = data[key];

          // Basic sanitization for shell execution. This attempts to escape common shell metacharacters.
          // WARNING: This is NOT a substitute for robust input validation and sanitization
          // specific to the command being executed and the environment.
          // Example: preventing command injection by strictly allowing only expected characters
          // or using command arguments/options instead of embedding values directly in the command string.
          const safeValue = (value === null || value === undefined) ? '' :
                            String(value)
                                .replace(/"/g, '\\"') // Escape double quotes
                                .replace(/`/g, '\\`') // Escape backticks
                                .replace(/\$/g, '\\$') // Escape dollar signs
                                .replace(/!/g, '\\!') // Escape exclamation marks
                                .replace(/&/g, '\\&') // Escape ampersands
                                .replace(/\|/g, '\\|') // Escape pipes
                                .replace(/;/g, '\\;') // Escape semicolons
                                .replace(/</g, '\\<') // Escape less than
                                .replace(/>/g, '\\>') // Escape greater than
                                .replace(/\(/g, '\\(') // Escape open parenthesis
                                .replace(/\)/g, '\\)') // Escape close parenthesis
                                .replace(/\s/g, '\\ '); // Escape spaces - may cause issues if spaces are intended in arguments


           // Use a regular expression for global replacement with word boundaries (\b)
           // Word boundaries help prevent replacing parts of other words/placeholders (e.g., replacing :userId in :userIdInApp)
           // However, be cautious if placeholders are intended to be parts of filenames or paths without boundaries.
          result = result.replace(new RegExp(`\\b${placeholder}\\b`, 'g'), safeValue);
      }
      return result;
}


/**
 * Executes a command locally or remotely via SSH and returns its stdout/stderr/exit code.
 * This helper handles the execution details and returns a promise.
 *
 * @param {string} command - The command string to execute.
 * @param {object} executionConfig - Configuration for execution ({ type: 'local' | 'ssh', sshDetails: {...}, cwd: '...' }).
 * @param {object} [sshClient] - An optional, already connected SSH client instance if executionConfig.type is 'ssh'.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>} Promise resolving with command results.
 * @throws {Error} If execution fails critically (e.g., cannot start command, SSH stream error). Does NOT throw for non-zero exit codes; those are in the resolved object.
 */
async function executeCommand(command, executionConfig, sshClient = null) {
    const serviceName = 'discovery-service'; // Need to pass serviceName or context from caller

    console.log(`[CMD Exec Connector] Executing command: "${command}"`);

    if (executionConfig.type === 'ssh') {
        if (!sshClient) {
            throw new Error("SSH client is required for remote execution but was not provided to executeCommand.");
        }
        // Execute remotely over SSH
        return new Promise((resolve, reject) => {
            const options = {
                cwd: executionConfig.cwd // Pass cwd option if configured
                // Add other ssh2 exec options like pty, shell etc.
            };
            // Execute the command over the SSH connection
            sshClient.exec(command, options, (err, stream) => {
                if (err) {
                    // Error starting the command on the remote side
                    console.error(`[CMD Exec Connector] SSH exec stream error:`, err);
                    // Reject with a clear error indicating failure to start command
                    return reject(new Error(`SSH execution failed to start command "${command}": ${err.message}`));
                }

                let stdout = '';
                let stderr = '';
                let exitCode = null;
                let commandSignal = null; // For signals

                stream.on('data', (data) => { stdout += data; });
                stream.stderr.on('data', (data) => { stderr += data; }); // stderr comes on the stderr stream

                stream.on('close', (code, signal) => {
                    // Command finished, capture exit code and signal
                    exitCode = code;
                    commandSignal = signal;
                    console.log(`[CMD Exec Connector] Remote command stream closed. Exit Code: ${exitCode}, Signal: ${commandSignal}.`);
                    // Resolve the promise with the command results
                    resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString(), signal: commandSignal });
                });

                stream.on('error', (streamErr) => {
                    // Errors during the stream lifecycle (e.g., connection dropped during execution)
                    console.error('[CMD Exec Connector] SSH stream error:', streamErr);
                    // Reject the promise with a stream error
                    reject(new Error(`SSH stream error during command execution "${command}": ${streamErr.message}`));
                });

                 // Handle potential exit event for completeness, though 'close' is more common for simple commands
                 // stream.on('exit', (code, signal) => { console.log(`[CMD Exec Connector] Remote command exited. Code: ${code}, Signal: ${signal}.`); });
            });
        });

    } else { // Default to local execution using child_process.exec
        return new Promise((resolve, reject) => {
            const options = {
                cwd: executionConfig.cwd // Pass cwd option if configured
                // Add other exec options like timeout, maxBuffer, shell etc.
                 // maxBuffer: 1024 * 1024 * 10 // Example: Increase buffer if output is large (10MB)
            };
            // Execute the command locally
            const child = exec(command, options, (error, stdout, stderr) => {
                 // The error object is populated for non-zero exit codes OR if the command could not be started.
                 // stdout and stderr are Buffers by default, convert to string.
                 const exitCode = error && error.code !== undefined ? error.code : 0; // Get exit code, default to 0 if no error or code is undefined

                 if (error && exitCode !== 0) {
                     // Command failed with a non-zero exit code
                     const errMessage = `Local command failed with exit code ${exitCode}. Error: ${error.message}\nSTDOUT: ${stdout.toString()}\nSTDERR: ${stderr.toString()}`;
                     console.error(`[CMD Exec Connector] ${errMessage}`);
                     // Resolve with the non-zero exit code and output, don't reject unless it's an execution setup error
                     resolve({ exitCode: exitCode, stdout: stdout.toString(), stderr: stderr.toString() });

                 } else if (error && exitCode === 0) {
                      // Command finished with Exit Code 0, but exec returned an error object.
                      // This can happen for various reasons (e.g., command not found but shell exits 0, or timeout if configured).
                     console.warn(`[CMD Exec Connector] Local command finished with Exit Code 0, but exec returned an error object: ${error.message}. STDOUT:\n${stdout.toString()}\nSTDERR:\n${stderr.toString()}`);
                     // Treat as successful execution but log the warning
                     resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() });

                 } else {
                     // Command successful (exit code 0)
                     console.log(`[CMD Exec Connector] Local command successful. Exit Code: ${exitCode}.`);
                     if (stdout) console.log(`[CMD Exec Connector] STDOUT:\n${stdout.toString()}`);
                     if (stderr) console.error(`[CMD Exec Connector] STDERR:\n${stderr.stderr.toString()}`); // Note: error.stderr is a Buffer
                     resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() });
                 }
            });

             // Handle errors that occur *before* the command finishes (e.g., command not found, permissions)
             child.on('error', (execError) => {
                  console.error(`[CMD Exec Connector] Local command execution error:`, execError);
                  // Reject if the command couldn't even start properly
                  reject(new Error(`Local command execution failed to start "${command}": ${execError.message}`));
             });
        });
    }
}


/**
 * Command-line Execution Discovery Connector Adapter.
 * Discovers user access by executing shell commands.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure:
 * {
 * "execution": { // Required: How commands are executed
 * "type": "local" | "ssh", // Required
 * "sshDetails": { "host": "...", "username": "...", "password": "..." | "privateKey": "..." }, // Required if type is 'ssh'
 * "cwd": "/app/scripts" // Optional: Working directory for commands
 * // Add other ssh2 connection options or exec options here
 * },
 * "discoveryCommands": { // Required: Define command templates for discovery operations
 * "dumpAllAccess": { // Example command definition
 * "template": "/opt/myapp/reports/dump-access.sh --format csv :lastRunTimestampPlaceholder", // Command template string. Can include placeholders.
 * // Add other options for this specific command if needed
 * },
 * // Add other command definitions if needed (e.g., listUsers, listAccessForUser)
 * },
 * // Optional: Define mapping from command output to standardized fields and parsing rules
 * "commandOutputMapping": { // Required for interpreting command output
 * "parser": "csv" | "jsonl" | "regex", // How to parse stdout (e.g., 'csv', 'jsonl' for JSON Lines, 'regex')
 * "parserConfig": { // Configuration specific to the chosen parser
 * "columns": ["user_id", "entitlement_id", "status"], // Required for parser="csv": Array of column names in order
 * "delimiter": ",", // Optional for parser="csv"
 * "regex": "...", // Required for parser="regex": Regex pattern to capture data
 * "jsonPath": "$.data.items[*]", // Optional for parser="jsonl" or "json" (if output is single JSON)
 * // Add other parser specific options
 * },
 * // Note: uniqueIdentifierSourceField, entitlementIdentifierSourceField, and attributeMapping
 * // are defined in the Discovery Mapping Config's discoveredStateMapping, but are referenced here.
 * // For clarity, you might duplicate them here or ensure DiscoveryLogic passes the combined config.
 * },
 * "discovery": { // Optional: Adapter-specific discovery configuration
 * "incrementalQuery": true, // Set to true if the command template handles incremental filtering
 * "lastRunTimestampPlaceholder": "last_updated_after", // The name of the placeholder in the command template for the last run timestamp value
 * "timestampFormatForIncremental": "iso8601" // Format for the timestamp value in the placeholder, e.g., "iso8601", "unix_timestamp"
 * },
 * "successExitCodes": { // Optional: Define exit codes considered successful for different command types
 * "discovery": [0] // Default success exit code for discovery commands
 * },
 * }
 * @param {object} mappingRules - The Discovery MappingConfig for this application (SourceType: Discovery, TargetType: DiscoveredStateMapping).
 * Expected mappingRules.mappingRules.discoveredStateMapping structure:
 * {
 * // These define how to interpret the *parsed* raw data (output from commandOutputMappingConfig.parser)
 * "uniqueIdentifierSourceField": "user_id", // Field name *after parsing* command output for user ID (required)
 * "entitlementIdentifierSourceField": "entitlement_id", // Field name *after parsing* command output for entitlement ID (required)
 * "attributeMapping": { // Optional: Map other fields from parsed output to CurrentAppState metadata
 * "statusFlag": "status" // Example mapping: map 'status' field from parsed output to metadata 'statusFlag'
 * },
 * // userMapping and entitlementMapping are used by StateStorage, not the adapter
 * }
 * @param {Date|null} lastRunTimestamp - The end time of the last successful collection run. Used for incremental pulls.
 * @returns {Promise<Array<object>>} A promise resolving with an array of standardized discovered access records.
 * Returns objects like: { appSpecificUserId: '...', appSpecificEntitlementId: '...', metadata: { ... } }.
 * @throws {Error} If a critical configuration or execution setup error occurs.
 */
async function discoverAccess(configDetails, mappingRules, lastRunTimestamp) {
    const serviceName = 'discovery-service'; // Or pass service name from options
    console.log(`[CMD Exec Discovery Connector] Starting data discovery for application ${configDetails?.name}.`);
    // console.log(`[CMD Exec Discovery Connector] Config details (excluding secrets):`, { ...configDetails?.execution, sshDetails: { ...configDetails?.execution?.sshDetails, password: '***', privateKey: '***' } }); // Log carefully
    console.log(`[CMD Exec Discovery Connector] Last Run Timestamp:`, lastRunTimestamp);


    let sshClient = null; // SSH client instance if remote execution
    const discoveredRecords = []; // Array to hold standardized discovered access records

    try {
        // --- 1. Read Config and Validate ---
        const executionConfig = configDetails?.execution || { type: 'local' };
        const discoveryCommands = configDetails?.discoveryCommands;
        const commandOutputMappingConfig = configDetails?.commandOutputMapping; // Get output mapping from connector config
        const discoveryMappingRules = mappingRules?.mappingRules?.discoveredStateMapping; // Discovery mapping rules structure
        const discoverySpecificConfig = configDetails?.discovery; // Optional discovery specific config
        const discoverySuccessExitCodes = configDetails?.successExitCodes?.discovery || [0]; // Default success codes for discovery command

        // Validate essential configuration
        if (!executionConfig.type || (executionConfig.type !== 'local' && executionConfig.type !== 'ssh')) {
             throw new Error("Invalid CMD Exec connector configuration: 'execution.type' must be 'local' or 'ssh'.");
        }
        if (executionConfig.type === 'ssh') {
             const sshDetails = executionConfig.sshDetails;
             if (!sshDetails?.host || !sshDetails?.username || (!sshDetails?.password && !sshDetails?.privateKey)) {
                 throw new Error("Invalid CMD Exec connector configuration: Missing or incomplete remote SSH details for type 'ssh' (host, username, password/privateKey).");
             }
             // TODO: Add more granular validation for sshDetails
        }
        if (!discoveryCommands || typeof discoveryCommands !== 'object' || !discoveryCommands.dumpAllAccess || !discoveryCommands.dumpAllAccess.template) {
             throw new Error("Invalid CMD Exec connector configuration: Missing 'discoveryCommands.dumpAllAccess.template' for discovery.");
        }
        if (!commandOutputMappingConfig || !commandOutputMappingConfig.parser || !commandOutputMappingConfig.parserConfig) {
              throw new Error("Invalid CMD Exec connector configuration: Missing or invalid 'commandOutputMapping' (requires parser and parserConfig).");
        }
        // Validate essential mapping rules for interpreting parsed output
        if (!discoveryMappingRules?.uniqueIdentifierSourceField || !discoveryMappingRules?.entitlementIdentifierSourceField) {
             const missingField = !discoveryMappingRules?.uniqueIdentifierSourceField ? 'uniqueIdentifierSourceField' : 'entitlementIdentifierSourceField';
             throw new Error(`Invalid Discovery Mapping configuration: Missing essential field "${missingField}" in discoveredStateMapping rules (needed for mapping parsed output).`);
        }
         // attributeMappingRules can be empty, so no strict check needed there, but ensure it's an object
        const attributeMappingRules = discoveryMappingRules.attributeMapping || {};


        const rawUserIdentifierField = discoveryMappingRules.uniqueIdentifierSourceField; // Field name *after parsing* command output
        const rawEntitlementIdentifierField = discoveryMappingRules.entitlementIdentifierSourceField; // Field name *after parsing* command output


        // --- 2. Establish SSH Connection if remote execution ---
        if (executionConfig.type === 'ssh') {
             const sshDetails = executionConfig.sshDetails;
             console.log(`[CMD Exec Discovery Connector] Establishing SSH connection to ${sshDetails.host}:${sshDetails.port || 22}...`);
             try {
                 sshClient = new SSHClient();
                 await new Promise((resolve, reject) => {
                      // Set up listeners before calling connect
                      sshClient.on('ready', resolve);
                      sshClient.on('error', reject); // Catch connection errors

                      const connectTimeout = setTimeout(() => {
                          // Clean up the client if timeout occurs before 'ready' or 'error' fires consistently
                          if (sshClient && sshClient.connecting) {
                              try { sshClient.end(); } catch(e) { console.error('[CMD Exec Connector] Error ending SSH client during timeout:', e); }
                          }
                          reject(new Error(`SSH connection to ${sshDetails.host} timed out after ${executionConfig.sshDetails.connectTimeout || 10000}ms.`));
                      }, executionConfig.sshDetails.connectTimeout || 10000); // Use configured timeout or default

                      sshClient.connect(sshDetails);

                      // Clear the timeout once connection is ready
                      sshClient.on('ready', () => clearTimeout(connectTimeout));
                 });
                 console.log('[CMD Exec Discovery Connector] SSH client connected.');

                  // Add a listener for unexpected errors after the connection is ready
                  sshClient.on('error', (err) => {
                      console.error('[CMD Exec Connector] SSH connection error after ready:', err);
                      // Depending on the nature of the error (e.g., socket closed), this might indicate
                      // that subsequent command executions on this client will fail.
                      // More sophisticated handling (e.g., marking client as unhealthy, reconnecting)
                      // would be needed in a pooling scenario. For a single-use client per run,
                      // errors during exec will typically reject the promise directly.
                  });

             } catch (sshConnectError) {
                 console.error(`[CMD Exec Discovery Connector] Failed to establish SSH connection:`, sshConnectError);
                  // Re-throw the critical error
                 throw new Error(`CMD Exec Discovery connector failed to connect via SSH: ${sshConnectError.message}`);
             }
        }


        // --- 3. Construct and Execute Discovery Command ---
        // Example: run a command that dumps all user-entitlement pairs.
        const dumpCommandConfig = discoveryCommands.dumpAllAccess; // Get the config for the dump command

        // Prepare data for placeholder substitution, including the last run timestamp if needed for incremental sync
        const commandData = {};
        const isIncrementalRun = discoverySpecificConfig?.incrementalQuery === true && discoverySpecificConfig?.lastRunTimestampPlaceholder && lastRunTimestamp;

        if (isIncrementalRun) {
             try {
                 const lastRunDate = new Date(lastRunTimestamp);
                 // Check if the date is valid
                 if (isNaN(lastRunDate.getTime())) {
                     console.warn(`[CMD Exec Discovery Connector] Invalid lastRunTimestamp format received: "${lastRunTimestamp}". Ignoring incremental sync.`);
                     // Proceed without adding the timestamp parameter
                 } else {
                     // Format timestamp based on configuration (default ISO 8601)
                     const timestampFormat = discoverySpecificConfig.timestampFormatForIncremental || 'iso8601';
                     let incrementalTimestampValue;
                     switch (timestampFormat) {
                         case 'iso8601':
                         default:
                             incrementalTimestampValue = lastRunDate.toISOString();
                             break;
                         case 'unix_timestamp':
                             incrementalTimestampValue = Math.floor(lastRunDate.getTime() / 1000); // Seconds
                             break;
                         // TODO: Add other formatters if needed (e.g., YYYY-MM-DD HH:MM:SS)
                     }
                     // Add the formatted timestamp to the data for substitution
                     commandData[discoverySpecificConfig.lastRunTimestampPlaceholder] = incrementalTimestampValue;
                     console.log(`[CMD Exec Discovery Connector] Preparing incremental sync value: ${discoverySpecificConfig.lastRunTimestampPlaceholder}=${incrementalTimestampValue} (Format: ${timestampFormat}).`);
                 }
             } catch (e) {
                  console.error('[CMD Exec Connector] Error processing lastRunTimestamp for incremental sync, ignoring incremental sync:', e);
                  // Proceed without adding the timestamp parameter
             }
        } else if (lastRunTimestamp) {
             console.log('[CMD Exec Discovery Connector] lastRunTimestamp is available, but incremental sync configuration is missing or disabled. Performing full sync.');
        }


        // Substitute placeholders in the command template
        const command = substitutePlaceholders(dumpCommandConfig.template, commandData);


        let commandResult;
        try {
            // Execute the command using the helper function
            // Pass the SSH client instance if in remote mode
            commandResult = await executeCommand(command, executionConfig, sshClient);

            // Check the exit code against configured success codes
             const isCommandSuccessful = discoverySuccessExitCodes.includes(commandResult.exitCode);


            if (!isCommandSuccessful) {
                 // Log the command output regardless of whether it's deemed successful by exit code
                 if (commandResult.stdout) console.log(`[CMD Exec Connector] Command STDOUT:\n${commandResult.stdout}`);
                 if (commandResult.stderr) console.error(`[CMD Exec Connector] Command STDERR:\n${commandResult.stderr}`);
                 // Throw an error indicating command failure based on exit code
                 throw new Error(`Discovery command "${command}" failed with unexpected exit code ${commandResult.exitCode}.`);
            }
            console.log(`[CMD Exec Connector] Discovery command successful (Exit Code: ${commandResult.exitCode}).`);

        } catch (execError) {
            // Catch errors during command execution (e.g., command not found, permissions, SSH stream error)
            console.error(`[CMD Exec Connector] Error executing discovery command "${command}":`, execError);
            // Re-throw the critical execution error
            throw new Error(`Error executing discovery command "${command}": ${execError.message}`);
        }


        // 4. Parse Raw Command Output and Map to Standardized Records
        // Uses commandOutputMappingConfig to define parsing rules (e.g., parser, parserConfig).
        const rawOutput = commandResult.stdout; // Assume all data is in stdout

        if (!rawOutput) {
             console.warn('[CMD Exec Discovery Connector] Discovery command produced no output. Returning empty records.');
             return []; // Return empty array if no output
        }

        let parsedRawRecords = []; // Array of raw records as objects after parsing

        console.log(`[CMD Exec Discovery Connector] Parsing command output using parser "${commandOutputMappingConfig.parser}"...`);
        try {
            // Use the commandOutputParser helper module
            parsedRawRecords = commandOutputParser.parse(rawOutput, commandOutputMappingConfig);
            console.log(`[CMD Exec Discovery Connector] Parsed ${parsedRawRecords.length} raw records from output.`);
        } catch (parseError) {
             console.error('[CMD Exec Connector] Error parsing command output:', parseError);
             // Re-throw the critical parsing failure
             throw new Error(`Failed to parse command output: ${parseError.message}`);
        }


        // Now map these parsed raw records to the standardized format expected by StateStorage
        if (parsedRawRecords && Array.isArray(parsedRawRecords) && parsedRawRecords.length > 0) {
             const parsedRecordCount = parsedRawRecords.length;
             console.log(`[CMD Exec Discovery Connector] Mapping ${parsedRecordCount} parsed records to standardized format...`);

             for (const rawRecord of parsedRawRecords) {
                 // Map fields from the parsed record object using discoveryMappingRules
                 let appSpecificUserId = getNestedValue(rawRecord, rawUserIdentifierField);
                 let appSpecificEntitlementId = getNestedValue(rawRecord, rawEntitlementIdentifierField);

                 // Ensure extracted identifiers are not null/undefined and are strings
                 const cleanedAppSpecificUserId = (appSpecificUserId !== undefined && appSpecificUserId !== null) ? String(appSpecificUserId) : undefined;
                 const cleanedAppSpecificEntitlementId = (appSpecificEntitlementId !== undefined && appSpecificEntitlementId !== null) ? String(appSpecificEntitlementId) : undefined;

                 if (!cleanedAppSpecificUserId || !cleanedAppSpecificEntitlementId) {
                     console.warn(`[CMD Exec Discovery Connector] Skipping parsed record: Missing required identifiers after mapping (User field "${rawUserIdentifierField}" or Entitlement field "${rawEntitlementIdentifierField}"). Raw data subset:`, { userIdRaw: appSpecificUserId, entitlementIdRaw: appSpecificEntitlementId, rawRecordKeys: Object.keys(rawRecord).slice(0, 5) }); // Log keys for context
                      // TODO: Log the full raw record causing the skip if needed for debugging (be mindful of sensitive data)
                      continue; // Skip this record
                 }

                 // Map other raw attributes from the parsed record to CurrentAppState metadata using attributeMappingRules
                 const metadata = {};
                  // Create a copy of the raw object data to pass to getNestedValue for attribute mapping
                  const rawAttributeData = { ...rawRecord }; // Shallow clone is usually sufficient

                 for(const metaKey in attributeMappingRules) {
                      if (Object.prototype.hasOwnProperty.call(attributeMappingRules, metaKey)) {
                          const rawField = attributeMappingRules[metaKey]; // e.g. "status"
                          metadata[metaKey] = getNestedValue(rawAttributeData, rawField); // Get value from parsed record
                      }
                 }
                  // Ensure metadata is a non-null object
                  if (typeof metadata !== 'object' || metadata === null) metadata = {};


                 // Add to the array of standardized records
                 discoveredRecords.push({
                      appSpecificUserId: cleanedAppSpecificUserId, // User ID for the target app (string)
                      appSpecificEntitlementId: cleanedAppSpecificEntitlementId, // Entitlement ID for the target app (string)
                      // Optional: Add other relevant fields if available and mapped directly
                      // from the raw record without specific mapping rules if they are standard (less common).
                      // discoveredAt: new Date(), // This timestamp is typically added by StateStorage, not the connector
                      metadata: metadata // Other mapped attributes (JSONB)
                 });
             }
             console.log(`[CMD Exec Discovery Connector] Mapped ${discoveredRecords.length} records to standardized format.`);
        } else {
             console.log(`[CMD Exec Connector] No raw records parsed successfully or parsed data is not in expected array format.`);
        }


    } catch (error) {
        console.error('[CMD Exec Discovery Connector] Overall error during discovery:', error);
        // Re-throw the error so the calling logic (DiscoveryLogic) can handle it
        throw error;
    } finally {
        // --- 5. Close SSH Connection if remote and was opened ---
        // Ensure the SSH client connection is ended
        if (sshClient) {
             try {
                 sshClient.end(); // Close the SSH connection
                 console.log('[CMD Exec Discovery Connector] SSH connection ended in finally block.');
             } catch (closeError) {
                 console.error('[CMD Exec Connector] Error closing SSH connection in finally block:', closeError);
             }
         } else {
             console.log('[CMD Exec Discovery Connector] SSH client was not initialized or connected (likely local execution).');
         }
    }

    // --- 6. Return Data ---
    // The adapter returns the array of standardized records. StateStorage will handle storing them.
    return discoveredRecords;
}

// Helper function to get a value from a nested object path (copied locally)
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

// Helper function to substitute placeholders (copied locally)
function substitutePlaceholders(template, data) {
      if (!template || typeof template !== 'string') return template;
      let result = template;
      const keys = Object.keys(data).sort((a, b) => b.length - a.length); // Longest keys first

      for (const key of keys) {
          const placeholder = `:${key}`; // Example placeholder format
          const value = data[key];

          // Basic sanitization for shell execution.
          const safeValue = (value === null || value === undefined) ? '' :
                            String(value)
                                .replace(/"/g, '\\"') // Escape double quotes
                                .replace(/`/g, '\\`') // Escape backticks
                                .replace(/\$/g, '\\$') // Escape dollar signs
                                .replace(/!/g, '\\!') // Escape exclamation marks
                                .replace(/&/g, '\\&') // Escape ampersands
                                .replace(/\|/g, '\\|') // Escape pipes
                                .replace(/;/g, '\\;') // Escape semicolons
                                .replace(/</g, '\\<') // Escape less than
                                .replace(/>/g, '\\>') // Escape greater than
                                .replace(/\(/g, '\\(') // Escape open parenthesis
                                .replace(/\)/g, '\\)') // Escape close parenthesis
                                .replace(/\s/g, '\\ '); // Escape spaces

           result = result.replace(new RegExp(`\\b${placeholder}\\b`, 'g'), safeValue);
      }
      return result;
}

// Helper function to execute command (copied locally)
// Note: This uses the locally defined substitutePlaceholders (though not directly in its current form)
async function executeCommand(command, executionConfig, sshClient = null) {
    const serviceName = 'discovery-service'; // Need to pass serviceName or context

    console.log(`[CMD Exec Connector] Executing command: "${command}"`);

    if (executionConfig.type === 'ssh') {
        if (!sshClient) {
            throw new Error("SSH client is required for remote execution but was not provided to executeCommand.");
        }
        return new Promise((resolve, reject) => {
            const options = { cwd: executionConfig.cwd };
            const stream = sshClient.exec(command, options, (err) => {
                if (err) return reject(new Error(`SSH execution failed to start command "${command}": ${err.message}`));
            });

            let stdout = '';
            let stderr = '';
            let exitCode = null;
            let commandSignal = null;

            stream.on('data', (data) => { stdout += data; });
            stream.stderr.on('data', (data) => { stderr += data; });

            stream.on('close', (code, signal) => {
                exitCode = code;
                commandSignal = signal;
                console.log(`[CMD Exec Connector] Remote command stream closed. Exit Code: ${exitCode}, Signal: ${commandSignal}.`);
                resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString(), signal: commandSignal });
            });

            stream.on('error', (streamErr) => {
                console.error('[CMD Exec Connector] SSH stream error:', streamErr);
                reject(new Error(`SSH stream error during command execution "${command}": ${streamErr.message}`));
            });
        });

    } else { // Default to local execution using child_process.exec
        return new Promise((resolve, reject) => {
            const options = { cwd: executionConfig.cwd };
            const child = exec(command, options, (error, stdout, stderr) => {
                 const exitCode = error && error.code !== undefined ? error.code : 0;

                 if (error && exitCode !== 0) {
                     const errMessage = `Local command failed with exit code ${exitCode}. Error: ${error.message}\nSTDOUT: ${stdout.toString()}\nSTDERR: ${stderr.toString()}`;
                     console.error(`[CMD Exec Connector] ${errMessage}`);
                     resolve({ exitCode: exitCode, stdout: stdout.toString(), stderr: stderr.toString() });
                 } else if (error && exitCode === 0) {
                    console.warn(`[CMD Exec Connector] Local command finished with Exit Code 0, but exec returned an error object: ${error.message}.`);
                    resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() });
                 } else {
                    console.log(`[CMD Exec Connector] Local command successful. Exit Code: ${exitCode}.`);
                    if (stdout) console.log(`[CMD Exec Connector] STDOUT:\n${stdout.toString()}`);

                    
                    if (stderr) console.error(`[CMD Exec Connector] STDERR:\n${stderr.toString()}`);
                    resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() });
                 }
            });

             child.on('error', (execError) => {
                  console.error(`[CMD Exec Connector] Local command execution error:`, execError);
                  reject(new Error(`Local command execution failed to start "${command}": ${execError.message}`));
             });
        });
    }
}


module.exports = {
    discoverAccess,
    // addtional methods if needed (e.g., discoverUsers, discoverEntitlements if discovery is separate)
};