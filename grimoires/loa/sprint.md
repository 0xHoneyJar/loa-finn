# Sprint Plan: Forward Architecture — Economic Consciousness

> **Version**: 1.1.0
> **Date**: 2026-02-21
> **Cycle**: cycle-030
> **Source**: Bridgebuilder Deep Review (PR #92) — findings D-1, D-2, D-3 + forward visions 1-3
> **Sprints**: 3 (18 tasks)
> **Global IDs**: 121–123
> **Team**: 1 agent (Claude Opus 4.6)
> **Predecessor**: cycle-029 "Launch Execution" (10 sprints, 120 global, 3,122 tests, bridge FLATLINED)
> **GPT-5.2 Review**: Iteration 1 — 7 blocking issues resolved (v1.1.0)

---

## Sprint Overview

| Sprint | Global ID | Label | Tasks | Dependencies | Status |
|--------|-----------|-------|-------|-------------|--------|
| 1 | 121 | EventStore Abstraction Layer | 7 | None | |
| 2 | 122 | Personality-Aware Model Routing | 6 | None | APPROVED |
| 3 | 123 | Quality Feedback Loop + Observability | 5 | Sprint 1, Sprint 2 | |

### Dependency Graph

```
Sprint 1 (EventStore) ──┐
                         ├── Sprint 3 (Quality Feedback)
Sprint 2 (Routing)   ──┘
```

### Source: Bridgebuilder Deep Review Findings

| Finding | Description | Sprint |
|---------|-------------|--------|
| D-1 | Event Sourcing Convergence — 4 append-only streams trending toward unified EventStore | Sprint 1 |
| D-2 | Ostrom Governance — monitoring and cross-cutting invariants need event infrastructure | Sprint 3 |
| D-3 | Genotype/Phenotype Vocabulary — dAMP-96 as genotype, BEAUVOIR as phenotype | Sprint 2 |
| Vision 1 | Unified Event Log (6-month, foundation layer) | Sprint 1 |
| Vision 2 | Personality as Routing Function (3-month, core deliverable) | Sprint 2 |
| Vision 3 | Agent-to-Agent x402 Commerce (12-month, deferred) | — |

### GPT-5.2 Review Fixes (v1.1.0)

| # | Issue | Fix Applied |
|---|-------|-------------|
| 1 | EventStore JSONL-only — won't cover Postgres/Redis streams | Added T1.5 (PostgresEventWriter) + T1.6 (credit journal adapter). Backend-agnostic interfaces proven across 2 backends. |
| 2 | `routing_quality` stream not in EventStream union | `EventStream` changed to branded string with open registry pattern. New streams registered via `registerEventStream()`. |
| 3 | Redis INCR + file append not atomic — "no gaps" impossible | Changed to WAL-position-authority: sequence assigned by writer on successful append. Acceptance criteria: monotonic + unique (gaps allowed on crash). |
| 4 | New envelope schema may break existing wal-replay.ts | Added T1.7: WAL compatibility layer with golden-file fixtures. On-disk billing WAL format unchanged; EventEnvelope fields embedded as supplementary. |
| 5 | Tier safety — no hard allowlist at final selection, fallback could escalate | Added authoritative `allowedPoolsForTier()` enforced at selection AND fallback. Negative test: free tier + only enterprise pools → explicit "no eligible pools" error. |
| 6 | T3.3 missing dependency wiring + aggregation cost | Specified: singleton RoutingQualityStore, in-memory LRU cache (TTL 5m, max 1000 entries), router-time scoring only. Performance guard: <1ms per scoring call. |
| 7 | Prometheus personality_id label — unbounded cardinality | Removed personality_id from metric labels. Replaced with bounded labels (archetype, tier, task_type, pool). Per-personality diagnostics to structured logs only. |

---

## Sprint 1: EventStore Abstraction Layer

> **Global ID**: 121 | **Priority**: HIGH | **Dependencies**: None
> **Goal**: Extract the shared append-only event pattern into a backend-agnostic EventStore abstraction with at least two concrete backends (JSONL file + Postgres), proving the abstraction generalizes across heterogeneous storage.

### Context

The codebase has 4 independent append-only streams that independently converged on the same pattern:
- **Billing WAL** (`src/billing/`) — JSONL files, CRC32, monotonic sequence, deterministic reducers
- **Credit journal** (`src/credits/`) — Postgres-backed, conservation-checked, idempotency-keyed
- **Reconciliation audit** (`src/billing/reconciliation.ts`) — WAL-appended correction entries
- **Personality versions** (`src/nft/personality-version.ts`) — Redis sorted sets, compare-and-set

All four share: envelope schema, timestamp, correlation ID, append-only semantics, replay capability.

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T1.1 | Define unified `EventEnvelope<T>` type with open stream registry | `src/events/types.ts`: Define `EventEnvelope<T>` that generalizes all four stream envelopes. Fields: `event_id` (ULID), `stream` (branded string, NOT a closed union — new streams registered via `registerEventStream(name)`), `event_type` (string), `timestamp` (number), `correlation_id` (string), `sequence` (number, monotonic per stream, assigned by writer on successful append), `checksum` (CRC32 of payload), `schema_version` (number), `payload` (T). Pre-register streams: `"billing"`, `"credit"`, `"reconciliation"`, `"personality"`, `"routing_quality"`. Add `EventCursor` type for replay position (sequence-based). Existing `BillingWALEnvelope` must be assignable to `EventEnvelope<BillingEntry>` via a mapping function (`toBillingEnvelope` / `fromBillingEnvelope`). Test: type compatibility — mapping functions round-trip correctly. New stream registration succeeds. Unknown stream rejected at runtime. |
| T1.2 | Create backend-agnostic `EventWriter` / `EventReader` interfaces | `src/events/writer.ts`: Define `EventWriter` interface: `append(stream, event_type, payload, correlation_id): Promise<EventEnvelope<T>>`. Sequence assigned by the writer implementation on successful append (not a separate Redis counter). Auto-assigns: `event_id` (ULID), `checksum` (CRC32), `timestamp`. `src/events/reader.ts`: Define `EventReader` interface: `replay(stream, cursor?): AsyncIterable<EventEnvelope<T>>`. `cursor` is sequence-based (resume from last processed). These are pure interfaces — no implementation in this task. Test: interface-level contract tests using a mock implementation. |
| T1.3 | Implement `JsonlEventWriter` / `JsonlEventReader` | `src/events/jsonl-writer.ts`: Implement `JsonlEventWriter` backed by rotating JSONL files (reuse billing WAL's segment rotation logic). Sequence authority is WAL-position: writer atomically appends line + assigns sequence = previous max + 1 (read from last line on init, or 0 for new streams). Max segment size: 1GB (Flatline IMP-004). On crash between append attempts: gaps in sequence are allowed but monotonicity and uniqueness are guaranteed. Torn-write recovery: skip last incomplete line of last segment. `src/events/jsonl-reader.ts`: Implement `JsonlEventReader` that reads JSONL segments in order, validates CRC32, skips entries before cursor. Test: append 100 events across 2 streams → all have unique event_ids, monotonic sequences per stream, valid CRC32 checksums. Corrupt last entry → yields valid events + logs warning. Simulated crash → sequence may have gap but no duplicates. |
| T1.4 | Implement `PostgresEventWriter` / `PostgresEventReader` | `src/events/pg-writer.ts`: Implement `PostgresEventWriter` using Drizzle. Table `finn_events`: `(event_id TEXT PK, stream TEXT NOT NULL, event_type TEXT NOT NULL, sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL, correlation_id TEXT NOT NULL, checksum TEXT NOT NULL, schema_version INT NOT NULL, payload JSONB NOT NULL)`. Unique index on `(stream, sequence)`. Sequence assigned via `SELECT COALESCE(MAX(sequence), 0) + 1 FROM finn_events WHERE stream = $1` inside the INSERT transaction (atomic). `src/events/pg-reader.ts`: Implement `PostgresEventReader` with cursor-based SELECT ordered by sequence. Test: append 50 events → replay from cursor → yields correct subset. Concurrent appends → sequences are unique and monotonic (Postgres serialization guarantees). |
| T1.5 | Adapt credit journal to emit through PostgresEventWriter | `src/credits/rektdrop-ledger.ts`: When a `EventWriter` is injected, emit `CreditTransaction` entries as EventEnvelopes on the `"credit"` stream alongside the existing Postgres write-through. This is a read-only adapter initially — credit journal continues to use its own table (`finn_credit_transactions`) as the authoritative store, and the EventStore receives a copy for cross-stream queries. Test: credit reserve → event appears in unified `"credit"` stream with correct payload. Without EventWriter → existing behavior unchanged. Conservation invariant still holds (EventStore write is non-transactional with credit mutation — acceptable because credit table is authoritative). |
| T1.6 | Adapt billing WAL writer to emit through EventWriter | `src/billing/state-machine.ts`: Modify `appendToWAL()` to optionally delegate to `EventWriter.append("billing", ...)` when an EventWriter is injected. On-disk billing WAL line format is UNCHANGED — the EventWriter emits an additional record in the unified format alongside the existing billing WAL line. Both records contain the same payload; the billing WAL line uses `BillingWALEnvelope` schema, the EventStore record uses `EventEnvelope` schema. `wal-replay.ts` continues to read the existing billing WAL files (no change to replay logic). Add `EventWriter` as optional dependency in billing state machine constructor. Test: billing reserve with EventWriter → event appears in unified stream AND in existing billing WAL. Without EventWriter → existing behavior unchanged. Golden-file test: capture current WAL output → verify it's byte-identical after EventWriter integration. |
| T1.7 | Cross-stream replay, backward compatibility, and ordering test suite | `tests/events/eventstore.test.ts`: Comprehensive test suite. (a) Write events to billing + credit streams interleaved → replay each stream independently → correct per-stream ordering. (b) Write 1000 events → JSONL segment rotation at 1MB boundary → replay crosses segments correctly. (c) CRC32 mismatch → event skipped with warning, replay continues. (d) Simulated concurrent writers → sequences are monotonic and unique (gaps are acceptable). (e) Cursor persistence: replay, save cursor, append more, replay from cursor → only new events. (f) Postgres backend: same tests as (a)-(e) using PostgresEventWriter/Reader. (g) WAL backward compatibility: golden-file fixture from current billing WAL output → wal-replay.ts processes it identically before and after EventWriter integration. (h) Mixed backend: billing events via JSONL, credit events via Postgres → each stream replays independently from its own backend. |

### Testing

- Type compatibility: existing envelopes map to/from unified type
- Backend-agnostic: same contract tests pass for JSONL and Postgres writers
- Per-stream monotonic sequences (gaps allowed on crash, no duplicates)
- CRC32 validation with corrupt entry recovery
- Backward compatibility: billing WAL byte-identical with golden-file fixture
- Credit journal emits to EventStore without affecting conservation invariant

---

## Sprint 2: Personality-Aware Model Routing

> **Global ID**: 122 | **Priority**: HIGH | **Dependencies**: None
> **Goal**: Wire dAMP-96 genotype into HounfourRouter pool selection with hard tier-safety guarantees. A "creative" genotype routes to models with literary depth. An "analytical" genotype routes to reasoning-optimized models. The personality becomes a routing function, not just a prompt prefix.

### Context

The routing gap: `PersonalityContext` exists (`src/nft/personality-context.ts`) and carries `fingerprint_hash`, `archetype`, `dominant_dimensions` — but these are used for logging only. `NFTRoutingCache` exists (`src/hounfour/nft-routing-config.ts`) with per-personality task routing — but it's not wired into `HounfourRouter.resolveExecution()` or the `/agent/chat` endpoint.

The 96 dAMP dials across 12 categories (social warmth, cognitive style, creativity, epistemic behavior, etc.) directly encode preferences that should influence model selection. A personality with high `cr_*` (creativity) dials should prefer models with literary capability. High `cg_*` (cognitive) dials should prefer reasoning models.

### Tier Safety Invariant (GPT-5.2 fix #5)

An authoritative `allowedPoolsForTier(tier: Tier): PoolId[]` function is the single source of truth for pool access. This function is called at the FINAL selection point — both primary selection AND health fallback are constrained by it. If all allowed pools are unhealthy, the request fails with an explicit "no eligible pools" error rather than escalating to an unauthorized pool.

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T2.1 | Define archetype→pool affinity matrix + tier allowlist | `src/nft/routing-affinity.ts`: Define `ARCHETYPE_POOL_AFFINITY` — a `Record<Archetype, Record<PoolId, number>>` scoring matrix. Each archetype (freetekno, milady, chicago_detroit, acidhouse) gets affinity scores [0-1] for each pool (cheap, fast-code, reviewer, reasoning, architect). Scores reflect archetype personality: `freetekno` → high creativity pools, `milady` → high social/aesthetic pools, `chicago_detroit` → high energy/assertive pools, `acidhouse` → high experimental pools. Export `getArchetypeAffinity(archetype, poolId): number`. Also define authoritative `allowedPoolsForTier(tier: Tier): PoolId[]` — the single source of truth for tier→pool access. Free: `[cheap]`. Pro: `[cheap, fast-code, reviewer]`. Enterprise: all pools. This function is used at BOTH primary selection and fallback. Test: all 4 archetypes × 5 pools return valid [0-1] scores. `allowedPoolsForTier("free")` returns exactly `["cheap"]`. |
| T2.2 | Implement dial-weighted pool scoring function | `src/nft/routing-affinity.ts`: Define `DIAL_POOL_WEIGHTS` — maps dial categories to pool preferences. E.g., high `cr_*` (creativity) → boost `architect` pool affinity. High `cg_*` (cognitive) → boost `reasoning` pool. High `cs_*` (conversational) → boost `cheap` pool (fast, chatty). Implement `scorePoolByGenotype(fingerprint: DAMPFingerprint, poolId: PoolId): number` that: (1) extracts top-5 most distinctive dials (deviation from 0.5), (2) weights each dial's pool affinity by its distinctiveness, (3) returns composite score [0-1]. Test: a fingerprint with all `cr_*` dials > 0.8 → `architect` pool scores highest. A fingerprint with all `cg_*` dials > 0.8 → `reasoning` pool scores highest. Flat fingerprint (all 0.5) → equal scores across all pools. |
| T2.3 | Extend PersonalityContext with routing affinity | `src/nft/personality-context.ts`: Add `routing_affinity?: Record<PoolId, number>` field to `PersonalityContext`. Modify `buildPersonalityContext()` to compute routing affinity when `damp_fingerprint` is available: combine `getArchetypeAffinity()` (weight 0.6) with `scorePoolByGenotype()` (weight 0.4) to produce per-pool affinity scores. Test: context built from a freetekno archetype with high creativity dials → `architect` pool has highest affinity. Context without fingerprint → `routing_affinity` is undefined (no personality influence). |
| T2.4 | Wire personality affinity into HounfourRouter with tier enforcement | `src/hounfour/router.ts`: Modify `resolveExecution()` to accept optional `PersonalityContext`. When provided and `routing_affinity` is populated: (1) compute `allowedPoolsForTier(tier)` to get candidate set, (2) sort candidates by `routing_affinity[poolId]` (descending), (3) select highest-affinity pool that passes health check. If all allowed pools are unhealthy → return explicit error `{ code: "NO_ELIGIBLE_POOLS", tier, attempted: [...] }` (NOT escalate to unauthorized pool). Fallback chain walks only within tier-allowed pools. Test: personality with high `architect` affinity + enterprise tier → selects architect pool. Same personality with free tier → gets `cheap` only (tier constraint). Free tier + `cheap` pool unhealthy → explicit "no eligible pools" error (NOT fallback to `fast-code`). Architect pool unhealthy + enterprise tier → falls back to next-highest affinity within enterprise-allowed pools. |
| T2.5 | Wire agent-chat endpoint to pass PersonalityContext | `src/gateway/routes/agent-chat.ts`: After resolving personality, build `PersonalityContext` from the personality's dAMP fingerprint. Pass context to router invocation. If personality has no dAMP fingerprint (legacy_v1), skip personality-aware routing (fall through to existing tier-based selection). Test: POST `/api/v1/agent/chat` with a token_id that has dAMP fingerprint → router receives PersonalityContext with routing_affinity. Token without fingerprint → router receives no PersonalityContext (existing behavior). |
| T2.6 | Personality routing integration test suite | `tests/nft/routing-affinity.test.ts` + `tests/hounfour/personality-routing.test.ts`: (a) All 4 archetypes produce different pool rankings. (b) Distinctive dials shift pool preference vs. flat fingerprint. (c) **Tier safety negative tests**: free tier + personality preferring architect → gets cheap ONLY. Free tier + cheap unhealthy → explicit NO_ELIGIBLE_POOLS error, NOT escalation. Pro tier + only enterprise pools preferred → gets reviewer (highest-affinity within pro-allowed). (d) Pool health fallback works within tier-allowed set only. (e) Legacy v1 personalities get tier-default routing (no personality influence). (f) Agent-chat endpoint propagates PersonalityContext correctly. (g) Mock router confirms personality-driven pool selection in E2E flow. |

### Testing

- 4 archetypes produce distinct pool preference orderings
- Distinctive dials measurably shift pool selection
- **Tier access is NEVER escalated** — verified with explicit negative tests
- Health-aware fallback only walks tier-allowed pools
- No eligible pools → explicit error, NOT silent escalation
- Legacy personalities get existing behavior unchanged

---

## Sprint 3: Quality Feedback Loop + Observability

> **Global ID**: 123 | **Priority**: MEDIUM | **Dependencies**: Sprint 1 (EventStore for persistence), Sprint 2 (Routing for feedback source)
> **Goal**: Close the feedback loop between routing quality and future routing decisions. Track which model performs best for each personality genotype. Add Prometheus metrics with bounded cardinality.

### Context

Sprint 2 wires personality into routing, but the affinity matrix is static. Sprint 3 adds the feedback loop: track quality per (personality, model, task) tuple, and use accumulated evidence to adjust routing preferences over time. This is the "epigenetic" layer — experience modulates the genotype's expression.

The EventStore from Sprint 1 provides durable persistence for quality events, enabling temporal queries ("did this personality's preferred model change after epoch 5?").

### Dependency Wiring (GPT-5.2 fix #6)

`RoutingQualityStore` is a **singleton** instantiated at server startup and injected into both the experience accumulator (write path) and routing-affinity scoring (read path). Quality aggregation uses an **in-memory LRU cache** (max 1000 entries, TTL 5 minutes) keyed by `{personality_id}:{pool_id}`. Cache miss triggers a Postgres/JSONL read of last 100 events with exponential decay aggregation. Scoring at router-time reads only from cache — guaranteed <1ms per call.

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T3.1 | Define quality tracking event type + cached store | `src/nft/routing-quality.ts`: Define `RoutingQualityEvent` — emitted after each inference response: `{ personality_id, pool_id, model, task_type, latency_ms, tokens_used, quality_signals: { user_satisfaction?, coherence_score?, safety_pass } }`. Implement `RoutingQualityStore` as a singleton: (a) write path: append quality events to EventWriter on `"routing_quality"` stream (Sprint 1), (b) read path: `getPoolQuality(personality_id, pool_id): QualityScore | null` — reads from in-memory LRU cache (max 1000 entries, TTL 5 minutes). Cache miss: aggregate last 100 events from EventReader with exponential decay (half-life configurable via `FINN_ROUTING_QUALITY_DECAY_DAYS`, default 30). Cache hit: return cached score (<1ms). Test: append 50 quality events → getPoolQuality returns weighted average. Empty store → returns null. Cache TTL expiry → re-aggregates from store. Performance: 1000 sequential getPoolQuality calls complete in <100ms (cache hits). |
| T3.2 | Wire experience accumulator as quality signal source | `src/nft/experience-accumulator.ts`: After recording interaction metadata, emit a `RoutingQualityEvent` to the `RoutingQualityStore`. Map existing `CompletionMetadata` fields to quality signals: `latency_ms` from metadata, `tokens_used` from metadata, `safety_pass` from anti-narration check result (if available). `coherence_score` is optional (deferred to future LLM-as-judge implementation). Fire-and-forget: quality emission MUST NOT block response path. Test: experience accumulator records interaction → quality event appears in `routing_quality` stream. Accumulator with no quality store injected → no error (graceful skip). Emission failure → logged, not thrown. |
| T3.3 | Feed quality scores into routing affinity (cached, router-time) | `src/nft/routing-affinity.ts`: Add optional `RoutingQualityStore` dependency to scoring. Modify pool scoring: `final_score = static_affinity * (1 - quality_weight) + quality_score * quality_weight` where `quality_weight` defaults to 0.3 (configurable via `FINN_ROUTING_QUALITY_WEIGHT`). If no quality data for a (personality, pool) pair → use static_affinity only (no penalty for new pools). Quality score normalized to [0-1]. Scoring reads from RoutingQualityStore cache ONLY — no I/O at scoring time. When no RoutingQualityStore is injected, pure static routing (Sprint 2 behavior preserved exactly). Test: personality with quality data showing pool X outperforms → pool X gets boosted. No quality data → pure static affinity unchanged. Quality score of 0 → pool affinity reduced but not eliminated. Performance guard: `scorePoolByGenotype` + quality lookup completes in <1ms (measured). |
| T3.4 | Prometheus metrics with bounded cardinality | `src/gateway/metrics.ts`: Add counters and histograms with BOUNDED labels only (GPT-5.2 fix #7 — no `personality_id` in metric labels): `finn_routing_pool_selected{pool, archetype, task_type}` counter — tracks which pool was selected per archetype. `finn_routing_affinity_used{pool, archetype}` counter — tracks when personality affinity influenced selection. `finn_routing_fallback_total{from_pool, to_pool, reason}` counter — tracks personality-preferred pool → actual pool (health fallback or tier constraint). `finn_routing_quality_cache_hit_total` / `finn_routing_quality_cache_miss_total` counters — cache effectiveness. Per-personality diagnostics emitted as structured JSON logs (not metrics). Wire into router: emit metrics after pool selection. Test: mock Prometheus registry → router emits expected metric values. Verify NO metric has unbounded cardinality (no personality_id, no user_id, no session_id in labels). |
| T3.5 | E2E integration test + genotype/phenotype documentation | `tests/integration/personality-routing-e2e.test.ts`: Full pipeline test: (a) Create personality with freetekno archetype + high creativity dials. (b) Send chat request → router selects creativity-favoring pool (within tier). (c) Record quality event with high score for that pool. (d) Send another request → quality feedback boosts the pool's ranking (verify via metrics or mock). (e) Verify Prometheus metrics emitted with bounded labels. (f) Verify quality cache is populated and hit on second request. Add JSDoc throughout Sprint 2 + 3 code using genotype/phenotype vocabulary per Finding D-3: dAMP = genotype, BEAUVOIR = phenotype, experience = epigenetic layer, routing affinity = phenotypic expression of genotype. |

### Testing

- Quality events persist via EventStore and survive replay
- Quality feedback measurably influences routing decisions
- No quality data → graceful fallback to static affinity
- Prometheus metrics have BOUNDED cardinality (no personality_id in labels)
- Cache performance: <1ms per scoring call, <100ms for 1000 calls
- E2E: personality → routing → quality → improved routing loop

---

## Environment Variables (New)

| Variable | Sprint | Required | Description |
|----------|--------|----------|-------------|
| `FINN_EVENTSTORE_DIR` | 1 | No | Directory for JSONL event segments (default: `data/events/`) |
| `FINN_EVENTSTORE_MAX_SEGMENT_MB` | 1 | No | Max segment size in MB (default: 1024) |
| `FINN_ROUTING_QUALITY_DECAY_DAYS` | 3 | No | Half-life for quality score decay (default: 30) |
| `FINN_ROUTING_QUALITY_WEIGHT` | 3 | No | Weight of quality feedback in routing (default: 0.3, range 0-1) |
| `FINN_QUALITY_CACHE_MAX_ENTRIES` | 3 | No | Max LRU cache entries (default: 1000) |
| `FINN_QUALITY_CACHE_TTL_SECONDS` | 3 | No | Cache TTL in seconds (default: 300) |

---

## Success Criteria

| Metric | Target | Sprint |
|--------|--------|--------|
| Backend-agnostic EventStore | JSONL + Postgres backends both pass contract tests | Sprint 1 |
| Cross-stream replay | Events from different streams/backends replay independently | Sprint 1 |
| WAL backward compat | Golden-file fixture byte-identical before/after integration | Sprint 1 |
| Personality routing | dAMP genotype influences pool selection | Sprint 2 |
| Tier safety | Personality routing NEVER escalates tier access (negative tests) | Sprint 2 |
| No eligible pools | Explicit error when all tier-allowed pools unhealthy | Sprint 2 |
| Quality tracking | Per-(personality, model) quality scores accumulated via EventStore | Sprint 3 |
| Feedback loop | Quality data influences subsequent routing decisions | Sprint 3 |
| Metric cardinality | ALL Prometheus metrics have bounded label sets | Sprint 3 |
| Cache performance | Quality scoring <1ms per call at router-time | Sprint 3 |

---

## FAANG Parallels (from Bridgebuilder Deep Review)

| Vision | Parallel | Connection |
|--------|----------|------------|
| EventStore | Google Zanzibar changelog / Apache Kafka Streams | Single changelog for all state changes; any query resolved by replaying to timestamp |
| Personality Routing | Netflix recommendation engine / Spotify personalization | User embeddings → content/model ranking; genotype embeddings → pool ranking |
| Quality Feedback | Google Borg scheduling | Resource boundaries (credits, tier) + affinity scoring (personality) = optimal assignment |
| Tier Safety | AWS IAM deny-by-default | Hard allowlist enforced at every selection point, not just initial filtering |
