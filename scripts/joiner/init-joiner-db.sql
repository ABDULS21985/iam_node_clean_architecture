-- init-joiner-db.sql

-- 1️⃣ Ensure the uuid-ossp extension is available for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2️⃣ Create the table that will record every Joiner event run
CREATE TABLE IF NOT EXISTS "JoinerRuns" (
  -- Primary key
  id UUID PRIMARY KEY
    DEFAULT uuid_generate_v4(),

  -- HRMS identifier for the record
  hrms_id VARCHAR NOT NULL,

  -- IGLM User UUID (foreign key into your Users table)
  user_id UUID NOT NULL,

  -- The routing key used on the MQ (e.g. 'joiner.new')
  routing_key VARCHAR NULL,

  -- Raw event payload, stored for audit/debug
  payload JSONB NOT NULL,

  -- When we processed this message
  processed_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP,

  -- Standard Sequelize timestamps
  created_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP
);

-- 3️⃣ (Optional) Add an index on processed_at so you can query recent runs quickly
CREATE INDEX IF NOT EXISTS idx_joiner_runs_processed_at
  ON "JoinerRuns" (processed_at);
