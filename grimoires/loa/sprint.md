# Sprint Plan: Per-NFT Personality — Pipeline Wiring + Scale-Out Design

**Cycle:** 040
**PRD:** `grimoires/loa/prd.md`
**SDD:** `grimoires/loa/sdd.md`
**Date:** 2026-03-26
**References:** [Issue #132](https://github.com/0xHoneyJar/loa-finn/issues/132) · [Issue #133](https://github.com/0xHoneyJar/loa-finn/issues/133)

---

## Goals

| ID | Goal | Source |
|----|------|--------|
| G-1 | Soft launch ready: 5-10 team members chatting with distinct dNFT agents on production | prd.md:L27 |
| G-2 | Product thesis validated: on-chain traits produce personality | prd.md:L28 |
| G-3 | Scale-out architecture designed for 100K+ NFTs | prd.md:L29 |

---

## Sprint 1: Core Pipeline Wiring (P0)

**Global ID:** 162
**Goal:** Wire existing pipeline components into `PersonalityPipelineOrchestrator` so tokenId in chat request produces on-chain-derived personality with ownership verification and fallback degradation.

### Tasks

| ID | Task | Files | Goals |
|----|------|-------|-------|
| T-1.1 | Create `PersonalityPipelineOrchestrator` implementing `PersonalityProvider` — sequences: cache check → signal resolution → DAMP derivation → BEAUVOIR synthesis → cache write | `src/nft/personality-pipeline.ts` (NEW) | G-1, G-2 |
| T-1.2 | Wire orchestrator into `PersonalityProviderChain` via `server.ts` — chain: PipelineOrchestrator → PersonalityStore → StaticPersonalityLoader | `personality-provider-chain.ts`, `server.ts` | G-1 |
| T-1.3 | Centralized `verifyOwnership()` service function + Hono middleware — 60s TTL auth cache (NOT 24h signal cache), deny-by-default, `blockNumber` staleness detection. All session paths MUST route through this. | `src/nft/ownership-gate.ts` (NEW), `agent-chat.ts` | G-1 |
| T-1.4 | Implement fallback/degradation chain — on-chain fail → reject, graph fail → empty subgraph, synthesis fail → cached BEAUVOIR → static fallback | `personality-pipeline.ts` | G-1 |
| T-1.5 | Per-token distributed lock (Redis `SET NX`, 30s expiry) for synthesis concurrency control. Dual-write consistency: Postgres first, then Redis. Read-repair on content hash mismatch. | `personality-pipeline.ts` | G-1 |
| T-1.6 | BEAUVOIR sanitization — strip `<system-personality>` delimiters, system-role directives. Validate against section schema + length limits before storage. | `personality-pipeline.ts` | G-1 |
| T-1.7 | WebSocket loading state frames — `personality_loading` with stage/progress, then `personality_ready` with metadata | `agent-chat.ts`, WebSocket handler | G-1 |
| T-1.8 | Unit + integration tests for pipeline (cache hit, cache miss, degradation, concurrency, sanitization) | `tests/finn/personality-pipeline.test.ts` (NEW) | G-1, G-2 |
| T-1.9 | Ownership gate tests — matching wallet, non-owner 403, allowlist denied, ALL entry points covered | `tests/finn/ownership-gate.test.ts` (NEW) | G-1 |

### Acceptance Criteria

- [x] A tokenId in the chat request produces a personality derived from on-chain traits (not static config)
- [x] Non-owners receive 403 `OWNERSHIP_REQUIRED` on ALL entry points (HTTP, WS)
- [x] Non-allowlisted wallets receive 403 `ALLOWLIST_DENIED` during soft launch
- [x] Ownership uses 60s TTL cache, NOT 24h signal cache
- [x] Concurrent requests for same tokenId do not trigger duplicate synthesis (singleflight)
- [ ] Postgres is source of truth; Redis self-heals via read-repair on hash mismatch *(read-repair deferred to Sprint 2)*
- [x] Generated BEAUVOIR cannot break out of `<system-personality>` delimiters
- [ ] WebSocket sends loading state frames during cold-cache resolution *(T-1.7 deferred)*
- [x] Synthesis failure falls back to cached BEAUVOIR, then static config
- [x] All degradation paths logged with severity

### Dependencies

None. All pipeline components already exist.

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| On-chain RPC failures in pipeline | Medium | Circuit breaker + fallback chain |
| Opus synthesis latency (10s+) blocks first session | High | Loading state frames + pre-compute in Sprint 3 |
| Stale ownership cache after NFT transfer | High | 60s TTL + transfer-listener invalidation (Flatline SKP-002) |
| Duplicate synthesis on concurrent requests | Medium | Redis SET NX singleflight lock (Flatline SKP-004) |

---

## Sprint 2: Identity Graph + Experience Engine + Metadata (P1)

**Global ID:** 163
**Goal:** Enrich pipeline with cultural context from identity graph, wire experience engine for gradual personality drift, persist experience state, expose agent name/archetype in API responses.

### Tasks

| ID | Task | Files | Goals |
|----|------|-------|-------|
| T-2.1 | Wire identity graph into pipeline — `extractSubgraph()` → `toSynthesisSubgraph()` → pass to `BeauvoirSynthesizer.synthesize()` as `subgraph` parameter | `personality-pipeline.ts` | G-2 |
| T-2.2 | Wire experience engine with canonical ordering (IMP-005/SKP-007): drift applied at read-time (`birth_fingerprint + stored_offsets = effective_fingerprint`), NOT during synthesis. Offsets updated async post-session via atomic Postgres transaction with optimistic concurrency. | `personality-pipeline.ts` | G-2 |
| T-2.3 | Create `finn_experience_snapshots` Postgres table via Drizzle migration — personality_id PK, dial_offsets JSONB, interaction_count, epoch_count | `src/drizzle/schema.ts`, migration | G-2 |
| T-2.4 | Extend agent-chat response with `agent_name` (nameKDF), `archetype`, `era` metadata | `agent-chat.ts` | G-1, G-2 |
| T-2.5 | Identity graph integration tests — two agents with different ancestors produce different cultural grounding | `tests/finn/identity-graph-integration.test.ts` (NEW) | G-2 |
| T-2.6 | Experience engine wiring tests — interaction count tracked, epoch trigger applies drift within bounds, cumulative clamp | `tests/finn/experience-wiring.test.ts` (NEW) | G-2 |

### Acceptance Criteria

- [x] Generated BEAUVOIR docs include cultural references appropriate to the ancestor
- [x] Two agents with different ancestors produce visibly different cultural grounding
- [x] After N interactions, personality dials shift within ±0.5% per epoch, ±5% cumulative
- [x] Experience state persists across deploys (Postgres-backed)
- [x] API response includes `agent_name`, `archetype`, and `era` fields

### Dependencies

Sprint 1 (pipeline orchestrator must exist).

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Identity graph missing codex data for some combos | Low | `extractSubgraph()` returns empty subgraph gracefully |
| Experience drift accumulation bugs | Medium | ±5% cumulative clamp + rebase mechanism |

---

## Sprint 3: Pre-Compute + Polish + E2E Validation (P1-P2)

**Global ID:** 164
**Goal:** Pre-compute 5 demo personalities, wire transfer invalidation, document scale-out architecture, validate all PRD goals end-to-end.

### Tasks

| ID | Task | Files | Goals |
|----|------|-------|-------|
| T-3.1 | Create `scripts/precompute-personalities.ts` CLI — takes tokenIds, runs full pipeline per ID, validates anti-narration, reports distinctiveness scores | `scripts/precompute-personalities.ts` (NEW) | G-1 |
| T-3.2 | Pre-compute 5 demo personalities with test tokenIds — validate all pass anti-narration, pairwise cosine < 0.7 | Script execution | G-1, G-2 |
| T-3.3 | Wire transfer listener to cache invalidation — on Transfer event: `PersonalityStore.invalidate()` + `SignalCache.invalidate()` | `transfer-listener.ts` | G-1 |
| T-3.4 | Create scale-out architecture documentation — batch derivation, cache warming, synthesis queue, degradation tiers, transfer invalidation | `docs/scale-out-design.md` (NEW) | G-3 |
| T-3.5 | End-to-end integration test — cold cache → ownership → on-chain → DAMP → graph → synthesis → cache → warm read | `tests/finn/personality-e2e.test.ts` (NEW) | G-1, G-2 |

### Acceptance Criteria

- [x] 5 personalities pre-computed and cached *(test fixtures; real tokenIds at production wiring)*
- [x] All 5 pass anti-narration validation (0% violation rate)
- [x] Pairwise cosine similarity < 0.7 between all 5 demos
- [x] Transfer listener invalidates both personality and signal caches
- [x] Scale-out doc covers all 5 patterns from PRD 5.5
- [x] E2E test covers full cold-cache → warm-cache pipeline flow

### Dependencies

Sprint 2 (identity graph wiring, experience engine, metadata).

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Opus synthesis latency during pre-computation (~50s for 5) | Medium | Sequential processing is acceptable for 5 IDs |
| Anti-narration false positives | Low | Retry loop (3 attempts) with violation feedback |

---

## Goal Traceability

| Goal | Contributing Tasks | Validation |
|------|--------------------|------------|
| G-1: Soft launch ready | T-1.1 through T-1.6, T-2.4, T-3.1, T-3.2, T-3.3, T-3.5 | Sprint 3 AC: 5 personalities cached, pipeline resolves, ownership works |
| G-2: Product thesis validated | T-1.1, T-1.5, T-2.1 through T-2.6, T-3.2, T-3.5 | Sprint 3 AC: DAMP distinct (cosine < 0.7), BEAUVOIR passes AN, graph enriches synthesis |
| G-3: Scale-out designed | T-3.4 | Sprint 3 AC: doc covers all 5 patterns |

---

## Open Questions

| Question | Owner | Status | Impact |
|----------|-------|--------|--------|
| Which 5 team-owned tokenIds for soft launch? | @janitooor | Open | Sprint 3 T-3.2 — using test IDs until resolved |
| `collectionSalt` for `nameKDF()` in production? | @janitooor | Open | Sprint 2 T-2.4 — needs config value |
| Experience flush: every epoch or batched? | Engineering | Open | Sprint 2 T-2.3 — recommend every epoch |
