// services/provisioning-service/src/connectors/provisioning/cmd-exec.js
// Built-in Node.js module for local command execution
const { exec } = require('child_process');
// For remote execution over SSH: npm install ssh2
// Use a different name for the SSH Client to avoid conflict with potential other 'Client' imports
const { Client: SSHClient } = require('ssh2');

/**
 * Command-line Execution Provisioning Connector Adapter.
 * Manages access by executing shell commands (local or remote) based on configured templates.
 *
 * Note: This implementation focuses on executing predefined command templates.
 * Error checking based on exit codes and command output is crucial.
 * Remote SSH execution logic is included but requires implementation details.
 */

/**
 * Helper function to substitute placeholders in a command template string.
 * Placeholders are identified by a colon prefix (e.g., ":userIdInApp").
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

         // Basic sanitization for shell execution - MORE ROBUST SANITIZATION
         // IS CRUCIAL FOR PRODUCTION AND DEPENDS ON EXPECTED COMMAND/DATA.
         const safeValue = (value === null || value === undefined) ? '' : String(value).replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$'); // Escape quotes, backticks, dollars

         // Use a regex with word boundaries (\b) to ensure we replace exact placeholders
         // The '\b' matches word boundaries, preventing replacing ':user' in ':username'
         result = result.replace(new RegExp(`\\b${placeholder}\\b`, 'g'), safeValue);
     }
     return result;
 }


/**
 * Executes a single command locally or remotely via SSH.
 *
 * @param {string} command - The command string to execute.
 * @param {object} executionConfig - Configuration for execution (e.g., { type: 'local' } or { type: 'ssh', sshDetails: {...} }).
 * @param {object} [sshClient] - An optional SSH client instance if executionConfig.type is 'ssh'.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>} Promise resolving with command results.
 * @throws {Error} If execution fails critically (e.g., cannot connect SSH, command not found, SSH stream error).
 */
async function executeCommand(command, executionConfig, sshClient = null) {
    const serviceName = 'provisioning-service'; // Need to pass serviceName or context
    console.log(`[CMD Exec Connector] Executing command: "${command}"`);

    if (executionConfig.type === 'ssh') {
        if (!sshClient) {
            throw new Error("SSH client not provided for remote execution.");
        }
        // Execute remotely over SSH
        return new Promise((resolve, reject) => {
            // SSH Client's exec method returns a stream
             const options = {
                  cwd: executionConfig.cwd // Pass cwd option if configured
             };
            sshClient.exec(command, options, (err, stream) => {
                if (err) {
                    // Error starting the command (e.g., command not found on remote)
                    console.error(`[CMD Exec Connector] SSH exec stream error:`, err);
                    return reject(new Error(`SSH execution failed to start command: ${err.message}`));
                }

                let stdout = '';
                let stderr = '';
                let exitCode = null;

                stream.on('data', (data) => { stdout += data; }); // Standard output
                stream.stderr.on('data', (data) => { stderr += data; }); // Standard error

                stream.on('close', (code, signal) => {
                    // Command process has ended
                    exitCode = code;
                    console.log(`[CMD Exec Connector] Remote command stream closed. Exit Code: ${exitCode}, Signal: ${signal}.`);
                    resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() }); // Resolve with results
                });

                stream.on('error', (streamErr) => {
                    // Error on the stream itself
                    console.error('[CMD Exec Connector] SSH stream error:', streamErr);
                    reject(new Error(`SSH stream error during command execution: ${streamErr.message}`));
                });

            });
        });

    } else { // Default to local execution using child_process.exec
        // Use child_process.exec for simple local commands.
        // It buffers stdout/stderr and returns them when the process finishes.
        return new Promise((resolve, reject) => {
            const options = {
                cwd: executionConfig.cwd // Pass cwd option if configured
                // Add other exec options like timeout, maxBuffer, shell etc.
            };
            exec(command, options, (error, stdout, stderr) => {
                // Error object is populated for non-zero exit codes or execution issues
                 const exitCode = error ? error.code || 1 : 0; // Get exit code from error object if available, default to 1 if error

                if (error && exitCode !== 0) {
                     // Command failed with non-zero exit code or a critical error (e.g., command not found)
                     // Include stdout/stderr in the error message for context
                     const errMessage = `Local command failed: ${error.message}\nSTDOUT: ${stdout.toString()}\nSTDERR: ${stderr.toString()}`;
                     console.error(`[CMD Exec Connector] Local command failed. Exit Code: ${exitCode}. Error: ${errMessage}`);
                     reject(new Error(errMessage)); // Reject the promise with a detailed error
                } else if (error && exitCode === 0) {
                     // This case is less common but possible (e.g., non-ExitError). Treat as success.
                     console.warn(`[CMD Exec Connector] Local command finished with Exit Code 0, but exec returned an error object: ${error.message}.`);
                     resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() }); // Resolve as success
                } else {
                     // Success (Exit Code 0)
                     console.log(`[CMD Exec Connector] Local command successful. Exit Code: ${exitCode}.`);
                     if (stdout) console.log(`[CMD Exec Connector] STDOUT:\n${stdout.toString()}`);
                     if (stderr) console.error(`[CMD Exec Connector] STDERR:\n${stderr.toString()}`);
                     resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() }); // Resolve as success
                }
            });
        });
    }
}


