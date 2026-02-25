# NOTES.md

## Learnings

### TypeBox FormatRegistry Footgun (cycle-033, T-3.9)

**Symptom**: `Value.Check()` silently passes invalid UUIDs and date-time strings.

**Cause**: TypeBox's `FormatRegistry` starts empty. Schemas using `{ format: "uuid" }` or
`{ format: "date-time" }` constraints will pass _any_ string if the format checker is not
registered first. The `import "./typebox-formats.js"` side-effect import registers these
formats, but side-effect imports are fragile — test runners may hoist or reorder imports,
and tree-shakers may eliminate "unused" imports.

**Fix (defense-in-depth)**:
1. **Side-effect import**: `import "./typebox-formats.js"` at module top (primary).
2. **Runtime guard**: Check `FormatRegistry.Has("uuid")` before `Value.Check()` and throw
   an explicit error if not registered (belt-and-suspenders, T-3.2).
3. **Test setup**: `tests/setup/typebox-formats.setup.ts` registered as vitest `setupFiles`
   ensures formats are available regardless of test order (T-3.3).

**Reference**: Bridgebuilder review Finding F4 (Medium), PR #107.

### Routing Vocabulary: 6 TaskTypes → 5 RoutingKeys (cycle-033, T-3.9)

**Decision**: Protocol defines 6 `TaskType` values: `code_review`, `creative_writing`,
`analysis`, `summarization`, `general`, `unspecified`. These map to 5 `NFTRoutingKey` values:
`code`, `chat`, `analysis`, `default` (×2), with `summarization` mapping to `analysis`.

**Rationale**: `summarization` and `analysis` are both "deep-think" tasks requiring
reasoning-capable models. Merging them at the routing layer keeps pool configuration simple
(5 slots per personality, not 6) while the protocol retains semantic precision for telemetry.
This parallels Kubernetes CRD extensibility — multiple API resources can map to a single
controller when the execution characteristics are equivalent.

**Compile-time safety**: `mapKnownTaskType()` has no `default` branch — if a new protocol
variant is added to the `TaskType` union, TypeScript will produce a compile error until the
mapping is updated (T-3.1).

**Reference**: Bridgebuilder review Finding F5 (Medium) + F10 (Medium), PR #107.

### KnownFoo Exhaustive Pattern (cycle-033, T-4.4)

**Pattern**: Exhaustive mapping over a known subset of an open union, with safe fallback
for unknown variants. Solves the TypeScript problem where `TUnion<[...literals, TString]>`
collapses to `string`, making exhaustive `switch` impossible.

**Structure**:
1. **Closed inner function** — `mapKnownTaskType(taskType: KnownTaskType): NFTRoutingKey` with
   no `default` branch and a `never` check. TypeScript compile error if a known variant is
   unhandled.
2. **Known set** — `KNOWN_TASK_TYPE_SET: ReadonlySet<string>` derived from the `KNOWN_TASK_TYPES`
   const array. Runtime O(1) membership test.
3. **Open wrapper** — `mapTaskTypeToRoutingKey(taskType: TaskType): NFTRoutingKey` narrows via
   Set guard, delegates known values to the inner function, falls back to `"default"` for
   unknown strings.

**Parallels**:
- **Android API Levels**: Known API versions have deterministic feature sets; unknown future
  versions gracefully degrade to the highest known level.
- **Protobuf open enums**: Known values are typed; unknown wire values are preserved as integers
  without breaking the protocol.

**Implementing files**: `src/hounfour/nft-routing-config.ts` (`KnownTaskType` + `mapKnownTaskType`).

**Applicability**: Any protocol union that may grow new variants upstream — `AccessPolicyKind`,
`ReputationEventKind`, future `GovernanceMutationKind`. The pattern ensures loa-finn handles
known variants exhaustively while remaining forward-compatible with unknown ones.

**Reference**: Bridgebuilder Deep Review Finding 2 (PRAISE), PR #107.

