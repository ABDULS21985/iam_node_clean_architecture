-- -----------------------------------------------------------------------------
-- Identity Collection Service – User & Role Bootstrap – init-create-idcs-user.sql
-- Revision: 2025-04-30 R2  (adds GRANT CREATE for full migration compatibility)
-- Purpose : Idempotently create the `idcs_user` role and apply secure grants
-- -----------------------------------------------------------------------------

\set ON_ERROR_STOP on
\echo '[IDCS Bootstrap] Starting creation of idcs_user role…'

-- 1. Conditionally create the idcs_user role
DO $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'idcs_user'
     ) THEN
    CREATE ROLE idcs_user
      LOGIN
      PASSWORD 'Secured3211'          -- keep in sync with .env
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      CONNECTION LIMIT -1;
  END IF;
END
$$;

\echo '[IDCS Bootstrap] Role idcs_user ensured.'

-- 2. Grant database-level access
GRANT CONNECT ON DATABASE idcs_dev TO idcs_user;
GRANT CREATE  ON DATABASE idcs_dev TO idcs_user;   -- ← NEW: enables CREATE EXTENSION

-- 3. Switch to the target database to apply schema-level grants
\connect idcs_dev

-- 4. Grant ownership and privileges on public schema
ALTER SCHEMA public OWNER TO idcs_user;
GRANT USAGE ON SCHEMA public TO idcs_user;

-- 5. Grant full privileges on current and future objects
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES    IN SCHEMA public TO idcs_user;
GRANT USAGE,  SELECT, UPDATE          ON ALL SEQUENCES IN SCHEMA public TO idcs_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO idcs_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE,  SELECT, UPDATE          ON SEQUENCES TO idcs_user;

-- 6. Allow use of pgcrypto’s UUID generator
GRANT EXECUTE ON FUNCTION gen_random_uuid() TO idcs_user;

\echo '[IDCS Bootstrap] All privileges granted to idcs_user on idcs_dev.'
