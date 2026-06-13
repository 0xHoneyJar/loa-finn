# loa-finn Reality Index

> Refreshed by `/ride` 2026-06-12 (EXP-004 lens; supersedes 2026-06-08 enriched extraction).
> Token-optimized codebase interface for the `/reality` command — hub-and-spoke (llms.txt pattern).

## Project Summary

- **Name**: loa-finn (v0.1.0) — persistent agent runtime + agent-commerce platform + experiment program
- **Runtime**: Node.js ≥22, TypeScript ESM, pnpm 10.28
- **HTTP**: Hono v4 + WebSocket (`ws`); Agent SDK: Pi (`@mariozechner/pi-*`)
- **Data**: PostgreSQL (`finn` schema, Drizzle); R2 (S3) WAL checkpoints; Git archive
- **Entry**: `src/index.ts` → `src/gateway/server.ts`
- **Scale**: 27 source modules, 363 non-test `.ts` files, ~83.6K LOC, 381 test files, ~87 route mounts, 230 git tags
- **Active build**: branch `feature/score-phase1` — Score Phase-1 forensic core (Sprint 1 done)

## Spokes

| Artifact | Purpose |
|----------|---------|
| [api-surface.md](api-surface.md) | HTTP/WS endpoints + key exports |
| [types.md](types.md) | Core types / DB tables |
| [interfaces.md](interfaces.md) | External integration points |
| [structure.md](structure.md) | Module map + responsibilities |
| [entry-points.md](entry-points.md) | Boot, CLI, env requirements |
| [architecture-overview.md](architecture-overview.md) | Components, data flow, experiment program |
| [decisions.md](decisions.md) | ADR archaeology (enrichment) |
| [terminology.md](terminology.md) | Domain vocabulary (enrichment) |

## Experiment program (see architecture-overview.md)
EXP-001 cost-of-play (DONE: H1/H2 FALSIFIED, H3 HELD) · EXP-002 commerce forensics (DONE: registration
theater) · EXP-003 verification-void (DONE 2026-06-12: **GO vertical / NO-GO horizontal**) ·
**EXP-004 graduation gate (NOT BUILT)** = `src/score` Sprint 2 ingestion + Sprint 3 FR-2a validation harness.
Briefs: `grimoires/loa/context/` + `grimoires/k-hole/research-output/`. Spine: `observatory/`.

## Module Map (file counts)

```
hounfour/ (91)  routing · budget · JWT · orchestration · oracle/knowledge
nft/      (73)  per-NFT personality pipeline (Mibera/Berachain)
gateway/  (49)  HTTP/WS server · auth · routes · dashboard
x402/     (17)  HTTP 402 on-chain payments (Base)
credits/  (16)  credit accounts · rektdrop · reorg detection
cron/     (13)  scheduled jobs · circuit breakers
billing/  (13)  billing finalization · fencing locks
substrate/(12)  sandboxed Effect runtime · JWT-licensed constructs
score/    (8)   Phase-1 forensic X-ray (core pure + edge port/stub adapters)  [feature/score-phase1]
persistence/(10) WAL → R2 → Git
cost/     (2)   per-request 3-ledger cost atom (inference/infra/orchestration)
agent/    (9)   sessions · sandbox · worker pool
events/   (8)   event store    bridgebuilder/ (8) PR review
safety/   (7)   audit · firewall · redaction
marketplace/(5) · scheduler/boot/drizzle (4 ea) · dashboard/tracing/shared/learning/types/beads/config (1-2)
```

## Caveats

- `package.json` license field says **MIT** but actual license is **AGPL-3.0** (`LICENSE.md`) — still drift.
- `package.json` description "Minimal persistent Loa agent runtime" is stale at ~83.6K LOC / 27 modules.
- `src/score` exports a deterministic screen, but adapters throw `NotImplementedError` and no validation
  harness exists — the screen is fixture-fed and internal-only (see drift-report.md §1, the EXP-004 gap).
