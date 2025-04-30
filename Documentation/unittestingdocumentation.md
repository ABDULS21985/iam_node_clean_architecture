# IGLM IAM System: Detailed Testing Guide

This document provides a step-by-step guide for manually testing the core backend microservices of the IGLM IAM system, following a logical dependency sequence.

**Services to Test:**

* Identity Collection Service (ICS)
* Joiner Service
* Mover Service
* Leaver Service
* Provisioning Service
* Discovery Service

**Prerequisites:**

* Node.js and npm installed.
* Docker and Docker Compose installed.
* Source code is cloned and dependencies (`npm install`) are installed in the project root.
* A `.env` file is created at the project root with all necessary environment variables configured (DB, MQ, Redis URLs, ports, service API URLs).
* You have access to monitor the logs of each service (`node src/server.js` output).
* (Optional but Recommended) Access to RabbitMQ Management UI (typically <http://localhost:15672>) for monitoring queues and exchanges.
* (Optional but Recommended) Access to your PostgreSQL database (Config/Core DB) to check table contents (`Users`, `ProvisioningTasks`, `CurrentAppStates`, `ReconciliationResults`, etc.).
* Your HRMS database/mock is running and populated with test user data.
* Your target application systems/mocks are running and configured (required for Phase 3 onwards).

---

## Phase 0: Infrastructure & Configuration (Prerequisite Verification)

**Goal:** Ensure the underlying infrastructure (DBs, MQ, Redis) is running and the configuration database is correctly populated with initial settings, mappings, and connector definitions.

1. **Start Infrastructure:**
    * Navigate to your infrastructure directory (e.g., `cd deploy/infrastructure`).
    * Run Docker Compose:

        ```bash
        docker-compose up -d
        ```

    * **Verification:** Ensure all containers start successfully. Check Docker logs if any fail. Verify you can access RabbitMQ Management UI and connect to your PostgreSQL database.

2. **Run Database Migrations:**
    * Navigate to the project root (e.g., `cd ../..`).
    * Run migrations to create all necessary tables:

        ```bash
        npx sequelize-cli db:migrate --url postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME
        ```

        (Replace `$DB_USER`, etc., or ensure env vars are loaded in your shell).
    * **Verification:** Check database logs or connect to the DB to confirm all tables from your `shared/models` definitions and migrations exist.

3. **Populate Configuration Database:**
    * Navigate to the project root.
    * Run the setup script containing definitions for service configs, connector configs, and mapping configs (including the Attribute-to-Role mapping).

        ```bash
        node scripts/setupConfigs.js
        ```

    * **Verification:** Monitor script logs for successful database connection and logs indicating which configurations were created or found. Connect to the Config DB to check `ConnectorConfigs` and `MappingConfigs` tables contain the expected entries with correct `mappingRules` JSONB data.

**Status:** Proceed to Phase 1 once Phase 0 is fully verified.

---

## Phase 1: Identity Collection Service (ICS) Isolation Test

**Goal:** Verify ICS can connect to HRMS, pull data, detect deltas against a snapshot, save a new snapshot, and publish identity change events to the MQ.

**Prerequisites:** Phase 0 Complete & Verified. HRMS DB has test data accessible by the configured query. Your ICS service code (`services/identity-collection-service/src/server.js` and related modules like `collectionLogic.js`, `dataProcessor.js`, adapters) is updated and saved. Redis snapshot for ICS is empty for the *first* run test.

1. **Clean Redis Snapshot (for first run test):**
    * Ensure your Redis container is running.
    * Connect to Redis (e.g., using `redis-cli`).
    * Execute `FLUSHALL` or `DEL hrms_snapshot:<ConnectorConfig ID>` (if you know the specific key from a previous run). `FLUSHALL` is simplest if Redis is only used for this.

    * ```bash
        # Example using redis-cli
        redis-cli
        FLUSHALL
        exit
        ```

    * **Verification:** Connect to Redis and verify no keys exist or the specific snapshot key is gone.

2. **Start Identity Collection Service (ICS):**
    * Navigate to the ICS service directory:

        ```bash
        cd services/identity-collection-service
        ```

    * Start the service:

        ```bash
        node src/server.js
        ```

    * **Verification:**
        * Monitor ICS logs (`src/server.js` output) for successful startup, Config DB connection, MQ connection, Redis connection, and the scheduler starting.
        * Look for "Cron schedule triggered." and "Starting scheduled data collection task.".
        * Look for logs indicating successful data collection from HRMS (e.g., logs from your `hrms-db-postgres.js` adapter, "Data collection completed. NNN record(s) retrieved.").
        * Look for logs from `collectionLogic.js` indicating delta detection ran ("Deltas found - Joiners: N, Movers: 0, Leavers: 0" on the first run after cleaning Redis, where N is total users).
        * Monitor logs from `dataProcessor.js` indicating mapped records and DB interactions ("Processing mapped Joiner...", "Created new User in DB...").
        * **Crucially:** Look for logs indicating successful MQ publish attempts for Joiner/Mover/Leaver events ("Published 'joiner.new' event...", "Published 'mover.update' event...", "Published 'leaver.exit' event...").
        * Check the RabbitMQ Management UI (Exchanges tab -> `identity.changes`) for messages being routed to queues (like `joiner.events.queue`). The queues don't need consumers yet for this phase.
        * Check your IGLM Core DB (`Users` table) to confirm that new users were created (on the first run).
        * Check Redis (`redis-cli KEYS *`) to confirm the new snapshot key `hrms_snapshot:<ConnectorConfig ID>` exists and contains data.

3. **Test Delta Detection (Subsequent Runs):**
    * Make changes in your HRMS mock data (e.g., change a department, update a job title, mark a user as terminated, add a new user).
    * Wait for the configured `pollingIntervalMinutes` for the next ICS run (or restart ICS to trigger an immediate run if not using the scheduler).
    * **Verification:** Monitor ICS logs for the subsequent run. Verify the delta detection logs (`Deltas found - Joiners: N1, Movers: N2, Leavers: N3`) accurately reflect the changes you made in the HRMS. Verify corresponding MQ publish logs appear.

**Status:** Phase 1 is verified when you are confident that ICS correctly pulls data, detects the expected deltas, saves snapshots, and publishes the correct events to RabbitMQ.

---

## Phase 2: Lifecycle Services (Joiner/Mover/Leaver) + Provisioning Service API Test

**Goal:** Verify JML services consume identity events from MQ, use the Role Assignment Service, determine desired roles, call the Provisioning Service API correctly, and acknowledge messages. Verify Provisioning Service API receives these requests and queues tasks.

**Prerequisites:** Phase 0 Complete & Verified. Phase 1 Complete & Verified (ICS publishes events). HRMS DB has test data. Your Provisioning Service (`services/provisioning-service/src/server.js`), Joiner Service (`services/joiner-service/src/server.js`), Mover Service (`services/mover-service/src/server.js`), Leaver Service (`services/leaver-service/src/server.js`), and Role Assignment Service (`shared/roleAssignmentService.js`) code are updated and saved. Configuration Database contains the correct Attribute-to-Role Mapping.

1. **Start Provisioning Service:**
    * Navigate to the Provisioning Service directory: `cd services/provisioning-service`.
    * Start the service: `node src/server.js`.
    * **Verification:** Monitor logs for successful startup, Config DB/MQ/Redis init, worker setup, and API listening on its configured port (default 4005). Ensure no startup errors related to MQ or configs.

2. **Start Lifecycle Services (Joiner, Mover, Leaver):**
    * Navigate to each service directory in separate terminals.
    * Start each service: `node src/server.js`.
    * **Verification:** Monitor logs for each service for successful startup, config loading (especially the Attribute-to-Role mapping), MQ connection, consumer setup, and API listening (if applicable). Ensure no startup errors.

3. **Clean IGLM Core DB Users & Provisioning Tasks (for fresh flow test):**
    * Connect to your IGLM Core DB.
    * Empty the `Users` and `ProvisioningTasks` tables to simulate a clean state for new users.

    * ```sql
        -- Example SQL
        DELETE FROM "ProvisioningTasks";
        DELETE FROM "UserRoles"; -- Need to clear join table first
        DELETE FROM "Users";
        ```

    * Clean the Redis snapshot for ICS as in Phase 1 Step 1.
    * Ensure HRMS DB has the initial user data.

4. **Trigger Identity Collection (for Joiner Events):**
    * Start the ICS service (`cd services/identity-collection-service && node src/server.js`). This will trigger a run (either immediately or on schedule) and publish `joiner.new` events for all users in the HRMS (since Users table and snapshot are empty).
    * **Verification:** Monitor ICS logs for successful run and publish logs.

5. **Monitor Lifecycle Services Processing:**
    * Monitor logs for Joiner, Mover, and Leaver services.
    * Look for logs indicating they received messages ("Listener received joiner event...").
    * Look for logs showing Role Assignment logic executing ("Determining roles for user...", "Determined initial desired roles...").
    * Look for logs indicating they are calling the Provisioning API ("Calling Provisioning Service API...").
    * Look for logs confirming the Provisioning API request was accepted ("Provisioning request accepted for user...", expecting status 202).
    * Look for logs confirming the message was acknowledged on the MQ ("Listener successfully processed and acknowledged joiner event...").
    * **Verification:** Check RabbitMQ Management UI for messages being consumed from `joiner.events.queue`, `mover.events.queue`, `leaver.events.queue`. Check the `provisioning.tasks.queue` receiving new messages published by the Provisioning API. Check the IGLM Core DB `ProvisioningTasks` table for new entries with status 'pending'. Check the `Users` table to see if users were created by the DataProcessor (called by ICS).

6. **Test Mover/Leaver Flow:**
    * Modify data in your HRMS mock for existing users (change department, job title, etc., or mark as terminated).
    * Trigger another ICS run (as in Step 4).
    * **Verification:** Monitor logs to see `mover.update` or `leaver.exit` events published by ICS and consumed by Mover/Leaver services. Verify Role Assignment runs for Mover. Verify API calls to Provisioning (`/provision` for Mover with new roles, `/provision/revoke` for Leaver).

**Status:** Proceed to Phase 3 when you are confident JML services correctly consume events, determine roles, call the Provisioning API, and tasks appear in the Provisioning queue.

---

## Phase 3: Provisioning Service Worker + Adapter Execution Test

**Goal:** Verify Provisioning Service worker consumes tasks from the MQ, loads necessary configs/mappings, maps user/entitlements to app-specific format, dynamically loads and calls the correct adapter's `applyDesiredState` method, and updates task status. Requires implemented Provisioning Adapters and target systems/mocks.

**Prerequisites:** Phase 0 Complete & Verified. Phase 2 Complete & Verified (Prov API receives calls and queues tasks). Your Provisioning Adapters (`services/provisioning-service/src/connectors/provisioning/*.js`) are implemented with `applyDesiredState` logic and any connection management/cleanup. Your target application mocks/systems are ready and accessible, configured in Config DB.

1. **Start Target Application Mocks/Systems:**
    * Ensure your target application mocks (e.g., mock DBs, mock LDAP servers, mock REST APIs) are running and accessible on the network.
    * **Verification:** Verify they are running and accessible.

2. **Start Services:**
    * Ensure Infra is running.
    * Ensure Config DB is populated with Applications, ConnectorConfigs, MappingConfigs (Provisioning mappings).
    * **Start Provisioning Service (`cd services/provisioning-service && node src/server.js`).** (Its worker will consume tasks).
    * You don't strictly *need* JML/Leaver/Mover running for this phase if you manually trigger tasks.
    * You don't strictly *need* ICS running.

3. **Trigger Provisioning Tasks (Manual Trigger):**
    * You can use RabbitMQ Management UI or a simple script to publish messages directly to the `provisioning.tasks.queue`.
    * The payload should be `{ "taskId": "..." }`. The task ID must correspond to a valid `ProvisioningTask` record already in your IGLM Core DB (created via the API in Phase 2, or manually inserted for testing).
    * Publish messages for different types of tasks (e.g., a grant task for one user/app, a revoke task for another user/app/entitlement).
    * **Verification:** Check RabbitMQ UI to see the messages entering the `provisioning.tasks.queue`.

4. **Monitor Provisioning Service Worker Processing:**
    * Monitor Provisioning Service logs.
    * Look for logs indicating the worker consumed a task ("Worker received task message for task ID:...").
    * Look for logs from `provisioningLogic.js` indicating task loading, user/app loading, config/mapping loading, user ID determination, entitlement mapping, "Prepared app-specific desired state for Application...", "Adapter call complete...".
    * **Crucially:** Look for logs generated *by your adapter's `applyDesiredState` method*, confirming it was called and received the correct parameters (user ID in app, lists of entitlements to grant/revoke).
    * Monitor logs/state of the target application mocks/systems for received provisioning actions (e.g., user creation attempts, group membership changes, permission updates).
    * Monitor Provisioning Service logs for the final task status update ("Task ID... status updated to 'completed'/'failed'.").
    * Look for logs confirming the 'provisioning.task.status' event was published to the MQ.

5. **Verify Task Results and Status:**
    * Check the IGLM Core DB `ProvisioningTasks` table. Find the tasks you triggered. Verify their status is 'completed' or 'failed'. Examine the `results` and `errorDetails` JSONB fields to see the outcome reported by the adapter for each application and individual operation.
    * Check the RabbitMQ Management UI for messages in the `provisioning.task.status` exchange/queue.

**Status:** Proceed to Phase 4 when you are confident the Provisioning worker correctly consumes tasks, loads configs/mappings, calls adapters, and reflects the outcome in task logs and status events.

---

## Phase 4: Discovery Service + Reconciliation Test

**Goal:** Verify Discovery pulls current state from target systems, stores it, triggers Reconciliation, which compares desired vs. discovered state, identifies discrepancies, stores them, and triggers remediation Provisioning tasks. Requires implemented Discovery Adapters and target systems/mocks.

**Prerequisites:** Phase 0 Complete & Verified. Phase 3 Complete & Verified (Provisioning worker and adapters work). Your Discovery Service (`services/discovery-service/src/server.js` and related modules), Reconciliation Logic (`services/discovery-service/src/reconciliationLogic.js`), and Discovery Adapters (`services/discovery-service/src/connectors/discovery/*.js`) are implemented and saved. Config DB contains Discovery Connector and Mapping configs. Target application mocks/systems are ready and accessible, populated with *current* access state data. IGLM Core DB contains the *desired* state (Users with Roles/Entitlements/Applications). Redis is running.

1. **Start Services:**
    * Ensure Infra is running.
    * Ensure Config DB is populated.
    * Ensure IGLM Core DB contains the desired state data (Users, Roles, Entitlements, RoleEntitlementMappings) representing *what access users should have*.
    * Ensure target application mocks/systems are ready and contain a *mix* of access data (some matching desired state, some excess, some missing).
    * **Start Provisioning Service (`cd services/provisioning-service && node src/server.js`).** (Needed to receive remediation calls).
    * **Start Discovery Service (`cd services/discovery-service && node src/server.js`).** (Its scheduler will trigger discovery runs).

2. **Trigger Discovery Run:**
    * Wait for Discovery's configured schedule (e.g., via `node-cron`).
    * Alternatively, if your Discovery Service has an API endpoint or manual trigger, activate it.
    * **Verification:** Monitor Discovery logs for "Cron schedule triggered.", "Starting Discovery run...", logs from your adapter's `discoverAccess` method, "State storage complete...", and "Published 'discovery.status' event... with routing key 'reconciliation.triggers.run.completed'".

3. **Monitor Reconciliation Processing:**
    * Monitor Discovery Service logs (worker consuming the reconciliation trigger). Look for "Worker received message...", "Starting reconciliation for Discovery Run...".
    * Monitor Reconciliation logs (`reconciliationLogic.js`) for logs indicating state loading, comparison logic, discrepancy identification ("Discrepancy found: ...").
    * **Verification:** Check the IGLM Core DB `CurrentAppStates` table (should be populated by Discovery) and `ReconciliationResults` table (should be populated by Reconciliation with discrepancies).

4. **Monitor Remediation Trigger:**
    * If Reconciliation finds discrepancies that are configured for automatic remediation, it will call the Provisioning API.
    * Monitor Provisioning Service logs for "Received explicit revocation request." or "Received provisioning request (Grant)." shortly after Reconciliation completes.
    * Monitor Provisioning Service logs for the processing of these remediation tasks (Phase 3 logic applies here).

**Status:** Proceed to Phase 5 when you are confident Discovery correctly pulls state, Reconciliation identifies expected discrepancies, and triggers the appropriate remediation tasks in the Provisioning Service.

---

## Phase 5: End-to-End Flow Test

**Goal:** Verify the entire automated flow from an HRMS change through the pipeline to corresponding changes in target applications and subsequent reconciliation.

**Prerequisites:** All previous Phases (0-4) Complete & Verified. All backend services are running. All infrastructure is running. All adapters (Identity Collection, Provisioning, Discovery) are implemented. HRMS mock DB is running and populated with initial data and you have a way to simulate changes (e.g., SQL updates, a simple UI/script to modify data). Target application mocks/systems are running and accessible.

1. **Ensure All Components are Running:**
    * Ensure Infra is running (`docker-compose ps`).
    * Ensure Config DB is populated (`node scripts/setupConfigs.js`).
    * Start all services in the correct order (Prov, JML, Mover, Leaver, ICS, Discovery). Monitor all logs for successful startup.

2. **Simulate an HRMS Change:**
    * Make a specific test change in your HRMS mock database. Examples:
        * **New Hire:** Insert a new employee record with required attributes.
        * **Mover:** Update an existing employee's department, job title, location, etc., such that the Attribute-to-Role mapping dictates a change in desired roles.
        * **Leaver:** Update an existing employee's status to 'Terminated' or set a `termination_date` that marks them as exited.
    * **Verification:** Confirm the data change in the HRMS mock DB.

3. **Monitor the Pipeline Flow:**
    * Wait for the ICS polling interval to pass.
    * Monitor logs chronologically across all services:
        * **ICS Logs:** Look for the collection run triggering, delta detection showing the expected Joiner/Mover/Leaver, and corresponding event publish logs (`identity.changes`).
        * **JML/Leaver Logs:** Look for the correct service consuming the event message, role assignment determining the expected desired roles (for J/M), and logs calling the Provisioning API (`/provision` or `/provision/revoke`).
        * **Provisioning Logs:** Look for the API receiving the call, task creation, task message publish (`provisioning.tasks`). Then, look for the worker consuming the task, adapter loading, user/entitlement mapping, "Prepared app-specific desired state...", adapter call logs, adapter result summary, final task status update (`completed`/`failed`), and task status event publish (`provisioning.task.status`).
        * **Target Application Mocks/Systems Logs/State:** Monitor logs or check the state in your target systems to verify that the expected grant/revoke actions occurred shortly after the Provisioning worker processed the task.
        * **Discovery Logs:** Wait for the next scheduled Discovery run. Look for the run triggering, adapter calls, state storage logs. Look for the reconciliation trigger event publish (`reconciliation.triggers.run.completed`).
        * **Reconciliation Logs:** Look for the reconciliation worker consuming the trigger, loading states, comparing, discrepancy identification logs. For a successful JML flow that worked perfectly, Reconciliation *should ideally find no discrepancies* related to that flow in this run. If it finds discrepancies (e.g., Provisioning failed for one entitlement, or Discovery pulled state incorrectly), monitor logs for remediation trigger calls to the Provisioning API (`/provision` or `/provision/revoke`).

4. **Verify Final State:**
    * Check the state in your target application mocks/systems – does the user have exactly the access that the *latest* IGLM desired state (based on their current HRMS attributes and the ACM) dictates?
    * Check the Config DB (`CollectionRuns`, `DiscoveryRuns`, `ProvisioningTasks`, `ReconciliationResults`) to see the full history and outcome of the flow. Verify task results and discrepancy details match expectations.

This elaborate testing sequence should provide a thorough process for verifying the functionality and integration of your IGLM IAM System microservices. Good luck!
