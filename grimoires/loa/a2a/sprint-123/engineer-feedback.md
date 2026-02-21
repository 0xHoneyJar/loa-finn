# Sprint 123: Quality Feedback Loop + Observability — Engineer Feedback (Pass 2)

**Reviewer**: Senior Technical Lead (code-level review)
**Date**: 2026-02-21
**Verdict**: All good

---

## Previous Blocking Issues — All Verified Fixed

### Issue 1: 3 metrics registered but never emitted — RESOLVED

All 5 metrics are now both registered (in `src/gateway/metrics-endpoint.ts` lines 211-215) AND emitted:

- `finn_routing_pool_selected`: emitted in `src/hounfour/router.ts` line 428 after pool selection.
- `finn_routing_affinity_used`: emitted in `src/hounfour/router.ts` line 434 when personality routing is active.
- `finn_routing_fallback_total`: emitted in `src/hounfour/router.ts` line 395 (personality-aware path, preferred pool unhealthy) and line 418 (standard path, resolved pool differs from requested).
- `finn_routing_quality_cache_hit_total`: emitted in `src/nft/routing-quality.ts` line 291 (`getPoolQuality()`) and line 339 (`getPoolQualityCached()`).
- `finn_routing_quality_cache_miss_total`: emitted in `src/nft/routing-quality.ts` line 296 (`getPoolQuality()`) and line 341 (`getPoolQualityCached()`).

The `metrics` import was added to `routing-quality.ts` (line 20), resolving Advisory 1 from the previous pass. The coupling between `nft/` and `gateway/` layers is acceptable given that `metrics-endpoint.ts` exports a global singleton registry — this is the standard pattern used across the codebase.

### Issue 2: Reader replays oldest 100 events — RESOLVED

`src/nft/routing-quality.ts` lines 300-316: The implementation now collects ALL matching events into `allMatching`, sorts by timestamp descending, and takes `slice(0, maxEventsToAggregate)` (the most recent N). This is correct.

### Issue 3: Incremental cache update uses simple averaging — RESOLVED

`src/nft/routing-quality.ts` lines 235-249: The blending formula now uses exponential decay:

```
halfLifeMs = decayHalfLifeDays * 24 * 60 * 60 * 1000
decayFactor = exp(-ln(2) / halfLifeMs * age)
alpha = max(1/(n+1), 1 - decayFactor)
blendedScore = existing.score * (1 - alpha) + quality * alpha
```

Verified correctness:
- Large age (stale cache): decayFactor -> 0, alpha -> 1, new observation dominates. Correct.
- Zero age (same timestamp): decayFactor = 1, 1 - decayFactor = 0, alpha = 1/(n+1) floor. New observation contributes proportionally. Correct.
- Lambda calculation matches cold path (`aggregateWithDecay` line 138). Consistent.
- Score clamped to [0,1]. Correct.

---

## Checklist Status (All Passing)

- [x] T3.1: RoutingQualityStore with LRU cache, TTL, exponential decay
- [x] T3.2: Quality emission is fire-and-forget (`.catch(() => {})` on line 158 of experience-accumulator.ts)
- [x] T3.3: Quality blending formula correct in `computeRoutingAffinity`
- [x] T3.4: All 5 metrics registered AND emitted with bounded cardinality
- [x] T3.5: E2E test covers accumulator -> store -> affinity loop
- [x] LRU cache handles eviction and TTL correctly
- [x] Exponential decay weights recent events higher
- [x] Incremental cache update consistent with cold path decay
- [x] Reader aggregation collects ALL events, takes last N
- [x] Metrics cardinality is bounded (no personality_id, user_id, session_id)
- [x] Sprint 2 behavior preserved when no quality store
- [x] No regressions to existing accumulator tests
- [x] Performance guard: <100ms for 1000 cache reads

---

## Advisory Notes (Non-Blocking)

### Advisory 1: No test for >100 event boundary in reader aggregation

The test suite ("aggregates from reader on cache miss") uses only 2 events. There is no test verifying that when more than 100 events exist, only the last 100 are aggregated. This is a coverage gap, not a correctness bug — the implementation at lines 314-316 is correct. Consider adding a test with >100 events in a follow-up.

### Advisory 2: Reader aggregation collects ALL events into memory

The current approach (line 300: collect all matching events, sort, slice) reads the entire stream into memory on cache miss. For a stream with millions of events for a single (personality, pool) pair, this could be expensive. Acceptable for now given the max 1000 cache entries and 5-minute TTL limiting how often this path runs. A follow-up task should consider per-(personality, pool) indexes or reverse replay when the stream grows large.

### Advisory 3: Cache hit/miss metrics emit on synchronous path

`getPoolQualityCached()` (lines 335-343) calls `metrics.incrementCounter()` on every cache read. Since this method is called from the hot scoring path in `computeRoutingAffinity()`, this adds a small overhead per scoring call. The `incrementCounter` implementation is a simple Map lookup + increment, so the cost is negligible — but worth noting for future profiling if the <1ms guarantee needs verification under high concurrency.

---

## Summary

All three blocking issues from the first review pass have been correctly resolved. The implementation is sound: the decay-aware blending formula in the hot path is mathematically consistent with the cold path, the reader now correctly aggregates the most recent events, and all 5 Prometheus metrics are wired end-to-end. The test suite covers the critical paths with 34 tests. Ready for audit.
