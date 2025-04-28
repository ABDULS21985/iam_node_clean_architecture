
# Provisioning Pipeline (API & Worker)

This service provides the API endpoint for requesting provisioning actions and includes a worker that executes the tasks.

---

## API Endpoints
**Location:** `services/provisioning-service/src/server.js`

### POST `/provision`
- **Description:** Accepts a desired state payload (e.g., `{ userId: '...', roles: [...] }`).
- **Process:**
  - Validates the payload and the user/application IDs in the Core DB.
  - Creates a `ProvisioningTask` record in the DB (type: `'grant'`).
  - Publishes a message with the task ID to the `provisioning.tasks` exchange (using `routingKey: task.new`) via `MqService.publish`.
  - Responds with `202 Accepted` and returns the task ID.

### POST `/provision/revoke`
- **Description:** Accepts an explicit revocation payload (e.g., `{ userId: '...', applicationId: '...', appSpecificUserId: '...', entitlementsToRevoke: [...] }`).
- **Process:**
  - Validates the payload and the user/application IDs.
  - Creates a `ProvisioningTask` record (type: `'revoke'`).
  - Publishes a message with the task ID to the MQ.
  - Responds with `202 Accepted` and the task ID.

### Additional Features
- Basic request logging implemented.
- Error handling for immediate API responses.

---

## Provisioning Task Worker
**Location:** `services/provisioning-service/src/server.js` & `services/provisioning-service/src/provisioningLogic.js`

### Functionality
- Sets up a consumer for the `provisioning.tasks.queue`.
- Upon receiving a message containing a `taskId`:
  - Calls `ProvisioningLogic.processProvisioningTask(taskId, options)`.
  - Awaits the result of processing.
  - **If successful:** Acknowledges (`ack`) the message in MQ.
  - **If error occurs:** Rejects (`nack`) the message and sends it to a Dead Letter Queue (DLQ).

---

## Provisioning Logic
**Location:** `services/provisioning-service/src/provisioningLogic.js`

Handles the core business logic for processing provisioning and revocation tasks based on the taskId received from the worker.

---
