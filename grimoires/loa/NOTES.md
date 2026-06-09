# NOTES.md

## Session Continuity

### /ride --enriched re-analysis (2026-06-08)
Re-rode loa-finn (supersedes stale cycle-013 reality, Feb 11). Codebase grew ~3x: 28 modules /
359 non-test files / ~81.6K LOC / 374 tests (was "15 modules, 120+ files"). A whole economic/NFT
layer landed undocumented in the README module map: `nft`(73), `x402`(17), `credits`(16),
`billing`(13), `substrate`(12), `marketplace`, `events`, `oracle`, `tracing`.

Ride results: drift 6.5/10 · consistency 8/10 · governance 9/10 (230 semver tags).
**Critical drift**: `package.json` `"license":"MIT"` contradicts AGPL-3.0 (`LICENSE.md`+README) → GAP-001.
7 gaps filed (`gaps.md`, session `a51c`); 2 ADRs catalogued (`reality/decisions.md`); 30 domain
terms (`reality/terminology.md`). Reality files refreshed (9 spokes, ~5.8K tokens).

**Judgment call**: `prd.md`/`sdd.md` are genuine hand-authored feature docs (Per-NFT Personality,
2026-03-26) — NOT overwritten. Ride output written to `prd-ride-reality.md` / `sdd-ride-reality.md`.
Phase 8 legacy-deprecation skipped (would have wrongly deprecated SECURITY/CONTRIBUTING/README).
Artifact verification: 20/20 persisted.

### Finn PRD discovery — the Score-truth-agent reframe (2026-06-08)
`/discovering-requirements` for a NEW Finn/Economy-OS PRD (→ `prd-finn-economy-os.md`; do NOT touch
Cycle-040 `prd.md`). Operator pivoted the spine mid-discovery: first SKU = **Score-as-a-truth-agent**
(grounded integrity scoring of tokens + agents, legit-vs-farm), NOT the vending machine. First
deliverable = **demand-discovery via a bottom-up market study** (dogfood our truth tool on the live
agent economy — ~82% theater per aGDP Epoch 5 — to map where real deal flow goes). Build target stays
**exploratory** (PLAN v3 pillars not committed). Full reframe + locked decisions + Score lineage:
`context/2026-06-08-finn-score-truth-agent-reframe.md`. Market study `w74auxo01` DONE (6 grounded
probes): the "real earner" (aixbt) is ~99% token/~31% accuracy/no audited track record; real WTP is
institutional provenance subs (Kaito ~$40M ARR). Wedge = a no-LLM deterministic aGDP leaderboard
X-ray (wash-confidence per agent), weekly X thread, 3-report experiment with falsifiable kill-gates.
**Spine ratified:** token=free-first · buyer=institutions+allocators · timing=enter-now-but-substrate-
agnostic (1→3) · posture=spike/derisk/experiment. **PRD v2 written:** `prd-finn-economy-os.md`.
GPT-5 adversarial review (via codex — governed 3-model Flatline is mis-wired here: config aliases
`gpt-5.2`/`gemini-2.5-flash` unknown to loa_cheval + opus needs absent ANTHROPIC_API_KEY; flagged, not
silently worked around). 7 blockers integrated: honesty reframe (forensic spike, NOT asserted
credit-bureau) · **defamation/legal as a Phase-1 gate** (publicly naming agents "wash-farming" =
real risk) · Distribution-GO vs Commercial-GO (WTP) split · anomaly-language + validation gate +
facts-first · auditable-not-un-gameable + token-conflict guard · adversary model · moat definition.
Demand-discovery-first sequencing was the one part GPT-5 credited. Review raw:
`a2a/flatline/prd-codex-adversarial-review.raw.txt`.
Recall finding: governed memory has nothing on this thesis (it's new — promote by operator hand only).

### Finn/Score Phase-1 sprint plan written (2026-06-09)
`/sprint-plan` over `prd-finn-economy-os.md` + `sdd-finn-economy-os.md` (Phase-1 forensic spike ONLY;
Cycle-040 `prd.md`/`sdd.md`/`sprint.md` UNTOUCHED — confirmed clean in git). Plan →
`grimoires/loa/sprint-finn-score.md` (new path, NOT `sprint.md`). **4 sprints**, mapped 1:1 to SDD §8:
S1 substrate-agnostic pure core + GraphSource port + 3 tables (FR-1/2/6, MEDIUM/6) · S2 ingestion +
epoch job + PREMISE smoke (FR-1/7, MEDIUM/6) · S3 validation harness (FR-2a, SMALL/3) · S4 report +
publication-hold + GO instrumentation (FR-3/§7, LARGE/7). All demand-gated work EXCLUDED (no
LLM/wallet/Bedrock/broker/token/MCP). SDD open Qs grounded into tasks: Q2 event-sigs→T2.1, Q3
farming-band→T2.6, Q1 precision-bar→T3.1. OD-7 legal/Q5 is a PARALLEL HUMAN track that the
publication-hold blocks on — noted, NOT an engineering sprint. SDD-referenced organs all verified on
disk; `src/score/` is greenfield.
**Ledger:** new `cycle-041`, global ids **165–168** (max prior = 164; the `next_global_sprint_id`
pointer was stale at 158 — bumped to 169). Note: ledger carries 10 pre-existing duplicate global_id
groups (126–132, 144–146) from legacy double-registration — I added ZERO new collisions.
**Beads:** 4 epics (bd-2pyh/ua3w/ajio/90cu) + 22 child tasks, epic-blocking deps S1→S2→S3→S4
(S1 unblocked root, S4 terminal). Beads SQLite was empty (5) vs JSONL (578) — reconciled via
`br sync --merge` (three-way), NOT force-flush (would have lost 255 issues). All 26 cycle-041 lines
in JSONL.

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
