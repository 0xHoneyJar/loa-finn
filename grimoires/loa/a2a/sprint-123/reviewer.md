# Sprint 123: Quality Feedback Loop + Observability — Implementation Report

**Global ID**: 123 | **Local**: sprint-3 | **Cycle**: cycle-030
**Status**: All 5 tasks implemented with 34 new tests + 562 total tests passing

---

## Task Summary

| ID | Task | Status | Files |
|----|------|--------|-------|
| T3.1 | RoutingQualityEvent + RoutingQualityStore | Done | `src/nft/routing-quality.ts` |
| T3.2 | Wire experience accumulator as quality signal source | Done | `src/nft/experience-accumulator.ts` |
| T3.3 | Feed quality scores into routing affinity | Done | `src/nft/routing-affinity.ts` |
| T3.4 | Prometheus metrics with bounded cardinality | Done | `src/gateway/metrics-endpoint.ts`, `src/hounfour/router.ts` |
| T3.5 | E2E integration test + quality feedback documentation | Done | `tests/nft/routing-quality.test.ts` |

---

## Implementation Details

### T3.1: RoutingQualityEvent + RoutingQualityStore

**File**: `src/nft/routing-quality.ts`

**RoutingQualityEvent**: Emitted after each inference response — carries personality_id, pool_id, model, task_type, latency_ms, tokens_used, quality_signals (user_satisfaction, coherence_score, safety_pass).

**RoutingQualityStore** — singleton with dual read/write paths:
- **Write path**: `recordQuality()` appends to EventWriter on `STREAM_ROUTING_QUALITY` stream (fire-and-forget). Also updates LRU cache proactively for fast reads.
- **Read path**: `getPoolQuality()` reads from in-memory LRU cache (max 1000 entries, TTL 5 minutes). Cache miss aggregates last 100 events from EventReader with exponential decay (half-life configurable via `FINN_ROUTING_QUALITY_DECAY_DAYS`, default 30 days).
- **Hot path**: `getPoolQualityCached()` is synchronous cache-only read (no I/O) for use in scoring paths. Guaranteed <1ms.

**LRU Cache**: Custom implementation with configurable max size + TTL. Evicts oldest entry on capacity overflow. Expired entries removed on access.

**Exponential Decay Aggregation**: Recent events weighted exponentially higher. `weight = e^(-λ * age)` where `λ = ln(2) / halfLifeMs`.

**Incremental Cache Blending**: Hot path uses `α = max(1/(n+1), 1-decayFactor)` to blend new observations with cached score. The `1/(n+1)` floor ensures new observations always contribute even when age=0 (same-timestamp events). Large time gaps increase α via decay, giving new observations more weight for stale cached scores. This is consistent with the cold path's weighted average behavior.

**Reader Aggregation**: On cache miss, replays ALL matching events from EventStore, sorts by timestamp descending, takes the last N (most recent 100). Prevents the pitfall of only seeing the oldest 100 events if the stream has more.

**Quality Signal Computation**: `qualityFromSignals()` — safety_pass=false → 0 (hard floor). Otherwise averages available signals. No signals → 0.5 baseline.

### T3.2: Wire Experience Accumulator

**File**: `src/nft/experience-accumulator.ts`

- Added optional `qualityStore` to `AccumulatorConfig`
- Extended `accumulate()` signature with optional `routingContext: { pool_id, task_type, safety_pass? }`
- After `engine.recordInteraction()`, emits `RoutingQualityEvent` to qualityStore (fire-and-forget via `.catch(() => {})`)
- Emission MUST NOT block response path — errors are swallowed
- Without routingContext or qualityStore → graceful skip (no error)
- Backward compatible: existing callers without routingContext work unchanged

### T3.3: Quality Feedback → Routing Affinity

**File**: `src/nft/routing-affinity.ts`

Extended `computeRoutingAffinity()` with optional parameters:
- `qualityStore?: RoutingQualityStore | null`
- `personalityId?: string | null`
- `qualityWeight = 0.3` (configurable via `FINN_ROUTING_QUALITY_WEIGHT`)

Scoring formula:
- With quality data: `final = static_affinity * (1 - qualityWeight) + quality_score * qualityWeight`
- Without quality data: `final = static_affinity` (no penalty for new pools)
- Without qualityStore: Sprint 2 behavior preserved exactly

Quality reads from `getPoolQualityCached()` ONLY — synchronous, no I/O at scoring time.

### T3.4: Prometheus Metrics

**File**: `src/gateway/metrics-endpoint.ts`

Registered 5 new counters with BOUNDED cardinality labels:
- `finn_routing_pool_selected{pool, archetype, task_type}` — which pool selected
- `finn_routing_affinity_used{pool, archetype}` — personality affinity influenced selection
- `finn_routing_fallback_total{from_pool, to_pool, reason}` — fallback events
- `finn_routing_quality_cache_hit_total` — cache effectiveness
- `finn_routing_quality_cache_miss_total` — cache effectiveness

