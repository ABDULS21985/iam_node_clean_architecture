// scripts/setupConfigs.js

require('dotenv').config(); // load .env
const ConfigService = require('../shared/configService');
const models = require('../shared/models');
const { ConnectorConfig, MappingConfig, Application } = models;

const serviceName = 'setup-script';
function logInfo(msg)   { process.stdout.write(`[${serviceName}] ${msg}\n`); }
function logWarn(msg)   { process.stderr.write(`[${serviceName}] WARNING: ${msg}\n`); }
function logError(msg, err) {
  process.stderr.write(`[${serviceName}] ERROR: ${msg}\n`);
  if (err) process.stderr.write(err.stack + '\n');
}

// Deep-merge helper (for mappingRules updates)
function deepMerge(target = {}, source = {}) {
  for (const key of Object.keys(source)) {
    const sv = source[key], tv = target[key];
    if (sv instanceof Date) {
      target[key] = new Date(sv);
    } else if (Array.isArray(sv)) {
      target[key] = sv;
    } else if (sv && typeof sv === 'object' && tv && typeof tv === 'object') {
      target[key] = deepMerge(tv, sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

/** 1) Define all Connector configs (IdentityCollection, Provisioning, Discovery) **/
const connectorDefs = [
  // HRMS source
  {
    name: "Postgres HRMS Identity Source",
    serviceType: "IdentityCollection",
    type: "hrms-db-postgres",
    configuration: {
      dbType: "postgres",
      connection: {
        host: process.env.HRMS_DB_HOST || "localhost",
        port: +(process.env.HRMS_DB_PORT || 5432),
        database: process.env.HRMS_DB_NAME || "erp",
        user: process.env.HRMS_DB_USER || "postgres",
        password: process.env.HRMS_DB_PASSWORD || "Secured3211"
      },
      query: `SELECT DISTINCT person_id, employee_id, first_name, middle_name, last_name,
        date_of_hire, job_title, supervisor_id, head_of_office_id, job_location_id,
        job_location, mobile_number, department_id, department_name, division_id,
        division_name, office_id, office_name, grade_id, grade, party_id,
        termination_date, job_status
      FROM apps.xxcbn_iam_employees_v
      WHERE (termination_date IS NULL OR termination_date >= CURRENT_DATE)
        AND department_id <> '1129'`,
      uniqueIdentifierAttribute: "employee_id"
    },
    metadata: { description: "Collect Employee Identities from Postgres View" }
  },

  // Finance App (Postgres) Provisioning & Discovery
  {
    name: "Finance App Provisioning (Postgres DB)",
    serviceType: "Provisioning",
    type: "app-db-postgres",
    configuration: {
      dbType: "postgres",
      connection: {
        host: process.env.FINANCE_APP_DB_HOST || "localhost",
        port: +(process.env.FINANCE_APP_DB_PORT || 5433),
        database: process.env.FINANCE_APP_DB_NAME || "finance_db",
        user: process.env.FINANCE_APP_DB_USER || "finance_user",
        password: process.env.FINANCE_APP_DB_PASSWORD || "secure_finance_pw"
      },
      sqlTemplates: {
        grantGroup: `INSERT INTO app_users_groups (user_id, group_id)
          VALUES ($1,$2) ON CONFLICT DO NOTHING;`,
        revokeGroup: `DELETE FROM app_users_groups WHERE user_id=$1 AND group_id=$2;`,
        grantLicense: `INSERT INTO app_user_licenses (user_id,license_code)
          VALUES ($1,$2) ON CONFLICT DO NOTHING;`,
        revokeLicense: `DELETE FROM app_user_licenses WHERE user_id=$1 AND license_code=$2;`
      },
      userIdentifierTargetAttribute: "user_id",
      entitlementIdentifierTargetAttribute: "group_id"
    },
    metadata: { description: "Provisioning connector for Finance App (Postgres)" }
  },
  {
    name: "Finance App Discovery (Postgres DB)",
    serviceType: "Discovery",
    type: "app-db-postgres",
    configuration: {
      dbType: "postgres",
      connection: {
        host: process.env.FINANCE_APP_DB_HOST || "localhost",
        port: +(process.env.FINANCE_APP_DB_PORT || 5433),
        database: process.env.FINANCE_APP_DB_NAME || "finance_db",
        user: process.env.FINANCE_APP_DB_USER || "finance_user",
        password: process.env.FINANCE_APP_DB_PASSWORD || "secure_finance_pw"
      },
      discovery: {
        query: `
          SELECT user_id, group_id AS entitlement_id, NULL AS license_code, 'Group' AS entitlement_type
          FROM app_users_groups
          UNION ALL
          SELECT user_id, NULL AS group_id, license_code, 'License' AS entitlement_type
          FROM app_user_licenses
        `,
        incrementalQuery: null,
        timestampFieldForIncremental: null
      },
      userIdentifierTargetAttribute: "user_id",
      entitlementIdentifierTargetAttribute: "entitlement_id"
    },
    metadata: { description: "Discovery connector for Finance App (Postgres)" }
  },

  // T24 / Oracle Provisioning & Discovery
  {
    name: "T24 Provisioning (Oracle DB)",
    serviceType: "Provisioning",
    type: "app-db-oracle",
    configuration: {
      connection: {
        user: process.env.T24_DB_USER || "t24_user",
        password: process.env.T24_DB_PASSWORD || "secure_t24_pw",
        connectString: process.env.T24_DB_CONNECT_STRING || "your_oracle_connect_string"
      },
      sqlTemplates: {
        grantPermission: `INSERT INTO T24_PERMISSIONS (user_id,permission_code)
          VALUES (:userId,:permissionCode)`,
        revokePermission: `DELETE FROM T24_PERMISSIONS
          WHERE user_id=:userId AND permission_code=:permissionCode`,
        grantRole: `INSERT INTO T24_USER_ROLES (user_id,role_id)
          VALUES (:userId,:roleId)`,
        revokeRole: `DELETE FROM T24_USER_ROLES
          WHERE user_id=:userId AND role_id=:roleId`
      },
      userIdentifierTargetAttribute: "user_id",
      entitlementIdentifierTargetAttribute: "permission_code"
    },
    metadata: { description: "Provisioning connector for T24 Core Banking (Oracle DB)" }
  },
  {
    name: "T24 Discovery (Oracle DB)",
    serviceType: "Discovery",
    type: "app-db-oracle",
    configuration: {
      connection: {
        user: process.env.T24_DB_USER || "t24_user",
        password: process.env.T24_DB_PASSWORD || "secure_t24_pw",
        connectString: process.env.T24_DB_CONNECT_STRING || "your_oracle_connect_string"
      },
      discovery: {
        query: `
          SELECT user_id, permission_code AS entitlement_id, NULL AS role_id FROM T24_PERMISSIONS
          UNION ALL
          SELECT user_id, NULL AS permission_code, role_id FROM T24_USER_ROLES
        `,
        incrementalQuery: null,
        timestampFieldForIncremental: null
      },
      userIdentifierTargetAttribute: "user_id",
      entitlementIdentifierTargetAttribute: "entitlement_id"
    },
    metadata: { description: "Discovery connector for T24 Core Banking (Oracle DB)" }
  },

  // Customer Portal (MySQL) Provisioning & Discovery
  {
    name: "Customer Portal Provisioning (MySQL DB)",
    serviceType: "Provisioning",
    type: "app-db-mysql",
    configuration: {
      connection: {
        host: process.env.PORTAL_DB_HOST || "localhost",
        port: +(process.env.PORTAL_DB_PORT || 3306),
        database: process.env.PORTAL_DB_NAME || "portal_db",
        user: process.env.PORTAL_DB_USER || "portal_user",
        password: process.env.PORTAL_DB_PASSWORD || "secure_portal_pw"
      },
      sqlTemplates: {
        grantGroup: `INSERT IGNORE INTO portal_user_groups (user_id,group_id) VALUES (?,?)`,
        assignFeature: `INSERT IGNORE INTO portal_user_features (user_id,feature_code) VALUES (?,?)`,
        revokeGroup: `DELETE FROM portal_user_groups WHERE user_id=? AND group_id=?`,
        revokeFeature: `DELETE FROM portal_user_features WHERE user_id=? AND feature_code=?`
      },
      userIdentifierTargetAttribute: "user_id",
      entitlementIdentifierTargetAttribute: "group_id"
    },
    metadata: { description: "Provisioning connector for Customer Portal (MySQL DB)" }
  },
  {
    name: "Customer Portal Discovery (MySQL DB)",
    serviceType: "Discovery",
    type: "app-db-mysql",
    configuration: {
      connection: {
        host: process.env.PORTAL_DB_HOST || "localhost",
        port: +(process.env.PORTAL_DB_PORT || 3306),
        database: process.env.PORTAL_DB_NAME || "portal_db",
        user: process.env.PORTAL_DB_USER || "portal_user",
        password: process.env.PORTAL_DB_PASSWORD || "secure_portal_pw"
      },
      discovery: {
        query: `
          SELECT user_id, group_id AS entitlement_id, NULL AS feature_code FROM portal_user_groups
          UNION ALL
          SELECT user_id, NULL AS group_id, feature_code AS entitlement_id FROM portal_user_features
        `,
        incrementalQuery: null,
        timestampFieldForIncremental: null
      },
      userIdentifierTargetAttribute: "user_id",
      entitlementIdentifierTargetAttribute: "entitlement_id"
    },
    metadata: { description: "Discovery connector for Customer Portal (MySQL DB)" }
  },

  // Active Directory / LDAP Provisioning & Discovery
  {
    name: "Active Directory / LDAP Provisioning",
    serviceType: "Provisioning",
    type: "ad-ldap",
    configuration: {
      connection: {
        url: process.env.LDAP_URL || "ldap://localhost:389",
        bindDn: process.env.LDAP_BIND_DN || "cn=BindUser,dc=example,dc=com",
        bindPassword: process.env.LDAP_BIND_PASSWORD || "yoursecurepassword"
      },
      userMapping: {
        userDnTemplate: process.env.LDAP_USER_DN_TEMPLATE ||
          "cn=:userIdInApp,ou=Users,dc=example,dc=com"
      },
      groupMemberAttribute: "member"
    },
    metadata: { description: "Provisioning connector for Active Directory / LDAP" }
  },
  {
    name: "Active Directory / LDAP Discovery",
    serviceType: "Discovery",
    type: "ad-ldap",
    configuration: {
      connection: {
        url: process.env.LDAP_URL || "ldap://localhost:389",
        bindDn: process.env.LDAP_BIND_DN || "cn=BindUser,dc=example,dc=com",
        bindPassword: process.env.LDAP_BIND_PASSWORD || "yoursecurepassword"
      },
      search: {
        userSearchBase: process.env.LDAP_USER_BASE || "ou=Users,dc=example,dc=com",
        userSearchFilter: "(objectClass=user)",
        userSearchAttributes: ["dn","sAMAccountName","userPrincipalName","memberOf"]
      },
      groupSearch: {
        base: process.env.LDAP_GROUP_BASE || "ou=Groups,dc=example,dc=com",
        filter: "(objectClass=group)",
        attributes: ["dn","cn","member"]
      }
    },
    metadata: { description: "Discovery connector for Active Directory / LDAP" }
  },

  // Generic REST-API Provisioning & Discovery
  {
    name: "Example REST App Provisioning",
    serviceType: "Provisioning",
    type: "generic-rest-api",
    configuration: {
      api: {
        baseUrl: process.env.REST_APP_BASE_URL || "https://api.example.com/v1",
        authentication: { type: "apiKey", header: "X-API-Key", value: process.env.REST_APP_API_KEY || "apikey" },
        endpoints: {
          grantEntitlement: {
            method: "POST",
            path: "/users/:userIdInApp/entitlements",
            body: { entitlementId: ":appEntitlementId", type: ":mappingDetails.operationType" }
          },
          revokeEntitlement: {
            method: "DELETE",
            path: "/users/:userIdInApp/entitlements/:appEntitlementId"
          }
        }
      }
    },
    metadata: { description: "Provisioning connector for Example REST App" }
  },
  {
    name: "Example REST App Discovery",
    serviceType: "Discovery",
    type: "generic-rest-api",
    configuration: {
      api: {
        baseUrl: process.env.REST_APP_BASE_URL || "https://api.example.com/v1",
        authentication: { type: "apiKey", header: "X-API-Key", value: process.env.REST_APP_API_KEY || "apikey" },
        endpoints: { discoverAccess: { method: "GET", path: "/access-report", params: { format: "json" } } }
      }
    },
    metadata: { description: "Discovery connector for Example REST App" }
  },

  // Generic SOAP Provisioning & Discovery
  {
    name: "Example SOAP App Provisioning",
    serviceType: "Provisioning",
    type: "generic-soap",
    configuration: {
      soap: {
        wsdlUrl: process.env.SOAP_APP_WSDL || "http://your-soap-service.com/service?wsdl",
        endpoint: process.env.SOAP_APP_ENDPOINT || "http://your-soap-service.com/service",
        auth: { type: "basic", username: process.env.SOAP_APP_USER || "soapuser", password: process.env.SOAP_APP_PASSWORD || "soappassword" },
        operationTemplates: {
          grant: {
            default: {
              soapOperationName: "AssignAccess",
              messageTemplate: { AssignAccessRequest: { UserId: ":userIdInApp", ItemId: ":appEntitlementId" } },
              successCriteria: { responsePath: "AssignAccessResponse.Status", expectedValue: "OK" }
            }
          },
          revoke: {
            default: {
              soapOperationName: "RemoveAccess",
              messageTemplate: { RemoveAccessRequest: { UserId: ":userIdInApp", ItemId: ":appEntitlementId" } },
              successCriteria: { responsePath: "RemoveAccessResponse.Status", expectedValue: "OK" }
            }
          }
        }
      }
    },
    metadata: { description: "Provisioning connector for Example SOAP App" }
  },
  {
    name: "Example SOAP App Discovery",
    serviceType: "Discovery",
    type: "generic-soap",
    configuration: {
      soap: {
        wsdlUrl: process.env.SOAP_APP_WSDL || "http://your-soap-service.com/service?wsdl",
        endpoint: process.env.SOAP_APP_ENDPOINT || "http://your-soap-service.com/service",
        auth: { type: "basic", username: process.env.SOAP_APP_USER || "soapuser", password: process.env.SOAP_APP_PASSWORD || "soappassword" },
        discoveryOperations: {
          listUserAccess: {
            soapOperationName: "ListAllUserAccess",
            messageTemplate: { ListAllUserAccessRequest: {} },
            resultMapping: {
              recordsPath: "ListAllUserAccessResponse.AccessList.AccessItem",
              recordMapping: {
                userIdentifier: "UserId",
                entitlementIdentifier: "ItemId",
                attributes: { status: "StatusFlag" }
              }
            }
          }
        }
      }
    },
    metadata: { description: "Discovery connector for Example SOAP App" }
  },

  // Generic CMD-Exec Provisioning & Discovery
  {
    name: "Example CMD App Provisioning",
    serviceType: "Provisioning",
    type: "cmd-exec",
    configuration: {
      execution: { type: "local", cwd: "/opt/myapp/scripts" },
      commandTemplates: {
        grant:   { default: { template: "/opt/myapp/scripts/grant-access.sh --user :userIdInApp --item :appEntitlementId" } },
        revoke:  { default: { template: "/opt/myapp/scripts/revoke-access.sh --user :userIdInApp --item :appEntitlementId" } }
      },
      successExitCodes: { grant: [0,1], revoke: [0] }
    },
    metadata: { description: "Provisioning connector for Example CMD App" }
  },
  {
    name: "Example CMD App Discovery",
    serviceType: "Discovery",
    type: "cmd-exec",
    configuration: {
      execution: { type: "local", cwd: "/opt/myapp/reports" },
      discoveryCommands: { dumpAllAccess: { template: "/opt/myapp/reports/dump-access.sh --format csv" } },
      commandOutputMapping: { parser: "csv", columns: ["user_id","entitlement_id","status"] }
    },
    metadata: { description: "Discovery connector for Example CMD App" }
  }
];

/** 2) Define all Mapping configs (including “service” configs + attribute→role + provisioning & discovery mappings) **/
const mappingDefs = [
  // HRMS→User mapping
  {
    name: "Postgres HRMS to IGLM User Mapping",
    sourceType: "IdentitySource",
    targetType: "User",
    sourceId: null,
    mappingRules: {
      attributeMappings: {
        firstName: "first_name", lastName: "last_name", email: "email",
        hrmsId: "employee_id", status: "job_status", hireDate: "date_of_hire",
        exitDate: "termination_date", department: "department_name", title: "job_title",
        location: "job_location", mobileNumber: "mobile_number"
      },
      statusMapping: {
        Active: "active", "On Leave": "active",
        Terminated: "exited", "Pending Hire": "pending_joiner", Inactive: "inactive"
      },
      metadataMapping: {
        personId: "person_id", middleName: "middle_name",
        supervisorHrmsId: "supervisor_id", headOfOfficeHrmsId: "head_of_office_id",
        jobLocationId: "job_location_id", departmentId: "department_id",
        divisionId: "division_id", divisionName: "division_name",
        officeId: "office_id", officeName: "office_name",
        gradeId: "grade_id", gradeLevel: "grade", partyId: "party_id"
      },
      metadata: {
        sourceUniqueIdField: "employee_id",
        statusSourceField: "job_status"
      }
    },
    metadata: {}
  },

  // Service-level configurations (ICS, Joiner, Mover, Leaver, Discovery)
  {
    name: "Identity Collection Service Configuration",
    serviceName: "identity-collection-service",
    sourceType: "Service",
    targetType: "Service",
    sourceId: null,
    mappingRules: {
      pollingIntervalMinutes: 1,
      identitySourceConnectorName: "Postgres HRMS Identity Source",
      userMappingName: "Postgres HRMS to IGLM User Mapping"
    },
    metadata: {}
  },
  {
    name: "Joiner Service Configuration",
    serviceName: "joiner-service",
    sourceType: "Service",
    targetType: "Service",
    sourceId: null,
    mappingRules: {
      provisioningServiceApiUrl: process.env.PROVISIONING_SERVICE_API_URL || "http://localhost:4005",
      attributeToRoleMappingName: "Default Attribute To Role Mapping"
    },
    metadata: {}
  },
  {
    name: "Mover Service Configuration",
    serviceName: "mover-service",
    sourceType: "Service",
    targetType: "Service",
    sourceId: null,
    mappingRules: {
      provisioningServiceApiUrl: process.env.PROVISIONING_SERVICE_API_URL || "http://localhost:4005",
      attributeToRoleMappingName: "Default Attribute To Role Mapping"
    },
    metadata: {}
  },
  {
    name: "Leaver Service Configuration",
    serviceName: "leaver-service",
    sourceType: "Service",
    targetType: "Service",
    sourceId: null,
    mappingRules: {
      provisioningServiceApiUrl: process.env.PROVISIONING_SERVICE_API_URL || "http://localhost:4005"
    },
    metadata: {}
  },
  {
    name: "Discovery Service Configuration",
    serviceName: "discovery-service",
    sourceType: "Service",
    targetType: "Service",
    sourceId: null,
    mappingRules: {
      discoveryIntervalMinutes: 60,
      applicationsToDiscover: [
        "Finance App (Postgres)",
        "T24 Core Banking (Oracle DB)",
        "Active Directory / LDAP",
        "Customer Portal (MySQL DB)",
        "Example REST App",
        "Example SOAP App",
        "Example CMD App"
      ],
      concurrencyLimit: 5
    },
    metadata: { description: "Configuration for the Discovery Service." }
  },

  // Attribute→Role mapping (ACM)
  {
    name: "Default Attribute To Role Mapping",
    serviceName: null,
    sourceType: "UserAttributes",
    targetType: "Roles",
    sourceId: null,
    mappingRules: {
      attributeToRoleMapping: {
        conditionEngine: 'simple',
        rules: [
          {
            ruleName: "Abuja Branch Controller",
            condition: {
              location: "ABUJA",
              department: "106002- ABUJA BRANCH",
              "metadata.officeName": "BR.CONTROLLER BRANCH CONTROLLER"
            },
            roles: ["Branch Controller"]
          },
          {
            ruleName: "Marketing Dept Roles",
            condition: { department: "Marketing" },
            roles: ["Marketing User", "Report Reader"]
          },
          {
            ruleName: "Manager G7 Roles",
            condition: { title: "Manager", "metadata.gradeLevel": "G7" },
            roles: ["Manager"]
          },
          {
            ruleName: "Default Employee Role",
            condition: "true",
            roles: ["Employee"]
          }
        ]
      }
    },
    metadata: { description: "Automated role assignment rules based on HR attributes (ACM)." }
  },

  // Provisioning Mappings (Finance, T24, Portal, AD/LDAP, REST, SOAP, CMD)
  {
    name: "Finance App Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "email", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000101": {
          appEntitlementId: 101, sqlTemplateName: "grantGroup", revokeSqlTemplateName: "revokeGroup"
        },
        "00000000-0000-0000-0000-000000000102": {
          appEntitlementId: 102, sqlTemplateName: "grantGroup", revokeSqlTemplateName: "revokeGroup"
        },
        "00000000-0000-0000-0000-000000000103": {
          appEntitlementId: "BASIC", sqlTemplateName: "grantLicense", revokeSqlTemplateName: "revokeLicense"
        }
      },
      defaultGrantTemplateName: "grantGroup",
      defaultRevokeTemplateName: "revokeGroup"
    },
    metadata: { description: "Maps IGLM entitlements to Finance App provisioning actions." }
  },
  {
    name: "Finance App Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "user_id",
        entitlementIdentifierSourceField: "entitlement_id",
        attributeMapping: { entitlementType: "entitlement_type", licenseCode: "license_code" },
        userMapping: { sourceField: "user_id", targetField: "hrmsId" },
        entitlementMapping: { sourceField: "entitlement_id", targetField: "applicationEntitlementId" }
      }
    },
    metadata: { description: "Maps Finance App discovered state to IGLM format." }
  },

  // T24 Provisioning Mappings
  {
    name: "T24 Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "hrmsId", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000201": {
          appEntitlementId: "VIEW.ACCOUNT",
          sqlTemplateName: "grantPermission",
          revokeSqlTemplateName: "revokePermission"
        },
        "00000000-0000-0000-0000-000000000202": {
          appEntitlementId: 5,
          sqlTemplateName: "grantRole",
          revokeSqlTemplateName: "revokeRole"
        }
      },
      defaultGrantTemplateName: "grantRole",
      defaultRevokeTemplateName: "revokeRole"
    },
    metadata: { description: "Maps IGLM entitlements to T24 provisioning actions." }
  },
  {
    name: "T24 Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "user_id",
        entitlementIdentifierSourceField: "entitlement_id",
        attributeMapping: { roleId: "role_id" },
        userMapping: { sourceField: "user_id", targetField: "hrmsId" },
        entitlementMapping: { sourceField: "entitlement_id", targetField: "applicationEntitlementId" }
      }
    },
    metadata: { description: "Maps T24 discovered state to IGLM format." }
  },

  // Portal Provisioning Mappings
  {
    name: "Customer Portal Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "email", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000301": {
          appEntitlementId: 5, sqlTemplateName: "grantGroup", revokeSqlTemplateName: "revokeGroup"
        },
        "00000000-0000-0000-0000-000000000302": {
          appEntitlementId: "FEATURE_X", sqlTemplateName: "assignFeature", revokeSqlTemplateName: "revokeFeature"
        }
      }
    },
    metadata: { description: "Maps IGLM entitlements to Portal provisioning actions." }
  },
  {
    name: "Customer Portal Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "user_id",
        entitlementIdentifierSourceField: "entitlement_id",
        attributeMapping: { featureCode: "feature_code" },
        userMapping: { sourceField: "user_id", targetField: "email" },
        entitlementMapping: { sourceField: "entitlement_id", targetField: "applicationEntitlementId" }
      }
    },
    metadata: { description: "Maps Portal discovered state to IGLM format." }
  },

  // AD/LDAP Provisioning Mappings
  {
    name: "AD/LDAP Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "email", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000401": {
          appEntitlementId: "cn=SalesGroup,ou=Groups,dc=example,dc=com",
          operationType: "groupMembership"
        },
        "00000000-0000-0000-0000-000000000402": {
          appEntitlementId: "cn=VPNUsers,ou=Groups,dc=example,dc=com",
          operationType: "groupMembership"
        }
      },
      defaultOperationType: "groupMembership"
    },
    metadata: { description: "Maps IGLM entitlements to AD/LDAP group memberships." }
  },
  {
    name: "AD/LDAP Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "sAMAccountName",
        entitlementIdentifierSourceField: "memberOf",
        attributeMapping: { userPrincipalName: "userPrincipalName", displayName: "displayName" },
        userMapping: { sourceField: "sAMAccountName", targetField: "email" },
        entitlementMapping: { sourceField: "memberOf", targetField: "applicationEntitlementId" }
      }
    },
    metadata: { description: "Maps AD/LDAP discovered state to IGLM format." }
  },

  // REST Provisioning Mapping
  {
    name: "Example REST App Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "email", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000501": {
          appEntitlementId: "PREMIUM",
          sqlTemplateName: "grantEntitlement",
          revokeSqlTemplateName: "revokeEntitlement",
          mappingDetails: { operationType: "License" }
        }
      }
    },
    metadata: { description: "Maps IGLM entitlements to REST provisioning actions." }
  },
  {
    name: "Example REST App Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "userIdentifier",
        entitlementIdentifierSourceField: "itemId",
        attributeMapping: { itemType: "itemType", assignedDate: "assignedDate" },
        userMapping: { sourceField: "userIdentifier", targetField: "email" },
        entitlementMapping: { sourceField: "itemId", targetField: "applicationEntitlementId" }
      },
      resultMapping: {
        recordsPath: "$.accessRecords",
        fieldMapping: { userIdentifier: "userId", entitlementIdentifier: "itemId" }
      }
    },
    metadata: { description: "Maps REST discovered state to IGLM format." }
  },

  // SOAP Provisioning Mapping
  {
    name: "Example SOAP App Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "email", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000501": {
          appEntitlementId: "AccessItem123",
          soapOperationName: "AssignAccess",
          revokeSoapOperationName: "RemoveAccess"
        }
      }
    },
    metadata: { description: "Maps IGLM entitlements to SOAP provisioning actions." }
  },
  {
    name: "Example SOAP App Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "userIdentifier",
        entitlementIdentifierSourceField: "entitlementIdentifier",
        attributeMapping: { statusFlag: "status" },
        userMapping: { sourceField: "userIdentifier", targetField: "email" },
        entitlementMapping: { sourceField: "entitlementIdentifier", targetField: "applicationEntitlementId" }
      }
    },
    metadata: { description: "Maps SOAP discovered state to IGLM format." }
  },

  // CMD Provisioning Mapping
  {
    name: "Example CMD App Provisioning Mappings",
    sourceType: "Provisioning",
    targetType: "ApplicationEntitlements",
    sourceId: null,
    mappingRules: {
      userIdentifierMapping: { sourceField: "hrmsId", targetFormat: "string" },
      entitlementMappings: {
        "00000000-0000-0000-0000-000000000601": {
          appEntitlementId: "app-group-a",
          commandTemplateName: "grantGroup",
          revokeCommandTemplateName: "revokeGroup"
        }
      }
    },
    metadata: { description: "Maps IGLM entitlements to CMD provisioning actions." }
  },
  {
    name: "Example CMD App Discovery Mappings",
    sourceType: "Discovery",
    targetType: "DiscoveredStateMapping",
    sourceId: null,
    mappingRules: {
      discoveredStateMapping: {
        uniqueIdentifierSourceField: "user_id",
        entitlementIdentifierSourceField: "entitlement_id",
        attributeMapping: { statusFlag: "status" },
        userMapping: { sourceField: "user_id", targetField: "hrmsId" },
        entitlementMapping: { sourceField: "entitlement_id", targetField: "applicationEntitlementId" }
      }
    },
    metadata: { description: "Maps CMD discovered state to IGLM format." }
  }
];





