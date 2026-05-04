-- tests/e2e/init-db.sql — E2E Database Init (T-6.5, cycle-034)
--
-- Creates test databases for finn and freeside E2E tests.
-- Mounted into postgres via docker-entrypoint-initdb.d.

-- finn_test already created as POSTGRES_DB in docker-compose
-- Create freeside_test for billing integration
CREATE DATABASE freeside_test;
