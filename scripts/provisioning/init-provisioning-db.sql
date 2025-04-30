-- init-provisioning-db.sql

-- make sure uuid_generate_v4() exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- audit table for every provisioning task message consumed
CREATE TABLE IF NOT EXISTS "ProvisioningRuns" (
  id            UUID                    PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id       UUID                    NOT NULL,
  routing_key   TEXT,
  payload       JSONB                   NOT NULL,
  processed_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
