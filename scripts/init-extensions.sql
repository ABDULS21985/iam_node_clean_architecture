-- -----------------------------------------------------------------------------
-- PostgreSQL Extensions Bootstrap – init-extensions.sql
-- Generated: 2025-04-27
-- Purpose: Standardize critical extensions across all service databases
-- -----------------------------------------------------------------------------

\set ON_ERROR_STOP on
\echo '[Extensions Bootstrap] Starting extensions initialization...'

-- Enable universally needed extensions
DO $$ 
BEGIN
  -- UUID Generation (Universally Unique Identifiers)
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp') THEN
    CREATE EXTENSION "uuid-ossp";
  END IF;

  -- Case-insensitive text (for case-insensitive email/username matching)
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext') THEN
    CREATE EXTENSION "citext";
  END IF;

  -- Cryptographic functions (e.g., password hashing, strong random generation)
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION "pgcrypto";
  END IF;

  -- Additional strategic extensions (optional, add as needed)
  -- IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hstore') THEN
  --   CREATE EXTENSION "hstore"; -- Key-value storage extension
  -- END IF;

END $$;

\echo '[Extensions Bootstrap] Extensions initialized successfully.'
