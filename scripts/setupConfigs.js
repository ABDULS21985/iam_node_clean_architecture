// scripts/setupConfigs.js
require('dotenv').config(); // Load environment variables from .env at project root

// Import shared services and models
const ConfigService = require('../shared/configService'); // Adjust path as needed
const models = require('../shared/models'); // Adjust path as needed

const serviceName = 'setup-script'; // Identifier for logging

async function runSetup() {
    console.log(`[${serviceName}] Starting configuration setup script...`);

    try {
        // 1. Initialize Configuration Service (connects to the Config DB)
        await ConfigService.init();
        console.log(`[${serviceName}] ConfigService initialized.`);

        // Access models after ConfigService is initialized, they are attached to sequelize
        const { ConnectorConfig, MappingConfig, Application, Entitlement } = models; // Assuming Application and Entitlement models are also needed/available


        // --- Define Configuration Data ---

        // Data for the HRMS Connector Config (Existing)
// Data for the HRMS Connector Config (Existing)
        const hrmsConnectorData = {
            name: "Postgres HRMS Identity Source",
            serviceType: "IdentityCollection",
            type: "hrms-db-postgres",
            configuration: {
                mappingRules: {
                    dbType: "postgres",
                    connection: {
                        host: process.env.HRMS_DB_HOST,
                        port: parseInt(process.env.HRMS_DB_PORT, 10),
                        database: process.env.HRMS_DB_NAME,
                        user: process.env.HRMS_DB_USER,
                        password: process.env.HRMS_DB_PASSWORD
                    },
                    // === UPDATED QUERY HERE ===
                    query: "SELECT DISTINCT person_id, employee_id, first_name, middle_name, last_name, date_of_hire, job_title, supervisor_id, head_of_office_id, job_location_id, job_location, mobile_number, department_id, department_name, division_id, division_name, office_id, office_name, grade_id, grade, party_id, termination_date, job_status FROM apps.xxcbn_iam_employees_v WHERE (termination_date IS NULL OR termination_date = CURRENT_DATE OR termination_date > CURRENT_DATE) AND department_id <> '1129' LIMIT 4000;",
                    // ==========================
                    uniqueIdentifierAttribute: "employee_id"
                },
                metadata: {
                    description: "Collect Employee Identities from Postgres View"
                }
            },
            // This top-level metadata is also fine for the ConnectorConfig entry
            metadata: {
                description: "Collect Employee Identities from Postgres View"
            }
        };
        
          

        // Data for the HRMS to IGLM User Mapping Config (Existing)
        const userMappingData = {
            name: "Postgres HRMS to IGLM User Mapping",
            sourceType: "IdentitySource", // Use a specific sourceType like "IdentitySource" or "HRMS"
            sourceId: null, // Can be linked to connector ID later if needed, but name is sufficient for lookup now
            targetType: "User", // Mapping is to the IGLM User model
            mappingRules: {
                attributeMappings: {
                    "firstName": "first_name",
                    "lastName": "last_name",
                    "email": "email",
                    "hrmsId": "employee_id",
                    "status": "job_status", // Maps HRMS status string for lookup in statusMapping
                    "jobStatus": "job_status", // Maps raw HRMS status string to the jobStatus column
                    "hireDate": "date_of_hire",
                    "exitDate": "termination_date",
                    "departmentName": "department_name",
                    "departmentId": "department_id",
                    "supervisorId": "supervisor_id", // Maps source supervisor_id to direct supervisorId column
                    "headOfOfficeId": "head_of_office_id", // <<-- ADDED: Maps source head_of_office_id to direct headOfOfficeId column
                    "jobTitle": "job_title",
                    "jobLocation": "job_location",
                    // "location": "job_location", // <-- REMOVED: Source 'location' not in query
                    "mobileNumber": "mobile_number",
                    "jobLocationId": "job_location_id", // Added direct mapping for jobLocationId
                    "divisionId": "division_id", // Added direct mapping for divisionId
                    "divisionName": "division_name", // Added direct mapping for divisionName
                    "officeId": "office_id", // Added direct mapping for officeId
                    "officeName": "office_name", // Added direct mapping for officeName
                    "gradeId": "grade_id", // Added direct mapping for gradeId
                    "grade": "grade", // <<-- ADDED: Maps source grade to direct grade column
                    "partyId": "party_id" // Added direct mapping for partyId
                },
                statusMapping: { // Map HRMS status values (from job_status) to IGLM status values ('pending_joiner', 'active', etc.)
                    "Active": "active",
                    "Active Assignment": "active",
                    "On Leave": "active",
                    "Maternity Leave Without Pay": "on_leave",
                    "Suspend Employee from Payroll": "inactive",
                    "Terminated": "exited",
                    "Pending Hire": "pending_joiner",
                    "Inactive": "inactive"
                },
                metadataMapping: { // Map HRMS fields into the IGLM User metadata JSONB (using these keys)
                    "personId": "person_id",
                    "middleName": "middle_name",
                    "supervisorHrmsId": "supervisor_id", // Maps source supervisor_id to metadata key supervisorHrmsId
                    "headOfOfficeHrmsId": "head_of_office_id", // Maps source head_of_office_id to metadata key headOfOfficeHrmsId
                    "jobLocationId": "job_location_id",
                    "departmentId": "department_id",
                    "divisionId": "division_id",
                    "divisionName": "division_name",
                    "officeId": "office_id",
                    "officeName": "office_name",
                    "gradeId": "grade_id",
                    "gradeLevel": "grade", // Maps source grade to metadata key gradeLevel
                    "partyId": "party_id"
                },
                metadata: { // Metadata about the mapping rules themselves
                    "sourceUniqueIdField": "employee_id", // <-- Crucial for DeltaDetection and DataProcessor
                    "statusSourceField": "job_status" // <-- Crucial for DataProcessor applyMapping status logic
                    // TODO: Add rules for identifying mover attributes if needed for sophisticated comparison/events
                    // "moverAttributes": ["job_title", "department_name", "job_location", "email"]
                }
            },
            metadata: {} // Top-level metadata for the MappingConfig entry itself
        };


// ────────────────────────────────────────────────────────────────────────────────
// NEW ▸ Baseline mapping of user attributes to RBAC roles
// // ────────────────────────────────────────────────────────────────────────────────
const defaultAttrRoleMappingData = {
        name: "Default Attribute To Role Mapping",
        sourceType: "UserAttribute",      // the matrix setup script looks for this
        sourceId: null,
        targetType: "Role",
        mappingRules: {
            /*
             * attributeRoleRules ⇒ evaluated in order;
             * the first rule that matches {attribute,value} wins.
             */
            attributeRoleRules: [
                { attribute: "department_name", value: "Finance",   role: "finance_user"   },
                { attribute: "department_name", value: "IT",        role: "it_user"        },
                { attribute: "job_title",       value: "Manager",   role: "people_manager" }
            ],
            /*
             * fallback role when no explicit rule matches
             */
            defaultRole: "basic_user"
        },
        metadata: {
            description: "Baseline attribute-driven RBAC mapping consumed by Joiner / \
    Mover / Leaver orchestration layers."
        }
    };
    

        // Data for the ICS Service Configuration (Existing)
        const icsServiceConfigData = {
             name: "Identity Collection Service Configuration", // More specific name
             serviceName: "identity-collection-service", // Match serviceName constant
             sourceType: "Service",
             sourceId: null,
             targetType: "Service", // Indicates this config is for a service
             mappingRules: { // Configuration values for the service itself
                pollingIntervalMinutes: 1, // Set to 1 minute for quick testing
                identitySourceConnectorName: "Postgres HRMS Identity Source", // <-- Must match ConnectorConfig name (ServiceType: IdentityCollection)
                userMappingName: "Postgres HRMS to IGLM User Mapping" // <-- Must match MappingConfig name (SourceType: IdentitySource, TargetType: User)
                // Add other ICS specific settings here
             },
             metadata: {}
        };


        // --- Define NEW Configuration Data for Joiner, Mover, and Leaver Services ---

        // Data for the Joiner Service Configuration
        const joinerServiceConfigData = {
             name: "Joiner Service Configuration",
             serviceName: "joiner-service", // Match serviceName constant
             sourceType: "Service",
             sourceId: null,
             targetType: "Service",
             mappingRules: { // Configuration values for the Joiner service
                 provisioningServiceApiUrl: process.env.PROVISIONING_SERVICE_API_URL || "http://localhost:4005", // Use env var
                 // TODO: Add default roles mapping or rule name here if they are determined by Joiner service
                 // defaultJoinerRoleMappingName: "Default Joiner Roles" // <-- Name of a MappingConfig (Source: Service, Target: EntitlementAssignment)
             },
             metadata: {}
        };

        // Data for the Mover Service Configuration
        const moverServiceConfigData = {
             name: "Mover Service Configuration",
             serviceName: "mover-service", // Match serviceName constant
             sourceType: "Service",
             sourceId: null,
             targetType: "Service",
             mappingRules: { // Configuration values for the Mover service
                 provisioningServiceApiUrl: process.env.PROVISIONING_SERVICE_API_URL || "http://localhost:4005", // Use env var
                 // TODO: Add attribute-to-role mapping name or rule name here if determined by Mover service
                 // moverRoleAssignmentMappingName: "Mover Role Reassignment" // <-- Name of a MappingConfig (Source: UserAttribute, Target: EntitlementAssignment)
             },
             metadata: {}
        };

         // Data for the Leaver Service Configuration
         const leaverServiceConfigData = {
              name: "Leaver Service Configuration",
              serviceName: "leaver-service", // Match serviceName constant
              sourceType: "Service",
              sourceId: null,
              targetType: "Service",
              mappingRules: { // Configuration values for the Leaver service
                 provisioningServiceApiUrl: process.env.PROVISIONING_SERVICE_API_URL || "http://localhost:4005", // Use env var
                 // TODO: Add leaver entitlement removal rules mapping name here
                 // leaverEntitlementRemovalMappingName: "Leaver Entitlement Cleanup" // <-- Name of a MappingConfig (Source: Service, Target: EntitlementAssignment)
              },
              metadata: {}
         };


        // --- Define Configuration Data for Target Applications ---

        // 1a. Application Entry (in Core Data Model DB)
        const postgresApp = {
            name: "Finance App (Postgres)",
            description: "Financial application running on PostgreSQL",
            type: "financial", // We will type
            connectorId: null // Will link to the ConnectorConfig ID later
            // id will be generated
        };

        // 1b. ConnectorConfig Entry (in Config DB)
        const postgresAppConnector = {
            name: "Finance App Provisioning (Postgres DB)",
            serviceType: "Provisioning", // This is a provisioning connector
            type: "app-db-postgres", // <-- Matches the app-db-postgres.js file name
            configuration: {
                dbType: "postgres",
                connection: { // Use specific env vars for this app's DB, nested under connection
                    host: process.env.FINANCE_APP_DB_HOST || "localhost",
                    port: process.env.FINANCE_APP_DB_PORT ? parseInt(process.env.FINANCE_APP_DB_PORT, 10) : 5433, // We will different port, parse int
                    database: process.env.FINANCE_APP_DB_NAME || "finance_db",
                    user: process.env.FINANCE_APP_DB_USER || "finance_user",
                    password: process.env.FINANCE_APP_DB_PASSWORD || "secure_finance_pw",
                    // Add other pg specific options
                },
                // --- SQL Templates for Provisioning Actions ---
                sqlTemplates: {
                    // Template to grant a group membership - assumes entitlementId is the group ID in the app DB
                    // Using $1 for user ID parameter, $2 for entitlement/group ID parameter
                    grantGroup: "INSERT INTO app_users_groups (user_id, group_id) VALUES ($1, $2) ON CONFLICT (user_id, group_id) DO NOTHING;", // Added ON CONFLICT for idempotency
                    // Template to revoke a group membership
                    revokeGroup: "DELETE FROM app_users_groups WHERE user_id = $1 AND group_id = $2",
                    // Add other templates like grantLicense, createUser, etc.
                    // grantLicense: "INSERT INTO app_user_licenses (user_id, license_code) VALUES ($1, $2) ON CONFLICT (user_id, license_code) DO NOTHING;",
                },
                // Configuration for parameter mapping if needed, though default $1,$2 is common
                userIdentifierTargetAttribute: "user_id", // Name of the column in the target app DB user table
                entitlementIdentifierTargetAttribute: "group_id" // Name of the column for entitlement ID in the target table
            },
            metadata: {
                 description: "Provisioning connector for Finance App (Postgres)"
            }
            // id will be generated
        };

        // 1c. MappingConfig Entry (in Config DB) - IGLM Entitlement ID -> App-Specific Mapping
        // This mapping defines how an IGLM Entitlement translates into a provisioning action
        // using a specific SQL template and app-specific identifier.
        const postgresAppMapping = {
            name: "Finance App Provisioning Mappings", // More specific name
            sourceType: "Provisioning", // Source is the provisioning intent
            sourceId: null, // Will link to the Application ID later
            targetType: "ApplicationEntitlements", // Mapping is for app entitlements
            mappingRules: {
                // --- How to find the user identifier needed by SQL templates ---
                // Maps an IGLM User attribute (or nested attribute) to the identifier used as $1 in SQL
                userIdentifierMapping: {
                    sourceField: "email", // Use the 'email' attribute from the IGLM User model
                    targetFormat: "string" // The format needed by the target DB (usually just string)
                    // TODO: Add logic if email needs formatting for the target DB, or if a lookup is required
                    // lookup: { connectorName: "...", queryTemplate: "..." } // We will: lookup user_id in target app's users table
                },
                // --- Map IGLM Entitlement IDs to App-Specific Identifiers/Parameters for SQL ---
                // The keys here are the UUIDs of your IGLM Entitlement entries in the DB.
                // The values provide the app-specific ID/params needed by the SQL templates.
                entitlementMappings: {
                    // We will: Map IGLM Entitlement "Finance App User Group" (UUID: xxx) to Group ID 101 in app DB
                    "00000000-0000-0000-0000-000000000101": { // Replace with actual IGLM Entitlement UUID
                         appEntitlementId: 101, // The actual group ID in the Finance App DB (used as $2 in SQL)
                         sqlTemplateName: "grantGroup", // Which template to use from sqlTemplates in the connector config
                         revokeSqlTemplateName: "revokeGroup" // Optional: specific revoke template if different convention
                         // Add other parameters needed by the SQL template here
                         // extraParams: [{ sourceField: "...", targetParameterIndex: 3 }]
                    },
                    // We will: Map IGLM Entitlement "Finance App Admin Group" (UUID: yyy) to Group ID 102
                     "00000000-0000-0000-0000-000000000102": { // Replace with actual IGLM Entitlement UUID
                         appEntitlementId: 102,
                         sqlTemplateName: "grantGroup",
                         revokeSqlTemplateName: "revokeGroup"
                     },
                     // We will: Map IGLM Entitlement "Finance App License Basic" (UUID: zzz) to License Code 'BASIC'
                     "00000000-0000-0000-0000-000000000103": { // Replace with actual IGLM Entitlement UUID
                          appEntitlementId: 'BASIC', // The actual license code string in app DB
                          sqlTemplateName: "grantLicense", // Need a grantLicense template in connector config
                          revokeSqlTemplateName: "revokeLicense" // Need a revokeLicense template
                     }
                    // Add mappings for all entitlements relevant to this app
                },
                // Define default templates if entitlementMappings don't override
                 defaultGrantTemplateName: "grantGroup",
                 defaultRevokeTemplateName: "revokeGroup"
            },
            metadata: {
                 description: "Maps IGLM entitlements to Finance App (Postgres) provisioning actions."
            }
            // id will be generated
        };


        // --- Data for Oracle Target Application ---

        // 2a. Application Entry (in Core Data Model DB)
        const oracleApp = {
            name: "T24 Core Banking (Oracle DB)", // We will name
            description: "Core banking application running on Oracle DB",
            type: "core-banking", // We will type
            connectorId: null // Will link later
            // id will be generated
        };

        // 2b. ConnectorConfig Entry (in Config DB)
        const oracleAppConnector = {
            name: "T24 Provisioning (Oracle DB)",
            serviceType: "Provisioning",
            type: "app-db-oracle", // <-- Matches the app-db-oracle.js file name
            configuration: {
                dbType: "oracle",
                // Use specific env vars for T24 DB
                connection: {
                     user: process.env.T24_DB_USER || "t24_user",
                     password: process.env.T24_DB_PASSWORD || "secure_t24_pw",
                     connectString: process.env.T24_DB_CONNECT_STRING || "your_oracle_connect_string" // e.g., localhost:1521/servicename
                     // Add other node-oracledb connection options
                },
                // --- SQL Templates for Provisioning Actions (Oracle Syntax) ---
                sqlTemplates: {
                    // We will: Grant a T24 permission (assuming a permission table)
                    // Using :param binding for node-oracledb
                    grantPermission: "INSERT INTO T24_PERMISSIONS (user_id, permission_code) VALUES (:userId, :permissionCode)",
                    // We will: Add user to a T24 role/group table
                    grantRole: "INSERT INTO T24_USER_ROLES (user_id, role_id) VALUES (:userId, :roleId)",
                    // We will: Revoke a permission
                    revokePermission: "DELETE FROM T24_PERMISSIONS WHERE user_id = :userId AND permission_code = :permissionCode",
                     // We will: Create a user in T24's user table (more complex, likely needs sequence, multiple fields)
                     // createUser: "INSERT INTO T24_USERS (id, username, ...) VALUES (t24_users_seq.NEXTVAL, :username, ...)",
                },
                // Configuration for parameter mapping if needed
                 userIdentifierTargetAttribute: "user_id", // Name of the parameter/column for the user ID
                 entitlementIdentifierTargetAttribute: "permission_code" // We will default for entitlement ID
            },
            metadata: {
                 description: "Provisioning connector for T24 Core Banking (Oracle DB)"
            }
        };

        // 2c. MappingConfig Entry (in Config DB) - IGLM Entitlement ID -> App-Specific Mapping
        // This mapping defines how an IGLM Entitlement translates into a provisioning action
        // using a specific SQL template and app-specific identifier.
        const oracleAppMapping = {
            name: "T24 Provisioning Mappings", // More specific name
            sourceType: "Provisioning",
            sourceId: null, // Will link to the T24 Application ID later
            targetType: "ApplicationEntitlements",
            mappingRules: {
                // --- How to find the user identifier needed by SQL templates ---
                // Maps an IGLM User attribute to the identifier used as :userId in SQL
                userIdentifierMapping: {
                    sourceField: "hrmsId", // Use the 'hrmsId' attribute from IGLM User
                    targetFormat: "string" // Or other format if T24 uses a different type
                     // Add lookup logic here if needed
                },
                // --- Map IGLM Entitlement IDs to App-Specific SQL Parameters/Identifiers ---
                entitlementMappings: {
                    // We will: Map IGLM Entitlement "T24 View Account Permission" (UUID: xxx) to T24 permission 'VIEW.ACCOUNT'
                     "00000000-0000-0000-0000-000000000201": { // Replace with actual IGLM Entitlement UUID
                         appEntitlementId: 'VIEW.ACCOUNT', // The actual permission code in T24 (used as :permissionCode)
                         sqlTemplateName: "grantPermission", // Which template to use
                         revokeSqlTemplateName: "revokePermission"
                     },
                     // We will: Map IGLM Entitlement "T24 Finance Role" (UUID: yyy) to Role ID 5
                     "00000000-0000-0000-0000-000000000202": { // Replace with actual IGLM Entitlement UUID
                         appEntitlementId: 5, // The actual role ID in T24 DB (used as :roleId)
                         sqlTemplateName: "grantRole", // Need a grantRole template
                         revokeSqlTemplateName: "revokeRole" // Need a revokeRole template
                     }
                    // Add mappings for other T24 entitlements
                },
                // Define default templates if entitlementMappings don't override
                 defaultGrantTemplateName: "grantRole", // We will default
                 defaultRevokeTemplateName: "revokeRole" // We will default
            },
            metadata: {
                 description: "Maps IGLM entitlements to T24 (Oracle DB) provisioning actions."
            }
        };

        // --- Data for MySQL Target Application ---

        // 3a. Application Entry (in Core Data Model DB)
        const mysqlApp = {
            name: "Customer Portal (MySQL DB)", // We will name
            description: "Customer self-service portal on MySQL",
            type: "customer-portal", // We will type
            connectorId: null // Will link later
            // id will be generated
        };

        // 3b. ConnectorConfig Entry (in Config DB)
        const mysqlAppConnector = {
            name: "Customer Portal Provisioning (MySQL DB)",
            serviceType: "Provisioning",
            type: "app-db-mysql", // <-- Matches the app-db-mysql.js file name
            configuration: {
                dbType: "mysql",
                // Use specific env vars for MySQL DB, nested under connection
                connection: {
                     host: process.env.PORTAL_DB_HOST || "localhost",
                     port: process.env.PORTAL_DB_PORT ? parseInt(process.env.PORTAL_DB_PORT, 10) : 3306, // Default MySQL port, parse int
                     database: process.env.PORTAL_DB_NAME || "portal_db",
                     user: process.env.PORTAL_DB_USER || "portal_user",
                     password: process.env.PORTAL_DB_PASSWORD || "secure_portal_pw",
                     // Add other mysql2 options
                },
                // --- SQL Templates for Provisioning Actions (MySQL Syntax) ---
                sqlTemplates: {
                    // We will: Add user to a portal group
                    // Using ? binding for mysql2
                    grantGroup: "INSERT IGNORE INTO portal_user_groups (user_id, group_id) VALUES (?, ?)", // INSERT IGNORE for idempotency
                    // We will: Assign a feature flag
                    assignFeature: "INSERT IGNORE INTO portal_user_features (user_id, feature_code) VALUES (?, ?)",
                    // We will: Revoke a group membership
                    revokeGroup: "DELETE FROM portal_user_groups WHERE user_id = ? AND group_id = ?",
                     // We will: Revoke a feature flag
                    revokeFeature: "DELETE FROM portal_user_features WHERE user_id = ? AND feature_code = ?",
                },
                // Configuration for parameter mapping if needed
                 userIdentifierTargetAttribute: "user_id", // Name of the parameter/column for the user ID
                 entitlementIdentifierTargetAttribute: "group_id" // We will default for entitlement ID
            },
            metadata: {
                 description: "Provisioning connector for Customer Portal (MySQL DB)"
            }
        };

        // 3c. MappingConfig Entry (in Config DB) - IGLM Entitlement ID -> App-Specific Mapping
        // This mapping defines how an IGLM Entitlement translates into a provisioning action
        // using a specific SQL template and app-specific identifier.
        const mysqlAppMapping = {
            name: "Customer Portal Provisioning Mappings", // More specific name
            sourceType: "Provisioning",
            sourceId: null, // Will link to the Portal Application ID later
            targetType: "ApplicationEntitlements",
            mappingRules: {
                // --- How to find the user identifier needed by SQL templates ---
                // e.g., Map IGLM User's email to the username column in the portal DB
                userIdentifierMapping: {
                    sourceField: "email", // Use the 'email' attribute from IGLM User
                    targetFormat: "string"
                    // TODO: Add formatting rules if username is derived from email, or lookup
                },
                // --- Map IGLM Entitlement IDs to App-Specific SQL Parameters/Identifiers ---
                entitlementMappings: {
                    // We will: Map IGLM Entitlement "Portal Premium Access" (UUID: xxx) to Group ID 5
                     "00000000-0000-0000-0000-000000000301": { // Replace with actual IGLM Entitlement UUID
                         appEntitlementId: 5, // The actual group ID in the Portal DB (used as ?)
                         sqlTemplateName: "grantGroup",
                         revokeSqlTemplateName: "revokeGroup"
                     },
                     // We will: Map IGLM Entitlement "Portal Feature X" (UUID: yyy) to Feature Code 'FEATURE_X'
                     "00000000-0000-0000-0000-000000000302": { // Replace with actual IGLM Entitlement UUID
                          appEntitlementId: 'FEATURE_X', // The actual feature code string
                          sqlTemplateName: "assignFeature",
                          revokeSqlTemplateName: "revokeFeature"
                     }
                    // Add mappings for other Portal entitlements
                },
                // Define default templates if entitlementMappings don't override
                defaultGrantTemplateName: "grantGroup",
                defaultRevokeTemplateName: "revokeGroup"
            },
            metadata: {
                 description: "Maps IGLM entitlements to Customer Portal (MySQL DB) provisioning actions."
            }
        };

        // --- Define Configuration Data for Active Directory / LDAP ---

        // 4a. Application Entry (in Core Data Model DB) - Optional, AD/LDAP can be a ServiceTarget too
        // If you want to track AD/LDAP as a target application in your IGLM model:
        const adApp = {
             name: "Active Directory / LDAP",
             description: "Enterprise user directory",
             type: "directory",
             connectorId: null // Will link later
             // id will be generated
        };


        // 4b. ConnectorConfig Entry (in Config DB)
        // This is the configuration for the ad-ldap.js provisioning adapter
        const adLdapConnector = {
             name: "Active Directory / LDAP Provisioning",
             serviceType: "Provisioning",
             type: "ad-ldap", // <-- Matches the ad-ldap.js file name
             configuration: {
                 connection: { // LDAP connection details
                     url: process.env.LDAP_URL || "ldap://localhost:389",
                     bindDn: process.env.LDAP_BIND_DN || "cn=amduser,dc=katangatest,dc=com",
                     bindPassword: process.env.LDAP_BIND_PASSWORD || "A123456@amd",
                     // Add other ldapjs client options here (e.g., connectTimeout, requestTimeout, tlsOptions)
                     connectTimeout: 5000,
                     requestTimeout: 10000
                 },
                 userMapping: { // How to determine the user's DN for LDAP operations
                     // Option 1: Use a template
                     userDnTemplate: process.env.LDAP_USER_DN_TEMPLATE || "cn=:userIdInApp,ou=Users,dc=katangatest,dc=com",
                     // Option 2: Assume userIdInApp is the full DN
                     // userIdInAppIsDn: true
                 },
                  // Add other LDAP specific configuration like default member attribute
                  // groupMemberAttribute: "member" // 'member' is common, 'memberOf' is operational/reverse
             },
             metadata: {
                 description: "Provisioning connector for Active Directory / LDAP"
             }
        };

        // 4c. MappingConfig Entry (in Config DB) - IGLM Entitlement ID -> AD/LDAP Specific Mapping
        // This mapping defines how an IGLM Entitlement translates into an AD/LDAP action
        // (e.g., adding/removing a user from a group).
        const adLdapMapping = {
             name: "AD/LDAP Provisioning Mappings", // More specific name
             sourceType: "Provisioning",
             sourceId: null, // Will link to the AD/LDAP Application ID (if created) or be generic
             targetType: "ApplicationEntitlements", // Mapping is for app entitlements (groups are entitlements)
             mappingRules: {
                 // --- How to find the user identifier needed for LDAP operations (the user's DN) ---
                 // The ad-ldap connector handles constructing the User DN using its own userMapping config.
                 // This mapping primarily maps entitlements.
                 // However, you might need a source field from the IGLM User to find the user in AD/LDAP
                 // if the connector needs something other than the default IGLM User ID.
                 // We will: Map IGLM User's hrmsId to the sAMAccountName attribute in AD (if needed for lookup before modify)
                 // userIdentifierMapping: { sourceField: "hrmsId", targetAttribute: "sAMAccountName" }
                 // For modify operations on groups, the connector uses the user's *calculated DN*.

                 // --- Map IGLM Entitlement IDs to App-Specific Identifiers/Parameters for LDAP ---
                 // The keys here are the UUIDs of your IGLM Entitlement entries.
                 // The values provide the app-specific ID/params needed by the LDAP operations (e.g., Group DN).
                 entitlementMappings: {
                     // We will: Map IGLM Entitlement "AD Sales Group" (UUID: xxx) to the DN of the Sales group
                     "00000000-0000-0000-0000-000000000401": { // Replace with actual IGLM Entitlement UUID
                          appEntitlementId: "cn=SalesGroup,ou=Groups,dc=We will,dc=com", // The actual Group DN in AD/LDAP
                          operationType: "groupMembership" // Indicates this maps to a group membership operation
                          // Add other parameters if needed for complex LDAP ops
                     },
                     // We will: Map IGLM Entitlement "AD VPN Users" (UUID: yyy) to the DN of the VPN Users group
                     "00000000-0000-0000-0000-000000000402": { // Replace with actual IGLM Entitlement UUID
                          appEntitlementId: "cn=VPNUsers,ou=Groups,dc=We will,dc=com",
                          operationType: "groupMembership"
                     }
                     // Add mappings for all relevant AD/LDAP groups/entitlements
                 },
                 // Define default operation type if entitlementMappings don't override
                 defaultOperationType: "groupMembership" // Assumes entitlements map to group memberships by default
             },
             metadata: {
                 description: "Maps IGLM entitlements to AD/LDAP group membership actions."
             }
        };


        // --- Insert or Find Configurations ---
        console.log(`[${serviceName}] Inserting/finding configurations...`);

        // HRMS Connector Config (Existing insert logic)
        const [hrmsConnector, createdHrmsConnector] = await ConnectorConfig.findOrCreate({
             where: { name: hrmsConnectorData.name, serviceType: hrmsConnectorData.serviceType },
             defaults: hrmsConnectorData
        });
        if (createdHrmsConnector) console.log(`[${serviceName}] Created HRMS Connector Config: ${hrmsConnector.name}`);
        else console.log(`[${serviceName}] Found existing HRMS Connector Config: ${hrmsConnector.name}`);

        

        // User Mapping Config (Existing insert logic)
        const [userMapping, createdUserMapping] = await MappingConfig.findOrCreate({
             where: { name: userMappingData.name, sourceType: userMappingData.sourceType, targetType: userMappingData.targetType },
             defaults: userMappingData
        });
         if (createdUserMapping) console.log(`[${serviceName}] Created User Mapping Config: ${userMapping.name}`);
         else console.log(`[${serviceName}] Found existing User Mapping Config: ${userMapping.name}`);

        // ICS Service Config (Existing insert logic)
        const [icsServiceConfig, createdIcsServiceConfig] = await MappingConfig.findOrCreate({
             where: { name: icsServiceConfigData.name, serviceName: icsServiceConfigData.serviceName }, // serviceName is key for service configs
             defaults: icsServiceConfigData
        });
         if (createdIcsServiceConfig) console.log(`[${serviceName}] Created ICS Service Config: ${icsServiceConfig.name}`);
         else console.log(`[${serviceName}] Found existing ICS Service Config: ${icsServiceConfig.name}`);



        // Default Attribute ➔ Role Mapping  (★ new ★)
        const [defaultAttrRoleMapping, createdDefaultAttrRoleMapping] =
            await MappingConfig.findOrCreate({
                where: {
                    name:         defaultAttrRoleMappingData.name,
                    sourceType:   defaultAttrRoleMappingData.sourceType,
                    targetType:   defaultAttrRoleMappingData.targetType
                },
                defaults: defaultAttrRoleMappingData
            });

        if (createdDefaultAttrRoleMapping)
        console.log(`[${serviceName}] Created Attribute-Role Mapping: ${defaultAttrRoleMapping.name}`);
        else
        console.log(`[${serviceName}] Found existing Attribute-Role Mapping: ${defaultAttrRoleMapping.name}`);

        // --- Insert Logic for Joiner, Mover, Leaver Service Configs ---

        // Joiner Service Config
        const [joinerServiceConfig, createdJoinerServiceConfig] = await MappingConfig.findOrCreate({
             where: { name: joinerServiceConfigData.name, serviceName: joinerServiceConfigData.serviceName }, // serviceName is key for service configs
             defaults: joinerServiceConfigData
         });
          if (createdJoinerServiceConfig) console.log(`[${serviceName}] Created Joiner Service Config: ${joinerServiceConfig.name}`);
          else console.log(`[${serviceName}] Found existing Joiner Service Config: ${joinerServiceConfig.name}`);

         // Mover Service Config
         const [moverServiceConfig, createdMoverServiceConfig] = await MappingConfig.findOrCreate({
              where: { name: moverServiceConfigData.name, serviceName: moverServiceConfigData.serviceName }, // serviceName is key for service configs
              defaults: moverServiceConfigData
          });
           if (createdMoverServiceConfig) console.log(`[${serviceName}] Created Mover Service Config: ${moverServiceConfig.name}`);
           else console.log(`[${serviceName}] Found existing Mover Service Config: ${moverServiceConfig.name}`);

         // Leaver Service Config
         const [leaverServiceConfig, createdLeaverServiceConfig] = await MappingConfig.findOrCreate({
              where: { name: leaverServiceConfigData.name, serviceName: leaverServiceConfigData.serviceName }, // serviceName is key for service configs
              defaults: leaverServiceConfigData
          });
            if (createdLeaverServiceConfig) console.log(`[${serviceName}] Created Leaver Service Config: ${leaverServiceConfig.name}`);
            else console.log(`[${serviceName}] Found existing Leaver Service Config: ${leaverServiceConfig.name}`);


        // --- Insert Logic for Target Applications (Postgres, Oracle, MySQL, AD/LDAP) ---

        // Postgres App
        const [postgresAppEntry, createdPostgresApp] = await Application.findOrCreate({
             where: { name: postgresApp.name },
             defaults: postgresApp
        });
        if (createdPostgresApp) console.log(`[${serviceName}] Created Application: ${postgresAppEntry.name}`);
        else console.log(`[${serviceName}] Found existing Application: ${postgresAppEntry.name}`);

        const [postgresAppConnectorEntry, createdPostgresAppConnector] = await ConnectorConfig.findOrCreate({
             where: { name: postgresAppConnector.name, serviceType: postgresAppConnector.serviceType, type: postgresAppConnector.type }, // Add type for uniqueness
             defaults: postgresAppConnector
        });
        if (createdPostgresAppConnector) console.log(`[${serviceName}] Created Connector Config: ${postgresAppConnectorEntry.name}`);
        else console.log(`[${serviceName}] Found existing Connector Config: ${postgresAppConnectorEntry.name}`);

        const [postgresAppMappingEntry, createdPostgresAppMapping] = await MappingConfig.findOrCreate({
             where: { name: postgresAppMapping.name, sourceType: postgresAppMapping.sourceType, targetType: postgresAppMapping.targetType },
             defaults: postgresAppMapping
        });
        if (createdPostgresAppMapping) console.log(`[${serviceName}] Created Mapping Config: ${postgresAppMappingEntry.name}`);
        else console.log(`[${serviceName}] Found existing Mapping Config: ${postgresAppMappingEntry.name}`);

        // --- Link the IDs for Postgres App ---
        if (postgresAppEntry.connectorId !== postgresAppConnectorEntry.id) {
             await postgresAppEntry.update({ connectorId: postgresAppConnectorEntry.id });
             console.log(`[${serviceName}] Linked Application ${postgresAppEntry.name} to Connector ${postgresAppConnectorEntry.name}.`);
        }
         // Note: For Provisioning mappings, the source is the provisioning process/intent,
         // which is tied to the Application being provisioned to.
        if (postgresAppMappingEntry.sourceId !== postgresAppEntry.id) {
             await postgresAppMappingEntry.update({ sourceId: postgresAppEntry.id });
             console.log(`[${serviceName}] Linked Mapping Config ${postgresAppMappingEntry.name} to Application ${postgresAppEntry.name}.`);
        }


        // Oracle App
        const [oracleAppEntry, createdOracleApp] = await Application.findOrCreate({
             where: { name: oracleApp.name },
             defaults: oracleApp
        });
        if (createdOracleApp) console.log(`[${serviceName}] Created Application: ${oracleAppEntry.name}`);
        else console.log(`[${serviceName}] Found existing Application: ${oracleAppEntry.name}`);

        const [oracleAppConnectorEntry, createdOracleAppConnector] = await ConnectorConfig.findOrCreate({
             where: { name: oracleAppConnector.name, serviceType: oracleAppConnector.serviceType, type: oracleAppConnector.type },
             defaults: oracleAppConnector
        });
        if (createdOracleAppConnector) console.log(`[${serviceName}] Created Connector Config: ${oracleAppConnectorEntry.name}`);
        else console.log(`[${serviceName}] Found existing Connector Config: ${oracleAppConnectorEntry.name}`);

        const [oracleAppMappingEntry, createdOracleAppMapping] = await MappingConfig.findOrCreate({
             where: { name: oracleAppMapping.name, sourceType: oracleAppMapping.sourceType, targetType: oracleAppMapping.targetType },
             defaults: oracleAppMapping
        });
        if (createdOracleAppMapping) console.log(`[${serviceName}] Created Mapping Config: ${oracleAppMappingEntry.name}`);
        else console.log(`[${serviceName}] Found existing Mapping Config: ${oracleAppMappingEntry.name}`);

        // --- Link the IDs for Oracle App ---
        if (oracleAppEntry.connectorId !== oracleAppConnectorEntry.id) {
             await oracleAppEntry.update({ connectorId: oracleAppConnectorEntry.id });
             console.log(`[${serviceName}] Linked Application ${oracleAppEntry.name} to Connector ${oracleAppConnectorEntry.name}.`);
        }
        if (oracleAppMappingEntry.sourceId !== oracleAppEntry.id) {
             await oracleAppMappingEntry.update({ sourceId: oracleAppEntry.id });
             console.log(`[${serviceName}] Linked Mapping Config ${oracleAppMappingEntry.name} to Application ${oracleAppEntry.name}.`);
        }


        // MySQL App
        const [mysqlAppEntry, createdMysqlApp] = await Application.findOrCreate({
             where: { name: mysqlApp.name },
             defaults: mysqlApp
        });
        if (createdMysqlApp) console.log(`[${serviceName}] Created Application: ${mysqlAppEntry.name}`);
        else console.log(`[${serviceName}] Found existing Application: ${mysqlAppEntry.name}`);

        const [mysqlAppConnectorEntry, createdMysqlAppConnector] = await ConnectorConfig.findOrCreate({
             where: { name: mysqlAppConnector.name, serviceType: mysqlAppConnector.serviceType, type: mysqlAppConnector.type },
             defaults: mysqlAppConnector
        });
        if (createdMysqlAppConnector) console.log(`[${serviceName}] Created Connector Config: ${mysqlAppConnectorEntry.name}`);
        else console.log(`[${serviceName}] Found existing Connector Config: ${mysqlAppConnectorEntry.name}`);

        const [mysqlAppMappingEntry, createdMysqlAppMapping] = await MappingConfig.findOrCreate({
             where: { name: mysqlAppMapping.name, sourceType: mysqlAppMapping.sourceType, targetType: mysqlAppMapping.targetType },
             defaults: mysqlAppMapping
        });
        if (createdMysqlAppMapping) console.log(`[${serviceName}] Created Mapping Config: ${mysqlAppMappingEntry.name}`);
        else console.log(`[${serviceName}] Found existing Mapping Config: ${mysqlAppMappingEntry.name}`);

        // --- Link the IDs for MySQL App ---
        if (mysqlAppEntry.connectorId !== mysqlAppConnectorEntry.id) {
             await mysqlAppEntry.update({ connectorId: mysqlAppConnectorEntry.id });
             console.log(`[${serviceName}] Linked Application ${mysqlAppEntry.name} to Connector ${mysqlAppConnectorEntry.name}.`);
        }
        if (mysqlAppMappingEntry.sourceId !== mysqlAppEntry.id) {
             await mysqlAppMappingEntry.update({ sourceId: mysqlAppEntry.id });
             console.log(`[${serviceName}] Linked Mapping Config ${mysqlAppMappingEntry.name} to Application ${mysqlAppEntry.name}.`);
        }

        // AD/LDAP (Optional Application Entry)
        const [adAppEntry, createdAdApp] = await Application.findOrCreate({
            where: { name: adApp.name },
            defaults: adApp
       });
       if (createdAdApp) console.log(`[${serviceName}] Created Application: ${adAppEntry.name}`);
       else console.log(`[${serviceName}] Found existing Application: ${adAppEntry.name}`);


        const [adLdapConnectorEntry, createdAdLdapConnector] = await ConnectorConfig.findOrCreate({
             where: { name: adLdapConnector.name, serviceType: adLdapConnector.serviceType, type: adLdapConnector.type },
             defaults: adLdapConnector
        });
        if (createdAdLdapConnector) console.log(`[${serviceName}] Created Connector Config: ${adLdapConnectorEntry.name}`);
        else console.log(`[${serviceName}] Found existing Connector Config: ${adLdapConnectorEntry.name}`);

        const [adLdapMappingEntry, createdAdLdapMapping] = await MappingConfig.findOrCreate({
             where: { name: adLdapMapping.name, sourceType: adLdapMapping.sourceType, targetType: adLdapMapping.targetType },
             defaults: adLdapMapping
        });
        if (createdAdLdapMapping) console.log(`[${serviceName}] Created Mapping Config: ${adLdapMappingEntry.name}`);
        else console.log(`[${serviceName}] Found existing Mapping Config: ${adLdapMappingEntry.name}`);

        // --- Link the IDs for AD/LDAP ---
        // Link the AD Application to its connector
        if (adAppEntry.connectorId !== adLdapConnectorEntry.id) {
            await adAppEntry.update({ connectorId: adLdapConnectorEntry.id });
            console.log(`[${serviceName}] Linked Application ${adAppEntry.name} to Connector ${adLdapConnectorEntry.name}.`);
        }
        // Link the AD/LDAP Mapping Config to the AD Application
         if (adLdapMappingEntry.sourceId !== adAppEntry.id) {
            await adLdapMappingEntry.update({ sourceId: adAppEntry.id });
            console.log(`[${serviceName}] Linked Mapping Config ${adLdapMappingEntry.name} to Application ${adAppEntry.name}.`);
         }

        // TODO: Add creation/linking logic for IGLM Entitlement entries here if needed.
        // These UUIDs ("000...") in the entitlementMappings need corresponding
        // Entitlement entries in the Core Data Model DB (via the Config DB).

        console.log(`[${serviceName}] Configuration setup script finished successfully.`);

    } catch (error) {
        console.error(`[${serviceName}] Error running configuration setup script:`, error);
        // Don't re-throw, let the finally block run
    } finally {
        // Ensure the database connection is closed
        if (ConfigService.sequelize) {
             console.log(`[${serviceName}] Attempting to close Config DB connection...`);
             await ConfigService.sequelize.close().then(() => {
                console.log(`[${serviceName}] Config DB connection closed.`);
             }).catch(err => console.error(`[${serviceName}] Error closing Config DB connection:`, err));
        } else {
            console.log(`[${serviceName}] ConfigService.sequelize was not initialized.`);
        }
         // Also ensure other potential connections from models init are closed if necessary
         if (models.sequelize) {
             console.log(`[${serviceName}] Attempting to close Core DB connection...`);
             await models.sequelize.close().then(() => {
                 console.log(`[${serviceName}] Core DB connection closed.`);
             }).catch(err => console.error(`[${serviceName}] Error closing Core DB connection:`, err));
         } else {
             console.log(`[${serviceName}] models.sequelize was not initialized.`);
         }

    }
}

// Execute the setup function
runSetup();