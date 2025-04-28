// shared/roleAssignmentService.js

// Import models if needed here (e.g., to look up Role IDs by name if mapping config provides names)
// const { Role, MappingConfig } = require('./models');

// Import the json-logic-js library
const jsonLogic = require('json-logic-js');

// Note: getNestedValue is included locally here for self-containment,
// but in a real project, shared utility functions like this
// should ideally be in a dedicated shared utility file.

/**
 * Helper function to get a value from a nested object path (e.g., 'metadata.sAMAccountName').
 * This is a utility for evaluating conditions based on nested attributes.
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
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined; // Path not found or hit a non-object/null
        }
        current = current[part];
    }
    return current;
}


/**
 * Determines the list of desired IGLM Role names for a user based on their attributes
 * and the configured matrix rules (Attribute-to-Role mapping).
 *
 * This function interprets the rules stored in a MappingConfig entry, supporting simple
 * object comparisons or complex conditions using json-logic-js.
 *
 * @param {object} userData - The IGLM User data object (e.g., from ICS event payload or IGLM DB).
 * Contains mapped attributes like hrmsId, department, title, metadata, etc.
 * @param {object} attributeToRoleMappingConfig - The MappingConfig containing attribute-to-role rules.
 * Expected mappingConfig.mappingRules.attributeToRoleMapping structure:
 * {
 * "rules": [ // Array of rules
 * { "condition": { "department": "IT", "title": "Engineer" }, "roles": ["IT Engineer Role"], "ruleName": "IT Engineer Rule" }, // Simple object condition
 * { "condition": { ">": [{ "metadata.gradeLevel": { "var": "metadata.gradeLevel" } }, 7] }, "roles": ["Senior Grade Role"], "ruleName": "Grade > 7 Rule" }, // JSON Logic condition
 * { "condition": "true", "roles": ["Employee"], "ruleName": "Base Employee Role" } // Simple string condition
 * ],
 * "conditionEngine": "simple" | "json-logic", // Optional: Specify which engine to use ('simple' object comparison or 'json-logic'). Defaults to 'simple'.
 * // Add other metadata about the rules if needed
 * "metadata": {
 * // e.g., "description": "Rules for assigning roles based on HR attributes"
 * }
 * }
 * @returns {Promise<Array<string>>} A promise resolving with an array of unique desired IGLM Role names.
 */
