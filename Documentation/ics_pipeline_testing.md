
# Steps to Test the Identity Collection Service (ICS) Pipeline (Running Locally)

This guide outlines a structured approach to verify the ICS pipeline functionality in a local development environment.

---

## 1. Start Infrastructure Containers

Ensure Docker Desktop (or Docker Engine) is running. Launch the necessary infrastructure containers using your `docker-compose.yml` file. Required services include:

- `config-db` (Postgres for Config DB)
- `rabbitmq`
- `redis`
- `hrms-db` (Postgres for Mock HRMS DB)
- `consul` (optional, recommended for service discovery)

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

- Connects to `config-db` container (localhost:${DB_PORT}).
- Ensures Applications, ConnectorConfigs, MappingConfigs, and policies are populated.

---

## 3. Populate Mock HRMS Database

If you mounted an initialization script (`init-hrms-db.sql`) for the `hrms-db` container, it should automatically populate the mock HRMS database at startup.

If not:

- Manually connect to the `hrms-db` Postgres container.
- Execute SQL commands to:
  - Create required schemas/tables/views.
  - Insert mock HRMS data (e.g., Alice, Bob, Charlie).

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

- Service starting.
- ConfigService initialized.
- MqService connected.
- Temporary Storage initialized.
- Service configurations loaded.
- Attribute-to-Role Mapping config loaded.
- Data collection scheduler started.
- Collection run starting.
- HRMS Connector Config loaded.
- Mapping Config loaded.
- HRMS Connector adapter loaded.
- Data pulled from HRMS (record counts logged).
- Previous snapshot loaded.
- Deltas found (joiners, movers, leavers).
- Deltas processed and published.
- New snapshot saved.
- Collection run finished.

---

## 6. Additional Monitoring

- **RabbitMQ Management UI:** Access at `http://localhost:15672` to verify message publishing.
- **Postgres Logs (Config DB):** Confirm database connections and operations.

---

## Conclusion

Executing these steps will validate the ICS pipeline end-to-end, ensuring infrastructure readiness, configuration integrity, connector functionality, delta detection, and event publishing.

---
