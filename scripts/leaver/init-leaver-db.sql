-- scripts/leaver/init-leaver-db.sql

-- 1) Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2) Create a schema for leaver events (optional)
CREATE SCHEMA IF NOT EXISTS leaver_service;

-- 3) leave_requests table
CREATE TABLE IF NOT EXISTS leaver_service.leave_requests (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID           NOT NULL,
  hrms_id        TEXT           NOT NULL,
  requested_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  status         TEXT           NOT NULL DEFAULT 'pending',
  processed_at   TIMESTAMPTZ,
  error_message  TEXT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- 4) (Optional) Audit log for deeper tracing
CREATE TABLE IF NOT EXISTS leaver_service.leave_request_logs (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id  UUID           NOT NULL REFERENCES leaver_service.leave_requests(id) ON DELETE CASCADE,
  event_time        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  event_type        TEXT           NOT NULL,
  message           TEXT
);
