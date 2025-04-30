-- init-mover-db.sql

-- ensure uuid_generate_v4() is available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- audit table to track every mover run
CREATE TABLE IF NOT EXISTS "MoverRunsAudit" (
  id            UUID                    PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID                    NOT NULL,
  started_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMP WITH TIME ZONE,
  status        TEXT,
  input_payload JSONB,  -- dump of the incoming event
  result        JSONB,  -- optional any output from your logic
  error         JSONB
);
