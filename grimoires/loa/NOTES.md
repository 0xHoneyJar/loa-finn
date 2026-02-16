# NOTES.md

## Learnings

## Blockers

- **BLOCKER: Verify arrakis `verifyS2SJWT()` sub claim validation before switching `s2sSubjectMode` default to `"service"`.**
  - `billing-finalize-client.ts` currently defaults to `s2sSubjectMode: "tenant"` (legacy) to avoid breaking arrakis if it enforces `sub == tenant_id`.
  - Before flipping to `"service"` mode: check arrakis PR #63 `verifyS2SJWT()` — does it validate the `sub` claim? What value does it expect?
  - If arrakis accepts any `sub`: switch default to `"service"` and remove config flag.
  - If arrakis enforces `sub == tenant_id`: coordinate arrakis-side change first, then flip.
  - See Bridgebuilder Finding #10 (PR #68), Sprint 2 T4.

- **BLOCKER: Pricing config schema migration (future cycle).**
  - Pricing enters as JS `number` from JSON config (IEEE-754 by spec). `usdToMicroBigInt()` converts via `toFixed(6)` — deterministic per ECMAScript but depends on the float already being "close enough" to intended decimal.
  - Future hardening: migrate pricing config to `input_micro_per_1m: string` (string-serialized integer micro-USD) to eliminate all IEEE-754 dependence from the pricing boundary.
  - Requires changing the pricing config schema across the entire model routing system — exceeds current sprint scope.
  - See GPT-5.2 review iterations 1-3 (sprint-findings-{1,2,3}.json).
