# Dr Katanga IGLM IAM System

## Comprehensive Documentation

This README provides a detailed overview of the IGLM (Identity Governance and Lifecycle Management) IAM System project, outlining its architecture, implemented components, core logic flows, configuration, development progress, and remaining tasks.

### 1. Project Goal & High-Level Architecture

**Goal:** To build a modern, microservice-based Identity Governance and Administration (IGA) system that automates user lifecycle (Joiner, Mover, Leaver - JML) processes and manages user access/entitlements across various target applications based on roles and policies defined in an Access Control Matrix (ACM).

**Architecture:** The system is designed as a collection of independent **microservices**, each responsible for a specific function. These services communicate asynchronously via a **Message Queue (RabbitMQ)** for event-driven workflows and synchronously via **REST API calls** for request/response patterns (e.g., Lifecycle services requesting provisioning). Interaction with external systems (HRMS, target applications) is abstracted through **configurable connector adapters**. All system configurations and persistent data are managed centrally in dedicated databases.

**High-Level Components:**

* **Identity Collection Service (ICS):** Pulls identity data from authoritative sources (HRMS).
* **Message Queue (MQ - RabbitMQ):** Decouples services, handles event distribution and task queuing.
* **Lifecycle Services (Joiner, Mover, Leaver):** Automate access changes based on identity events and policies.
* **Provisioning Service:** Executes access changes in target applications.
* **Discovery Service:** Fetches current access state from target applications.
* **Reconciliation Logic:** Compares desired state with discovered state and triggers remediation.
* **Shared Modules:** Reusable code (Config Service, MQ Service, Models, Temporary Storage, Role Assignment).
* **Configuration Database:** Stores all system configurations, mappings, and run logs.
* **Core Data Model Database:** Stores the system's understanding of users, roles, entitlements, applications. (Currently residing in the same database as Config DB).
* **Temporary Storage (Redis):** High-speed cache for temporary data like snapshots.
* **Service Discovery (Consul):** Facilitates service registration and lookup.

### 2. Database Schema & Models

The system utilizes PostgreSQL as the primary database for storing both the Core Data Model and Configuration data. The schema is managed via Sequelize migrations (`shared/migrations/*.js`) and defined by Sequelize models (`shared/models/*.js`).

**Key Tables/Models Implemented:**

* `Users`: IGLM user profiles (UUID PK, hrmsId unique, standard attributes, metadata JSONB).
* `Applications`: Target applications integrated with the system (UUID PK, name unique, type, connectorId FK).
* `Entitlements`: Definitions of access within applications (UUID PK, name, applicationId FK, applicationEntitlementId, type, metadata JSONB).
* `Roles`: IGLM Role definitions (UUID PK, name unique, description, metadata JSONB).
* `UserRoles`: Join table for User-Role assignments (FKs to User and Role, timestamps).
* `RoleEntitlementMappings`: Join table mapping Roles to Entitlements (FKs to Role and Entitlement, assignmentType, metadata JSONB).
* `ConnectorConfigs`: Configuration for connecting to external systems (UUID PK, name, serviceType, type, sourceId FK, configuration JSONB, metadata JSONB). Unique composite index on (`name`, `serviceType`, `type`).
* `MappingConfigs`: Configuration for data/logic mappings (UUID PK, name, sourceType, targetType, serviceName, sourceId FK, mappingRules JSONB, metadata JSONB). Unique composite index on (`name`, `serviceName`).
* `CollectionRuns`: Logs of ICS runs (UUID PK, connectorConfigId FK, status, startTime, endTime, metrics JSONB, errorDetails JSONB, metadata JSONB).
* `DiscoveryRuns`: Logs of Discovery runs (UUID PK, status, startTime, endTime, metrics JSONB, errorDetails JSONB, metadata JSONB).
* `ProvisioningTasks`: Logs of provisioning requests (UUID PK, userId FK, applicationId FK, desiredState JSONB, status, startTime, endTime, results JSONB, errorDetails JSONB, metadata JSONB).
* `CurrentAppStates`: Discovered access state (UUID PK, userId FK, applicationId FK, appSpecificUserId, appSpecificEntitlementId, iglmEntitlementId FK, discoveredAt, runId FK, metadata JSONB). Composite unique index on (`applicationId`, `appSpecificUserId`, `appSpecificEntitlementId`).
* `ReconciliationResults`: Details of discrepancies (UUID PK, runId FK, discrepancyType, userId FK, applicationId FK, appSpecificUserId, appSpecificEntitlementId, iglmEntitlementId FK, details JSONB, timestamp).

