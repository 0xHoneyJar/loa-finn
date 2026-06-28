#!/bin/bash
# 01-finn-roles.sh — PostgreSQL role provisioning for loa-finn (Sprint 1 T1.2)
# Runs via Docker entrypoint on first database initialization.
# Passwords sourced from FINN_APP_PASSWORD / FINN_MIGRATE_PASSWORD env vars.
set -euo pipefail

: "${FINN_APP_PASSWORD:?FINN_APP_PASSWORD must be set}"
: "${FINN_MIGRATE_PASSWORD:?FINN_MIGRATE_PASSWORD must be set}"

FINN_MIGRATE_PW_ESCAPED="${FINN_MIGRATE_PASSWORD//\'/\'\'}"
FINN_APP_PW_ESCAPED="${FINN_APP_PASSWORD//\'/\'\'}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'finn_migrate') THEN
      CREATE ROLE finn_migrate LOGIN PASSWORD '${FINN_MIGRATE_PW_ESCAPED}';
    END IF;
  END
  \$\$;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'finn_app') THEN
      CREATE ROLE finn_app LOGIN PASSWORD '${FINN_APP_PW_ESCAPED}';
    END IF;
  END
  \$\$;

  GRANT CREATE ON DATABASE "$POSTGRES_DB" TO finn_migrate;

  ALTER DEFAULT PRIVILEGES FOR ROLE finn_migrate
    GRANT USAGE ON SCHEMAS TO finn_app;

  ALTER DEFAULT PRIVILEGES FOR ROLE finn_migrate
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO finn_app;

  ALTER DEFAULT PRIVILEGES FOR ROLE finn_migrate
    GRANT USAGE, SELECT ON SEQUENCES TO finn_app;
EOSQL

echo "[finn-init] Roles finn_migrate and finn_app provisioned successfully."
