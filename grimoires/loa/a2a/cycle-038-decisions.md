# Cycle 038 Decision Context — Hounfour v8.3.0 Upgrade

**Date:** 2026-02-28
**Author:** Jani + Claude
**PR:** [#115](https://github.com/0xHoneyJar/loa-finn/pull/115)
**Bridgebuilder Review:** [Comment #3976376955](https://github.com/0xHoneyJar/loa-finn/pull/115#issuecomment-3976376955)

---

## Decision 1: Consumer Contract Scope (24→36 symbols)

**Choice:** The consumer contract declares the *minimum required runtime surface* — symbols finn actively imports at runtime. Not every barrel re-export is contractual.

**Rationale:** Including all barrel exports would create perpetual CI noise as hounfour evolves. The contract exists to detect *drift that breaks finn*, not to mirror the barrel. A `NON_CONTRACT_EXPORTS` allowlist covers forward-looking re-exports (governance types, utility schemas) that finn re-exports for ecosystem consumers but doesn't depend on at runtime. The contract grows only when finn adds an actual runtime dependency.

**Evidence:** Bridgebuilder Finding #7 identified the original 24-symbol static list was already incomplete (missing `validateAuditTimestamp`, `AuditEntrySchema`, `verifyAuditTrailIntegrity`, etc.). T-4.1 fixed this by deriving the contract from actual `src/` imports.

---

## Decision 2: Canonical Dampening Defaults Off

**Choice:** `FINN_CANONICAL_DAMPENING` defaults to `false`. When disabled, the local EMA logic runs unchanged.

**Rationale:** Strangler fig pattern — prove behavioral equivalence in staging before promoting to production. The canonical `computeDampenedScore()` uses a Bayesian prior with cold-start protection that differs from finn's local EMA. Delta logging (T-4.2, structured JSON) captures the divergence magnitude on every invocation when enabled. Only after staging validates that deltas are within acceptable bounds (< 0.001 for steady-state NFTs) should the flag be flipped to production.

**Evidence:** The dampening comparison tests (T-3.3) hardcode expected values to 5 decimal places, confirming the canonical function produces deterministic outputs. The structured telemetry (T-4.2) enables CloudWatch dashboards to monitor delta distribution before promotion.

---

## Decision 3: GovernedBilling as Conformance Proof (Not Production)

**Choice:** `GovernedBilling` implements `GovernedResourceBase` as a type-level conformance proof in this cycle. Runtime adoption is deferred to Sprint 5's shadow-mode wiring.

**Rationale:** GovernedResourceBase enforces invariant verification (cost non-negative, valid state transitions, reserve conservation) at the type level. Proving conformance first — without touching the production billing path — validates that finn's billing state machine *can* be governed before it *is* governed. Shadow-mode (Sprint 5) runs the governed path in parallel with production, logging divergence without affecting behavior.

**Migration Roadmap:**
1. **Sprint 3-4** (this cycle): Type-level conformance proof + conservation law tests
2. **Sprint 5** (this cycle): Shadow-mode wiring behind `FINN_GOVERNED_BILLING` flag
3. **Future cycle**: Staging validation with real traffic, then promotion via flag flip

**Evidence:** Bridgebuilder Finding #6 identified GovernedBilling as "a proof, not a path." The Bridgebuilder Addendum reframed this as trust infrastructure for community-governed economic coordination (Ostrom's 8 principles mapped to hounfour primitives).