/**
 * Applies the desired state (grant/revoke entitlements) for a user by executing commands.
 * This method is called by provisioningLogic.js.
 *
 * @param {object} configDetails - The 'configuration' object from the ConnectorConfig database entry.
 * Expected structure (example):
 * {
 * "execution": { "type": "local" | "ssh", "sshDetails": {...}, "cwd": "..." }, // How commands are executed
 * "commandTemplates": { // Define command templates
 * "grant": { // Grant templates
 * "00000000-0000-0000-0000-000000000601": { "template": "adduser --ingroup :appEntitlementId :userIdInApp" }, // IGLM Entitlement ID -> Template
 * "default": { "template": "grant-access.sh --user :userIdInApp --item :appEntitlementId" } // Default grant template
 * },
 * "revoke": { // Revoke templates
 * "00000000-0000-0000-0000-000000000601": { "template": "deluser :userIdInApp :appEntitlementId" },
 * "default": { "template": "revoke-access.sh --user :userIdInApp --item :appEntitlementId" }
 * }
 * },
 * "successExitCodes": [0, 10] // Optional array of exit codes considered successful (e.g., 0 for success, 10 for 'already exists')
 * }
 * @param {object} appSpecificDesiredState - The application-specific state for the user.
 * Expected structure (from provisioningLogic.js):
 * {
 * "userIdInApp": "...", // The user's identifier for the target system/commands
 * "entitlementsToGrant": [
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "mappingDetails": {...} },
 * ],
 * "entitlementsToRevoke": [
 * { "iglmEntitlementId": "...", "iglmEntitlementName": "...", "appEntitlementId": "...", "mappingDetails": {...} },
 * ]
 * }
 * @returns {Promise<object>} A promise resolving with the result of the provisioning operations.
 * Returns { success: boolean, operations: Array<{ entitlement: string, appEntitlementId?: string, status: 'granted'|'revoked'|'skipped'|'failed', message?: string, error?: string, command?: string, result?: { stdout: string, stderr: string, exitCode: number } }> }.
 * @throws {Error} If a critical configuration or connection setup error occurs.
 */