**File**: `src/hounfour/router.ts`

Wired ALL 5 metric emissions in `invokeForTenant()`:
- Emits `finn_routing_pool_selected` with bounded labels after pool selection
- Emits `finn_routing_affinity_used` when personality routing is active
- Emits `finn_routing_fallback_total` when personality-preferred pool is unhealthy (from_pool → to_pool, reason=unhealthy)
- Emits `finn_routing_fallback_total` when standard path `resolveWithFallback` returns different pool

**File**: `src/nft/routing-quality.ts`

Wired cache observability metrics:
- Emits `finn_routing_quality_cache_hit_total` in both `getPoolQuality()` and `getPoolQualityCached()` on cache hit
- Emits `finn_routing_quality_cache_miss_total` in both `getPoolQuality()` and `getPoolQualityCached()` on cache miss

**Cardinality bounds**: pool (5 values) × archetype (4 + "unknown") × task_type (bounded enum). NO personality_id, user_id, or session_id in any metric labels.

### T3.5: Test Suite + E2E

**File**: `tests/nft/routing-quality.test.ts` — 34 tests

| Test Group | Count | What |
|------------|-------|------|
| qualityFromSignals | 5 | Safety floor, baseline, averaging, unsafe override |
| aggregateWithDecay | 4 | Empty events, single event, recency weighting, clamping |
| RoutingQualityStore — Cache | 8 | Unknown key, caching, incremental update, eviction, TTL expiry, writer persistence, writer failure, null writer |
| RoutingQualityStore — Reader | 4 | Aggregation on miss, filtering, cache after aggregation, empty store |
| Performance | 1 | 1000 sequential cache hits <100ms |
| Accumulator emission (T3.2) | 4 | Emits with context, skips without context, skips without store, swallows errors |
| Quality → affinity (T3.3) | 4 | Quality boosts, no data = static, quality 0 reduces, Sprint 2 preserved |
| Prometheus metrics (T3.4) | 2 | Metrics registered, bounded labels verified |
| E2E pipeline (T3.5) | 2 | Quality shifts ranking, full accumulator→store→affinity loop |

---

## Test Results

```
tests/nft/routing-quality.test.ts     34 passed (34)
tests/nft/ + tests/hounfour/ + tests/gateway/  562 passed (562) across 26 files
```

No regressions in any affected module.

---

## Review Feedback Addressed

Three blocking issues from first review pass — all resolved:

| Issue | Problem | Fix |
|-------|---------|-----|
| 1 | 3 of 5 metrics registered but never emitted (fallback, cache hit/miss) | Wired `finn_routing_fallback_total` in `router.ts` for both personality-aware and standard paths. Wired `cache_hit/miss` in `routing-quality.ts` in both `getPoolQuality()` and `getPoolQualityCached()`. |
| 2 | Reader replays oldest 100 events, not last 100 | Changed to collect ALL matching events, sort by timestamp descending, take first N. |
| 3 | Incremental cache update uses simple averaging vs cold path exponential decay | Replaced with decay-aware blending: `α = max(1/(n+1), 1-decayFactor)`. Floor ensures same-timestamp contributions; decay increases new observation weight for stale scores. |

---

## Architecture Notes

### Singleton Dependency Injection

RoutingQualityStore is designed as a singleton, instantiated at server startup and injected into:
- ExperienceAccumulator (write path via `qualityStore` config)
- computeRoutingAffinity (read path via optional parameter)
- Both paths are optional — the system degrades gracefully without quality feedback

### Performance Guarantees

- Scoring reads from LRU cache ONLY (`getPoolQualityCached`) — no I/O
- 1000 sequential cache lookups: <100ms (measured)
- Quality emission is fire-and-forget — never blocks response path
- Cache miss aggregation is async and caches the result for subsequent calls

### dAMP Vocabulary (Finding D-3)

- **Genotype**: 96-dial dAMP fingerprint (static)
- **Phenotype**: Pool selection behavior (routing affinity)
- **Epigenetic layer**: Quality feedback that modulates genotype expression
- **Experience**: Accumulated quality observations over time

---

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/nft/routing-quality.ts` | Created | ~280 |
| `src/nft/experience-accumulator.ts` | Modified | +quality store, +routing context |
| `src/nft/routing-affinity.ts` | Modified | +quality blending in computeRoutingAffinity |
| `src/gateway/metrics-endpoint.ts` | Modified | +5 routing metric registrations |
| `src/hounfour/router.ts` | Modified | +metric emissions after pool selection |
| `tests/nft/routing-quality.test.ts` | Created | 34 tests |
