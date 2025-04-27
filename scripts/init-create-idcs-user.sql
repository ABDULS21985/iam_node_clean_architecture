-- -----------------------------------------------------------------------------
-- Identity Collection Service – User & Role Bootstrap – init-create-idcs-user.sql
-- Generated: 2025-04-27
-- Purpose: Idempotently create the `idcs_user` role and ensure secure grants
-- -----------------------------------------------------------------------------

\set ON_ERROR_STOP on
\echo '[IDCS Bootstrap] Starting creation of idcs_user role...'

-- 1. Conditionally create the idcs_user role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'idcs_user') THEN
    CREATE ROLE idcs_user
      LOGIN
      PASSWORD 'Secured3211' -- Sync with .env
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      CONNECTION LIMIT -1; -- unlimited connections
  END IF;
END
$$;

\echo '[IDCS Bootstrap] Role idcs_user ensured.'

-- 2. Ensure idcs_user has minimal necessary privileges on the target database
-- Note: We typically GRANT CONNECT here only. Object-level grants happen after schema initialization.

GRANT CONNECT ON DATABASE idcs_dev TO idcs_user;

\echo '[IDCS Bootstrap] idcs_user granted CONNECT on idcs_dev.'