### 3. Configuration Management

The system uses a **Configuration Database** (`iglm-config-db`) as the central source of truth for all system configurations.

* **`ConnectorConfigs`**: Define technical details for interacting with HRMS and target applications (connection strings, API endpoints, queries, etc.).
* **`MappingConfigs`**: Define various mapping rules:
  * HRMS attributes to IGLM User attributes (`sourceType: IdentitySource`, `targetType: User`).
  * User attributes to IGLM Roles (ACM rules, `sourceType: UserAttributes`, `targetType: Roles`).
  * IGLM Entitlement IDs to application-specific actions/IDs for provisioning (`sourceType: Provisioning`, `targetType: ApplicationEntitlements`).
  * Raw discovered data fields to `CurrentAppState` fields and IGLM entities (`sourceType: Discovery`, `targetType: DiscoveredStateMapping`).
  * Service-specific configurations (`sourceType: Service`, `targetType: Service`) like polling intervals, default connector names, Provisioning API URLs.
* **Setup Scripts (`scripts/setupConfigs.js`, `scripts/setupMatrixConfigs.js`):** Node.js scripts that use the Sequelize models to insert or update default and defined configurations into the Config Database. These scripts are crucial for initializing a new environment or applying configuration changes.

### 4. Core Logic Flows Implemented

Key automated processes are structured and implemented in the backend services:

* **Identity Collection Pipeline:**
  * ICS server schedules runs (`node-cron`).
  * `collectionLogic.js::performRun` loads configs, finds HRMS connector, loads last snapshot from Redis, loads HRMS adapter (`hrms-db-postgres.js`), calls adapter's `collectData` function to pull raw data.
  * `DeltaDetection.js::compareSnapshots` compares the current raw data against the previous snapshot (loaded from Redis) to identify Joiners, Movers, and Leavers.
  * `DataProcessor.js::processDeltas` takes the delta records, applies mapping rules (HRMS to IGLM User structure), creates/updates `User` records in the Config DB, and publishes 'joiner.new', 'mover.update', 'leaver.exit' events to the `identity.changes` MQ exchange using `MqService.publish`.
  * The new snapshot (current raw data) is saved to Redis using `TemporaryStorage.saveSnapshot`.
  * The `CollectionRun` log is updated.

* **Joiner/Mover/Leaver Lifecycle Flows:**
  * Each Lifecycle Service (`joiner-service`, `mover-service`, `leaver-service`) server sets up an MQ consumer using `MqService.subscribe` bound to the `identity.changes` exchange with specific routing keys ('joiner.new', 'mover.update', 'leaver.exit').
  * The consumer callback for each service processes the incoming event message.
  * **Joiner:** Consumes 'joiner.new' event. Uses `roleAssignmentService.determineRolesBasedOnMatrixRules` (with the Attribute-to-Role mapping config loaded at startup) to calculate the desired IGLM Roles for the new user based on their attributes. Prepares a provisioning payload containing the IGLM User ID and the list of desired IGLM Role names. Calls the Provisioning Service API (`POST /provision`) using `axios` (with retry logic) to request the provisioning of entitlements associated with those roles. Acknowledges the MQ message upon successful API call acceptance.
  * **Mover:** Consumes 'mover.update' event. Uses `roleAssignmentService` to determine the *new* set of desired IGLM Roles based on the updated user attributes. Compares the new desired roles with the user's *current* roles (likely from the Config DB User model's loaded associations). Prepares a provisioning payload to add newly required entitlements (from new roles) and remove entitlements no longer required (from old roles). Calls the Provisioning Service API (`POST /provision`) or dedicated revoke endpoints. Acknowledges MQ message upon successful API call acceptance.
  * **Leaver:** Consumes 'leaver.exit' event. The event itself signifies the user should lose all access. Prepares a provisioning payload containing the IGLM User ID (or app-specific ID for orphans) and an *empty* set of roles or an explicit list of entitlements to revoke (e.g., from Reconciliation via an explicit revoke event type). Calls the Provisioning Service API (`POST /provision/revoke`) to trigger deprovisioning of all access. Acknowledges MQ message upon successful API call acceptance.

