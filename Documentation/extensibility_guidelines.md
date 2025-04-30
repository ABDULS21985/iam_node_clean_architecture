
# Extensibility: Adding New Target Systems

The IGLM system's architecture is intentionally designed for extensibility, enabling seamless integration of new target applications through connector adapters and configuration-driven onboarding.

---

## Integration Workflow

### 1. Implement Connector Adapters

- **Discovery Adapter:**
  - Create a new file (e.g., `my-new-app.js`) in:
    ```
    services/discovery-service/src/connectors/discovery/
    ```
  - Implement the following function:
    ```javascript
    async discoverAccess(configDetails, mappingRules, lastRunTimestamp)
    ```

- **Provisioning Adapter:**
  - Create a new file (e.g., `my-new-app.js`) in:
    ```
    services/provisioning-service/src/connectors/provisioning/
    ```
  - Implement the following function:
    ```javascript
    async applyDesiredState(configDetails, appSpecificDesiredState)
    ```

- **Connection and Cleanup Requirements:**
  - Adapters must use the provided `configDetails` for connection establishment.
  - Adapters must properly manage and close persistent connections or connection pools.
  - Register cleanup functions via:
    ```javascript
    ProvisioningLogic.registerCleanup(async () => { ... });
    DiscoveryLogic.registerCleanup(async () => { ... });
    ```

---

### 2. Define Configuration Entries

- **Create Application Entry:**
  - Insert a new Application entry into the Core DB representing the target application.

- **Create ConnectorConfig Entries:**
  - Insert two entries in the Config DB:
    - **Discovery type ConnectorConfig**
    - **Provisioning type ConnectorConfig**
  - Link both to the Application and specify the `type` property to match the adapter file names.
  - Include all connection details in the `configuration` (JSONB format).

- **Create MappingConfig Entries:**
  - Define Discovery and Provisioning MappingConfig entries.
  - Link them to the Application ID.
  - Establish `mappingRules` for data format and entitlement/action mapping between IGLM and the target application.

---

### 3. Update Setup Script

- Update the `scripts/setupConfigs.js` file to automate onboarding:
  - Add creation/update logic for the new Application, ConnectorConfig, and MappingConfig entries.
  - Use `findOrCreate` patterns and correctly link all related IDs.

---

### 4. Restart Services

- **Restart the following services:**
  - Discovery Service
  - Provisioning Service
  - Any other dependent services

- Upon restart, services will:
  - Load new configuration entries from the database.
  - Dynamically detect and invoke the newly created connector adapters.

---

## Summary

This extensibility model ensures rapid, low-risk onboarding of new target systems into the IGLM ecosystem without the need for service re-deployment or codebase modifications beyond the addition of properly implemented and registered adapters.

---
