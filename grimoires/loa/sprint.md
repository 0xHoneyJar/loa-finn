# Sprint Plan: Hounfour v8.2.0 Upgrade — Commons Protocol + ModelPerformance

> **Version**: 1.2.0
> **Date**: 2026-02-25
> **Cycle**: cycle-033
> **PRD**: v1.1.0 (GPT-5.2 APPROVED)
> **SDD**: v1.1.0 (GPT-5.2 APPROVED)
> **Global Sprint IDs**: 132-134
> **Total Tasks**: 24
> **Bridgebuilder Review**: [PR #107 Comment](https://github.com/0xHoneyJar/loa-finn/pull/107#issuecomment-3957731958)

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