* **Provisioning Task Processing:**
  * The Provisioning Service server sets up an MQ consumer bound to `provisioning.tasks.queue` using `MqService.subscribe`.
  * The consumer callback (`provisioningLogic.js::processProvisioningTask`) processes the task ID received in the message.
  * Loads the `ProvisioningTask` entry from the Config DB.
  * Parses the task payload to determine the `taskType` ('grant' or 'revoke') and the specific data (desired roles/entitlements for grants, explicit entitlements to revoke for revokes).
  * Loads the target `Application`, its `Provisioning Connector Config`, and its application-specific `MappingConfig` (IGLM Entitlement -> App action/ID).
  * Determines the user's identifier for the target application using the `userIdentifierMapping` rule from the app mapping config.
  * Maps the IGLM Entitlements (from desired roles for grants, or explicit list for revokes) to app-specific identifiers and actions using the app mapping config's `entitlementMappings` and default templates/operations.
  * Dynamically loads the correct Provisioning Connector Adapter (`services/provisioning-service/src/connectors/provisioning/*.js`) based on the connector config's `type`.
  * Calls the adapter's `applyDesiredState(configDetails, appSpecificDesiredState)` method, passing the adapter's configuration and the prepared list of app-specific entitlements to grant and/or revoke for the user.
  * Updates the `ProvisioningTask` status ('completed', 'failed', 'partial_success') and stores results/errors based on the adapter's response.
  * Publishes 'provisioning.task.status' events to the `provisioning.task.status` MQ exchange.

* **Discovery Pipeline & Reconciliation:**
  * Discovery Service server schedules runs (`node-cron`).
  * `discoveryLogic.js::performRun` loads configs, finds configured Applications, loads Discovery Connector/Mapping Configs per app.
  * Calls Discovery Adapter's `discoverAccess` to pull raw current access state for each application.
  * `stateStorage.js::storeDiscoveredState` takes raw discovered records, maps them to `CurrentAppState` structure, performs identity/entitlement resolution using discovery mapping rules, and **upserts** records into the `CurrentAppStates` table. Includes `removeOldState`.
  * `discoveryLogic.js` updates the `DiscoveryRun` log and publishes a `discovery.status.run.completed` event to the `reconciliation.triggers` MQ exchange.
  * The Discovery Service server also runs a **Reconciliation Worker** consuming 'reconciliation.triggers.run.completed' messages.
  * The worker callback calls `reconciliationLogic.js::performReconciliation`.
  * `reconciliationLogic.js` loads discovered state (`CurrentAppState`) for the latest run and desired state (Users with Roles/Entitlements) from the Config DB.
  * Loads relevant Provisioning Mapping Configs.
  * Compares states to identify **Violations**, **Orphaned Accounts**, and **Missing Access**.
  * Stores discrepancies in the `ReconciliationResult` table.
  * Prepares payloads for remediation (lists of entitlements to grant/revoke, user IDs).
  * Calls the Provisioning Service API (`POST /provision/revoke` for violations/orphans, `POST /provision` for missing access) using `axios` (with retry logic).
  * Publishes 'reconciliation.status' events.

### 5. Technologies Used

