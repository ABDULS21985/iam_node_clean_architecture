-- Create the database for the Identity Collection Service
CREATE DATABASE idcs_dev;

-- Create the user for the Identity Collection Service
-- Use the password defined in your .env file
-- IMPORTANT: Make sure the password here 'Secured3211' matches exactly what's in your .env IDCS_DB_PASSWORD
CREATE USER idcs_user WITH PASSWORD 'Secured3211';

-- Grant privileges on the new database to the new user
GRANT ALL PRIVILEGES ON DATABASE idcs_dev TO idcs_user;

-- Optional: Grant permissions on future schemas/tables created by idcs_user within idcs_dev
-- This is often needed if idcs_user will be creating tables via migrations
-- \connect idcs_dev; -- Connect to the new database
-- GRANT ALL ON SCHEMA public TO idcs_user; -- Grant on the public schema

-- If idcs_user is the *owner* of tables/schemas, you might need more specific grants or ALTER DEFAULT PRIVILEGES
-- For migrations, GRANT ALL PRIVILEGES ON DATABASE is often sufficient initially.