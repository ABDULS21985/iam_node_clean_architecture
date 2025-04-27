-- -----------------------------------------------------------------------------
-- Bootstrap Identity Collection Service Schema – init-idcs-db.sql
-- Generated: 2025-04-27
-- Purpose: Idempotently create database, role, schema, and security for ICS
-- -----------------------------------------------------------------------------

\set ON_ERROR_STOP on
\echo '[ICS Bootstrap] Starting initialization...'

-- 1. Conditionally create the database
SELECT
  'CREATE DATABASE idcs_dev'
  || ' WITH OWNER = postgres'
  || ' ENCODING = ''UTF8'''
  || ' LC_COLLATE = ''en_US.utf8'''
  || ' LC_CTYPE = ''en_US.utf8'''
  || ' TEMPLATE = template0'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'idcs_dev'
)
\gexec

-- 2. Conditionally create the service role
SELECT
  'CREATE ROLE idcs_user'
  || ' WITH LOGIN'
  || ' PASSWORD ''Secured3211'''
  || ' NOSUPERUSER'
  || ' NOCREATEROLE'
  || ' NOCREATEDB'
  || ' NOREPLICATION'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'idcs_user'
)
\gexec

-- 3. Grant connect privilege on the database
GRANT CONNECT ON DATABASE idcs_dev TO idcs_user;

-- 4. Switch to the idcs_dev database context
\c idcs_dev
\echo '[ICS Bootstrap] Connected to idcs_dev'

-- 5. Ensure the public schema exists and reassign it to idcs_user
-- This makes idcs_user truly own all objects in public
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'public') THEN
    EXECUTE 'CREATE SCHEMA public AUTHORIZATION idcs_user';
  ELSE
    -- If it already exists, just reassign ownership
    EXECUTE 'ALTER SCHEMA public OWNER TO idcs_user';
  END IF;
END
$$;

-- 6. Grant privileges on schema objects
GRANT USAGE ON SCHEMA public TO idcs_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO idcs_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO idcs_user;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO idcs_user;

-- 7. Set default privileges for future created objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO idcs_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO idcs_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO idcs_user;

\echo '[ICS Bootstrap] Initialization complete.'