/** 3) Define each Application along with its 4 associated entries **/
const appDefs = [
  {
    application: {
      name: "Finance App (Postgres)",
      description: "Financial application running on PostgreSQL",
      type: "financial",
      connectorId: null
    },
    provisioningConnectorName: "Finance App Provisioning (Postgres DB)",
    discoveryConnectorName:   "Finance App Discovery (Postgres DB)",
    provisioningMappingName:   "Finance App Provisioning Mappings",
    discoveryMappingName:      "Finance App Discovery Mappings"
  },
  {
    application: {
      name: "T24 Core Banking (Oracle DB)",
      description: "Core banking application running on Oracle DB",
      type: "core-banking",
      connectorId: null
    },
    provisioningConnectorName: "T24 Provisioning (Oracle DB)",
    discoveryConnectorName:   "T24 Discovery (Oracle DB)",
    provisioningMappingName:   "T24 Provisioning Mappings",
    discoveryMappingName:      "T24 Discovery Mappings"
  },
  {
    application: {
      name: "Customer Portal (MySQL DB)",
      description: "Customer self-service portal on MySQL",
      type: "customer-portal",
      connectorId: null
    },
    provisioningConnectorName: "Customer Portal Provisioning (MySQL DB)",
    discoveryConnectorName:   "Customer Portal Discovery (MySQL DB)",
    provisioningMappingName:   "Customer Portal Provisioning Mappings",
    discoveryMappingName:      "Customer Portal Discovery Mappings"
  },
  {
    application: {
      name: "Active Directory / LDAP",
      description: "Enterprise user directory",
      type: "directory",
      connectorId: null
    },
    provisioningConnectorName: "Active Directory / LDAP Provisioning",
    discoveryConnectorName:   "Active Directory / LDAP Discovery",
    provisioningMappingName:   "AD/LDAP Provisioning Mappings",
    discoveryMappingName:      "AD/LDAP Discovery Mappings"
  },
  {
    application: {
      name: "Example REST App",
      description: "Application managed via REST API",
      type: "rest-api",
      connectorId: null
    },
    provisioningConnectorName: "Example REST App Provisioning",
    discoveryConnectorName:   "Example REST App Discovery",
    provisioningMappingName:   "Example REST App Provisioning Mappings",
    discoveryMappingName:      "Example REST App Discovery Mappings"
  },
  {
    application: {
      name: "Example SOAP App",
      description: "Application managed via SOAP service",
      type: "soap",
      connectorId: null
    },
    provisioningConnectorName: "Example SOAP App Provisioning",
    discoveryConnectorName:   "Example SOAP App Discovery",
    provisioningMappingName:   "Example SOAP App Provisioning Mappings",
    discoveryMappingName:      "Example SOAP App Discovery Mappings"
  },
  {
    application: {
      name: "Example CMD App",
      description: "Application managed via command-line tools",
      type: "cmd",
      connectorId: null
    },
    provisioningConnectorName: "Example CMD App Provisioning",
    discoveryConnectorName:   "Example CMD App Discovery",
    provisioningMappingName:   "Example CMD App Provisioning Mappings",
    discoveryMappingName:      "Example CMD App Discovery Mappings"
  }
];