async function applyDesiredState(configDetails, appSpecificDesiredState) {
    const serviceName = 'provisioning-service'; // Or pass service name from options
    console.log(`[CMD Exec Connector] Applying desired state for user: ${appSpecificDesiredState?.userIdInApp || 'N/A'}`);
    // Log sensitive data carefully
    // console.log(`[CMD Exec Connector] Config details (excluding secrets):`, { ...configDetails, execution: { ...configDetails?.execution, sshDetails: { ...configDetails?.execution?.sshDetails, password: '***', privateKey: '***' } } });
    console.log(`[CMD Exec Connector] Desired state (summary): Granting ${appSpecificDesiredState?.entitlementsToGrant?.length || 0}, Revoking ${appSpecificDesiredState?.entitlementsToRevoke?.length || 0}`);

    let sshClient = null; // SSH client instance if remote execution
    const operationResults = []; // Collect results for each entitlement operation

    try {
        // 1. Read Config and Validate
        const executionConfig = configDetails?.execution || { type: 'local' }; // Default to local
        const commandTemplates = configDetails?.commandTemplates;
        const successExitCodes = Array.isArray(configDetails?.successExitCodes) ? configDetails.successExitCodes : [0]; // Default to [0] for success

        const { userIdInApp, entitlementsToGrant, entitlementsToRevoke } = appSpecificDesiredState || {}; // Handle case where appSpecificDesiredState is null/undefined

        if (!commandTemplates || typeof commandTemplates !== 'object') {
             throw new Error("Invalid CMD Exec connector configuration: Missing or invalid 'commandTemplates'.");
        }
        if (!userIdInApp) {
             console.warn(`[CMD Exec Connector] Invalid appSpecificDesiredState: Missing userIdInApp. Skipping all operations.`);
             // Add a failed result for the overall task if userIdInApp is missing
             operationResults.push({ entitlement: 'N/A', status: 'failed', message: 'Missing userIdInApp in desired state' });
             return { success: false, operations: operationResults }; // Return early
        }

        // 2. Establish SSH Connection if remote execution
        if (executionConfig.type === 'ssh') {
            const sshDetails = executionConfig.sshDetails;
             if (!sshDetails || !sshDetails.host || !sshDetails.username || (!sshDetails.password && !sshDetails.privateKey)) {
                 throw new Error("Invalid CMD Exec connector configuration: Missing or incomplete remote SSH details for type 'ssh'.");
             }
             console.log(`[CMD Exec Connector] Establishing SSH connection to ${sshDetails.host}:${sshDetails.port || 22}...`);
             try {
                 // Establish SSH connection asynchronously
                 sshClient = new SSHClient();
                 await new Promise((resolve, reject) => {
                      sshClient.on('ready', resolve).on('error', reject);
                      // Add timeout for connection attempt
                      const connectTimeout = setTimeout(() => reject(new Error('SSH connection timed out')), executionConfig.sshDetails.connectTimeout || 10000); // Default 10s timeout
                      sshClient.connect(sshDetails);
                      sshClient.on('ready', () => clearTimeout(connectTimeout)); // Clear timeout on success
                 });
                 console.log('[CMD Exec Connector] SSH client connected.');

                 // Add error listener after connection is ready
                 sshClient.on('error', (err) => {
                     console.error('[CMD Exec Connector] SSH connection error after ready:', err);
                     // This catches unexpected errors *after* connection.
                     // Need a strategy to handle this (e.g., mark subsequent ops failed).
                     // For now, errors during `connection.exec` will reject their promise.
                 });

             } catch (sshConnectError) {
                 console.error(`[CMD Exec Connector] Failed to establish SSH connection:`, sshConnectError);
                 throw new Error(`CMD Exec connector failed to connect via SSH: ${sshConnectError.message}`); // Critical failure
             }
        }


        // 3. Process Grants
        const grantTemplates = commandTemplates.grant;
        if (!grantTemplates) {
             console.warn("[CMD Exec Connector] No 'grant' command templates defined. Skipping all grant operations.");
             // Add skipped results for all intended grants
             for (const grantItem of entitlementsToGrant || []) {
                 operationResults.push({ entitlement: grantItem.iglmEntitlementName, appEntitlementId: grantItem.appEntitlementId, status: 'skipped', message: 'No grant templates defined', iglmEntitlementId: grantItem.iglmEntitlementId });
             }
        } else {
            const grantsToProcess = entitlementsToGrant || []; // Ensure it's an array
             console.log(`[CMD Exec Connector] Processing ${grantsToProcess.length} entitlements to grant...`);
             for (const grantItem of grantsToProcess) {
                  const { iglmEntitlementId, iglmEntitlementName, appEntitlementId } = grantItem; // appEntitlementId is the command parameter value
                  const opContext = `User "${userIdInApp}" grant "${iglmEntitlementName}" (${appEntitlementId})`;

                 // Determine the command config for this entitlement (by IGLM ID or default)
                 const commandConfig = grantTemplates[iglmEntitlementId] || grantTemplates.default;

                  if (!commandConfig || !commandConfig.template) {
                      console.warn(`[CMD Exec Connector] ${opContext}: Skipping - No grant command template found for IGLM ID "${iglmEntitlementId}" and no default 'grant' template.`);
                      operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing command template', iglmEntitlementId: iglmEntitlementId });
                      continue;
                  }
                 if (appEntitlementId === undefined || appEntitlementId === null) {
                     console.warn(`[CMD Exec Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
                     operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId', iglmEntitlementId: iglmEntitlementId });
                     continue;
                 }

                  // Construct the final command string by substituting placeholders
                  const commandTemplate = commandConfig.template;
                  const command = substitutePlaceholders(commandTemplate, { userIdInApp, appEntitlementId, ...grantItem }); // Use the helper

                  console.log(`[CMD Exec Connector] ${opContext}: Executing command: "${command}"`);

                  try {
                      // Execute the command (local or remote) using the helper function
                      const commandResult = await executeCommand(command, executionConfig, sshClient);

                      // Check command result for success based on successExitCodes
                      const isSuccessful = successExitCodes.includes(commandResult.exitCode);

                      if (isSuccessful) {
                          console.log(`[CMD Exec Connector] ${opContext}: Command successful (Exit Code: ${commandResult.exitCode}).`);
                          operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'granted', command: command, result: commandResult });
                      } else {
                          console.error(`[CMD Exec Connector] ${opContext}: Command failed (Exit Code: ${commandResult.exitCode}).`);
                          operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'failed', message: `Command failed with exit code ${commandResult.exitCode}`, error: commandResult.stderr || commandResult.stdout || `Exit Code: ${commandResult.exitCode}`, command: command, result: commandResult });
                      }

                 } catch (execError) {
                      // Catch errors during command execution setup or execution itself
                      console.error(`[CMD Exec Connector] ${opContext}: Error executing command:`, execError);
                      operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'failed', message: `Error during command execution: ${execError.message}`, error: execError.message, command: command });
                 }
             }
        }


        // 4. Process Revokes
        const revokeTemplates = commandTemplates.revoke;
        if (!revokeTemplates) {
            console.warn("[CMD Exec Connector] No 'revoke' command templates defined. Skipping all revoke operations.");
            // Add skipped results for all intended revokes
            for (const revokeItem of entitlementsToRevoke || []) {
                 operationResults.push({ entitlement: revokeItem.iglmEntitlementName, appEntitlementId: revokeItem.appEntitlementId, status: 'skipped', message: 'No revoke templates defined', iglmEntitlementId: revokeItem.iglmEntitlementId });
            }
        } else {
             const revokesToProcess = entitlementsToRevoke || []; // Ensure it's an array
             console.log(`[CMD Exec Connector] Processing ${revokesToProcess.length} entitlements to revoke...`);
              for (const revokeItem of revokesToProcess) {
                  const { iglmEntitlementId, iglmEntitlementName, appEntitlementId } = revokeItem;
                  const opContext = `User "${userIdInApp}" revoke "${iglmEntitlementName}" (${appEntitlementId})`;

                  // Determine the command config for this entitlement (by IGLM ID or default)
                  const commandConfig = revokeTemplates[iglmEntitlementId] || revokeTemplates.default;

                   if (!commandConfig || !commandConfig.template) {
                       console.warn(`[CMD Exec Connector] ${opContext}: Skipping - No revoke command template found for IGLM ID "${iglmEntitlementId}" and no default 'revoke' template.`);
                       operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing command template', iglmEntitlementId: iglmEntitlementId });
                       continue;
                   }
                  if (appEntitlementId === undefined || appEntitlementId === null) {
                       console.warn(`[CMD Exec Connector] ${opContext}: Skipping - Missing or null appEntitlementId.`);
                       operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'skipped', message: 'Missing appEntitlementId', iglmEntitlementId: iglmEntitlementId });
                       continue;
                   }

                  // Construct the final command string by substituting placeholders
                  const commandTemplate = commandConfig.template;
                  const command = substitutePlaceholders(commandTemplate, { userIdInApp, appEntitlementId, ...revokeItem });

                  console.log(`[CMD Exec Connector] ${opContext}: Executing command: "${command}"`);

                  try {
                      // Execute the command (local or remote) using the helper function
                      const commandResult = await executeCommand(command, executionConfig, sshClient);

                      // Check command result for success based on successExitCodes
                      const isSuccessful = successExitCodes.includes(commandResult.exitCode);

                      if (isSuccessful) {
                           console.log(`[CMD Exec Connector] ${opContext}: Command successful (Exit Code: ${commandResult.exitCode}).`);
                          operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'revoked', command: command, result: commandResult });
                      } else {
                           console.error(`[CMD Exec Connector] ${opContext}: Command failed (Exit Code: ${commandResult.exitCode}).`);
                          operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'failed', message: `Command failed with exit code ${commandResult.exitCode}`, error: commandResult.stderr || commandResult.stdout || `Exit Code: ${commandResult.exitCode}`, command: command, result: commandResult });
                      }

                 } catch (execError) {
                       console.error(`[CMD Exec Connector] ${opContext}: Error executing command:`, execError);
                      operationResults.push({ entitlement: iglmEntitlementName, appEntitlementId: appEntitlementId, status: 'failed', message: `Error during command execution: ${execError.message}`, error: execError.message, command: command });
                 }
              }
         }


        // 5. Return Summary
        const overallSuccess = !operationResults.some(op => op.status === 'failed');
        console.log(`[CMD Exec Connector] Finished operations. Overall success: ${overallSuccess}. Results:`, operationResults.map(r => ({ entitlement: r.entitlement, status: r.status, appEntitlementId: r.appEntitlementId, exitCode: r.result?.exitCode })));

        return { success: overallSuccess, operations: operationResults };

    } catch (error) {
        // Catch any critical errors that occurred before processing operations (config, connection)
        console.error('[CMD Exec Connector] Overall error during applyDesiredState:', error);
        // Close SSH connection if remote and was opened
         if (sshClient) {
              try { sshClient.end(); console.log('[CMD Exec Connector] SSH connection ended after overall error.'); }
              catch(e) { console.error('[CMD Exec Connector] Error closing SSH connection after overall error:', e); }
         }
        // Re-throw the error so provisioningLogic can catch it and mark the task failed
        throw error;

    } finally {
        // 6. Ensure SSH connection is closed if remote and was opened
        if (sshClient && typeof sshClient.end === 'function') {
             try {
                 sshClient.end(); // Close the SSH connection
                 console.log('[CMD Exec Connector] SSH connection ended in finally block.');
             } catch (closeError) {
                  console.error('[CMD Exec Connector] Error closing SSH connection in finally block:', closeError);
             }
         } else {
              console.log('[CMD Exec Connector] SSH client was not initialized or connected (likely local execution).');
         }
    }
}

/**
 * Helper function to substitute placeholders in a command template string.
 * Placeholders are identified by a colon prefix (e.g., ":userIdInApp").
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

         // Basic sanitization for shell execution - MORE ROBUST SANITIZATION
         // IS CRUCIAL FOR PRODUCTION AND DEPENDS ON EXPECTED COMMAND/DATA.
         // This attempts to escape common shell metacharacters within the substituted value.
         const safeValue = (value === null || value === undefined) ? '' : String(value).replace(/[^\w\s\.\-\/]/g, '\\$&').replace(/\s/g, '\\ '); // Escape non-word/space/dot/dash/slash chars and spaces

         // Use a regex with word boundaries (\b) to ensure we replace exact placeholders
         // The '\b' matches word boundaries, preventing replacing ':user' in ':username'
         result = result.replace(new RegExp(`\\b${placeholder}\\b`, 'g'), safeValue);
     }
     return result;
}

/**
 * Executes a single command locally or remotely via SSH.
 *
 * @param {string} command - The command string to execute.
 * @param {object} executionConfig - Configuration for execution (e.g., { type: 'local' } or { type: 'ssh', sshDetails: {...}, cwd: '...' }).
 * @param {object} [sshClient] - An optional SSH client instance if executionConfig.type is 'ssh'.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>} Promise resolving with command results.
 * @throws {Error} If execution fails critically (e.g., cannot start command, SSH stream error).
 */
async function executeCommand(command, executionConfig, sshClient = null) {
    const serviceName = 'provisioning-service'; // Need to pass serviceName or context
    console.log(`[CMD Exec Connector] Executing command: "${command}"`);

    if (executionConfig.type === 'ssh') {
        if (!sshClient) {
            // If SSH client is not passed but type is SSH, this is an error in orchestration
            throw new Error("SSH client is required for remote execution but was not provided.");
        }
        // Execute remotely over SSH
        return new Promise((resolve, reject) => {
            // SSH Client's exec method returns a stream. Need to collect stdout/stderr and wait for exit code.
             const options = {
                  cwd: executionConfig.cwd // Pass cwd option if configured
             };
             // Execute command via the SSH connection
            sshClient.exec(command, options, (err, stream) => {
                if (err) {
                    // Error starting the command (e.g., command not found on remote)
                    console.error(`[CMD Exec Connector] SSH exec stream error:`, err);
                    // Reject with a clear error including the command
                    return reject(new Error(`SSH execution failed to start command "${command}": ${err.message}`));
                }

                let stdout = '';
                let stderr = '';
                let exitCode = null;

                stream.on('data', (data) => { stdout += data; }); // Standard output
                stream.stderr.on('data', (data) => { stderr += data; }); // Standard error

                stream.on('close', (code, signal) => {
                    // Command process has ended
                    exitCode = code;
                    console.log(`[CMD Exec Connector] Remote command stream closed. Exit Code: ${exitCode}, Signal: ${signal}.`);
                    // Resolve with results after stream closes
                    resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() });
                });

                stream.on('error', (streamErr) => {
                    // Error on the stream itself
                    console.error('[CMD Exec Connector] SSH stream error:', streamErr);
                     // Reject with a clear stream error
                    reject(new Error(`SSH stream error during command execution "${command}": ${streamErr.message}`));
                });

            });
        });

    } else { // Default to local execution using child_process.exec
        // Use child_process.exec for simple local commands.
        // It buffers stdout/stderr and returns them when the process finishes.
        return new Promise((resolve, reject) => {
            const options = {
                cwd: executionConfig.cwd // Pass cwd option if configured
                // Add other exec options like timeout, maxBuffer, shell etc.
            };
             // Execute command locally
            exec(command, options, (error, stdout, stderr) => {
                // Error object is populated for non-zero exit codes or execution issues
                 const exitCode = error ? error.code || 1 : 0; // Get exit code from error object if available, default to 1 if error

                if (error && exitCode !== 0) {
                     // Command failed with non-zero exit code or a critical error (e.g., command not found)
                     // Include stdout/stderr in the error message for context
                     const errMessage = `Local command failed with error: ${error.message}\nSTDOUT: ${stdout.toString()}\nSTDERR: ${stderr.toString()}`;
                     console.error(`[CMD Exec Connector] Local command failed. Exit Code: ${exitCode}. Error: ${errMessage}`);
                     reject(new Error(errMessage)); // Reject the promise with a detailed error
                } else if (error && exitCode === 0) {
                    // This case is less common but possible (e.g., non-ExitError). Treat as success.
                    console.warn(`[CMD Exec Connector] Local command finished with Exit Code 0, but exec returned an error object: ${error.message}.`);
                     resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() }); // Resolve as success
                } else {
                     // Success (Exit Code 0)
                     console.log(`[CMD Exec Connector] Local command successful. Exit Code: ${exitCode}.`);
                     if (stdout) console.log(`[CMD Exec Connector] STDOUT:\n${stdout.toString()}`);
                     if (stderr) console.error(`[CMD Exec Connector] STDERR:\n${stderr.toString()}`);
                     resolve({ exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() }); // Resolve as success
                }
            });
        });
    }
}


module.exports = {
    applyDesiredState,
    // Optional methods: discoverUsers, discoverEntitlements
};