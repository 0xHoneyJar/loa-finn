# Sprint Plan: Hounfour v8.2.0 Upgrade — Commons Protocol + ModelPerformance

> **Version**: 1.1.0
> **Date**: 2026-02-25
> **Cycle**: cycle-033
> **PRD**: v1.1.0 (GPT-5.2 APPROVED)
> **SDD**: v1.1.0 (GPT-5.2 APPROVED)
> **Global Sprint IDs**: 132-133
> **Total Tasks**: 15

---

## Sprint 1: Bump + Foundation (Global ID: 132)

**Goal**: Bump dependency, verify exports, update handshake, establish re-export hub.

| Task | Title | Files | AC |
|------|-------|-------|-----|
| T-1.1 | Bump `@0xhoneyjar/loa-hounfour` to v8.2.0 tag | `package.json`, `pnpm-lock.yaml` | AC1: `pnpm ls` shows 8.2.0 |
| T-1.2 | Verify exports map — run import surface discovery | (bash verification) → `grimoires/loa/context/hounfour-v8.2.0-exports.md` (new) | AC5: (1) checked-in artifact listing all resolved entrypoints + named exports used by finn, (2) `./commons` and `./governance` resolve in TS compile context, (3) commands used to generate logged in artifact |
| T-1.3 | Update protocol-types.ts re-export hub | `src/hounfour/protocol-types.ts` | AC5: new types importable from hub |
| T-1.4 | Add import surface test | `tests/finn/protocol-imports.test.ts` (new) | AC5: all re-exports resolve without errors |
| T-1.5 | Bump `FINN_MIN_SUPPORTED` to `"7.0.0"`, add feature thresholds | `src/hounfour/protocol-handshake.ts` | AC4: v8.2.0 accept, v7.9.2 grace, v6.0.0 reject |
| T-1.6 | Add handshake test cases | `tests/finn/interop-handshake.test.ts` | AC4: test v8.2.0 compat, v7.9.2 grace, v6.0.0 reject |
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
```

---

## Acceptance Criteria Cross-Reference

| AC | Sprint | Tasks |
|----|--------|-------|
| AC1: dependency resolves to v8.2.0 | S1 | T-1.1 |
| AC2: zero regression | S1 | T-1.8 |
| AC3: conformance vectors pass | S1 | T-1.7 |
| AC4: handshake compat window | S1 | T-1.5, T-1.6 |
| AC5: new types importable | S1 | T-1.3, T-1.4 |
| AC6: QualityObservation validated | S2 | T-2.6, T-2.7 |
| AC7: 'unspecified' routes to default | S2 | T-2.3, T-2.4, T-2.5 |
| AC8: ReputationEvent all variants | S2 | T-2.1, T-2.2 |
| AC9: no postinstall patch | S1 | T-1.8 |

---

## Risk Mitigation Order

Sprint 1 is sequenced to surface risks early:
1. **T-1.1** (bump) — if `pnpm install` fails, stop immediately
2. **T-1.2** (exports verification) — if `./commons` doesn't resolve, need alternate import path; gates T-1.3, T-1.5, T-1.7
3. **T-1.3** (re-exports) — derived from T-1.2 discovery artifact, not speculative
4. **T-1.8** (full test suite + AC9 check) — catches structural schema breaks and confirms no postinstall patching before Sprint 2