/** Helper to upsert ConnectorConfig **/
async function upsertConnector(cfg) {
  const where = { name: cfg.name, serviceType: cfg.serviceType, type: cfg.type };
  const [entry, created] = await ConnectorConfig.findOrCreate({ where, defaults: cfg });
  logInfo(`${created ? 'Created' : 'Found'} ConnectorConfig: ${cfg.name}`);
  return entry;
}

/** Helper to upsert MappingConfig (with optional deep-merge) **/
async function upsertMapping(cfg) {
  const where = {
    name: cfg.name,
    sourceType: cfg.sourceType,
    targetType: cfg.targetType,
    ...(cfg.serviceName != null ? { serviceName: cfg.serviceName } : {})
  };
  const [entry, created] = await MappingConfig.findOrCreate({ where, defaults: cfg });
  if (created) {
    logInfo(`Created MappingConfig: ${cfg.name}`);
  } else {
    logInfo(`Found existing MappingConfig: ${cfg.name}`);
    // For service configs (Discovery, etc.), deep-merge mappingRules
    if (cfg.mappingRules) {
      const merged = deepMerge(cfg.mappingRules, entry.mappingRules || {});
      if (JSON.stringify(merged) !== JSON.stringify(entry.mappingRules)) {
        await entry.update({ mappingRules: merged });
        logInfo(`Updated mappingRules for ${cfg.name}`);
      }
    }
  }
  return entry;
}

