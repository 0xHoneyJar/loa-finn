# loa-finn Ground Truth

> Token-efficient routing hub. Each spoke file provides grounded claims with `file:line` citations.

## Project

loa-finn: Multi-model AI inference engine serving token-gated agent experiences, organized as a 15-module modular monolith (120+ TypeScript files).

## Spokes

| File | What It Covers | Key Claims |
|------|---------------|------------|
| [architecture-overview.md](architecture-overview.md) | 5-layer architecture (Persistence, Orchestration, Agent/Safety, App Services, Gateway) with CODE-FACTUAL evidence blocks | 12 |
| [capability-brief.md](capability-brief.md) | 7 capability areas: durable state, multi-model routing, code review, learning, scheduling, safety, gateway | 14 |
| [features.yaml](features.yaml) | Feature registry — 26 features with status, category, module paths, and evidence citations | 26 |
| [limitations.yaml](limitations.yaml) | Known limitations per feature with reason and evidence | 12 |
| [capability-taxonomy.yaml](capability-taxonomy.yaml) | 7 top-level capability categories that features.yaml maps into | 7 |
| [banned-terms.txt](banned-terms.txt) | 20 banned marketing adjectives (e.g., "blazing", "robust", "scalable") | 20 |
| [banned-security-terms.txt](banned-security-terms.txt) | 16 regex patterns for leaked secrets/credentials scan | 16 |
| [banned-security-allow.txt](banned-security-allow.txt) | 6 allowlisted safe patterns (RFC5737 IPs, placeholder tokens) | 6 |
| [generation-manifest.json](generation-manifest.json) | 16 generated docs, all 9/9 gates PASS at commit `c7d93f2` | 16 |
| [checksums.json](checksums.json) | SHA-256 checksums for 8 reality spoke files at commit `9562034` | 8 |
| [provenance-history.jsonl](provenance-history.jsonl) | Provenance audit trail — corpus stats per cycle (230 tagged blocks, 133 CODE-FACTUAL) | 2 |
| [gate-metrics.jsonl](gate-metrics.jsonl) | Per-gate pass/fail metrics across all verification runs | ~292K bytes |

### Placeholder Spokes (empty, reserved for future extraction)

| File | Intended Coverage |
|------|------------------|
| [api-surface.md](api-surface.md) | Public API endpoints and contracts |
| [architecture.md](architecture.md) | Condensed architecture reference |
| [behaviors.md](behaviors.md) | Runtime behavior documentation |
| [contracts.md](contracts.md) | Interface contracts and invariants |

## Quick Facts

- **Language**: TypeScript (ESM-only)
- **Runtime**: Node.js 22+
- **Framework**: Hono v4 HTTP + WebSocket
- **Key modules**: hounfour (33 files), gateway (17), cron (13), persistence (10), bridgebuilder (7), agent (9), safety (6)
- **Test framework**: Vitest (2101+ passing tests)
- **Entry point**: `src/index.ts`
- **Current cycle**: cycle-027
- **Last updated**: 2026-02-19
