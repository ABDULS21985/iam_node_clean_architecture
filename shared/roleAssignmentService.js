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
 * object comparisons or complex conditions using json-logic-js, and handles eligible grades.
 *
 * @param {object} userData - The IGLM User data object (e.g., from ICS event payload or IGLM DB).
 * Contains mapped attributes like hrmsId, departmentName, jobTitle, metadata, etc.
 * @param {object} attributeToRoleMappingConfig - The MappingConfig containing attribute-to-role rules.
 * Expected mappingConfig.mappingRules structure:
 * {
 * "attributeToRoleMapping": { // <--- Rules are expected nested here
 * "rules": [ // Array of rules { condition: {...}, eligibleGrades: [...], roles: [...], ruleName: "..." }
 * // ... rules ...
 * ],
 * "conditionEngine": "simple" | "json-logic", // Specify engine
 * },
 * "defaultRole": "basic_user" // <--- Default role expected here if no explicit rules match
 * // ... other mapping rules/metadata ...
 * }
 * @returns {Promise<Array<string>>} A promise resolving with an array of unique desired IGLM Role names.
 */
async function determineRolesBasedOnMatrixRules(userData, attributeToRoleMappingConfig) {
    const serviceName = 'role-assignment-service'; // Or pass serviceName/context
    console.log(`[${serviceName}] Determining roles for user based on matrix rules.`);
    // console.log(`[${serviceName}] User data:`, userData); // Be mindful of sensitive data

    // Get the rules container and the condition engine configuration from the expected nested path
    const mappingRules = attributeToRoleMappingConfig?.mappingRules || {};
    const attributeToRoleConfig = mappingRules.attributeToRoleMapping || {}; // Get the nested object
    const attributeToRoleRules = attributeToRoleConfig.rules || []; // Get rules array from nested object
    const conditionEngine = attributeToRoleConfig.conditionEngine || 'simple'; // Default to 'simple' engine
    const defaultRole = mappingRules.defaultRole; // Get the default role from the top level of mappingRules


    const desiredRoleNames = new Set(); // Use a Set to avoid duplicate role names

    // --- Handle case with no explicit rules ---
    if (attributeToRoleRules.length === 0) {
        console.warn(`[${serviceName}] No explicit attribute-to-role matrix rules found in the provided config.`);
        // If no explicit rules, just assign the default role if it exists
        if (defaultRole && typeof defaultRole === 'string' && defaultRole.length > 0) {
            console.log(`[${serviceName}] Assigning default role: ${defaultRole} (no explicit rules found).`);
            desiredRoleNames.add(defaultRole);
        } else {
            console.warn(`[${serviceName}] No default role configured and no explicit rules found. User will have no roles assigned by this matrix.`);
        }
        // Convert Set of role names to Array and return (will be empty or contain default)
        return Array.from(desiredRoleNames);
    }

    console.log(`[${serviceName}] Applying ${attributeToRoleRules.length} matrix rules using engine: "${conditionEngine}".`);

    // --- Evaluate explicit rules ---
    let anyExplicitRuleMatched = false; // Flag to track if *any* explicit rule matched its full criteria

    for (const rule of attributeToRoleRules) {
        // Ensure rule has expected minimum structure (at least 'roles' array)
        if (!rule || !Array.isArray(rule.roles)) {
            const ruleName = rule?.ruleName || 'Unnamed/Malformed Rule';
            console.warn(`[${serviceName}] Skipping malformed rule "${ruleName}". Missing 'roles' array.`, { rule });
            continue; // Skip to the next rule
        }

        const condition = rule.condition; // Main condition (can be object, string, undefined/null)
        const eligibleGrades = rule.eligibleGrades; // Eligible grades array (optional)
        const rolesToAssign = rule.roles; // Array of role names for this rule
        const ruleName = rule.ruleName || 'Unnamed Rule';

        let mainConditionMet = false; // Result of evaluating the 'condition' property
        let gradesConditionMet = false; // Result of checking user's grade against eligibleGrades
        let evaluationError = null; // Track errors during condition or grade evaluation

        try {
            // --- 1. Evaluate the main 'condition' property ---
            if (typeof condition === 'undefined' || condition === null) {
                 // If no condition property, treat as always met initially
                 mainConditionMet = true;
                 // console.log(`[${serviceName}] Rule "${ruleName}": No condition specified, treating as always met.`);
             } else if (conditionEngine === 'json-logic' && typeof condition === 'object') {
                 // Use json-logic-js to evaluate the condition object
                 mainConditionMet = jsonLogic.apply(condition, userData);
                 // jsonLogic.apply can return non-boolean values. Treat non-true/non-boolean as false.
                 if (typeof mainConditionMet !== 'boolean' || mainConditionMet !== true) {
                      if (typeof mainConditionMet !== 'boolean') {
                          console.warn(`[${serviceName}] Rule "${ruleName}": json-logic condition evaluation returned non-boolean value (${mainConditionMet}). Treating as false.`);
                      }
                     mainConditionMet = false; // Ensure it's strictly boolean true
                 }
             } else if (conditionEngine === 'simple' && typeof condition === 'object' && condition !== null) {
                 // Evaluate simple object condition { "attributePath": "value", ... }
                 let allSimpleConditionsMet = true;
                 for (const attributePath in condition) {
                     // Use hasOwnProperty check for safety
                     if (Object.prototype.hasOwnProperty.call(condition, attributePath)) {
                         const requiredValue = condition[attributePath];
                         // Use getNestedValue to safely access user attributes, including nested metadata
                         const actualValue = getNestedValue(userData, attributePath);

                         // Basic strict comparison (might need type coercion or stricter checks depending on requirements)
                         if (actualValue !== requiredValue) {
                             allSimpleConditionsMet = false;
                             break; // No need to check other parts of this rule's condition
                         }
                     } else {
                         // Condition property like 'hasOwnProperty' itself in the rule definition. Treat as not met.
                         allSimpleConditionsMet = false;
                         break;
                     }
                 }
                 mainConditionMet = allSimpleConditionsMet;
             } else if (conditionEngine === 'simple' && condition === 'true') {
                 // Special case for a literal 'true' string condition in 'simple' engine
                 mainConditionMet = true;
             } else {
                 // Invalid condition type for the specified engine
                 console.warn(`[${serviceName}] Rule "${ruleName}": Invalid condition type "${typeof condition}" for engine "${conditionEngine}". Skipping main condition evaluation.`);
                 mainConditionMet = false;
             }

             // --- 2. If main condition potentially met, evaluate eligible grades if present ---
             // The grades condition is only relevant if the main condition evaluation passed
             if (mainConditionMet && eligibleGrades && Array.isArray(eligibleGrades) && eligibleGrades.length > 0) {
                 // Get the user's grade from userData (assuming it's mapped to 'grade' or 'metadata.gradeLevel')
                 // Use getNestedValue for robustness
                 const userGrade = userData.grade || getNestedValue(userData, 'metadata.gradeLevel');

                 if (userGrade !== undefined && userGrade !== null) {
                      // Check if the user's grade is included in the eligible grades array
                      // Ensure comparison handles types appropriately (convert userGrade to string if eligibleGrades are strings)
                     const userGradeStr = String(userGrade); // Convert user grade to string for comparison
                     if (eligibleGrades.includes(userGradeStr)) {
                         gradesConditionMet = true;
                         // console.log(`[${serviceName}] Rule "${ruleName}": Grade "${userGradeStr}" is eligible.`);
                     } else {
                          // Main condition met, but grade is not eligible
                         // console.log(`[${serviceName}] Rule "${ruleName}": Grade "${userGradeStr}" is NOT eligible.`);
                         gradesConditionMet = false;
                     }
                 } else {
                     // Main condition met, eligible grades specified, but user's grade not found. Treat as not eligible.
                     console.warn(`[${serviceName}] Rule "${ruleName}": Eligible grades specified, but user's grade not found in userData. Treating as not eligible.`);
                     gradesConditionMet = false;
                 }

             } else if (mainConditionMet) {
                 // If main condition met AND no eligible grades specified or empty, the grade condition is implicitly met (or not required)
                 gradesConditionMet = true;
                 // console.log(`[${serviceName}] Rule "${ruleName}": Main condition met, and no eligible grades specified. Grade condition implicitly met.`);
             } else {
                 // If main condition was NOT met, the grades condition is irrelevant and remains false.
                 gradesConditionMet = false;
                 // console.log(`[${serviceName}] Rule "${ruleName}": Main condition not met. Skipping grade check.`);
             }


         } catch (err) {
             // Catch any errors during condition or grade evaluation (e.g., invalid json-logic, errors in getNestedValue)
              console.error(`[${serviceName}] Rule "${ruleName}": Error evaluating condition or grades:`, err);
              evaluationError = err;
              // Treat evaluation error as the rule not matching
              mainConditionMet = false;
             gradesConditionMet = false;
         }


        // --- Determine if the rule *as a whole* matched ---
        // The rule is met if the main condition was met AND the grade condition was met (if applicable), AND no evaluation errors occurred.
        const ruleMatched = mainConditionMet && gradesConditionMet && !evaluationError;


        // If the rule matched, add its roles
        if (ruleMatched) {
            anyExplicitRuleMatched = true; // Mark that at least one explicit rule matched
            console.log(`[${serviceName}] Rule "${ruleName}" matched. Assigning roles: ${rolesToAssign.join(', ')}`);
            // Add roles to the set, ensuring they are valid strings
             if (Array.isArray(rolesToAssign)) {
                rolesToAssign.forEach(roleName => {
                   if (typeof roleName === 'string' && roleName.length > 0) {
                      desiredRoleNames.add(roleName); // Add valid role names to the Set
                   } else {
                      console.warn(`[${serviceName}] Rule "${ruleName}": Invalid role name "${roleName}" in 'roles' array. Skipping.`);
                   }
                });
            } else {
                // This check is redundant due to the outer rule validation, but harmless
                console.warn(`[${serviceName}] Rule "${ruleName}" matched, but 'roles' is not a valid array. Skipping role assignment for this rule.`);
            }
        } else if (!ruleMatched && !evaluationError) {
             // Rule did not match, and no error occurred. This is expected for rules that don't apply to the user.
             // console.log(`[${serviceName}] Rule "${ruleName}" did not match.`);
        } else if (evaluationError) {
             // Rule evaluation resulted in an error, roles are not assigned for this rule.
             console.warn(`[${serviceName}] Rule "${ruleName}" skipped due to evaluation error.`);
        }
    }

    // --- Handle Default Role ---
    // If *no explicit* rules matched AND a default role is configured, assign the default role.
    // If *any explicit* rules matched, the default role is NOT assigned (unless it was explicitly assigned by one of those rules).
    if (!anyExplicitRuleMatched && defaultRole && typeof defaultRole === 'string' && defaultRole.length > 0) {
        console.log(`[${serviceName}] No explicit rule conditions met. Assigning default role: ${defaultRole}.`);
        desiredRoleNames.add(defaultRole); // Add the default role
    } else if (!anyExplicitRuleMatched && (!defaultRole || typeof defaultRole !== 'string' || defaultRole.length === 0)) {
         console.warn(`[${serviceName}] No explicit rule conditions met, and no valid default role is configured. User will have no roles assigned by this matrix.`);
    } else if (anyExplicitRuleMatched && defaultRole && typeof defaultRole === 'string' && defaultRole.length > 0) {
         // Optional log: If explicit rules matched, the default isn't applied (unless implicitly added by a rule)
         // console.log(`[${serviceName}] Explicit rules matched, default role "${defaultRole}" is not applied automatically.`);
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