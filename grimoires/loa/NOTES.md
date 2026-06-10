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

### Finn/Score cycle-041 Sprint 1 BUILT + code-reviewed (2026-06-09)
Branch `feature/score-phase1` (off HEAD, LOCAL — not pushed). Clean-tree setup first: shielded 289
pre-existing untracked `.claude/` construct installs + `src/*.js` build artifacts via
`.git/info/exclude`; the grimoires planning docs (prd/sdd/sprint/context) are git-IGNORED by Loa
convention (local-only — that's why they never commit). **S1 = the substrate-agnostic pure forensic
core** under `src/score/`: TxGraph + GraphSource port (FR-6 seam + Virtuals stub) · recomputeLeaderboard
(FR-1, net = gross − subsidy − circular) · jaccardOverlap + buyerCountDeviation (FR-2) · union-find
clustering · screenAnomaly (HIGH/MED/LOW/INSUFFICIENT, FR-2a invariants by construction). 3 additive
drizzle tables + hand-written migration `0002` (drizzle-kit generate has a pre-existing bigint bug;
migrations here are hand-maintained). vitest config: added `src/score/` to the grep root (mirrors
substrate). **GPT-5 codex code-review found 2 HIGH + 3 MED real bugs — all fixed** (branch-order
downgrade, subsidy-alone-HIGH over-accusation, Number(bigint) threshold flip, inconsistent agent
universe, cluster-threshold coupling). **26/26 tests pass, src/score typechecks clean.** Commits:
99355d27 (planning state) · 104bf95d (S1 impl) · 7b083ce6 (beads close) · cb0a5738 (review fixes).
AC verification: `a2a/score-sprint-1/reviewer.md`. Flatline mis-wired in this repo (loa_cheval aliases
gpt-5.2/gemini-2.5-flash unknown + opus needs absent ANTHROPIC_API_KEY) → used codex as the working
cross-model lane for both PRD and code review.

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

## Session 2026-06-09 — cost-of-play reframe (cycle-041 → service-agent economics)

Finn reframed: service-agent/operator CONSUMING Score API verdicts behind a Markov blanket; the open
risk is marginal economics, not analysis capability. Forks resolved: verdicts-consumer (score island
stays, producer-side architecturally) · Railway vs payload-real stub · ad-hoc composition.

- **Design (build-from doc):** `grimoires/loa/specs/arch-finn-cost-of-play.md` — representative call
  (`/api/v1/score/verdict`, Class A relay / Class B cheval-enrich), 3-ledger CostAtom, fail-closed
  cheval-ROI gate (incl. no-inference-on-abstain), lean image, pre-registered H1 ≤20%/>40%.
- **Composition run PROVEN:** `cost-of-play-0609b` → `valid_run`, digest sha256:b5986c43…;
  `compositions/cost-of-play.yaml` authored ad-hoc (the-weaver naming pending).
- **Runtime finding:** construct adapters ignored task-mandated reads 4/4 → 4 clews captured;
  executor grounded via Explore + merged at seams with operator ratification.
- **Score API exists** (research-stage): 0xHoneyJar/score-api PR #263 — layered fact-sheet verdict,
  abstain-by-default; ACP escrow economy tiny ($30 top earner) → marginal-cost scope only.
- **Next:** micro-sprint the V1 checklist (items 1–4 are /implement-gated app code), deploy, run
  playtest phases 0–3, readout vs pre-registered bars.

## Session 2026-06-09 (build) — sprint-169 COMPLETED (cost-of-play V1 built + gated)

`/run sprint-169` full cycle, local mode (no finn origin remote — only the loa framework
remote exists; cycle-041 stays a local branch by operator convention). 4 commits on
`feature/score-phase1`: impl (8 tasks) → review cycle-2 fixes (F1-F8) → cycle-3 day-bound
reservation tokens → audit fixes (A1 timing-safe bearer, A2 harness disclosure).

- **Review found real bugs** (cross-model mandate earned its keep): codex dissent caught
  6 BLOCKING incl. the InfraEstimator-never-fed AC violation (also found by self-review),
  the kill-switch concurrency race (fixed via day-bound reservation tokens reserved in the
  same microtask as the gate decision), corrupt-spend-file silent ceiling reset, and
  unvalidated cheval telemetry (float contamination path). Codex VERIFICATION pass on the
  fixes then caught the cross-midnight reservation-theft edge — two-pass dissent works.
- **Final state:** 78/78 new-suite tests · island 26/26 · full gate 4991 passed (sole fail =
  pre-existing native-runtime-spike load-flake, passes in isolation at HEAD; knownFailures
  candidate) · lean image 1.11GB (beat 1.2-1.35 target) · phase-0 smoke 5/5 atoms, sum
  invariant holds · COMPLETED marker written, ledger sprint-169 completed, epic bd-hwa1 closed.
- **Working-tree forensics:** 6 stale May-3 compiled .js files (shielded in .git/info/exclude)
  shadowed .ts sources under vitest ESM resolution → 182 phantom test failures; verified
  pre-existing via clean HEAD worktree, deleted.
- **Metering deviation (documented in report):** NativeRuntimeMeter NOT used for Class B —
  it writes into production budget/cost-ledger; the atom is the experiment's meter.
- **NEXT (operator-paced):** item 8 — Railway deploy (2 services, finn-lean 1 replica +
  score-stub private networking, env per enhance doc) → phases 0-3 → readout vs sha-pinned
  bars (`scripts/playtest/cop-bars.json`, sha b98a5716…). Verify Railway unit prices on
  dashboard BEFORE readout. Operator directs: deploy go/no-go, phase transitions, verdict.

## Session 2026-06-09 (build) — flatline transport triage

FIRST-ACT flatline on the build doc hit 3 stacked infra defects in finn's vendored framework
(May-04 vintage, predates loa#727 headless adapters):

1. **mktemp suffix bug** — `.claude/scripts/lib/invoke-diagnostics.sh:69` uses
   `mktemp …-XXXXXX.log`; macOS/BSD mktemp won't randomize non-trailing X's, creates the literal
   name once, every later run dies "File exists". Mitigation: `rm -f $TMPDIR/loa-flatline-*XXXXXX.log*`
   before each run. Upstream fix belongs in loa (System Zone here — not edited).
2. **cheval.py error masking** — `cheval.py:412` `except BudgetExceededError` raises
   UnboundLocalError (name not in scope) and masks every real transport error. Also upstream.
3. **All 3 API transports dead in this environment**: OPENAI_API_KEY valid but
   **insufficient_quota** (verified direct curl) · ANTHROPIC_API_KEY unset · GOOGLE_API_KEY not in
   this cheval's env allowlist (the broken `fast-thinker`/gemini binding from the handoff).
   OpenAI circuit-breaker `.run/circuit-breaker-openai.json` was stuck OPEN from these — reset.

**Route taken:** ran the multi-model review via the main loa repo's orchestrator
(`~/Documents/GitHub/loa`, has codex/gemini/claude-headless adapters + fallback chains),
`--doc` pointed at finn's build doc, `--skip-knowledge`. Results land in
`grimoires/loa/a2a/flatline/cop-v1-build-review.json`.

## Session 2026-06-09 (plan) — cost-of-play V1 micro-sprint registered

`/sprint-plan` produced `grimoires/loa/sprint-cost-of-play.md` — ONE LARGE micro-sprint
(**global sprint 169**, cycle-041 sprint-5; ledger bumped to next_global_sprint_id 170) covering
build items 1–7 of `specs/enhance-finn-cost-of-play-v1.md`; item 8 (Railway deploy + phases 0–3)
stays operator-paced ops. Beads: epic `bd-hwa1` + 8 tasks (`bd-xbso` T5.1 atom, `bd-e4f4` T5.2 stub,
`bd-m08z` T5.3 gate P0, `bd-5dvb` T5.4 rpc counter, `bd-ops2` T5.5 lean image, `bd-viy9` T5.6 driver,
`bd-yugv` T5.7 readout+bars, `bd-a087` T5.E2E P0), deps mirror the dependency graph, label sprint:169.

**Grounded discovery during planning:** `vitest.config.ts:12` grep roots only scan
`tests/ src/substrate/__tests__/ src/score/` — the new `src/cost` + `deploy/score-stub` tests would
silently collect ZERO (exactly flatline IMP-016). T5.1 extends the grep roots + removes the untracked
`src/cost/tmp-verify.test.ts` probe; T5.E2E asserts non-zero collected counts. Also: spec cited
rpc-pool execute at :99-145; actual `execute()` is `src/x402/rpc-pool.ts:154` (plan cites :154).
Note `/Users/zksoju/bonfire/finn` is a SYMLINK to this repo (same inode) — not a second clone.

**Next:** `/run sprint-169` (implement→review→audit; decideGate + cost-atom middleware REQUIRE
cross-model review at the review gate), then item-8 deploy via use-railway, phases 0→3, readout.
