# Sprint Plan: Adaptive Intelligence — Quality Governance & Reputation Bootstrap

> **Version**: 1.1.0
> **Date**: 2026-02-21
> **Cycle**: cycle-031
> **Source**: Bridgebuilder Deep Review (PR #92) — Finding #6 (MEDIUM), Finding #7 (LOW), Forward Questions 1-4
> **Sprints**: 2 (12 tasks)
> **Global IDs**: 124–125
> **Team**: 1 agent (Claude Opus 4.6)
> **Predecessor**: cycle-030 "Forward Architecture — Economic Consciousness" (3 sprints, 123 global, 562 tests)
> **Bridge Review**: [Part 3](https://github.com/0xHoneyJar/loa-finn/pull/92#issuecomment-3937930880) — Forward Architecture Questions
> **GPT-5.2 Review**: Iteration 1 — 7 blocking issues resolved (v1.1.0)

---

## Sprint Overview

| Sprint | Global ID | Label | Tasks | Dependencies | Status |
|--------|-----------|-------|-------|-------------|--------|
| 1 | 124 | Quality Signal Governance + Anti-Sycophancy | 6 | None | |
| 2 | 125 | EventStore Indexed Access + Reputation Bootstrap | 6 | Sprint 1 | |

### Dependency Graph

```
Sprint 1 (Quality Governance) ──── Sprint 2 (IndexedAccess + Bootstrap)
```

### Source: Bridgebuilder Deep Review Findings & Questions

| Finding/Question | Description | Sprint |
|------------------|-------------|--------|
| Finding #6 (MEDIUM) | Quality Signal Ontology will become governance model — needs `challenge_rate`, anti-sycophancy | Sprint 1 |
| Question 1 | "What you measure determines what the system optimizes for" — deliberate signal design | Sprint 1 |
| Finding #7 (LOW) | EventStore `replay()` is O(total_events) per cache miss — needs indexing before 1M events | Sprint 2 |
| Question 2 | Reputation Bootstrap Problem — cold-start identical to Netflix/Uber recommendation systems | Sprint 2 |
| Question 3 | EventStore evolution: indexed lookup → compaction → materialized views | Sprint 2 |

### FAANG Parallels (from Bridgebuilder Review)

| Suggestion | Parallel | Connection |
|------------|----------|------------|
| Anti-sycophancy signals | Google Panda update (2011) — click-through rewarded clickbait, added "long click" and "pogo-sticking" as counter-signals | The quality signal ontology IS the governance model. Counter-signals prevent optimization gaming. |
| Reputation bootstrap | Netflix cold-start / Uber new-driver rating | No quality history → static fallback is correct default, but reputation portability unlocks collection-level intelligence |
| EventStore indexing | DynamoDB partition key / Kafka log compaction / CockroachDB CDC | Progressive evolution: index → compact → materialize. LRU cache buys time. |

### GPT-5.2 Review Fixes (v1.1.0)

| # | Issue | Fix Applied |
|---|-------|-------------|
| 1 | Collection index needs `collectionId → Set<personalityId>` secondary index for efficient T2.3 lookups | Added `Map<collectionId, Set<cacheKey>>` secondary index in T2.1. T2.3 collection lookup is O(#personalities_in_collection), not O(total_keys). |
| 2 | Node.js object overhead makes 16-byte memory estimate unrealistic | Changed to realistic ~200 bytes/entry estimate. Added hard cap (maxIndexKeys=1000, LRU eviction on index). Added heap bound acceptance criterion in tests. |
| 3 | JSONL compaction (atomic rename) doesn't apply to Postgres backend | Scoped T2.2 to JSONL-only. Added backend guard (no-op on Postgres). Future Postgres compaction via retention DELETE is a follow-up ticket. |
| 4 | Bootstrap decay claim unsupported by math — no explicit blending function | Added Bayesian pseudo-count blending: `q = (k*q_collection + n*q_personal)/(k+n)` with k=3. Tests assert prior weight <10% by n=5. |
| 5 | Governance processing in recordQuality() may violate fire-and-forget invariant | Added explicit acceptance criterion: governance wrapped in try/catch, never throws, never awaits I/O. Test with malformed env var → request path unblocked. |
| 6 | No schema validation for FINN_QUALITY_GOVERNANCE_OVERRIDES env var | Added strict validation: known signal keys only, finite non-negative weights, auto-normalize if sum>0, exclude safety_pass from weighting, fallback to defaults on parse error. |
| 7 | Collection reputation has no anti-sybil/manipulation resistance | Added min_sample_count threshold (default 5), max contributor cap (20 personalities), trimmed mean aggregation. Test: single outlier cannot move collection score beyond bound. |

---

## Sprint 1: Quality Signal Governance + Anti-Sycophancy

> **Global ID**: 124 | **Priority**: HIGH | **Dependencies**: None
> **Goal**: Transform the quality signal ontology from a passive measurement layer into an active governance model. Add anti-sycophancy detection, challenge_rate tracking, and archetype-aware signal weighting. The principle: **what you measure determines what the system optimizes for**.

### Context

The current `QualitySignals` interface (from sprint 123) carries three signals:

```typescript
interface QualitySignals {
  user_satisfaction?: number    // thumbs up/down → 0.0 or 1.0
  coherence_score?: number      // LLM-as-judge
  safety_pass: boolean          // hard floor
}
```

This is a reasonable v1 but creates a **sycophancy risk**: a model that always agrees with the user will score 1.0 on satisfaction and 0.0 on actual utility. Google learned this lesson with the Panda update (2011) — click-through rates rewarded clickbait, so they added "long click" (time on page) and "pogo-sticking" (returning to search quickly) as counter-signals.

The `safety_pass` hard floor is critical and correct. But `user_satisfaction` as a standalone float needs guardrails. The governance model needs:
1. **Counter-signals** that detect when satisfaction is gamed by sycophancy
2. **Challenge rate** — how often the personality pushes back on user assumptions
3. **Task completion** — did the user's downstream goal actually get accomplished
4. **Archetype-aware weighting** — a `freetekno` personality SHOULD challenge more than a `milady` personality

### Fire-and-Forget Invariant (GPT-5.2 fix #5)

All governance processing added to `recordQuality()` MUST be exception-safe and non-blocking. The existing invariant — quality emission never blocks the response path — is inviolable. Governance logic (sycophancy detection, archetype weighting, metrics emission) MUST be wrapped in try/catch within the fire-and-forget path. A malformed `FINN_QUALITY_GOVERNANCE_OVERRIDES` env var MUST NOT crash or block — fall back to defaults and increment an error counter.

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T1.1 | Extend QualitySignals with governance signals | `src/nft/routing-quality.ts`: Add new optional fields to `QualitySignals`: `challenge_rate?: number` — [0-1] measure of how often the personality pushes back on user assumptions (higher = more challenging). `task_completion?: number` — [0-1] measure of downstream task success (deferred signal, placeholder for future integration). `response_depth?: number` — [0-1] measure of engagement depth vs. surface agreement. All optional, backward compatible. Existing `qualityFromSignals()` must continue to work unchanged when new fields are absent. Test: QualitySignals with only `safety_pass` → existing behavior unchanged. With new fields populated → all contribute to quality score. |
| T1.2 | Implement anti-sycophancy detector | `src/nft/quality-governance.ts` (NEW): Implement `detectSycophancyRisk(signals: QualitySignals): { risk: boolean; confidence: number; reason?: string }`. Detection rules: (a) `user_satisfaction = 1.0` AND `coherence_score < 0.5` → HIGH risk (agreeable but incoherent). (b) `user_satisfaction > 0.8` AND `challenge_rate < 0.1` → MEDIUM risk (never pushes back). (c) `user_satisfaction > 0.9` AND `response_depth < 0.3` → MEDIUM risk (surface agreement). When sycophancy detected, export `adjustForSycophancy(signals: QualitySignals): QualitySignals` that caps effective `user_satisfaction` at `coherence_score` value. This prevents always-agreeing models from gaming the quality score. Test: satisfaction=1.0, coherence=0.3 → risk=true, adjusted satisfaction=0.3. Satisfaction=0.8, coherence=0.9 → risk=false, satisfaction unchanged. All signals absent → no risk detected, no adjustment. |
| T1.3 | Archetype-aware signal weighting governance with strict validation | `src/nft/quality-governance.ts`: Define `QualityGovernanceConfig` — maps archetype → signal weights for the 5 non-boolean signals (user_satisfaction, coherence_score, challenge_rate, task_completion, response_depth). `safety_pass` is EXCLUDED from weighting — it remains a hard floor that overrides all governance (GPT-5.2 fix #6). Default weights: `{ user_satisfaction: 0.3, coherence_score: 0.3, challenge_rate: 0.2, task_completion: 0.15, response_depth: 0.05 }`. Per-archetype overrides: `freetekno` — `challenge_rate: 0.3` (creative personalities should challenge more). `milady` — `user_satisfaction: 0.4` (social personalities prioritize engagement). `chicago_detroit` — `task_completion: 0.3` (assertive personalities are task-oriented). `acidhouse` — `response_depth: 0.25` (experimental personalities value depth). Export `getSignalWeights(archetype: Archetype)`. Weights auto-normalized to sum to 1.0. **Env var validation** (GPT-5.2 fix #6): `FINN_QUALITY_GOVERNANCE_OVERRIDES` parsed with strict schema — only known signal keys accepted, weights must be finite numbers ≥ 0, `safety_pass` key rejected, sum=0 → fallback to defaults, malformed JSON → log warning + fallback to defaults (never throw). Test: each archetype returns different weight distributions. All weight sets sum to 1.0. Malformed JSON env var → defaults used, error counter incremented. Negative weight → rejected. Unknown key `foo` → rejected. `safety_pass` in override → rejected. |
| T1.4 | Integrate governance into qualityFromSignals() (exception-safe) | `src/nft/routing-quality.ts`: Modify `qualityFromSignals()` to accept optional `archetype: Archetype` parameter. When archetype is provided: (a) apply anti-sycophancy adjustment, (b) use archetype-aware weights for final score. When archetype is absent: existing behavior (simple average of available signals). `safety_pass=false` ALWAYS returns 0 — this hard floor overrides all governance, applied BEFORE any weighting. Update `recordQuality()` to accept optional archetype in the event. Update `RoutingQualityEvent` to carry optional `archetype` field. **Fire-and-forget invariant** (GPT-5.2 fix #5): All governance processing in `recordQuality()` wrapped in try/catch. If governance throws (malformed config, unexpected signal value), log warning and fall back to ungoverned `qualityFromSignals()`. NEVER await I/O in governance path. NEVER propagate exceptions to caller. Test: quality computation with freetekno archetype produces different score than milady for same signals. Anti-sycophancy detection reduces score for agreeable-but-incoherent responses. Safety floor (safety_pass=false → 0) still overrides everything. Malformed governance config → ungoverned quality still computed, request path unblocked. |
| T1.5 | Prometheus metrics for quality governance | `src/gateway/metrics-endpoint.ts` + `src/nft/routing-quality.ts`: Register new bounded-cardinality counters: `finn_quality_sycophancy_detected_total{archetype}` — tracks sycophancy detection events per archetype (4 archetypes + "unknown" = 5 values). `finn_quality_governance_error_total` — tracks governance config parse errors or runtime failures. Wire emissions in `recordQuality()` after governance processing. Histogram metrics for signal distributions deferred to future sprint (Bridgebuilder Question 1 follow-up) — counters are sufficient for v1 observability. NO personality_id in labels (bounded cardinality preserved). Test: verify metrics registered. Verify sycophancy counter incremented when detection fires. Verify governance error counter incremented on malformed env var. Verify NO unbounded labels. |
| T1.6 | Quality governance integration test suite | `tests/nft/quality-governance.test.ts` (NEW): (a) Anti-sycophancy detection: 5 test cases covering all detection rules + edge cases (all signals absent, partial signals, boundary values). (b) Signal weighting: 4 archetypes × verify different weight distributions, all sum to 1.0. (c) Governance integration: quality computation with governance produces different scores for different archetypes given same signals. (d) Backward compatibility: existing tests in `routing-quality.test.ts` pass unchanged — `qualityFromSignals()` without archetype returns identical results to v1. (e) Env var validation: malformed JSON → defaults, negative weights → rejected, unknown keys → rejected, safety_pass key → rejected. (f) Safety floor: sycophancy-adjusted scores still respect safety_pass=false → 0. (g) Fire-and-forget: governance error → quality still computed, no throw. (h) E2E: record quality event with archetype + governance → cached score reflects governance adjustments. |

### Testing

- Anti-sycophancy detection catches all 3 risk patterns
- Archetype-specific weighting produces measurably different quality scores
- Backward compatibility: all 34 existing routing-quality tests pass unchanged
- Safety floor overrides governance adjustments
- Fire-and-forget invariant: governance errors never block response path
- Env var validation: malformed overrides degrade gracefully
- Prometheus metrics bounded cardinality maintained
- E2E: governance adjustments influence cached quality scores → routing decisions

---

## Sprint 2: EventStore Indexed Access + Reputation Bootstrap

> **Global ID**: 125 | **Priority**: MEDIUM | **Dependencies**: Sprint 1 (quality governance shapes reputation scores)
> **Goal**: Solve the O(total_events) replay performance bottleneck and the cold-start reputation problem. Add indexed EventStore access for O(1) lookups and collection-level reputation sharing with anti-manipulation guardrails.

### Context

**Performance**: The current `RoutingQualityStore.getPoolQuality()` on cache miss iterates the entire `routing_quality` stream to find matching events:

```typescript
for await (const envelope of this.reader.replay<RoutingQualityEvent>(STREAM_ROUTING_QUALITY)) {
  if (envelope.payload.personality_id === personalityId && envelope.payload.pool_id === poolId) {
    allMatching.push(...)
  }
}
```

At 100 events, fine. At 1M events (a few months of production quality recording), this becomes the bottleneck. The LRU cache (5-min TTL, max 1000 entries) buys time by making cache misses rare, but every cold start, TTL expiry, or cache eviction triggers a full scan.

**Cold Start**: When a new personality has no quality history, `getPoolQualityCached()` returns `null` and the system falls back to static affinity. This is correct (no penalty for missing data). But it creates the Netflix cold-start problem: new personalities get identical routing regardless of their collection's quality history.

Netflix solved this with content-based filtering (new users see popular content). Uber solved it with geographic baselines (new drivers get average ride distribution). loa-finn can solve it with **collection-level reputation sharing**: if other personalities in the same collection have quality history, use the collection average as a warm-start.

### Memory Model (GPT-5.2 fix #2)

The in-memory index stores `{ quality: number, timestamp: number }` tuples per key. In V8/Node.js, each object has ~64 bytes overhead (hidden class + properties), each array element pointer is 8 bytes, plus the Map entry overhead (~100 bytes per key). Realistic estimate: **~200 bytes per event entry**, **~200 bytes per index key overhead**.

Hard caps enforced:
- `maxIndexKeys`: 1000 (aligned with LRU cache maxSize) — LRU eviction on index when exceeded
- `maxEventsPerKey`: 100 (aligned with maxEventsToAggregate)
- **Worst-case memory**: 1000 keys × 100 events × 200 bytes = ~20MB (acceptable for a gateway process)
- Secondary collection index: `Map<collectionId, Set<cacheKey>>` adds ~50KB for 1000 keys across 10 collections

### Bootstrap Blending (GPT-5.2 fix #4)

Collection reputation uses a **Bayesian pseudo-count prior**:

```
q_effective = (k * q_collection + n * q_personal) / (k + n)
```

Where:
- `k` = pseudo-count (default 3, configurable via `FINN_BOOTSTRAP_PSEUDO_COUNT`)
- `q_collection` = collection-level trimmed mean quality
- `n` = number of personal quality events
- `q_personal` = personal quality score

At n=0: `q_effective = q_collection` (pure bootstrap)
At n=3: `q_effective = 0.5 * q_collection + 0.5 * q_personal` (equal blend)
At n=5: `q_effective = 0.375 * q_collection + 0.625 * q_personal` (personal dominates)
At n=10: `q_effective ≈ 0.23 * q_collection + 0.77 * q_personal`

Prior weight at n=5 is 37.5% — test asserts prior weight < 40% (conservative bound).

### Anti-Manipulation (GPT-5.2 fix #7)

Collection-level reputation aggregation has v1 defenses against Sybil/manipulation:

1. **Minimum sample threshold**: Only personalities with ≥ `minSampleCount` (default 5) quality events contribute to collection average
2. **Max contributor cap**: At most `maxContributors` (default 20) personalities contribute per pool — take the 20 with highest sample_count
3. **Trimmed mean**: Discard highest and lowest quality scores before averaging (removes outlier manipulation)
4. **Confidence weighting**: Each personality's contribution weighted by `min(sample_count / 50, 1.0)` — new personalities with few events have less influence

### Tasks

| ID | Task | Acceptance Criteria |
|----|------|-------------------|
| T2.1 | Add in-memory index with dual-key structure and collection secondary index | `src/nft/routing-quality.ts`: Add `QualityEventIndex` with two data structures: (a) **Primary index**: `Map<string, Array<{ quality: number; timestamp: number }>>` keyed by `personality_id:pool_id` — for O(1) lookups on cache miss. (b) **Secondary collection index** (GPT-5.2 fix #1): `Map<string, Set<string>>` mapping `collectionId → Set<cacheKey>` — enables efficient collection-level aggregation in T2.3 without scanning all keys. Collection ID extracted as the prefix before `:` in personality_id (e.g., `honeyjar` from `honeyjar:42`). Both indexes built lazily on first full scan (during `getPoolQuality()` cache miss). Updated incrementally on `recordQuality()`. **Hard caps** (GPT-5.2 fix #2): `maxIndexKeys=1000` with LRU eviction (evict oldest-accessed key when full), `maxEventsPerKey=100` (ring buffer — oldest event dropped on overflow). When index exists, cache miss uses indexed data instead of full stream replay. Index is optional — when not populated (first cache miss after startup), falls back to stream replay to build both indexes. Test: append 1000 events across 50 personality:pool pairs in 5 collections. First cache miss → full scan + dual index build. Second miss for different key → O(1) indexed lookup (no full scan). Collection secondary index correctly groups keys by collection prefix. LRU eviction at key cap works. Heap usage for 1000-key index < 25MB (measured). |
| T2.2 | Stream compaction for JSONL quality stream (JSONL-only) | `src/nft/routing-quality.ts`: Implement `compactQualityStream(retainPerKey: number = 100): Promise<{ keysCompacted: number; eventsRemoved: number }>`. **JSONL-only** (GPT-5.2 fix #3): compaction checks backend type — if EventWriter is not JSONL-backed, returns `{ keysCompacted: 0, eventsRemoved: 0 }` (no-op). For Postgres, future work: retention DELETE job keyed by (personality_id, pool_id) with windowing (logged as follow-up). JSONL algorithm: (a) full scan of `routing_quality` stream, (b) group by `personality_id:pool_id`, (c) for each key retain only the `retainPerKey` most recent events, (d) write compacted events to new stream file, (e) atomically swap (rename old → `.bak`, rename new → active). Compaction runs on-demand (not automatic in v1 — callers decide when). After compaction, the in-memory index is rebuilt. Test: 1000 JSONL events across 10 keys → compact(retain=50) → 500 events remain (50 per key). Compacted stream replays identically to original for recent events. Quality scores computed from compacted stream match pre-compaction scores (within floating-point epsilon). Postgres backend → no-op, zero events removed. |
| T2.3 | Collection-level reputation aggregation with anti-manipulation | `src/nft/reputation-bootstrap.ts` (NEW): Implement `ReputationBootstrap` class. Constructor accepts `RoutingQualityStore` (for index access) and `ReputationConfig` (tunable thresholds). Method `getCollectionQuality(collectionId: string, poolId: string): QualityScore | null`. Algorithm: (a) Use secondary collection index from T2.1 to get all `cacheKey`s for `collectionId` — O(#personalities_in_collection), NOT O(total_keys) (GPT-5.2 fix #1). (b) Filter to personalities with `sample_count >= minSampleCount` (default 5) — excludes low-data personalities (GPT-5.2 fix #7). (c) Cap at `maxContributors` (default 20), selecting by highest `sample_count`. (d) Weight each contributor by `min(sample_count / 50, 1.0)` — confidence weighting. (e) Apply **trimmed mean**: discard highest and lowest scores, weighted-average the rest. (f) Return aggregated score. If fewer than 2 qualifying personalities → returns null (insufficient data for trimming). Test: 3 personalities with scores [0.8, 0.6, 0.7] and sufficient samples → trimmed mean ≈ 0.7. Empty collection → null. Single personality → null (can't trim). 1 outlier at 0.1 among [0.7, 0.8, 0.7, 0.8, 0.1] → trimmed mean ≈ 0.75 (outlier discarded). Personality with only 2 events (below minSampleCount=5) → excluded from aggregation. |
| T2.4 | Warm-start protocol with Bayesian pseudo-count blending | `src/nft/reputation-bootstrap.ts`: Add `getQualityWithBootstrap(personalityId: string, poolId: string, collectionId?: string): { score: QualityScore | null; source: "personal" | "bootstrap" | "none" }`. Lookup cascade: (1) Personality quality (cache) with n personal events → if found, blend with collection prior. (2) No personal data, collection quality exists → return collection quality as bootstrap with `source: "bootstrap"`. (3) Neither → return `{ score: null, source: "none" }` (static affinity, current behavior). **Bayesian blending** (GPT-5.2 fix #4): When personal data exists AND collection data exists, compute `q_effective = (k * q_collection + n * q_personal) / (k + n)` where `k` is pseudo-count (default 3, configurable via `FINN_BOOTSTRAP_PSEUDO_COUNT`). This ensures: at n=0, pure collection prior; at n=5, prior weight = k/(k+n) = 3/8 = 37.5% (< 40%); at n=10, prior weight ≈ 23%. Test: new personality, no history, collection has history → returns bootstrap score with source="bootstrap". Personality with 5 personal events → prior weight < 40% of effective score. Personality with 10+ events → prior weight < 25%. Both empty → source="none". Bootstrap score with source="bootstrap" used in routing → measurably shifts pool selection vs. pure static affinity. |
| T2.5 | Wire reputation bootstrap into routing affinity | `src/nft/routing-affinity.ts`: Modify `computeRoutingAffinity()` to accept optional `collectionId: string` and optional `reputationBootstrap: ReputationBootstrap`. When `qualityStore` is present and no personality quality exists, attempt collection-level bootstrap via `getQualityWithBootstrap()`. Bootstrap scores from source="bootstrap" blend at Bayesian-discounted weight (already computed in T2.4). Personal scores from source="personal" use standard `qualityWeight`. No data (source="none") → pure static affinity (current behavior). Without collectionId or reputationBootstrap → current behavior exactly (no bootstrap). Test: new personality in collection with quality history → routing differs from pure static affinity. Same personality without collectionId → pure static affinity. Established personality with 10+ events → routing nearly identical to no-bootstrap (prior weight negligible). |
| T2.6 | Performance + integration test suite | `tests/nft/reputation-bootstrap.test.ts` (NEW) + updates to `tests/nft/routing-quality.test.ts`: (a) **Index performance**: 10,000 events → indexed lookup <1ms (vs. full scan). First miss triggers scan, subsequent misses use index. Heap bound: 1000-key index < 25MB. (b) **Compaction correctness**: pre/post compaction quality scores match within epsilon. Postgres backend → no-op. (c) **Collection aggregation**: multi-personality collection produces correct trimmed mean. minSampleCount filter works. maxContributor cap works. Single outlier cannot shift score more than 10% vs. trimmed mean without outlier. (d) **Warm-start cascade**: personal → bootstrap → none fallback works correctly. (e) **Bootstrap Bayesian decay**: at n=5 personal events, collection prior weight < 40%. At n=10, < 25%. Monotonically decreasing. (f) **Anti-manipulation**: attacker mints 50 personalities with score=0.0, all below minSampleCount → collection score unaffected. Attacker with 1 high-sample personality at score=0.0 among 5 honest personalities → trimmed mean excludes the outlier. (g) **E2E**: new personality minted in active collection → first request uses bootstrap routing → quality recorded → subsequent requests increasingly use personal quality. (h) **Backward compat**: all 34+ existing routing-quality tests pass unchanged. All Sprint 1 governance tests pass. |

### Testing

- Indexed lookup is O(1) after initial build — measured <1ms for 10K events
- Heap bound: index < 25MB for 1000 keys
- Stream compaction preserves quality score accuracy (JSONL-only; Postgres no-op)
- Collection reputation sharing provides meaningful warm-start with anti-manipulation
- Bayesian bootstrap decay: prior weight < 40% by 5 personal events
- Anti-sybil: outlier personalities cannot shift collection score beyond bound
- All 34+ existing routing-quality tests pass unchanged
- Performance: 1000 sequential cache lookups still <100ms

---

## Environment Variables (New)

| Variable | Sprint | Required | Description |
|----------|--------|----------|-------------|
| `FINN_QUALITY_GOVERNANCE_OVERRIDES` | 1 | No | JSON string overriding archetype signal weights (strict schema validation — known keys only, finite ≥ 0, safety_pass excluded) |
| `FINN_SYCOPHANCY_DETECTION_ENABLED` | 1 | No | Enable/disable anti-sycophancy detection (default: true) |
| `FINN_BOOTSTRAP_PSEUDO_COUNT` | 2 | No | Bayesian pseudo-count k for collection prior blending (default: 3) |
| `FINN_BOOTSTRAP_MIN_SAMPLES` | 2 | No | Minimum quality events per personality to contribute to collection reputation (default: 5) |
| `FINN_BOOTSTRAP_MAX_CONTRIBUTORS` | 2 | No | Max personalities contributing to collection reputation per pool (default: 20) |
| `FINN_QUALITY_INDEX_ENABLED` | 2 | No | Enable in-memory quality event index (default: true) |
| `FINN_QUALITY_INDEX_MAX_KEYS` | 2 | No | Max keys in quality event index before LRU eviction (default: 1000) |
| `FINN_QUALITY_COMPACTION_RETAIN` | 2 | No | Events to retain per key during compaction (default: 100) |

---

## Success Criteria

| Metric | Target | Sprint |
|--------|--------|--------|
| Anti-sycophancy detection | Catches agreeable-but-incoherent responses | Sprint 1 |
| Archetype governance | Different archetypes produce different quality scores for same signals | Sprint 1 |
| Backward compatibility | All 34 existing routing-quality tests pass unchanged | Both |
| Safety floor | `safety_pass=false` always overrides governance | Sprint 1 |
| Fire-and-forget | Governance errors never block response path | Sprint 1 |
| Env var validation | Malformed governance overrides degrade gracefully to defaults | Sprint 1 |
| Bounded cardinality | ALL new Prometheus metrics have bounded label sets | Sprint 1 |
| Indexed lookup | O(1) cache miss resolution after initial scan, heap < 25MB | Sprint 2 |
| Stream compaction | Quality scores preserved within epsilon after compaction (JSONL-only) | Sprint 2 |
| Collection bootstrap | New personalities get warm-start from collection peers | Sprint 2 |
| Anti-manipulation | Outlier personality cannot shift collection score > 10% | Sprint 2 |
| Bootstrap decay | Collection prior weight < 40% by 5 personal events | Sprint 2 |

---

## Architecture Notes

### The Governance Model Insight

The Bridgebuilder review's deepest observation: **the quality signal ontology IS the governance model**. What loa-finn measures determines what the system optimizes for. A system that only measures user satisfaction will converge on sycophancy. A system that only measures coherence will converge on mediocrity.

The governance model in Sprint 1 introduces *counter-signals* — measurements that create tension with each other. A personality cannot simultaneously maximize satisfaction (by agreeing with everything) and challenge rate (by pushing back on assumptions). This tension is the mechanism that prevents degenerate optimization.

This is the same insight behind Google's search quality evolution:
- v1: PageRank (link authority) → gamed by link farms
- v2: Panda (content quality) → counter-signal to thin content
- v3: BERT (semantic understanding) → counter-signal to keyword stuffing

Each counter-signal closed an optimization loophole. Sprint 1 closes the sycophancy loophole.

### The Reputation Portability Principle

Sprint 2's collection-level reputation sharing embodies a Web4 principle: if reputation is a form of social currency, the ability to port it across contexts is a feature, not a bug.

When a user mints a new NFT in the `honeyjar` collection, that NFT should benefit from the collection's accumulated quality history — not start from zero. This is analogous to:
- **Credit bureaus**: a new account benefits from the holder's credit history
- **Google Scholar**: a new paper benefits from the author's h-index
- **Uber**: a new market benefits from the driver's rating in other markets

The Bayesian pseudo-count blending (k=3) encodes appropriate skepticism: collection reputation is a *prior*, not a *certainty*. It fades monotonically as personal data accumulates, ensuring earned reputation always dominates inherited reputation. The anti-manipulation guardrails (trimmed mean, min samples, max contributors) prevent a single actor from poisoning the collection's reputation — the same defense mechanism that TripAdvisor uses for its review aggregation.