* **Node.js**
* **Express**
* **Sequelize** (ORM)
* **PostgreSQL** (Database)
* **RabbitMQ** (Message Queue)
* **Redis** (Temporary Storage)
* **Docker & Docker Compose** (Containerization & Orchestration)
* **npm** (Package Manager)
* `node-cron` (Scheduling)
* `axios` (HTTP Client)
* `axios-retry` (Retry Logic for Axios)
* Adapter Libraries: `ldapjs` (LDAP), `pg` (Postgres), `oracledb` (Oracle), `mysql2` (MySQL), `soap` (SOAP), `child_process`/`ssh2` (CMD Exec).
* `winston` (Structured Logging)
* `ioredis` (Redis Client)
* `json-logic-js` (Condition Engine)
* `dotenv` (Environment Variables)
* `uuid` (UUID generation)

### 6. Development Roadmap, Progress, and Outstanding

**Roadmap Phases:**

1. Foundational Setup (Complete)
2. Identity Collection Service (Structure & Core Logic Implemented)
3. Provisioning Service (Structure & Core Logic Implemented)
4. Lifecycle Services (Structure & Basic Logic Implemented)
5. Discovery Service & Reconciliation (Structure & Core Logic Implemented)
6. Frontend (Not Started)
7. Advanced Features & Refinements (Ongoing/Future)
8. Dockerization & Deployment (Blocked/Future)

**Progress Made:**

* Successful implementation of the **entire foundational layer** (Project structure, shared modules, database schema, migrations, config files, setup scripts).
* Successful implementation of the **core logic flows and structures** for **ICS, Provisioning, Joiner, Mover, Leaver, and Discovery/Reconciliation**.
* Database migrations are defined and can be applied to set up the Config DB schema correctly.
* Configuration is stored in the Config DB and loaded by services.
* Inter-service communication patterns (MQ events, API calls) are implemented.
* Robust handling of dependency connections (DB, MQ, Redis) and retries is being integrated.
* Code structures and implementations for various **Connector Adapter types** (HRMS, DB, LDAP, REST, SOAP, CMD) for both Collection and Provisioning are defined and partially/fully implemented.
* **The ICS pipeline has successfully run end-to-end** in local testing, pulling data, performing delta detection, processing deltas, saving snapshots, and attempting MQ publishing.
* **The Joiner, Mover, and Leaver services successfully start** and set up their MQ listeners, indicating their basic structure and dependency connections are working.

**Outstanding Items:**

* **Implement Connector Adapter Details:** Finish filling in the specific data collection (`discoverAccess`/`collectData`) and access modification (`applyDesiredState`) logic within *all* adapter files for *all* types. This involves writing the code that uses the external system libraries (`pg`, `ldapjs`, `axios`, `soap`, `child_process`/`ssh2`) based on the configuration.
* **Verify Data Processor Logic:** Debug the `DataProcessor.js` to ensure it correctly processes Joiners, Movers, and Leavers, maps attributes accurately based on the User Mapping config, creates/updates `User` records in the database, and publishes MQ events correctly *when deltas are present*. (The 0 delta issue needs a simulated first run to confirm this part).
* **Debug MQ Publishing:** Address the `MQ Channel is not ready for publishing.` error that occurred during the Data Processor's publishing loop. This requires ensuring the `MqService.publish` method robustly waits for the channel and that the `DataProcessor` uses the updated `MqService`.
* **Implement Reconciliation Logic Refinements:** Add policies for automatic vs. manual remediation, refine discrepancy storage if needed, add reporting/auditing capabilities.
* **Implement Frontend:** Build the user interface.
* **Comprehensive Testing:** Implement unit and integration tests. Perform full end-to-end JML and Reconciliation flow testing.
* **Address Docker Build/Deployment:** Resolve the WSL 2 filesystem issue to enable building and running services in Docker containers. Finalize Dockerfiles for all services.
* **Implement Missing Helper Modules:** (e.g., `commandOutputParser.js`).
* **Implement IGLM Entity Management:** Add scripts or an API for creating/managing `Application`, `Entitlement`, and `Role` entries in the Config DB, as these are referenced by UUIDs and names in mappings.

This documentation provides a comprehensive overview of where we stand, highlighting the significant progress in building the backend core while clearly outlining the remaining tasks to achieve a complete system.