### Autopoietic Loop — Design Sketch (cycle-033, T-4.5)

**Concept**: A 6-stage feedback cycle where quality measurement influences future model
selection through reputation:

```
quality_signal → reputation_event → reputation_store → tier_resolution → model_selection → quality_measurement
      ↑                                                                                          ↓
      └──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Current state (v8.2.0)**:
- Stages 1-2 **built**: `scoreToObservation()` emits `QualityObservation`, `normalizeReputationEvent()`
  validates and normalizes all 4 `ReputationEvent` variants.
- Stages 3-4 **partially built**: `resolvePool()` in `tier-bridge.ts` maps routing keys to NFT
  pools, but does not yet query reputation data to weight pool selection.
- Stages 5-6 **not wired**: No consumer reads reputation scores to influence which model
  handles a given task type.

**Gap**: The loop is open between stages 2 and 4. `normalizeReputationEvent()` produces
normalized events but nothing consumes accumulated reputation to influence `resolvePool()`.

**Integration point**: `resolvePool()` could query dixie's `PostgresReputationStore` to weight
pool selection based on model performance history. This would close the loop:
poor-performing models receive fewer tasks, high-performing models receive more.

**Status**: SPECULATION — not blocking merge. Candidate for a future cycle. The prerequisite
is a reputation query interface from dixie that loa-finn can call at routing time.

**Reference**: Bridgebuilder Deep Review Finding 5 (SPECULATION), PR #107.

### Trust Infrastructure — Three-Legged Architecture (cycle-033, Sprint 6)

**Architecture**: The trust infrastructure spans three repositories, each owning a distinct
verification domain:

| Leg | Repository | Domain | Verification Status |
|-----|-----------|--------|-------------------|
| **finn** | `loa-finn` | Format validation, capability negotiation, routing, quality observation | Verified (Sprint 4-6) |
| **freeside** | `loa-freeside` | Economic conservation, credit lots, x402 payment protocol | Partial E2E |
| **dixie** | `loa-dixie` | Knowledge freshness, conviction voting, reputation aggregation | Unit only |

**Current verification per leg**:
- **finn**: Protocol handshake negotiates capabilities (Sprint 4). KnownFoo pattern applied to
  TaskType and ReputationEvent discrimination (Sprint 3 + Sprint 6 T-6.1). Quality observation
  pipeline instrumented with metrics (T-6.3). Reputation query interface defined (T-6.2).
  Quarantine records use commons schema (T-6.4). Integration test covers stages 1, 4-6 (T-6.5).
- **freeside**: Conservation laws verified via `BillingConservationGuard` (Sprint 5 T-5.4). Audit
  trail hash chain with integrity verification (T-5.6). Economic invariants schema-validated.
- **dixie**: Unit tests only. Reputation store and conviction voting not yet E2E verified.

**Autopoietic loop status (updated Sprint 6)**:
- Stage 1 (quality signal): `QualityGateScorer.scoreToObservation()` — **instrumented**
- Stage 2 (reputation event): `normalizeReputationEvent()` with KnownFoo — **built**
- Stage 3 (reputation store): dixie `PostgresReputationStore` — **not integrated**
- Stage 4 (tier resolution): `resolvePoolWithReputation()` — **built** (accepts `ReputationQueryFn`)
- Stage 5 (model selection): `PoolRegistry.resolve()` — **built**
- Stage 6 (quality measurement): `QualityObservation` schema-validated — **instrumented**

**Prerequisites for closing the loop**: All three legs must be E2E verified. The critical gap is
Stage 3: dixie's reputation store must expose a query interface that finn can call at routing time.
`ReputationQueryFn` (T-6.2) defines the contract; dixie must implement the provider.

**Trust analog** (web4 manifesto): "Trust must be verified, but verification patterns can be
universal." The three legs share commons schemas (`QuarantineRecordSchema`, `AuditEntrySchema`,
`QualityObservationSchema`, `ReputationEventSchema`) ensuring consistent verification across
the trust boundary.

## Blockers
