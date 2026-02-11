# loa-finn Reality Index

> Phase 0 extraction — cycle-013, 2026-02-11
> Source: `/ride` analysis of `src/` (120+ TypeScript files, 15 modules)

## Hub

| Artifact | Extraction Target (PRD §6.1.2) | Tokens (est.) |
|----------|-------------------------------|---------------|
| [routes.md](routes.md) | Route registrations | ~800 |
| [env-vars.md](env-vars.md) | Environment variables | ~900 |
| [auth.md](auth.md) | Auth middleware | ~600 |
| [background-jobs.md](background-jobs.md) | Background jobs | ~700 |
| [dependencies.md](dependencies.md) | External dependencies | ~500 |
| [interfaces.md](interfaces.md) | Exported interfaces | ~1200 |

## Project Summary

- **Name**: loa-finn
- **Version**: 0.1.0
- **Runtime**: Node.js 22+ (ESM-only)
- **Framework**: Hono v4 HTTP + WebSocket
- **LLM Runtime**: Pi SDK (`@mariozechner/pi-*` ~0.52.6)
- **Entry Point**: `src/index.ts`
- **Source Modules**: 15 (`agent`, `beads`, `boot`, `bridgebuilder`, `config`, `cron`, `dashboard`, `gateway`, `hounfour`, `learning`, `persistence`, `safety`, `scheduler`, `shared`, `types`)
- **Total Source Files**: 120+ `.ts`
- **Test Files**: 100+ across `tests/finn/`, `tests/e2e/`, `tests/integration/`

## Module Map

```
src/
├── agent/          (9)   Agent execution, sandbox, worker pool
├── beads/          (1)   Beads task graph bridge
├── boot/           (1)   Boot sequence orchestration
├── bridgebuilder/  (7)   GitHub PR automation pipeline
├── config.ts       (1)   FinnConfig loader (40+ env vars)
├── cron/           (13)  Scheduled job system with circuit breakers
├── dashboard/      (2)   Activity feed, UI handlers
├── gateway/        (17)  HTTP API, WebSocket, auth, rate limiting
├── hounfour/       (33)  Multi-model routing, JWT, budget, orchestration
├── learning/       (1)   Compound learning system
├── persistence/    (10)  WAL → R2 → Git 3-tier persistence
├── safety/         (6)   Audit trail, firewall, secret redaction
├── scheduler/      (4)   Periodic task scheduling
├── shared/         (1)   Resilient HTTP client
└── types/          (1)   TypeScript ambient extensions
```

## Extraction Metadata

- **Extracted by**: Claude Opus 4.6 (parallel agent extraction)
- **Sources read**: 25+ source files, package.json, tsconfig.json, docker-compose files
- **Coverage**: All 6 PRD §6.1.2 targets confirmed