/** Helper to link App→Connector & App→Mapping **/
async function linkApp(appEntry, connectorEntry, mappingEntry, role) {
  // connector
  if (appEntry.connectorId !== connectorEntry.id) {
    await appEntry.update({ connectorId: connectorEntry.id });
    logInfo(`Linked ${appEntry.name} → ${role} Connector ${connectorEntry.name}`);
  }
  // mapping
  if (mappingEntry.sourceId !== appEntry.id) {
    await mappingEntry.update({ sourceId: appEntry.id });
    logInfo(`Linked ${role} MappingConfig ${mappingEntry.name} → Application ${appEntry.name}`);
  }
}

/** Main orchestration **/
async function runSetup() {
  logInfo(`Starting configuration setup script...`);
  try {
    // 1) init
    await ConfigService.init();
    logInfo(`ConfigService initialized.`);

    // 2) upsert all connectors
    const connectorIndex = {};
    for (const cfg of connectorDefs) {
      const entry = await upsertConnector(cfg);
      connectorIndex[cfg.name] = entry;
    }

    // 3) upsert all mappings
    const mappingIndex = {};
    for (const cfg of mappingDefs) {
      const entry = await upsertMapping(cfg);
      mappingIndex[cfg.name] = entry;
    }

    // 4) create/link each Application
    for (const def of appDefs) {
      const { application, provisioningConnectorName, discoveryConnectorName,
              provisioningMappingName, discoveryMappingName } = def;

      // findOrCreate Application
      const [appEntry, createdApp] = await Application.findOrCreate({
        where: { name: application.name },
        defaults: application
      });
      logInfo(`${createdApp ? 'Created' : 'Found'} Application: ${application.name}`);

      // link provisioning connector + mapping
      await linkApp(
        appEntry,
        connectorIndex[provisioningConnectorName],
        mappingIndex[provisioningMappingName],
        'Provisioning'
      );

      // link discovery connector + mapping
      await linkApp(
        appEntry,
        connectorIndex[discoveryConnectorName],
        mappingIndex[discoveryMappingName],
        'Discovery'
      );
    }

    logInfo(`Configuration setup script finished successfully.`);
  } catch (err) {
    logError(`Error running configuration setup script:`, err);
  } finally {
    // teardown
    if (ConfigService.sequelize) {
      try {
        await ConfigService.sequelize.close();
        logInfo(`Config DB connection closed.`);
      } catch (e) {
        logError(`Error closing Config DB:`, e);
      }
    }
    if (models.sequelize) {
      try {
        await models.sequelize.close();
        logInfo(`Core DB connection closed.`);
      } catch (e) {
        logError(`Error closing Core DB:`, e);
      }
    }
  }
}

// fire on load
runSetup();
