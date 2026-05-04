# Sprint 157 (local sprint-5) — GovernedBilling Production Pathway

**Cycle:** 038 — Hounfour v8.3.0 Upgrade
**Status:** COMPLETE
**Date:** 2026-02-28

---

## Tasks Completed

### T-5.1: GovernedBilling shadow-mode wiring
- Added `isGovernedBillingEnabled()` function in state-machine.ts (reads `FINN_GOVERNED_BILLING` env var at call time)
- Added `runGovernedShadow()` private method to BillingStateMachine — creates GovernedBilling shadow, compares state, logs structured divergence telemetry
- Wired shadow into all 6 transition methods: reserve, commit, release, void_, finalizeAck, finalizeFail
- Shadow is fully synchronous, pure/in-memory — no DB, no network, no additional awaits
- When flag absent or false: zero overhead, no shadow instantiation
- **Files:** `src/billing/state-machine.ts`, `src/billing/governed-billing.ts`

### T-5.2: GovernedBilling invariant telemetry
- Shadow emits structured JSON after each transition: `{ event: "governed_billing_invariants", entryId, invariants: { cost_non_negative, valid_state, reserve_conservation }, all_hold }`
- Invariant failures produce `console.warn` (observational only — shadow mode)
- **Files:** `src/billing/state-machine.ts`

### T-5.3: GovernedBilling integration tests
- Created `tests/finn/billing/governed-billing-shadow.test.ts` with 11 test cases:
  - Flag absent: no shadow, no logs (2 tests)
  - Identical transitions: reserve, full lifecycle (2 tests)
  - Structured telemetry format validation (1 test)
  - Divergence detection via vi.spyOn mock (1 test)
  - Shadow purity: no I/O during comparison (1 test)
  - Performance budget: <5ms per transition (1 test)
  - runShadow unit tests: correct states, invariants, terminal state handling (3 tests)
- **Files:** `tests/finn/billing/governed-billing-shadow.test.ts`
- **Tests:** 11 passing

### T-5.4: Trust infrastructure framing in SDD
- Added SDD §7 "Trust Infrastructure Context" with:
  - Trust primitives framing (hash chains, conservation laws, GovernedResource, consumer contracts)
  - Ostrom's 8 commons governance principles mapped to hounfour/finn analogs
  - Ecosystem context with real issue/PR references (Freeside #62, Hounfour #90, #31)
  - GovernedBilling migration roadmap (4 phases)
- Renumbered subsequent sections (§7→§8, §8→§9, §9→§10)
- **Files:** `grimoires/loa/sdd.md`

### T-5.5: Verification gate
- Billing shadow tests: 11 pass
- All hounfour tests: 186 pass, 0 regressions
- Existing billing tests: 45 pass with flag=false
- Total: 242 tests pass, 0 regressions
- Flag=false is behavioral no-op (verified via dedicated test)

## Test Results

| Suite | Pass | Fail | Notes |
|-------|------|------|-------|
| governed-billing-shadow | 11 | 0 | All new (T-5.3) |
| billing-state-machine | 45 | 0 | 0 regressions |
| All hounfour | 186 | 0 | 0 regressions |

## Bug Fix During Implementation

- **GovernedBilling.applyEvent billing_commit validation**: BillingStateMachine.commit() validates RESERVE_HELD→COMMITTED then sets FINALIZE_PENDING (collapsed step). GovernedBilling.applyEvent was checking VALID_TRANSITIONS directly against FINALIZE_PENDING which failed. Fixed by using COMMITTED as the validation target for billing_commit events.

## Design Decisions

1. **Function over const for env var**: `isGovernedBillingEnabled()` reads env at call time instead of module load time, making it testable without module mocking
2. **runShadow as synchronous public method**: Avoids the async ceremony of GovernedResourceBase.transition() — creates a verifier instance with post-state to check invariants synchronously
3. **Shadow comparison per-transition**: Each transition gets its own shadow instance (stateless) rather than maintaining a persistent shadow alongside the state machine
