
# Reconciliation Service Architecture

This document details the Reconciliation Worker process and the logic that drives compliance reconciliation based on the latest Discovery Run.

---

## Reconciliation Worker

**Location:** `services/discovery-service/src/server.js`

### Responsibilities
- Sets up a consumer for the `reconciliation.triggers.run.completed` queue.
- Upon receiving a message containing `latestDiscoveryRunId`:
  - Calls `reconciliationLogic.performReconciliation(latestDiscoveryRunId, options)`.
  - Awaits the reconciliation result.
  - Acknowledges (`ack`) the message if successful.
  - Rejects (`nack`) the message if processing fails.

---

## Reconciliation Logic

**Location:** `services/discovery-service/src/reconciliationLogic.js`

### performReconciliation(latestDiscoveryRunId, options) Function

#### Main Steps

1. **Load Discovered State**
   - Fetches `CurrentAppStates` for the latest Discovery Run from the Core DB.

2. **Load Desired State**
   - Retrieves the intended users and entitlements structure based on Role assignments from the Core DB.

3. **State Comparison**
   - Compares the discovered state against the desired state to identify inconsistencies:
     - **Violations (Excess Access):** Access found that should not exist.
     - **Orphaned Accounts:** Discovered access records that cannot be associated with any known IGLM User ID.
     - **Missing Access:** Desired entitlements that are missing in the discovered records.

4. **Result Storage**
   - Stores identified discrepancies into the `ReconciliationResult` table for tracking and audit purposes.

5. **Remediation Triggering**
   - Prepares specific payloads for each type of discrepancy:
     - **Violations & Orphaned Accounts:** Payloads to revoke excessive access.
     - **Missing Access:** Payloads to provision the missing entitlements.

6. **Provisioning Service API Calls**
   - Executes remediation actions via the Provisioning Service:
     - `POST /provision/revoke` for Violations and Orphaned Accounts.
     - `POST /provision` for Missing Access.
   - Utilizes `axios.post` to interact with the Provisioning APIs.

7. **Event Publishing**
   - Publishes reconciliation result events to the MQ:
     - `reconciliation.task.completed` (on success).
     - `reconciliation.task.failed` (on failure).

---
