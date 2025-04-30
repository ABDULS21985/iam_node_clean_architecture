
# Provisioning Logic and Connector Architecture

This document elaborates the core function `processProvisioningTask(taskId, options)` and its interaction with Provisioning Connector Adapters.

---

## processProvisioningTask(taskId, options)

### Overview
Responsible for orchestrating the provisioning or revocation lifecycle based on the received task.

### Processing Steps
1. **Load Task Record**
   - Loads the `ProvisioningTask` record from the DB by its ID.

2. **Update Task Status**
   - Transitions task status from `'pending'` to `'in_progress'`.

3. **Load User Context (optional for revoke tasks)**
   - Loads the User model and related associations (Roles, Entitlements, Applications) from the Core DB.

4. **Analyze Payload**
   - Determines `taskType` from the task's `desiredState` payload (`'grant'` or `'revoke'`).

5. **Entitlement Mapping**
   - **Grant Flow:** Derives IGLM Entitlements based on the user's roles and their linked entitlements. Groups by Application ID.
   - **Revoke Flow:** Uses the explicit entitlements list provided in `desiredState.payload.entitlementsToRevoke`. Groups by Application ID.

6. **Per Application Processing**
   For each unique application affected:
   - Loads **ConnectorConfig** and **MappingConfig** using `ConfigService`, including cache clearing.
   - Determines user's application-specific identifier (`userIdInApp`) via helper functions.
   - Maps IGLM Entitlements to application-specific formats using MappingConfig or defaults.

7. **Adapter Invocation**
   - Dynamically loads the appropriate Provisioning Connector Adapter based on `ConnectorConfig.type`.
   - Calls the adapter's `async applyDesiredState(connectorConfig.configuration, appSpecificDesiredState)` method.

8. **Results Collection**
   - Aggregates results and errors returned per application.
   - Determines overall task status: `'completed'` if all succeeded, `'failed'` otherwise.

9. **Task Update**
   - Updates the ProvisioningTask record in DB: final status, end time, results, and errors.

10. **Event Publishing**
    - Publishes a `provisioning.task.status` event (`task.completed` or `task.failed`) to the MQ using `MqService.publish`.

11. **Error Handling**
    - Robust error handling and logging implemented at each step.

---

## Provisioning Connector Adapters

**Location:** `services/provisioning-service/src/connectors/provisioning/*.js`

### Responsibilities
- Implement `async applyDesiredState(configDetails, appSpecificDesiredState)`.
- **Inputs:**
  - `configDetails`: Connection information from `ConnectorConfig.configuration`.
  - `appSpecificDesiredState`: Contains `userIdInApp`, `entitlementsToGrant`, and `entitlementsToRevoke`.

### Adapter Workflow
- Connect to the target system (e.g., database, LDAP, REST API) using `configDetails`.
- Iterate over entitlements to **grant** and **revoke**.
- For each operation:
  - Utilize `appSpecificEntitlementId`, `mappingDetails` (template/operation type), and `userIdInApp` to execute the operation.
- Track and record success/failure per entitlement.
- Return a results object (e.g., `{ success: boolean, operations: [...] }`) back to `provisioningLogic.js`.

### Connection Management
- Adapters managing their own connection pools must register a cleanup function using:

```javascript
ProvisioningLogic.registerCleanup(async () => {
    // Close connections, clean up resources
});
```

during their initialization.

---

## Discovery Pipeline

A separate scheduled pipeline responsible for periodic system synchronization and environment discovery. (Details TBD)

---
