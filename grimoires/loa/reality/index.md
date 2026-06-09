# loa-finn Reality Index

> Refreshed by `/ride --enriched` 2026-06-08 (supersedes cycle-013 / 2026-02-11 extraction).
> Token-optimized codebase interface for the `/reality` command — hub-and-spoke (llms.txt pattern).

## Project Summary

- **Name**: loa-finn (v0.1.0) — persistent multi-tenant AI agent runtime + agent-commerce platform
- **Runtime**: Node.js ≥22, TypeScript 5.7 ESM, pnpm 10.28
- **HTTP**: Hono v4 + WebSocket (`ws`); Agent SDK: Pi (`@mariozechner/pi-*`)
- **Data**: PostgreSQL (`finn` schema, Drizzle); R2 (S3) WAL checkpoints; Git archive
- **Entry**: `src/index.ts` → `src/gateway/server.ts`
- **Scale**: 28 source modules, 359 non-test `.ts` files, ~81.6K LOC, 374 test files

## Spokes

| Artifact | Purpose |
|----------|---------|
| [api-surface.md](api-surface.md) | HTTP/WS endpoints + key exports |
| [types.md](types.md) | Core types / DB tables |
| [interfaces.md](interfaces.md) | External integration points |
| [structure.md](structure.md) | Module map + responsibilities |
| [entry-points.md](entry-points.md) | Boot, CLI, env requirements |
| [architecture-overview.md](architecture-overview.md) | Components, data flow, topology |
| [decisions.md](decisions.md) | ADR archaeology (enrichment) |
| [terminology.md](terminology.md) | Domain vocabulary (enrichment) |

## Module Map (file counts)

```
hounfour/ (91)  routing · budget · JWT · orchestration · oracle/knowledge
nft/      (73)  per-NFT personality pipeline (Mibera/Berachain)
gateway/  (49)  HTTP/WS server · auth · routes · dashboard
x402/     (17)  HTTP 402 on-chain payments (Base)
credits/  (16)  credit accounts · rektdrop · reorg detection
cron/     (13)  scheduled jobs · circuit breakers
billing/  (13)  billing finalization · fencing locks
substrate/(12)  sandboxed Effect runtime
persistence/(10) WAL → R2 → Git
agent/    (9)   sessions · sandbox · worker pool
events/   (8)   event store    bridgebuilder/ (8) PR review
safety/   (7)   audit · firewall · redaction
marketplace/(5) · scheduler/boot/drizzle (4 ea) · dashboard/tracing/shared/learning/types/beads/config (1-2)
```

## Caveats

- `package.json` license field says MIT but actual license is **AGPL-3.0** (`LICENSE.md`) — drift.
- Prior README module map omits the economic/NFT layer (nft, x402, credits, billing, etc.).
