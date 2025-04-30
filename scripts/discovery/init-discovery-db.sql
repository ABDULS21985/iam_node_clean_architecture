-- init-discovery-db.sql

-- ensure uuid_generate_v4() is available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- table to record every discovery run
CREATE TABLE IF NOT EXISTS "CollectionRunsAudit" (
  id            UUID                    PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID                    NOT NULL,
  started_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMP WITH TIME ZONE,
  status        TEXT,
  metrics       JSONB,
  error         JSONB
);
