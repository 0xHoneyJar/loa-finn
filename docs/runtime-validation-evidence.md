# Finn Runtime Validation Evidence

This document scopes the runtime-evidence work in PR #239.

## Validation script surface

`test:finn` is widened into a composed command:

- `test:finn:core`
- `test:gateway`
- `test:billing`
- `test:x402`
- `test:audit-fixtures`

This makes the package-level validation command better match the actual runtime surface: gateway, billing, x402, and audit timestamp fixtures.

## Database migration ownership

The Docker init script provisions roles only. It no longer pre-creates the application schema.

The migration role receives database-level `CREATE` so migrations can create Drizzle metadata and application schemas. The runtime role receives default privileges from objects created by the migration role but should not own DDL duties.

Evidence expected before final acceptance:

1. clean database startup;
2. migrations succeed;
3. runtime role can perform expected runtime reads/writes;
4. runtime role cannot perform migration-only actions.

## E2E modes

The Finn-only CI workflow starts Finn, Postgres, and Redis. It does not always start Freeside and Dixie.

Therefore the long E2E tests now distinguish two modes:

- **Finn-only mode:** `E2E_FREESIDE_URL` and `E2E_DIXIE_URL` absent. Tests prove Finn liveness/readiness, metrics, JWT shape, and local admin/runtime behavior.
- **Three-service mode:** both `E2E_FREESIDE_URL` and `E2E_DIXIE_URL` present. Tests additionally assert Freeside and Dixie reachability and cross-service behavior.

Final acceptance still requires an explicit workflow or documented command that runs the three-service mode.

## Remaining follow-up

This PR does not yet complete:

- Hounfour compatibility matrix;
- health route contract documentation;
- release smoke evidence;
- dependency-audit policy cleanup;
- explicit three-service CI wiring.
