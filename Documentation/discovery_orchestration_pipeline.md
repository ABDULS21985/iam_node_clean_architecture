
# Discovery Service Orchestration and Architecture

This document outlines the orchestration flow, discovery adapters, and state storage mechanics for the Identity Governance Lifecycle Management (IGLM) Discovery Service.

---

## Orchestration

**Location:** `services/discovery-service/src/server.js` & `services/discovery-service/src/discoveryLogic.js`

### Scheduler Trigger
- A `node-cron` scheduler triggers `discoveryLogic.performRun` at defined intervals.

### discoveryLogic.performRun Steps
1. **Load Configuration**
   - Loads the Discovery Service configuration settings.

2. **Identify Target Applications**
   - Finds applications configured for discovery (marked as Discoverable).

3. **Discovery Execution for Each Application**
   - Loads the application's `ConnectorConfig` (Discovery type) and `MappingConfig` (Discovery type) via `ConfigService`.
   - Dynamically loads the appropriate Discovery Connector Adapter from `services/discovery-service/src/connectors/discovery/*.js`.
   - Calls the adapter’s `async discoverAccess(connectorConfig.configuration, mappingRules, lastRunTimestamp)` method.
   - Receives raw discovered data (an array of objects).

4. **State Storage**
   - Calls `stateStorage.storeDiscoveredState` to map, resolve, and persist discovered access information into `CurrentAppStates`.

5. **DiscoveryRun Logging**
   - Updates the `DiscoveryRun` log with execution details.

6. **Completion Event Publishing**
   - After all applications are processed, publishes a `discovery.status` event (`reconciliation.triggers.run.completed`) to the Message Queue (MQ).

---

## Discovery Adapters

**Location:** `services/discovery-service/src/connectors/discovery/*.js`

### Responsibilities
- Implement `async discoverAccess(configDetails, mappingRules, lastRunTimestamp)`.

### Inputs
- `configDetails`: Connection parameters for the target system.
- `mappingRules`: Application-specific Discovery Mapping Config.
- `lastRunTimestamp`: Timestamp to support incremental discovery (fetch only updates since the last run).

### Adapter Workflow
- Connect to the target system using `configDetails`.
- Execute queries, API calls, or command executions based on `mappingRules`.
- Return **raw discovered data** as an array of objects, with each object representing a user's access item in the native format of the target application.

---

## State Storage

**Location:** `services/discovery-service/src/stateStorage.js`

### storeDiscoveredState Function
- **Input:** Raw discovered records, application mapping config, and the active DiscoveryRun ID.

### Responsibilities
1. **Mapping to Standard Format**
   - Maps raw discovery records to a standard schema expected by `CurrentAppStates` using the mapping config.

2. **Identity Resolution**
   - Attempts to resolve the application-specific user ID to an IGLM User ID.
   - Uses `User.metadata` or a dedicated mapping table for resolution.

3. **Entitlement Resolution**
   - Attempts to map application-specific entitlement IDs to IGLM Entitlement IDs.

4. **Upsert into CurrentAppStates**
   - Inserts new records or updates existing ones tied to the DiscoveryRun.

5. **Handle Deletions/Inactive Access**
   - Identifies and flags records from previous runs that are no longer present in the current discovery run.
   - Marks them as inactive or deletes them, reflecting removed access in the target system.

---

## Reconciliation Trigger

Upon successful completion of the Discovery Run, the system triggers a Reconciliation Pipeline by publishing the `reconciliation.triggers.run.completed` event.

---