async function determineRolesBasedOnMatrixRules(userData, attributeToRoleMappingConfig) {
    const serviceName = 'role-assignment-service'; // Or pass serviceName/context
    console.log(`[${serviceName}] Determining roles for user based on matrix rules.`);
    // console.log(`[${serviceName}] User data:`, userData);
    // console.log(`[${serviceName}] Mapping config (rules only):`, attributeToRoleMappingConfig?.mappingRules?.attributeToRoleMapping);


    // Get the rules and the condition engine configuration
    const attributeToRoleMapping = attributeToRoleMappingConfig?.mappingRules?.attributeToRoleMapping || {};
    const attributeToRoleRules = attributeToRoleMapping.rules || [];
    const conditionEngine = attributeToRoleMapping.conditionEngine || 'simple'; // Default to 'simple'

    const desiredRoleNames = new Set(); // Use a Set to avoid duplicate role names

    if (attributeToRoleRules.length === 0) {
        console.warn(`[${serviceName}] No attribute-to-role matrix rules found in the provided config. Returning empty roles.`);
        return []; // Return empty array if no rules are configured
    }

    console.log(`[${serviceName}] Applying ${attributeToRoleRules.length} matrix rules using engine: "${conditionEngine}".`);

    // --- Implement logic to evaluate conditions and determine roles ---

    for (const rule of attributeToRoleRules) {
        const condition = rule.condition;
        const rolesToAssign = rule.roles;
        const ruleName = rule.ruleName || 'Unnamed Rule';

        let conditionMet = false; // Assume condition is not met initially
        let evaluationError = null; // Track errors during condition evaluation

        try {
            if (conditionEngine === 'json-logic' && typeof condition === 'object' && condition !== null) {
                 // Use json-logic-js to evaluate the condition object
                 conditionMet = jsonLogic.apply(condition, userData);
                 if (typeof conditionMet !== 'boolean') {
                     // jsonLogic.apply can return non-boolean values depending on the rule
                     // For role assignment, we typically expect a boolean outcome.
                     console.warn(`[${serviceName}] Rule "${ruleName}": json-logic condition evaluation returned non-boolean value (${conditionMet}). Treating as false.`);
                     conditionMet = false;
                 }
                 // console.log(`[${serviceName}] Rule "${ruleName}": json-logic condition evaluated to ${conditionMet}.`);

            } else if (conditionEngine === 'simple' || typeof condition === 'string') {
                // Handle simple object comparisons or "true" string condition (backward compatibility/simplicity)

                if (typeof condition === 'string') {
                    // Simple string conditions like "true"
                    conditionMet = (condition === 'true');
                    if (condition !== 'true') {
                        console.warn(`[${serviceName}] Rule "${ruleName}": Invalid simple string condition "${condition}". Only "true" is explicitly supported.`);
                    }
                     // console.log(`[${serviceName}] Rule "${ruleName}": Simple string condition evaluated to ${conditionMet}.`);

                } else if (typeof condition === 'object' && condition !== null) {
                    // Evaluate simple object conditions { "attribute": "value", ... }
                    let allConditionsInRuleMet = true; // Assume all parts of the condition are met

                    for (const attributePath in condition) {
                         // Use hasOwnProperty check for safety
                        if (Object.prototype.hasOwnProperty.call(condition, attributePath)) {
                             const requiredValue = condition[attributePath];
                             const actualValue = getNestedValue(userData, attributePath); // Get the user's actual value

                             // Basic comparison (might need type coercion or stricter checks depending on requirements)
                             if (actualValue !== requiredValue) {
                                 allConditionsInRuleMet = false; // This part of the condition is NOT met
                                 // console.log(`[${serviceName}] Rule "${ruleName}": Condition part "${attributePath}" === "${requiredValue}" not met (actual: "${actualValue}"). Rule skipped.`);
                                 break; // No need to check other parts of this rule's condition
                             }
                        }
                    }
                    conditionMet = allConditionsInRuleMet; // The rule's condition is met only if all parts were met
                     // console.log(`[${serviceName}] Rule "${ruleName}": Simple object condition evaluated to ${conditionMet}.`);

                } else {
                    // Invalid condition type for 'simple' engine
                     console.warn(`[${serviceName}] Rule "${ruleName}": Invalid condition type "${typeof condition}" for "simple" engine. Skipping rule.`);
                     conditionMet = false;
                }

            } else {
                // Invalid condition engine or condition type for the specified engine
                 console.warn(`[${serviceName}] Rule "${ruleName}": Invalid condition type "${typeof condition}" or unsupported condition engine "${conditionEngine}". Skipping rule.`);
                 conditionMet = false;
            }

        } catch (err) {
            // Catch errors during condition evaluation (e.g., invalid json-logic structure)
             console.error(`[${serviceName}] Rule "${ruleName}": Error evaluating condition:`, err);
             evaluationError = err; // Store the error
             conditionMet = false; // Condition evaluation failed, treat as not met
        }


        // If the condition for this rule is met (and no evaluation error occurred), add the roles defined in this rule
        if (conditionMet && !evaluationError && Array.isArray(rolesToAssign)) {
            console.log(`[${serviceName}] Rule "${ruleName}" condition met. Assigning roles: ${rolesToAssign.join(', ')}`);
             rolesToAssign.forEach(roleName => {
                 if (typeof roleName === 'string' && roleName.length > 0) {
                     desiredRoleNames.add(roleName); // Add valid role names to the Set
                 } else {
                      console.warn(`[${serviceName}] Rule "${ruleName}": Invalid role name "${roleName}" in 'roles' array. Skipping.`);
                 }
             });
        } else if (conditionMet && !evaluationError && !Array.isArray(rolesToAssign)) {
             console.warn(`[${serviceName}] Rule "${ruleName}" condition met, but 'roles' is not a valid array. Skipping role assignment for this rule.`);
        } else if (!conditionMet && !evaluationError) {
             // Condition was not met, and no error occurred. This is expected for most rules.
             // console.log(`[${serviceName}] Rule "${ruleName}" condition not met. Skipping roles.`);
        } else if (evaluationError) {
             // Condition evaluation resulted in an error, roles are not assigned.
             console.warn(`[${serviceName}] Rule "${ruleName}" skipped due to condition evaluation error.`);
        }
    }

    // Convert Set of role names to Array and return
    const finalDesiredRoleNames = Array.from(desiredRoleNames);
    console.log(`[${serviceName}] Finished determining roles based on matrix rules. Final desired roles: ${finalDesiredRoleNames.join(', ')}`);
    return finalDesiredRoleNames; // Array of unique IGLM Role names
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


// Export the main function
module.exports = {
    determineRolesBasedOnMatrixRules,
    // Export getNestedValue if it's intended to be used elsewhere
    // getNestedValue
};