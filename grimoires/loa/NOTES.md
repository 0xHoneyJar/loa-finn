# NOTES.md

## Learnings

## Blockers

- **RESOLVED: Full JWT Claim Compatibility** (Sprint 59 T4, 2026-02-16)
  - Verified against arrakis PR #63 (0xHoneyJar/arrakis/pull/63, Cycles 025-028):
    - `sub`: "loa-finn" (s2sSubjectMode="service"). Arrakis validates via `createInternalJwt` helper.
    - `iss`: "loa-finn" — matches arrakis test expectations (billing-s2s.test.ts:28).
    - `aud`: "arrakis" — matches arrakis test expectations (billing-s2s.test.ts:29).
    - `kid`: Included in ES256 header ("loa-finn-v1"). Arrakis uses JWKS endpoint to resolve key.
    - `iat`/`exp`: Both services use 30s clock skew, 300s default TTL.
    - `jti`: NOT required by arrakis (not in s2sFinalizeRequestSchema or test helper).
  - Wire format verified: `reservationId`, `actualCostMicro` (string), `accountId` (optional).
  - Compatibility test vector: `tests/finn/jwt-claim-compatibility.test.ts` (7 tests).
  - See arrakis contracts: `themes/sietch/src/packages/core/contracts/s2s-billing.ts`.

- **BLOCKER: Pricing config schema migration (future cycle).**
  - Pricing enters as JS `number` from JSON config (IEEE-754 by spec). `usdToMicroBigInt()` converts via `toFixed(6)` — deterministic per ECMAScript but depends on the float already being "close enough" to intended decimal.
  - Future hardening: migrate pricing config to `input_micro_per_1m: string` (string-serialized integer micro-USD) to eliminate all IEEE-754 dependence from the pricing boundary.
  - Requires changing the pricing config schema across the entire model routing system — exceeds current sprint scope.
  - See GPT-5.2 review iterations 1-3 (sprint-findings-{1,2,3}.json).
