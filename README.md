# Identity Governance and Lifecycle Management (IGLM) System

This project is building a comprehensive system for managing digital identities and access rights across an enterprise.

## Project Overview

The goal of this system is to automate and govern the lifecycle of user identities from onboarding (Joiners), through organizational changes (Movers), to offboarding (Leavers). It aims to provide centralized control over user access to various enterprise applications based on roles and policies, ensuring security, compliance, and operational efficiency.

## Table of Contents

1. [Project Goal & Overview](#project-goal--overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Core Features](#core-features)
4. [Technologies Used](#technologies-used)
5. [Database Schema Overview](#database-schema-overview)
6. [Configuration Management](#configuration-management)
7. [Setup and Installation](#setup-and-installation)
    * [Prerequisites](#prerequisites)
    * [Environment Variables](#environment-variables)
    * [Database Setup](#database-setup)
    * [Running Infrastructure](#running-infrastructure)
    * [Running Services](#running-services)
8. [Core Logic Flows](#core-logic-flows)
    * [Identity Collection Pipeline](#identity-collection-pipeline)
    * [Lifecycle Events (Joiner/Mover/Leaver)](#lifecycle-events-joinermoverleaver)
    * [Provisioning Pipeline (API & Worker)](#provisioning-pipeline-api--worker)
    * [Discovery Pipeline](#discovery-pipeline)
    * [Reconciliation](#reconciliation)
9. [Extensibility (Adding New Target Systems)](#extensibility-adding-new-target-systems)
10. [Graceful Shutdown & Error Handling](#graceful-shutdown--error-handling)
11. [Testing Strategy](#testing-strategy)
12. [Future Enhancements](#future-enhancements)

## 1. Project Goal & Overview

The **IGLM IAM System** is a microservices-based Identity Governance and Administration (IGA) platform designed to automate the user lifecycle (Joiner, Mover, Leaver - JML) and manage user access/entitlements across various target applications. It operates based on roles and policies defined in a central Configuration Database, effectively implementing an Access Control Matrix (ACM).

The system aims to provide automated access provisioning, de-provisioning, and reconciliation to ensure users have the correct access entitlements based on their current status and role within the organization.

## 2. High-Level Architecture

The system is composed of several interconnected microservices, communicating primarily asynchronously via a Message Queue (RabbitMQ) and interacting with external systems (HRMS, target applications) through configurable connector adapters. A central Configuration Database stores all system settings, connection details, mappings, and operational logs.

<!-- ```mermaid
graph TD
    A[HRMS / Authoritative Source] -->|Pull Data| ICS
    TargetApps[Target Applications / Directories]
    TargetApps -->|Pull State via Adapters| DS
    TargetApps -->|Apply Changes via Adapters| PS_Worker

    ICS[Identity Collection Service] -->|Publish Identity Events| MQ
    MQ[Message Queue (RabbitMQ)]

    MQ -->|Consume J/M/L Events| JMLServices
    JMLServices[Joiner / Mover / Leaver Services] -->|Request Provisioning via API| PS_API

    PS_API[Provisioning Service API] -->|Create Task| ConfigDB
    PS_API -->|Publish Task Event| MQ

    MQ -->|Consume Provisioning Tasks| PS_Worker[Provisioning Service Worker]
    PS_Worker -->|Load Config/Mappings| ConfigDB[Configuration Database]
    PS_Worker -->|Apply Changes| PS_Adapter[(Provisioning Adapter)]

    DS[Discovery Service] -->|Load Config/Mappings| ConfigDB
    DS -->|Store Discovered State| CoreDB
    DS -->|Publish Discovery Trigger| MQ

    MQ -->|Consume Reconciliation Trigger| REC[Reconciliation Logic / Worker]
    REC -->|Load Desired State| CoreDB[Core Data Model DB]
    REC -->|Load Discovered State| CoreDB
    REC -->|Identify Discrepancies| ConfigDB (ReconciliationResults)
    REC -->|Trigger Remediation via API| PS_API

    Shared[Shared Modules<br>(Config, MQ, Redis, Models, Roles)] --|> ICS
    Shared --|> JMLServices
    Shared --|> PS_API
    Shared --|> PS_Worker
    Shared --|> DS
    Shared --|> REC

    ConfigDB --|> Shared
    CoreDB --|> Shared
    Redis[Temporary Storage (Redis)] --|> Shared

    subgraph Infrastructure
        ConfigDB
        CoreDB
        MQ
        Redis
        % Consul (Optional)
    end
    subgraph Services
        ICS
        JMLServices
        PS_API
        PS_Worker
        DS
        REC
        Shared
    end -->

# High-Level Components

## Identity Collection Service (ICS)

* Pulls identity data from authoritative sources (e.g., HRMS).

## Message Queue (MQ)

* Facilitates asynchronous communication and event triggers.

* **RabbitMQ** is used as the message broker.

## Lifecycle Services (Joiner, Mover, Leaver)

* Consume identity change events (`joiner.new`, `mover.update`, `leaver.exit`) from the MQ.

* Orchestrate access changes by calling the **Provisioning Service API**.
* Utilize `roleAssignmentService` and **ACM rules** for access logic.

## Provisioning Service

* Receives desired state requests via its API (`/provision`, `/provision/revoke`).

* Creates `ProvisioningTask` records.
* Publishes tasks to the MQ.
* Worker processes consume these tasks to execute access changes in target applications via configurable adapters.

## Discovery Service

* Periodically pulls the current access state from target applications via configurable adapters.

* Stores the retrieved data.
* Triggers reconciliation processes.

## Reconciliation Logic

* Compares desired state (based on IGLM data) against discovered state.

* Identifies discrepancies such as:
  * Violations
  * Orphans
  * Missing Access
* Triggers remediation actions via the **Provisioning Service API**.

## Shared Modules

* Common code and models used across services:
  * `ConfigService`
  * `MqService`
  * `TemporaryStorage` (Redis)
  * Sequelize `models`
  * `roleAssignmentService`

## Configuration Database

* Stores all static and dynamic configuration data.

* Sequelize models include:
  * `ConnectorConfigs`
  * `MappingConfigs`
  * Run logs
  * Discrepancy results

## Core Data Model Database

* Stores IGLM's view of users, roles, entitlements, and applications.

* Sequelize models include:
  * `Users`
  * `Roles`
  * `Entitlements`
  * `Applications`
  * `UserRoles`
  * `RoleEntitlementMappings`
  * `CurrentAppStates`
* Typically shares the same database instance as the Configuration Database for simplicity.

## Temporary Storage (Redis)

* Used by ICS for storing snapshots to enable delta detection.

# Core Features

## Automated Joiner-Mover-Leaver (JML)

* Automates the granting, modification, and revocation of user access based on HRMS-triggered events.

## Role-Based Access Control (RBAC)

* Manages access through **IGLM Roles** mapped to specific entitlements across target applications.

## Configurable Mappings

* **MappingConfig** entries allow flexible data transformations and role-to-access mappings between systems.

## Extensible Connectors

* Adapter pattern supports seamless integration with various system types:
  * Databases
  * LDAP
  * REST APIs
  * SOAP services
  * Command Execution

## Provisioning (Grant/Revoke)

* Supports access provisioning based on assigned roles.

* Supports explicit entitlement revocation.

## Discovery

* Periodic retrieval of current access states from target systems.

## Reconciliation

* Identifies gaps between desired and actual states.

* Automatically initiates remediation processes.

## Graceful Shutdown

* Services complete ongoing tasks and close all active connections cleanly during shutdown.

## Robust Messaging

* Utilizes RabbitMQ with:
  * Publisher confirms
  * Resilient consumer patterns

## Retry Logic

* Outbound API calls have configurable retry policies to enhance reliability.

## Structured Logging

* Consistent, structured logging implemented across all services to improve observability and troubleshooting.

# Technologies Used

## Core Frameworks and Runtimes

* **Node.js**: Backend runtime environment powering all services.

* **Express**: Web application framework used for API endpoints (e.g., Provisioning Service APIs, optional health checks in other services).

## Database and Persistence

* **Sequelize**: Object-Relational Mapper (ORM) for database interactions.

* **PostgreSQL**: Primary relational database for the Core Data Model and Configuration Database.

## Messaging and Caching

* **RabbitMQ**: Message Queue broker utilized via the `amqplib` library.

* **Redis**: In-memory data store for temporary storage needs (accessed through the `ioredis` library).

## Infrastructure and Environment Management

* **Docker & Docker Compose**:
  * Defines and manages the development/infrastructure environment (databases, MQ, Redis).
  * Supports containerization of all microservices.

## Development Utilities

* **npm**: Node.js package manager for dependency management.

## Scheduled Tasks

* **node-cron**: Enables scheduling of periodic tasks, such as Identity Collection and Discovery operations.

## HTTP Communication

* **axios**: Promise-based HTTP client used for inter-service communication and RESTful adapter integrations.

* **axios-retry**: Enhances axios with automatic retry logic for improved resilience.

## External Systems Integration

* **ldapjs**: Enables communication with LDAP directories (Active Directory/LDAP adapters).

* **pg**, **oracledb**, **mysql2**: Native database drivers for PostgreSQL, Oracle, and MySQL target system adapters.
* **soap**: Library for integrating with SOAP-based web services (SOAP adapters).

## Command Execution

* **child_process / ssh2**: Used to execute CLI commands and manage remote command execution via SSH (CMD Execution adapters).

## Logging and Observability

* **winston**: Provides structured, consistent, and extensible logging across all services.

## Rules and Logic Evaluation

* **json-logic-js**: Evaluates complex conditions, particularly within Attribute-to-Role mapping and dynamic access assignments.

## Environment Configuration

* **dotenv**: Loads environment variables from `.env` files to simplify configuration across environments.

# Database Schema Overview

The system leverages a relational database (**PostgreSQL**) typically orchestrated via **Docker Compose**, with schema management handled through **Sequelize migrations**.  
Key entities and their associated models (`shared/models/*.js`) include:

## Core Entities

### Users

* Represents IGLM's authoritative view of identity data.

* Data sourced and mapped from systems like HRMS.
* Core attributes plus a `metadata` (JSONB) field for extensible, flexible data storage.

### Applications

* Defines the target systems where access is provisioned (e.g., HRMS, Active Directory, business-specific applications).

### Entitlements

* Represents granular access rights within applications (e.g., `Admin Group`, `Finance License`, `Read Permission`).

* Each entitlement is associated with an Application.

### Roles

* Centralized IGLM role definitions.

* Roles are linked to Entitlements via the `RoleEntitlementMappings` join table.

### UserRoles

* Join table tracking user-to-role assignments.

### RoleEntitlementMappings

* Join table mapping Roles to the Entitlements they encompass.

* Defines which entitlements are automatically provisioned when a role is assigned.

## Configuration Entities

### ConnectorConfigs

* Defines connection and interaction details for external systems (HRMS, applications).

* Supports service types like:
  * Identity Collection
  * Provisioning
  * Discovery
* Configuration includes:
  * Connection endpoints
  * Authentication credentials
  * Query parameters

### MappingConfigs

* Captures the transformation and logic rules between systems or internal mappings.

* Examples:
  * HRMS attributes → User attributes
  * User attributes → Roles (ACM logic)
  * IGLM Entitlements → Target System Actions
* Contains a `mappingRules` field (JSONB) defining transformation logic.
* Service-specific mapping configurations are stored here.

## Operational Logs

### CollectionRuns

* Logs each instance of an Identity Collection process.

### DiscoveryRuns

* Logs each instance of a Discovery process.

### ProvisioningTasks

* Tracks tasks generated during Lifecycle events (Joiner, Mover, Leaver) or Reconciliation.

* Captures:
  * User
  * Target Application
  * Desired State (Entitlements to grant or revoke)
  * Execution status
  * Results and any encountered errors

### CurrentAppStates

* Maintains the latest discovered access state for each user/entitlement/application combination.

* Populated by the Discovery Service.
* Used for Reconciliation to detect mismatches.

### ReconciliationResults

* Stores detailed records of discrepancies found during Reconciliation processes.

* Facilitates auditability and targeted remediation.

# Configuration Management

The system centralizes dynamic configuration in the **Configuration Database**, enabling updates without requiring code redeployment.  
This design pattern supports high agility and operational resilience across services.

## Configuration Entities

### ConnectorConfigs

* Defines connection parameters and technical details for system adapters.

* Includes endpoint URLs, authentication credentials, query templates, and connection protocols.

### MappingConfigs

A versatile configuration model supporting multiple critical mappings:

* **Identity Source Mapping**:
  * Maps raw fields from identity sources (e.g., HRMS columns) to IGLM `User` model attributes and metadata keys.

* **Attribute-to-Role Mapping (ACM)**:
  * Defines the rules matrix for assigning IGLM Roles based on User attributes.
  * Stored with:
    * `sourceType: 'UserAttributes'`
    * `targetType: 'Roles'`
  * `mappingRules` structure:
    * `attributeToRoleMapping.rules`: An array of mapping rules supporting:
      * Simple object conditions
      * `json-logic` expressions
    * `defaultRole`: Default fallback role assignment.
    * Optional `eligibleGrades` for conditional mappings.

* **Provisioning Mapping**:
  * Maps IGLM Entitlements to application-specific actions.
  * Used by Provisioning adapters to execute grants or revocations.
  * Stored with:
    * `sourceType: 'Provisioning'`
    * `targetType: 'ApplicationEntitlements'`
  * Linked to a specific Application via `sourceId`.
  * Details include:
    * SQL templates
    * LDAP operations
    * Parameter mappings for REST/SOAP interactions.

* **Discovery Mapping**:
  * Defines transformation rules for normalizing discovered data into the `CurrentAppState` structure.
  * Resolves application-specific identifiers to IGLM-standard IDs.
  * Stored with:
    * `sourceType: 'Discovery'`
    * `targetType: 'DiscoveredStateMapping'`
  * Linked to Applications by `sourceId`.

* **Service Configuration**:
  * Stores operational settings for services such as:
    * Polling intervals
    * API URLs
    * Mapping names to use during operations
  * Stored with:
    * `sourceType: 'Service'`
    * `targetType: 'Service'`
  * Linked to services by `serviceName`.

## Supporting Components

### Setup Scripts

* Location: `scripts/setupConfigs.js`

* Node.js scripts that interact with the Configuration Database using Sequelize.
* Utilize `findOrCreate` patterns to:
  * Populate initial configuration entries.
  * Ensure idempotent execution, allowing safe re-runs during deployments or upgrades.

### Configuration Service

* Location: `shared/configService.js`

* Provides a unified interface for accessing configuration entries across services.
* Features:
  * Integrated **in-memory caching** to minimize database query overhead.
  * Support for **cache invalidation** when configuration changes are detected or triggered.
  * Standardized access pattern to enhance code maintainability and service performance.

# Setup and Installation

This project is engineered to run on **Node.js** with external infrastructure components orchestrated via **Docker Compose**.

## Prerequisites

Ensure the following software components are installed on your development or deployment environment:

* **Node.js** (v18 or higher recommended)
* **npm** (typically installed alongside Node.js)
* **Docker** and **Docker Compose** (or **Docker Desktop**)
* **Git** (for repository cloning and version control)

## Environment Variables

Configuration is managed through environment variables.  
To set up the environment:

1. **Copy the Example File**:

   ```bash
   cp .env.example .env

Configure the .env File: Populate the following environment variables as per your deployment needs:

Core Services Configuration
Database Connection:

DB_HOST

DB_PORT

DB_NAME

DB_USER

DB_PASSWORD

Message Queue:

MESSAGE_QUEUE_URL (RabbitMQ connection string)

Redis Connection:

REDIS_URL

REDIS_PASSWORD

Service Ports:

IDCS_PORT (Identity Collection Service)

JOINER_PORT (Joiner Service)

MOVER_PORT (Mover Service)

LEAVER_PORT (Leaver Service)

PROVISIONING_PORT (Provisioning Service)

DISCOVERY_PORT (Discovery Service)

Logging:

LOG_LEVEL (e.g., debug, info, warn, error)

Inter-Service Communication
Provisioning Service API:

PROVISIONING_SERVICE_API_URL

Used by the Joiner, Mover, Leaver, and Reconciliation components.

(Optional) Adapter-Specific Configuration
Connection details for target systems, depending on enabled adapters:

HRMS_DB_HOST

FINANCE_APP_DB_HOST

LDAP_URL

Other application-specific connection parameters as required.

# Database Setup

The database schema and initial configurations are managed using **Sequelize migrations** and **setup scripts**.

## Run Database Migrations

1. Ensure your database container is running.
2. Navigate to the project root.
3. Execute the following commands:

npm install  # Install project dependencies if not already installed

npx sequelize-cli db:migrate --url postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME

# Core Logic Flows

This section outlines the main data and event flows within the system.

---

# Identity Collection Pipeline

The Identity Collection pipeline is scheduled to run periodically (e.g., via `node-cron` in ICS).

## Orchestration (`identity-collection-service/src/collectionLogic.js`)

The orchestration process follows these steps:

1. **Load Configurations**:
   * Retrieves the ICS service configuration, HRMS connector configuration, and HRMS-to-User mapping configuration from the **Config DB** via `ConfigService`.

2. **Load Previous Snapshot**:
   * Fetches the previous data snapshot from **Redis** (`TemporaryStorage`).

3. **Pull Current Identity Data**:
   * Calls the configured **HRMS Connector Adapter** (`services/identity-collection-service/src/connectors/identity-collection/*.js`) to pull current identity records from HRMS.

4. **Delta Detection**:
   * Executes `deltaDetection.js` to compare current HRMS data against the previous snapshot.
   * Identifies:
     * **Joiners** (new users)
     * **Movers** (modified users)
     * **Leavers** (missing users)

5. **Process Deltas**:
   * Handles detected deltas using `dataProcessor.js`.

6. **Save Current Snapshot**:
   * Updates Redis with the current data snapshot for use in the next run.

7. **Log Collection Run**:
   * Updates the `CollectionRun` log in the Config DB with metrics (e.g., number of Joiners, Movers, Leavers) and status information.

---

## HRMS Connector Adapter

Located at: `services/identity-collection-service/src/connectors/identity-collection/*.js`

Responsibilities:

* Connects to the HRMS based on **ConnectorConfig** parameters.
* Executes a configured query:
  * Full extraction
  * Incremental extraction (based on the last run timestamp)
* Returns raw identity data as an array of objects.

---

## Data Processor (`services/identity-collection-service/src/dataProcessor.js`)

Responsibilities:

* Receives raw HRMS records and the associated **HRMS-to-User MappingConfig**.
* Applies mapping rules to transform raw records into the standard **IGLM User model** format:
  * Populates core user attributes.
  * Maps and structures metadata.
  * Derives and validates user status (e.g., active, inactive).
* Performs validation and filtering based on the User model schema.

### Processing Detected Deltas

For each identified delta:

* **Joiner**:
  * `findOrCreate` a new user record in the Core Data Model DB (`models.User`).
* **Mover**:
  * Update existing user attributes.
* **Leaver**:
  * Update user status to indicate exit/termination.

Additionally:

* **Event Publication**:
  * Publishes an event message to the `identity.changes` exchange on the MQ via `MqService.publish`.
    * Event types:
      * `joiner.new`
      * `mover.update`
      * `leaver.exit`

---

# Lifecycle Events (Joiner/Mover/Leaver)

These services operate as workers, consuming events published by the Identity Collection Service (ICS).

---

# Listener Setup

Located in:  

* `services/joiner-service/src/server.js`
* `services/mover-service/src/server.js`
* `services/leaver-service/src/server.js`

The listener setup process follows these steps:

1. **Initialize Configurations**:
   * Load service-specific configurations, including:
     * Provisioning Service API URL
     * Attribute-to-Role MappingConfig name

2. **Initialize MqService**:
   * Await `MqService.waitForChannel()` to establish connection with RabbitMQ.

3. **Exchange and Queue Setup**:
   * Assert the `identity.changes` exchange.
   * Assert the service-specific queue:
     * `joiner.events.queue`
     * `mover.events.queue`
     * `leaver.events.queue`
   * Bind the queue to the exchange using the appropriate routing key:
     * `joiner.new`
     * `mover.update`
     * `leaver.exit`

4. **Start Message Consumption**:
   * Begin consuming messages from the bound queue using `MqService.channel.consume`.
   * **Manual acknowledgement** mode is enabled (`noAck: false`).

---

# Message Processing Callback

When a message is consumed, the processing logic is as follows:

1. **Parse Received Message**:
   * Extract and parse the incoming `msg` payload.

2. **Validation**:
   * If the message is malformed:
     * Log the error.
     * Acknowledge (`ack`) the message to remove it from the queue.

3. **Process Valid Events**:
   * For events like `joiner.new`, `mover.update`, or `leaver.exit`:

### Joiner / Mover

* Use `roleAssignmentService.determineRolesBasedOnMatrixRules`:
  * Input: `userData` and Attribute-to-Role MappingConfig.
  * Output: Desired roles for the user.
* Prepare the desired state payload (user with new roles).

### Leaver

* Prepare a desired state payload with an **empty list of roles** (full access revocation).

4. **Provisioning API Call**:
   * Call the Provisioning Service API endpoint:
     * `/provision` or `/provision/revoke`
   * Utilize `axios.post` with built-in retry logic (via `axios-retry`).

5. **Acknowledgement Handling**:

* **On Success (HTTP 202 Accepted)**:
  * `ack` the message to confirm successful processing.

* **On Permanent Failure (non-retryable)**:
  * Log the error.
  * `nack` the message without requeue (`false, false`) to send it to the **Dead Letter Queue (DLQ)** for investigation.

* **On Transient or Unexpected Errors**:
  * Log the exception.
  * `nack` the message without requeue to DLQ.

# Provisioning Pipeline (API & Worker)

This service provides the API endpoint for requesting provisioning actions and includes a worker that executes the tasks.

---

## API Endpoints

**Location:** `services/provisioning-service/src/server.js`

### POST `/provision`

* **Description:** Accepts a desired state payload (e.g., `{ userId: '...', roles: [...] }`).
* **Process:**
  * Validates the payload and the user/application IDs in the Core DB.
  * Creates a `ProvisioningTask` record in the DB (type: `'grant'`).
  * Publishes a message with the task ID to the `provisioning.tasks` exchange (using `routingKey: task.new`) via `MqService.publish`.
  * Responds with `202 Accepted` and returns the task ID.

### POST `/provision/revoke`

* **Description:** Accepts an explicit revocation payload (e.g., `{ userId: '...', applicationId: '...', appSpecificUserId: '...', entitlementsToRevoke: [...] }`).
* **Process:**
  * Validates the payload and the user/application IDs.
  * Creates a `ProvisioningTask` record (type: `'revoke'`).
  * Publishes a message with the task ID to the MQ.
  * Responds with `202 Accepted` and the task ID.

### Additional Features

* Basic request logging implemented.
* Error handling for immediate API responses.

---

## Provisioning Task Worker

**Location:** `services/provisioning-service/src/server.js` & `services/provisioning-service/src/provisioningLogic.js`

### Functionality

* Sets up a consumer for the `provisioning.tasks.queue`.
* Upon receiving a message containing a `taskId`:
  * Calls `ProvisioningLogic.processProvisioningTask(taskId, options)`.
  * Awaits the result of processing.
  * **If successful:** Acknowledges (`ack`) the message in MQ.
  * **If error occurs:** Rejects (`nack`) the message and sends it to a Dead Letter Queue (DLQ).

---

## Provisioning Logic

**Location:** `services/provisioning-service/src/provisioningLogic.js`

Handles the core business logic for processing provisioning and revocation tasks based on the taskId received from the worker.

---

---

<!-- processProvisioningTask(taskId, options) function:
Loads the ProvisioningTask record from the DB by ID.
Checks/updates the task status ('pending' -> 'in_progress').
Loads the User model and relevant associations (Roles, Entitlements, Applications) from the Core DB for context (optional for revoke tasks).
Analyzes the task.desiredState payload to determine the taskType ('grant' or 'revoke').
Based on the taskType:
Grant: Derives the list of IGLM Entitlements to grant by iterating through the user's roles and their linked entitlements. Groups these by Application ID.
Revoke: Uses the explicit list of entitlements to revoke provided in the task.desiredState.payload.entitlementsToRevoke. Groups these by Application ID.
Iterates through the unique applications affected:
Loads the Application's ConnectorConfig (Provisioning type) and MappingConfig (Provisioning type, linked to Application ID) using ConfigService. Includes cache clearing.
Determines the user's application-specific identifier (userIdInApp) using a helper function and the mapping config.
Maps the IGLM Entitlements (to grant/revoke) to the specific format expected by the adapter (app-specific IDs, template names, operation types) using the application mapping config, falling back to Entitlement model data or defaults.
Dynamically loads the correct Provisioning Connector Adapter module based on ConnectorConfig.type.
Calls the adapter's async applyDesiredState(connectorConfig.configuration, appSpecificDesiredState) method, passing connection details and the prepared lists of entitlements to grant/revoke for that user in that specific application.
Collects the results and errors returned by the adapter per application.
Determines the overall task status ('completed' or 'failed') based on whether all applications succeeded.
Updates the ProvisioningTask record in the DB with the final status, end time, detailed results, and errors per application.
Publishes a 'provisioning.task.status' event (task.completed or task.failed routing key) to the MQ using MqService.publish.
Includes robust error handling throughout, logging failures at each step.

Provisioning Connector Adapters (services/provisioning-service/src/connectors/provisioning/*.js):

Implement the async applyDesiredState(configDetails, appSpecificDesiredState) function.
configDetails contains connection info from ConnectorConfig.configuration.
appSpecificDesiredState contains userIdInApp, entitlementsToGrant, entitlementsToRevoke.
Connects to the target system (using specified libraries and configDetails).
Iterates through entitlementsToGrant and entitlementsToRevoke.
For each entitlement, uses the appSpecificEntitlementId, mappingDetails (template/operation type), and userIdInApp to execute the corresponding action (e.g., run SQL query, make LDAP modification, call REST API).
Tracks the success or failure of each individual operation.
Returns a result object (e.g., { success: boolean, operations: [...] }) back to provisioningLogic.js.
Adapters managing connections/pools should register a cleanup function with ProvisioningLogic.registerCleanup(async () => { ... close connections ... }); during their own initialization.
Discovery Pipeline
This pipeline is scheduled to run periodically. -->

# Provisioning Logic and Connector Architecture

This document elaborates the core function `processProvisioningTask(taskId, options)` and its interaction with Provisioning Connector Adapters.

---

## processProvisioningTask(taskId, options)

### Overview

Responsible for orchestrating the provisioning or revocation lifecycle based on the received task.

### Processing Steps

1. **Load Task Record**
   * Loads the `ProvisioningTask` record from the DB by its ID.

2. **Update Task Status**
   * Transitions task status from `'pending'` to `'in_progress'`.

3. **Load User Context (optional for revoke tasks)**
   * Loads the User model and related associations (Roles, Entitlements, Applications) from the Core DB.

4. **Analyze Payload**
   * Determines `taskType` from the task's `desiredState` payload (`'grant'` or `'revoke'`).

5. **Entitlement Mapping**
   * **Grant Flow:** Derives IGLM Entitlements based on the user's roles and their linked entitlements. Groups by Application ID.
   * **Revoke Flow:** Uses the explicit entitlements list provided in `desiredState.payload.entitlementsToRevoke`. Groups by Application ID.

6. **Per Application Processing**
   For each unique application affected:
   * Loads **ConnectorConfig** and **MappingConfig** using `ConfigService`, including cache clearing.
   * Determines user's application-specific identifier (`userIdInApp`) via helper functions.
   * Maps IGLM Entitlements to application-specific formats using MappingConfig or defaults.

7. **Adapter Invocation**
   * Dynamically loads the appropriate Provisioning Connector Adapter based on `ConnectorConfig.type`.
   * Calls the adapter's `async applyDesiredState(connectorConfig.configuration, appSpecificDesiredState)` method.

8. **Results Collection**
   * Aggregates results and errors returned per application.
   * Determines overall task status: `'completed'` if all succeeded, `'failed'` otherwise.

9. **Task Update**
   * Updates the ProvisioningTask record in DB: final status, end time, results, and errors.

10. **Event Publishing**
    * Publishes a `provisioning.task.status` event (`task.completed` or `task.failed`) to the MQ using `MqService.publish`.

11. **Error Handling**
    * Robust error handling and logging implemented at each step.

---

## Provisioning Connector Adapters

**Location:** `services/provisioning-service/src/connectors/provisioning/*.js`

### Responsibilities

* Implement `async applyDesiredState(configDetails, appSpecificDesiredState)`.
* **Inputs:**
  * `configDetails`: Connection information from `ConnectorConfig.configuration`.
  * `appSpecificDesiredState`: Contains `userIdInApp`, `entitlementsToGrant`, and `entitlementsToRevoke`.

### Adapter Workflow

* Connect to the target system (e.g., database, LDAP, REST API) using `configDetails`.
* Iterate over entitlements to **grant** and **revoke**.
* For each operation:
  * Utilize `appSpecificEntitlementId`, `mappingDetails` (template/operation type), and `userIdInApp` to execute the operation.
* Track and record success/failure per entitlement.
* Return a results object (e.g., `{ success: boolean, operations: [...] }`) back to `provisioningLogic.js`.

### Connection Management

* Adapters managing their own connection pools must register a cleanup function using:

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

Orchestration (services/discovery-service/src/server.js & discoveryLogic.js):

<!-- Scheduler (node-cron) triggers discoveryLogic.performRun.
discoveryLogic.performRun:
Loads Discovery Service config.
Finds configured target Applications marked for Discovery.
Iterates through each Discoverable Application:
Loads the Application's ConnectorConfig (Discovery type) and MappingConfig (Discovery type, linked to Application ID) using ConfigService.
Dynamically loads the Discovery Connector Adapter module (services/discovery-service/src/connectors/discovery/*.js).
Calls the adapter's async discoverAccess(connectorConfig.configuration, mappingRules, lastRunTimestamp) method.
Receives raw discovered data (array of objects).
Calls stateStorage.storeDiscoveredState to map, resolve identities/entitlements, and upsert records into CurrentAppStates.
Updates the DiscoveryRun log.
After all applications are discovered, publishes a 'discovery.status' event (reconciliation.triggers.run.completed routing key) to the MQ.
Discovery Adapters (services/discovery-service/src/connectors/discovery/*.js):

Implement the async discoverAccess(configDetails, mappingRules, lastRunTimestamp) function.
configDetails contains connection info.
mappingRules is the application's Discovery mapping config.
lastRunTimestamp is for incremental pulls.
Connects to the target system.
Executes queries/API calls/commands based on configDetails and mappingRules.
Returns raw discovered data (array of objects), where each object represents a user's access item in a format native to the target application.
State Storage (services/discovery-service/src/stateStorage.js):

storeDiscoveredState function:
Receives raw discovered records for an application, relevant mapping config, and the DiscoveryRun ID.
Maps raw records to a standard format expected by CurrentAppStates using the mapping config.
Performs identity resolution: Attempts to map the app-specific user ID to an IGLM User ID (e.g., by looking up the app ID in User.metadata or a dedicated mapping table).
Performs entitlement resolution: Attempts to map the app-specific entitlement ID to an IGLM Entitlement ID.
Upserts (inserts or updates) records into the CurrentAppStates table linked to the DiscoveryRun.
Includes logic to identify and mark old CurrentAppStates records (from previous runs) that were not seen in the current run as inactive or delete them, effectively showing access that was removed in the target system.
Reconciliation
Reconciliation is triggered by the Discovery Service completing a run. -->

# Discovery Service Orchestration and Architecture

This document outlines the orchestration flow, discovery adapters, and state storage mechanics for the Identity Governance Lifecycle Management (IGLM) Discovery Service.

---

## Orchestration

**Location:** `services/discovery-service/src/server.js` & `services/discovery-service/src/discoveryLogic.js`

### Scheduler Trigger

* A `node-cron` scheduler triggers `discoveryLogic.performRun` at defined intervals.

### discoveryLogic.performRun Steps

1. **Load Configuration**
   * Loads the Discovery Service configuration settings.

2. **Identify Target Applications**
   * Finds applications configured for discovery (marked as Discoverable).

3. **Discovery Execution for Each Application**
   * Loads the application's `ConnectorConfig` (Discovery type) and `MappingConfig` (Discovery type) via `ConfigService`.
   * Dynamically loads the appropriate Discovery Connector Adapter from `services/discovery-service/src/connectors/discovery/*.js`.
   * Calls the adapter’s `async discoverAccess(connectorConfig.configuration, mappingRules, lastRunTimestamp)` method.
   * Receives raw discovered data (an array of objects).

4. **State Storage**
   * Calls `stateStorage.storeDiscoveredState` to map, resolve, and persist discovered access information into `CurrentAppStates`.

5. **DiscoveryRun Logging**
   * Updates the `DiscoveryRun` log with execution details.

6. **Completion Event Publishing**
   * After all applications are processed, publishes a `discovery.status` event (`reconciliation.triggers.run.completed`) to the Message Queue (MQ).

---

## Discovery Adapters

**Location:** `services/discovery-service/src/connectors/discovery/*.js`

### Responsibilities

* Implement `async discoverAccess(configDetails, mappingRules, lastRunTimestamp)`.

### Inputs

* `configDetails`: Connection parameters for the target system.
* `mappingRules`: Application-specific Discovery Mapping Config.
* `lastRunTimestamp`: Timestamp to support incremental discovery (fetch only updates since the last run).

### Adapter Workflow

* Connect to the target system using `configDetails`.
* Execute queries, API calls, or command executions based on `mappingRules`.
* Return **raw discovered data** as an array of objects, with each object representing a user's access item in the native format of the target application.

---

## State Storage

**Location:** `services/discovery-service/src/stateStorage.js`

### storeDiscoveredState Function

* **Input:** Raw discovered records, application mapping config, and the active DiscoveryRun ID.

### Responsibilities

1. **Mapping to Standard Format**
   * Maps raw discovery records to a standard schema expected by `CurrentAppStates` using the mapping config.

2. **Identity Resolution**
   * Attempts to resolve the application-specific user ID to an IGLM User ID.
   * Uses `User.metadata` or a dedicated mapping table for resolution.

3. **Entitlement Resolution**
   * Attempts to map application-specific entitlement IDs to IGLM Entitlement IDs.

4. **Upsert into CurrentAppStates**
   * Inserts new records or updates existing ones tied to the DiscoveryRun.

5. **Handle Deletions/Inactive Access**
   * Identifies and flags records from previous runs that are no longer present in the current discovery run.
   * Marks them as inactive or deletes them, reflecting removed access in the target system.

---

## Reconciliation Trigger

Upon successful completion of the Discovery Run, the system triggers a Reconciliation Pipeline by publishing the `reconciliation.triggers.run.completed` event.

---

# Reconciliation Service Architecture

This document details the Reconciliation Worker process and the logic that drives compliance reconciliation based on the latest Discovery Run.

---

## Reconciliation Worker

**Location:** `services/discovery-service/src/server.js`

### Responsibilities

* Sets up a consumer for the `reconciliation.triggers.run.completed` queue.

* Upon receiving a message containing `latestDiscoveryRunId`:
  * Calls `reconciliationLogic.performReconciliation(latestDiscoveryRunId, options)`.
  * Awaits the reconciliation result.
  * Acknowledges (`ack`) the message if successful.
  * Rejects (`nack`) the message if processing fails.

---

## Reconciliation Logic

**Location:** `services/discovery-service/src/reconciliationLogic.js`

### performReconciliation(latestDiscoveryRunId, options) Function

#### Main Steps

1. **Load Discovered State**
   * Fetches `CurrentAppStates` for the latest Discovery Run from the Core DB.

2. **Load Desired State**
   * Retrieves the intended users and entitlements structure based on Role assignments from the Core DB.

3. **State Comparison**
   * Compares the discovered state against the desired state to identify inconsistencies:
     * **Violations (Excess Access):** Access found that should not exist.
     * **Orphaned Accounts:** Discovered access records that cannot be associated with any known IGLM User ID.
     * **Missing Access:** Desired entitlements that are missing in the discovered records.

4. **Result Storage**
   * Stores identified discrepancies into the `ReconciliationResult` table for tracking and audit purposes.

5. **Remediation Triggering**
   * Prepares specific payloads for each type of discrepancy:
     * **Violations & Orphaned Accounts:** Payloads to revoke excessive access.
     * **Missing Access:** Payloads to provision the missing entitlements.

6. **Provisioning Service API Calls**
   * Executes remediation actions via the Provisioning Service:
     * `POST /provision/revoke` for Violations and Orphaned Accounts.
     * `POST /provision` for Missing Access.
   * Utilizes `axios.post` to interact with the Provisioning APIs.

7. **Event Publishing**
   * Publishes reconciliation result events to the MQ:
     * `reconciliation.task.completed` (on success).
     * `reconciliation.task.failed` (on failure).

---

# Extensibility: Adding New Target Systems

The IGLM system's architecture is intentionally designed for extensibility, enabling seamless integration of new target applications through connector adapters and configuration-driven onboarding.

---

## Integration Workflow

### 1. Implement Connector Adapters

* **Discovery Adapter:**
  * Create a new file (e.g., `my-new-app.js`) in:

    ```
    services/discovery-service/src/connectors/discovery/
    ```

  * Implement the following function:

    ```javascript
    async discoverAccess(configDetails, mappingRules, lastRunTimestamp)
    ```

* **Provisioning Adapter:**
  * Create a new file (e.g., `my-new-app.js`) in:

    ```
    services/provisioning-service/src/connectors/provisioning/
    ```

  * Implement the following function:

    ```javascript
    async applyDesiredState(configDetails, appSpecificDesiredState)
    ```

* **Connection and Cleanup Requirements:**
  * Adapters must use the provided `configDetails` for connection establishment.
  * Adapters must properly manage and close persistent connections or connection pools.
  * Register cleanup functions via:

    ```javascript
    ProvisioningLogic.registerCleanup(async () => { ... });
    DiscoveryLogic.registerCleanup(async () => { ... });
    ```

---

### 2. Define Configuration Entries

* **Create Application Entry:**
  * Insert a new Application entry into the Core DB representing the target application.

* **Create ConnectorConfig Entries:**
  * Insert two entries in the Config DB:
    * **Discovery type ConnectorConfig**
    * **Provisioning type ConnectorConfig**
  * Link both to the Application and specify the `type` property to match the adapter file names.
  * Include all connection details in the `configuration` (JSONB format).

* **Create MappingConfig Entries:**
  * Define Discovery and Provisioning MappingConfig entries.
  * Link them to the Application ID.
  * Establish `mappingRules` for data format and entitlement/action mapping between IGLM and the target application.

---

### 3. Update Setup Script

* Update the `scripts/setupConfigs.js` file to automate onboarding:
  * Add creation/update logic for the new Application, ConnectorConfig, and MappingConfig entries.
  * Use `findOrCreate` patterns and correctly link all related IDs.

---

### 4. Restart Services

* **Restart the following services:**
  * Discovery Service
  * Provisioning Service
  * Any other dependent services

* Upon restart, services will:
  * Load new configuration entries from the database.
  * Dynamically detect and invoke the newly created connector adapters.

---

## Summary

This extensibility model ensures rapid, low-risk onboarding of new target systems into the IGLM ecosystem without the need for service re-deployment or codebase modifications beyond the addition of properly implemented and registered adapters.

---

<!-- 10. Graceful Shutdown & Error Handling
Services are designed for robustness and graceful termination:

Graceful Shutdown: Handled by listening for SIGTERM and SIGINT signals. The gracefulShutdown function in each service's server.js stops message consumption, waits for active message processing tasks to complete (with a timeout), closes the HTTP server, and then closes connections to all external dependencies (Config DB, MQ channel/connection, Redis, and target application pools via ProvisioningLogic.shutdown/DiscoveryLogic.shutdown).
Winston Logging: Structured logging is used across all services for better visibility and debugging.
Axios Retry: Configured globally for outbound HTTP calls to handle transient network issues, with awareness of shutdown state.
MQ Handling: MqService provides connection/channel resilience and publish/subscribe methods that handle waiting for readiness internally. Consumers use manual ack/nack with false, false (no immediate requeue) to integrate with DLQ/DLX for robust retries of failed messages.
Global Error Handlers: process.on('uncaughtException') and process.on('unhandledRejection') are configured to log critical errors and initiate graceful shutdown.
Task/Run Logging: CollectionRun, DiscoveryRun, ProvisioningTask, and ReconciliationResult models store logs, metrics, results, and errors for each operation instance in the database for audit and monitoring. -->

# Testing Strategy

The testing methodology for the IGLM ecosystem adopts a structured, phased approach, ensuring verification of infrastructure, services, and integrations incrementally as components are built.

---

## Testing Phases

### Phase 0: Infrastructure & Configs

* **Objective:** Confirm that the foundational infrastructure and configurations are operational.
* **Tasks:**
  * Verify all infrastructure services are up and running.
  * Validate that the Config DB is correctly populated with initial entries.
* **Status:** ✅ Completed.

---

### Phase 1: Identity Collection Service (ICS) Isolation

* **Objective:** Validate the ICS service in isolation.
* **Tasks:**
  * Test data pulling from HRMS or identity sources.
  * Verify delta detection and snapshotting mechanisms.
  * Confirm MQ message publication (inspect via MQ UI).
* **Status:** 🔄 Ready for Verification.

---

### Phase 2: Lifecycle Services + Provisioning API

* **Objective:** Validate Joiners, Movers, Leavers (JML) and Provisioning API integrations.
* **Tasks:**
  * Test JML and Leaver modules consuming events.
  * Verify Role Assignment workflows.
  * Confirm successful API calls to the Provisioning Service.
  * Validate that Provisioning Tasks are created and queued in DB and MQ.
* **Preconditions:** Provisioning Service API must be running.

---

### Phase 3: Provisioning Worker + Adapter Execution

* **Objective:** Verify task execution by the Provisioning Worker and Adapter functionality.
* **Tasks:**
  * Test the Worker consuming tasks from MQ.
  * Verify adapter invocations and correct execution.
  * Validate actions on target systems or mock systems.
* **Preconditions:** Target systems or mock endpoints and fully implemented Adapters.

---

### Phase 4: Discovery Service + Reconciliation

* **Objective:** Test Discovery and Reconciliation end-to-end integration.
* **Tasks:**
  * Run Discovery Service to pull current state.
  * Store discovered access states properly.
  * Trigger Reconciliation logic.
  * Identify and store discrepancies (Violations, Orphans, Missing Access).
  * Verify Remediation actions triggered through the Provisioning API.
* **Preconditions:** Target systems/mocks operational; Provisioning Service API running.

---

### Phase 5: End-to-End Flow

* **Objective:** Validate the complete operational pipeline.
* **Tasks:**
  * Simulate an HRMS change (e.g., a new hire, role change).
  * Walk the change through ICS, Lifecycle Services, Provisioning, Discovery, Reconciliation.
  * Confirm updates propagated to the target systems.
  * Ensure discrepancies are detected and auto-remediated.

---

## Summary

This phased strategy mitigates risk by progressively validating each component and its integration touchpoints before full system-wide testing. It ensures quality assurance across microservices, workflows, data propagation, and external system interactions.

---

## Key principles guiding the development include

* **Microservices Architecture:** Breaking down functionality into independent, scalable services.
* **High Configurability:** Enabling administrators to define workflows, mappings, and connectors via a user interface without code changes.
* **Agnostic Connectors:** Supporting integration with diverse applications (modern APIs, legacy systems) and HRMS platforms.
* **Declarative Provisioning:** Defining desired states of access rather than imperative steps.
* **Centralized Identity Store:** Leveraging HRMS as the primary source of identity truth.

## Architecture

The system is designed as a set of interacting microservices, orchestrated via message queues and potentially service discovery.

* **Backend:** Node.js with Express.js
* **Frontend:** Next.js (Self-Service Portal & Admin UI)
* **Database:** PostgreSQL (for Core Data, Configuration, and Service-specific persistence)
* **ORM:** Sequelize
* **Message Queue:** RabbitMQ (or Kafka)
* **Containerization & Orchestration:** Docker and Kubernetes

## Current State (Phase 1: Foundational Setup Completed)

As of now, the foundational infrastructure and database schema are in place.

* **Project Structure:** The basic monorepo directory structure (`services/`, `shared/`, `frontend/`, `config/`, `deploy/`) has been established.
* **.env Configuration:** Environment variable loading is set up for local development.
* **Shared Modules (`shared/`):** Core reusable components are implemented:
  * `configService`: Handles connecting to the central PostgreSQL database and loading configurations.
  * `mqService`: Provides a basic interface for connecting to and interacting with the Message Queue (RabbitMQ).
* **Database Schema:** The complete database schema has been defined and migrated using Sequelize. This includes tables for:
  * `Users`: Core identity attributes (linked to HRMS via `hrmsId`).
  * `Applications`: Details about integrated target applications.
  * `Entitlements`: Specific access rights within applications.
  * `Roles`: Logical groupings of entitlements.
  * `UserRoles`: Links Users to Roles (many-to-many).
  * `RoleEntitlementMappings`: Links Roles to Entitlements (many-to-many).
  * `ConnectorConfigs`: Stores configurable details for connecting to HRMS and applications.
  * `MappingConfigs`: Stores configurable rules for transforming data and assigning roles/entitlements.
  * `CollectionRuns`: Logs for HRMS data collection processes.
  * `DiscoveryRuns`: Logs for application account/entitlement discovery processes.
    All tables use UUID primary keys, and relationships are enforced with foreign key constraints.

## Getting Started (For Development)

1. **Clone the repository.**
2. **Set up your environment variables:** Create a `.env` file in the project root based on the provided example and your database/MQ credentials.
3. **Start Infrastructure Containers:** Use Docker Compose (defined in `deploy/`) to run your PostgreSQL, RabbitMQ, Redis, and Consul containers. (Requires Docker and Docker Compose installed).

    ```bash
    # From the project root iglm-system/
    docker-compose -f deploy/docker-compose.yml up -d
    ```

4. **Enable PostgreSQL Extension:** Connect to your PostgreSQL database and ensure the `uuid-ossp` extension is enabled if not already:

    ```sql
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    ```

5. **Run Database Migrations:** Navigate to the `shared` directory and apply all database migrations:

    ```bash
    cd shared
    npx sequelize-cli db:migrate
    # Ensure all migrations run successfully
    npx sequelize-cli db:migrate:status # Should show all migrations as 'up'
    cd .. # Go back to root
    ```

6. **Install Dependencies:** Install dependencies for the shared module and any initialized services.

    ```bash
    cd shared
    npm install # Already done, but good practice
    cd ../services/identity-collection-service
    npm install # Just done, but good practice
    # Repeat for other service directories as they are initialized
    cd ../../
    ```

## Next Steps

The project will now proceed with building the individual microservices, starting with:

1. **Phase 2: Identity Collection Service:** Implement logic to use `ConnectorConfig` and `MappingConfig` to pull HRMS data, detect changes, and publish events.
2. **Phase 3: Core Provisioning Service:** Implement logic to use `ConnectorConfig` and `MappingConfig` to apply desired access states in target applications.
3. **Phase 4: Lifecycle Services:** Build the Joiner, Mover, and Leaver services to consume MQ events and orchestrate provisioning/deprovisioning via the Provisioning Service.
4. **Phase 5: Self-Service Portal & Admin UI:** Develop the Next.js frontend for user requests, reporting, and configuration management.
5. **Phase 6: Connector Development:** Build concrete adapter implementations for specific HRMS and application types.

# Steps to Test the Identity Collection Service (ICS) Pipeline (Running Locally)

This guide outlines a structured approach to verify the ICS pipeline functionality in a local development environment.

---

## 1. Start Infrastructure Containers

Ensure Docker Desktop (or Docker Engine) is running. Launch the necessary infrastructure containers using your `docker-compose.yml` file. Required services include:

* `config-db` (Postgres for Config DB)
* `rabbitmq`
* `redis`
* `hrms-db` (Postgres for Mock HRMS DB)
* `consul` (optional, recommended for service discovery)

Open a terminal at the project root (`iglm-system/`) and run:

```bash
docker compose -f deploy/docker-compose.yml up -d config-db rabbitmq redis hrms-db consul
```

**Note:** If `hrms-db` service is not yet defined in your compose file, refer to previous instructions to add it correctly.

---

## 2. Populate Configuration Database

Run the setup script to insert all required configuration entries into the Config DB.

```bash
node scripts/setupConfigs.js
```

* Connects to `config-db` container (localhost:${DB_PORT}).
* Ensures Applications, ConnectorConfigs, MappingConfigs, and policies are populated.

---

## 3. Populate Mock HRMS Database

If you mounted an initialization script (`init-hrms-db.sql`) for the `hrms-db` container, it should automatically populate the mock HRMS database at startup.

If not:

* Manually connect to the `hrms-db` Postgres container.
* Execute SQL commands to:
  * Create required schemas/tables/views.
  * Insert mock HRMS data (e.g., Alice, Bob, Charlie).

This ensures the ICS Connector will find records during data collection.

---

## 4. Start Identity Collection Service Locally

Navigate to the ICS service directory and start the Node.js process:

```bash
cd services/identity-collection-service
node src/server.js
```

---

## 5. Monitor Service Logs

Watch the terminal output for the following logs indicating successful initialization and operations:

* Service starting.
* ConfigService initialized.
* MqService connected.
* Temporary Storage initialized.
* Service configurations loaded.
* Attribute-to-Role Mapping config loaded.
* Data collection scheduler started.
* Collection run starting.
* HRMS Connector Config loaded.
* Mapping Config loaded.
* HRMS Connector adapter loaded.
* Data pulled from HRMS (record counts logged).
* Previous snapshot loaded.
* Deltas found (joiners, movers, leavers).
* Deltas processed and published.
* New snapshot saved.
* Collection run finished.

---

## 6. Additional Monitoring

* **RabbitMQ Management UI:** Access at `http://localhost:15672` to verify message publishing.
* **Postgres Logs (Config DB):** Confirm database connections and operations.

---

## Conclusion

Executing these steps will validate the ICS pipeline end-to-end, ensuring infrastructure readiness, configuration integrity, connector functionality, delta detection, and event publishing.

---

---

# Future Enhancements

This section outlines strategic next steps and expansion areas identified to elevate the current IGLM Identity and Access Management (IAM) system to production-grade maturity.

---

## Key Areas for Future Development

### 1. Complete Adapter Implementations

* Develop detailed connector logic for all supported target application types within the placeholder adapter files.
* Target systems include:
  * LDAP
  * Various relational databases (PostgreSQL, MySQL, Oracle)
  * RESTful APIs
  * SOAP services
  * Command-line interface (CMD) integrations

### 2. Implement Missing Helpers

* Finalize utility modules such as:
  * `commandOutputParser.js`
  * Other auxiliary parsers, mappers, or transformers needed for robust operation.

### 3. Refine Reconciliation Logic

* Introduce advanced remediation policies:
  * **Auto-Remediation:** Immediate automated corrections.
  * **Manual Review:** Flagging discrepancies for human validation.
* Enhance the linkage of remediation task IDs to specific discrepancies for traceability.
* Improve discrepancy reporting granularity for better operational oversight.

### 4. Implement Frontend (Phase 6)

* Develop a web-based administrative interface.
* Potentially include self-service portals for end-users to manage access requests.
* Features to include dashboards, access reports, remediation actions, and manual overrides.

### 5. Advanced Features (Phase 7)

* Introduce sophisticated IAM functionalities such as:
  * **Access Reviews** (Periodic certifications of user access)
  * **Separation of Duties (SoD)** enforcement
  * **Access Request Workflows** with approvals
  * **Bulk Operations** (e.g., mass onboarding, terminations)
  * **Comprehensive Auditing** (full activity trails)
  * **Scheduled Reports** for governance and compliance reporting

### 6. Dockerization & Deployment (Phase 8)

* Finalize production-grade Dockerfiles for all microservices.
* Develop deployment blueprints:
  * Kubernetes manifests (Deployment, Services, ConfigMaps, Secrets)
  * Helm charts
  * GitOps or CI/CD pipelines for automated deployment.

### 7. Health Check Enhancements

* Embed active health checks within services to verify:
  * Database connection health.
  * Message Queue connectivity.
  * External system accessibility (ping endpoints, validate API/DB credentials).
* Surface service-level health status through `/healthz` endpoints and integrate into monitoring dashboards.

---

## Conclusion

The current architecture lays a robust foundation. These future enhancements will systematically elevate the platform towards a highly scalable, secure, and enterprise-ready IAM solution.

---
