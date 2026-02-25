# Sprint Plan: Hounfour v8.2.0 Upgrade — Commons Protocol + ModelPerformance

> **Version**: 1.3.0
> **Date**: 2026-02-25
> **Cycle**: cycle-033
> **PRD**: v1.1.0 (GPT-5.2 APPROVED)
> **SDD**: v1.1.0 (GPT-5.2 APPROVED)
> **Global Sprint IDs**: 132-135
> **Total Tasks**: 30
> **Bridgebuilder Review**: [PR #107 Comment](https://github.com/0xHoneyJar/loa-finn/pull/107#issuecomment-3957731958)
> **Deep Review**: [PR #107 Deep Review](https://github.com/0xHoneyJar/loa-finn/pull/107#issuecomment-3957980938)

---

## Sprint 1: Bump + Foundation (Global ID: 132)

**Goal**: Bump dependency, verify exports, update handshake, establish re-export hub.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-1.1 | Bump `@0xhoneyjar/loa-hounfour` to v8.2.0 tag | `package.json`, `pnpm-lock.yaml` | AC1: `pnpm ls` shows 8.2.0 |
| T-1.2 | Verify exports map — run import surface discovery | (bash verification) → `grimoires/loa/context/hounfour-v8.2.0-exports.md` (new) | AC5: (1) checked-in artifact listing all resolved entrypoints + named exports used by finn, (2) `./commons` and `./governance` resolve in TS compile context, (3) commands used to generate logged in artifact |
| T-1.3 | Update protocol-types.ts re-export hub | `src/hounfour/protocol-types.ts` | AC5: new types importable from hub |
| T-1.4 | Add import surface test | `tests/finn/protocol-imports.test.ts` (new) | AC5: all re-exports resolve without errors |
| T-1.5 | Bump `FINN_MIN_SUPPORTED` to `"7.0.0"`, add feature thresholds | `src/hounfour/protocol-handshake.ts` | AC4: Acceptance window = `[FINN_MIN_SUPPORTED, CONTRACT_VERSION.major]`. Algorithm: (1) reject `remote < 7.0.0` (below min), (2) reject `remote.major > local.major` (future major), (3) accept `remote.major == local.major` (same major — 8.x), (4) accept `remote.major < local.major && remote >= 7.0.0` with cross-major warning (grace for 7.9.2). Boundary tests: 7.0.0=accept+warn, 7.9.2=accept+warn, 8.0.0=accept+warn(minor), 8.2.0=accept, 6.9.9=reject, 9.0.0=reject |
| T-1.6 | Add handshake test cases | `tests/finn/interop-handshake.test.ts` | AC4: test all boundary cases from T-1.5 AC + v6.0.0 reject-in-prod throws FATAL |
| T-1.7 | Update conformance vector assertions | `tests/finn/conformance-vectors.test.ts` | AC3: manifest match + ≥202 baseline |
| T-1.8 | Run full test suite — zero regression + AC9 verification | (all tests) | AC2: `pnpm test` exits 0; AC9: verify no `postinstall` script referencing hounfour in `package.json`, no `pnpm.patchedDependencies` entry for hounfour, no `patch-package` patches for hounfour |

**Sprint 1 acceptance**: All existing tests pass with v8.2.0 installed. Handshake, conformance, and import surface tests green. 8 tasks.

---

## Sprint 2: Adoption + Forward-Compat (Global ID: 133)

**Goal**: Wire new v8.2.0 features into loa-finn with schema-validated contracts.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-2.1 | Add ReputationEvent normalizer with schema validation | `src/hounfour/reputation-event-normalizer.ts` (new) | AC8: handles all 4 variants |
| T-2.2 | Add normalizer tests (4 variants + invalid + exhaustiveness) | `tests/finn/reputation-event-normalizer.test.ts` (new) | AC8: all pass |
| T-2.3 | Rename `NFTTaskType` → `NFTRoutingKey`, add mapping functions | `src/hounfour/nft-routing-config.ts` | AC7: (1) complete TaskType set from v8.2.0 protocol as input union, (2) `mapTaskTypeToRoutingKey()` with TS exhaustive switch + `never` check, (3) `mapUnknownTaskTypeToRoutingKey()` total at runtime for `unknown` inputs — `'unspecified'` → `'default'`, unknown strings → `'default'` with warning, (4) `KNOWN_ROUTING_KEYS` set derived from NFTRoutingKey union |
| T-2.4 | Wire `mapUnknownTaskTypeToRoutingKey()` into tier-bridge | `src/hounfour/tier-bridge.ts` | AC7: `'unspecified'` routes to default pool |
| T-2.5 | Add `'unspecified'` routing test | `tests/finn/nft-routing.test.ts` | AC7: test through resolvePool entrypoint |
| T-2.6 | Add `scoreToObservation()` to QualityGateScorer | `src/hounfour/quality-gate-scorer.ts` | AC6: returns QualityObservation-conformant output |
| T-2.7 | Add QualityObservation schema validation tests | `tests/finn/quality-observation.test.ts` (new) | AC6: Value.Check passes + negative tests |

**Sprint 2 acceptance**: All new tests pass. ReputationEvent normalized with schema gate. TaskType mapped through clean boundary. Quality output validated against protocol schema. 7 tasks.

---

## Sprint 3: Bridgebuilder Excellence (Global ID: 134)

**Goal**: Implement all improvements from the [Bridgebuilder review](https://github.com/0xHoneyJar/loa-finn/pull/107#issuecomment-3957731958) — compile-time safety, runtime guards, test determinism, security hardening, decision documentation, and observability enrichment.

| Task | Title | Files | AC | Finding |
|------|-------|-------|-----|---------|
| T-3.1 | Split `mapTaskTypeToRoutingKey` into exhaustive core + wrapper | `src/hounfour/nft-routing-config.ts` | AC10: (1) new `mapKnownTaskType(taskType: TaskType): NFTRoutingKey` has no `default` branch — TypeScript compile error if new protocol variant added, (2) `mapTaskTypeToRoutingKey` delegates to `mapKnownTaskType`, (3) `mapUnknownTaskTypeToRoutingKey` unchanged, (4) all existing routing tests pass | F5 (Medium) |
| T-3.2 | Add FormatRegistry guard in normalizer | `src/hounfour/reputation-event-normalizer.ts` | AC11: (1) `normalizeReputationEvent` checks `FormatRegistry.Has("uuid")` before `Value.Check`, (2) throws explicit `"TypeBox format 'uuid' not registered — import typebox-formats.js"` error if not registered, (3) existing normalizer tests still pass | F4 (Medium) |
| T-3.3 | Add format registration verification test + test setup | `tests/finn/typebox-formats.test.ts` (new), `vitest.config.ts` or test setup | AC11: (1) add `tests/setup/typebox-formats.setup.ts` that imports `../../src/hounfour/typebox-formats.js` — register via vitest `setupFiles` to ensure deterministic format registration regardless of test order or module isolation, (2) test verifies `FormatRegistry.Has("uuid")` returns true after setup, (3) test verifies `FormatRegistry.Has("date-time")` returns true, (4) test verifies UUID regex accepts valid UUIDs and rejects invalid strings, (5) test verifies date-time accepts ISO 8601 and rejects garbage strings, (6) test verifies the guard from T-3.2: importing normalizer *without* format registration (via dynamic import in isolated context or mock) throws the explicit error message | F1 suggestion |
| T-3.4 | Redact unknown task type from console.warn | `src/hounfour/nft-routing-config.ts` | AC12: (1) `console.warn` message says `"Unknown task type received"` without echoing the input value, (2) existing routing tests still pass | F6 (Low) |
| T-3.5 | Use deterministic timestamps in test fixtures | `tests/finn/reputation-event-normalizer.test.ts` | AC13: (1) `envelope.timestamp` is a fixed ISO string (not `new Date().toISOString()`), (2) all 10 normalizer tests still pass | F7 (Low) |
| T-3.6 | Update `resolvePool` JSDoc to document routing key mapping | `src/hounfour/tier-bridge.ts` | AC14: (1) JSDoc on `resolvePool` explicitly states that `taskType` is mapped through `mapUnknownTaskTypeToRoutingKey` before NFT preference lookup, (2) resolution order updated to mention the mapping step | F10 (Medium) |
| T-3.7 | Add `FEATURE_THRESHOLDS_ORDERED` array | `src/hounfour/protocol-handshake.ts` | AC15: (1) define `FEATURE_ORDER: readonly (keyof PeerFeatures)[]` as a single explicit ordered list of feature names (key-name duplication is acceptable since thresholds are not duplicated), (2) derive `FEATURE_THRESHOLDS_ORDERED = FEATURE_ORDER.map(name => ({ name, threshold: FEATURE_THRESHOLDS[name] }))` — threshold values come from the existing map, (3) add `satisfies` constraint ensuring `FEATURE_ORDER` covers all `keyof PeerFeatures`, (4) add test verifying: (a) `FEATURE_ORDER.length === Object.keys(FEATURE_THRESHOLDS).length`, (b) thresholds in the ordered array are monotonically non-decreasing by version, (c) every `PeerFeatures` key appears exactly once | F3 suggestion |
| T-3.8 | Enrich `scoreToObservation` with optional `dimensions` | `src/hounfour/quality-gate-scorer.ts` | AC16: (1) `scoreToObservation` accepts optional `dimensions?: Record<string, number>` parameter, (2) when provided, dimensions are included in the returned `QualityObservation`, (3) existing quality-observation tests still pass, (4) new test: `scoreToObservation` with dimensions validates against schema | F9 suggestion |
| T-3.9 | Document routing vocabulary ADR + FormatRegistry footgun | `grimoires/loa/NOTES.md`, `src/hounfour/nft-routing-config.ts` (header comment) | AC17: (1) NOTES.md documents the FormatRegistry footgun with symptoms, cause, and fix, (2) NOTES.md documents why 6 protocol TaskTypes map to 5 routing keys (summarization≈analysis rationale), (3) `nft-routing-config.ts` header comment references the routing vocabulary decision and notes the Kubernetes CRD extensibility parallel | F10 + Decision Trail |

**Sprint 3 acceptance**: All findings from Bridgebuilder review addressed. Zero regression (96+ hounfour tests pass). Compile-time exhaustiveness restored on known TaskType mapping. Runtime guards prevent silent format-registration failures. Test determinism improved. Security hardening on log output. Decision trails documented for future agents. 9 tasks.

---

## Task Dependency Graph

```
Sprint 1 (sequential within, parallel across independent tasks):
  T-1.1 → T-1.2 → T-1.3 → T-1.4
  T-1.1 → T-1.2 → T-1.5 → T-1.6
  T-1.1 → T-1.2 → T-1.7
  T-1.8 (after all above)

Sprint 2 (parallel tracks, all depend on Sprint 1 completion):
  Track A: T-2.1 → T-2.2  (ReputationEvent)
  Track B: T-2.3 → T-2.4 → T-2.5  (TaskType mapping)
  Track C: T-2.6 → T-2.7  (QualityObservation)

Sprint 3 (parallel tracks, all depend on Sprint 2 completion):
  Track D: T-3.1 → T-3.4  (Routing: exhaustive split + redact warn)
  Track E: T-3.2 → T-3.3 → T-3.5  (FormatRegistry: guard + test + determinism)
  Track F: T-3.6 → T-3.9  (Documentation: JSDoc + ADR)
  Track G: T-3.7  (Handshake: thresholds ordered)
  Track H: T-3.8  (Quality: dimensions enrichment)
```

---

## Acceptance Criteria Cross-Reference

| AC | Sprint | Tasks |
|----|--------|-------|
| AC1: dependency resolves to v8.2.0 | S1 | T-1.1 |
| AC2: zero regression | S1, S3 | T-1.8, all S3 tasks |
| AC3: conformance vectors pass | S1 | T-1.7 |
| AC4: handshake compat window | S1 | T-1.5, T-1.6 |
| AC5: new types importable | S1 | T-1.3, T-1.4 |
| AC6: QualityObservation validated | S2, S3 | T-2.6, T-2.7, T-3.8 |
| AC7: 'unspecified' routes to default | S2 | T-2.3, T-2.4, T-2.5 |
| AC8: ReputationEvent all variants | S2 | T-2.1, T-2.2 |
| AC9: no postinstall patch | S1 | T-1.8 |
| AC10: exhaustive TaskType mapping (no default) | S3 | T-3.1 |
| AC11: FormatRegistry guard + verification | S3 | T-3.2, T-3.3 |
| AC12: console.warn redacts input | S3 | T-3.4 |
| AC13: deterministic test timestamps | S3 | T-3.5 |
| AC14: resolvePool JSDoc documents mapping | S3 | T-3.6 |
| AC15: FEATURE_THRESHOLDS_ORDERED | S3 | T-3.7 |
| AC16: scoreToObservation dimensions | S3 | T-3.8 |
| AC17: decision trail documentation | S3 | T-3.9 |

---

## Risk Mitigation Order

Sprint 1 is sequenced to surface risks early:
1. **T-1.1** (bump) — if `pnpm install` fails, stop immediately
2. **T-1.2** (exports verification) — if `./commons` doesn't resolve, need alternate import path; gates T-1.3, T-1.5, T-1.7
3. **T-1.3** (re-exports) — derived from T-1.2 discovery artifact, not speculative
4. **T-1.8** (full test suite + AC9 check) — catches structural schema breaks and confirms no postinstall patching before Sprint 2

Sprint 3 risk is low — all tasks are refinements to existing code with existing test coverage. Key risk:
5. **T-3.1** (exhaustive split) — removing the `default` branch could cause compile error if protocol types don't match. Run `tsc --noEmit` after the change to verify.
6. **T-3.2** (FormatRegistry guard) — must not break existing tests that already import typebox-formats.js. Guard should be a safety net, not a behavior change.

---

## Sprint 4: Pre-Merge Polish — Deep Review Findings (Global ID: 135)

**Goal**: Address all remaining findings from the [Bridgebuilder Deep Review](https://github.com/0xHoneyJar/loa-finn/pull/107#issuecomment-3957980938) (Field Report #41). Fix the second FormatRegistry victim (store.ts), harden side-effect import ordering, document ecosystem conventions, and sketch the feedback pathway. Prepare PR #107 for merge.

**Source**: Deep Review findings 2-7 (Finding 3 already fixed in c32fb4c).

| Task | Title | Files | AC | Finding |
|------|-------|-------|-----|---------|
| T-4.1 | Centralize format registration with assertFormatsRegistered() | `src/hounfour/typebox-formats.ts` | AC18: (1) export `assertFormatsRegistered(formats: readonly string[]): void` from the existing `typebox-formats.ts` module — same file that registers formats via side-effect, no new module needed, (2) function checks `FormatRegistry.Has()` for each format and throws with clear message listing all missing formats, (3) refactor normalizer's inline `FormatRegistry.Has` guard (T-3.2) to call `assertFormatsRegistered(["uuid", "date-time"])`, (4) all existing tests pass, (5) import path remains `./typebox-formats.js` (standard TS ESM `.js` extension convention — source is `.ts`, runtime resolves `.js`) | F7 (LOW) |
| T-4.2 | Add FormatRegistry guard to store.ts Value.Check | `src/cron/store.ts` | AC19: (1) import `../hounfour/typebox-formats.js` side-effect at module top (registers formats), (2) import `assertFormatsRegistered` from same module, (3) call `assertFormatsRegistered(["uuid", "date-time"])` before `Value.Check()` at line 199, (4) existing store tests pass unchanged, (5) new test using `vi.isolateModules` or `vi.resetModules`: import `store.ts` without the vitest setup file's format registration and assert `assertFormatsRegistered` throws the explicit error; then import with `typebox-formats` preloaded and assert `Value.Check` succeeds on a format-dependent schema | F4 (MEDIUM) |
| T-4.3 | Add app-level format init to entry point | `src/index.ts` | AC20: (1) import `./hounfour/typebox-formats.js` as the **first** import in `src/index.ts` (the sole runtime entry point, per SDD §10.2), (2) add comment explaining why this must be first: FormatRegistry is a global singleton, all downstream `Value.Check` calls depend on it, (3) call `assertFormatsRegistered(["uuid", "date-time"])` inside `main()` before any module that uses `Value.Check` is invoked, (4) verify: `pnpm start` (or equivalent) does not throw on startup | F7 (LOW) |
| T-4.4 | Document KnownFoo exhaustive pattern as ecosystem convention | `grimoires/loa/NOTES.md` | AC21: (1) new section "KnownFoo Exhaustive Pattern" documenting the pattern: closed inner function with `never` check + open wrapper with Set guard, (2) names the Android API Level / protobuf open enum parallels, (3) lists the specific files implementing it: `nft-routing-config.ts` (KnownTaskType), (4) notes applicability to future open unions in the protocol (e.g., if AccessPolicyKind or ReputationEventKind grow new variants) | F2 (PRAISE → documentation) |
| T-4.5 | Sketch reputation→routing feedback pathway | `grimoires/loa/NOTES.md` | AC22: (1) new section "Autopoietic Loop — Design Sketch" describing the 6-stage feedback cycle: quality_signal → reputation_event → reputation_store → tier_resolution → model_selection → quality_measurement, (2) identifies the current gap: scoreToObservation emits but no consumer reads reputation to influence routing, (3) names the concrete integration point: `resolvePool()` in tier-bridge.ts could query dixie's PostgresReputationStore to weight pool selection, (4) marks as SPECULATION — not blocking merge, future cycle candidate | F5 (SPECULATION) |
| T-4.6 | Final merge readiness — test suite + conflict check | all test files, git | AC23: (1) `pnpm test` exits 0 with all hounfour tests passing (target: 112+), (2) `git merge-base --is-ancestor origin/main HEAD` confirms no divergence, (3) `tsc --noEmit` clean, (4) no console.error or unhandled rejection in test output | Merge gate |

**Sprint 4 acceptance**: All deep review findings addressed or documented. store.ts FormatRegistry vulnerability closed. Format registration centralized with single assertion point (`assertFormatsRegistered`). Entry point (`src/index.ts`) registers formats before any downstream consumer. Ecosystem patterns documented for future agents. Autopoietic loop sketched but explicitly deferred. Full test suite green. Ready for merge. 6 tasks.

---

## Updated Task Dependency Graph

```
Sprints 1-3: COMPLETED (24 tasks)

Sprint 4 (parallel tracks, depends on Sprint 3 completion):
  Track I: T-4.1 → T-4.2 → T-4.3  (FormatRegistry: centralize → store fix → entry point)
  Track J: T-4.4  (Documentation: KnownFoo pattern)
  Track K: T-4.5  (Documentation: autopoietic loop sketch)
  Track L: T-4.6  (after all above — final merge gate)
```

## Updated Acceptance Criteria Cross-Reference

| AC | Sprint | Tasks |
|----|--------|-------|
| AC1-AC17 | S1-S3 | (see above — all completed) |
| AC18: centralized assertFormatsRegistered() | S4 | T-4.1 |
| AC19: store.ts FormatRegistry guard | S4 | T-4.2 |
| AC20: app-level format init (src/index.ts) | S4 | T-4.3 |
| AC21: KnownFoo pattern documentation | S4 | T-4.4 |
| AC22: autopoietic loop design sketch | S4 | T-4.5 |
| AC23: merge readiness gate | S4 | T-4.6 |

## Sprint 4 Risk Assessment

Sprint 4 risk is minimal — all code changes are additive guards and refactors to existing patterns:
7. **T-4.1** (centralize assertion) — adds `assertFormatsRegistered()` export to existing `typebox-formats.ts` and refactors the normalizer's inline check. Risk: changing the assertion could break normalizer tests. Mitigation: function is additive — existing side-effect registration is untouched, assertion is belt-and-suspenders.
8. **T-4.2** (store.ts guard) — applies the centralized assertion to store.ts. Main risk: store.ts may not use format-dependent schemas in practice, making the guard a no-op safety net. This is acceptable — defense-in-depth. Test isolation via `vi.isolateModules` may require vitest config adjustment.
9. **T-4.3** (entry point init) — adding side-effect import as first line of `src/index.ts` (sole entry point per SDD §10.2). Risk: import order could affect startup timing. Mitigation: formats are cheap to register (two regex patterns), placed before any module that calls `Value.Check`.
