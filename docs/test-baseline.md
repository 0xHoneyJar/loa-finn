# loa-finn Test Baseline

> Sprint 10 Task 10.5 — Test suite documentation for post-beta maintenance.

---

## Test Suite Summary

| Category | Location | Test Count | Description |
|----------|----------|------------|-------------|
| Billing Core | `tests/finn/billing-*.test.ts` | ~108 | Conservation guard, state machine, WAL |
| Credits | `tests/finn/credit-*.test.ts` | ~30 | Purchase, deduction, BYOK entitlement |
| NFT Personality | `tests/finn/nft-*.test.ts` | ~46 | BEAUVOIR authoring, routing |
| Conversation | `tests/finn/conversation-*.test.ts` | ~18 | WebSocket, persistence, R2 snapshots |
| Allowlist + Onboarding | `tests/finn/allowlist.test.ts` | 42 | Address normalization, flags, onboarding wizard |
| Production Deploy | `tests/finn/production-deploy.test.ts` | 18 | Metrics, JWKS, WAL writer lock |
| x402 Payment | `tests/finn/x402.test.ts` | 26 | Quote, verify, settlement, circuit breaker |
| x402 Denomination | `tests/finn/x402-denomination.test.ts` | 22 | Conversion, drift, rate freeze, credit notes |
| E2E Full Stack | `tests/e2e/full-stack.test.ts` | 4 | Cross-system integration flows |
| E2E Staged Rollout | `tests/e2e/staged-rollout.test.ts` | 10 | Gate 0-4 flag validation |
| Load Testing | `tests/load/beta-load.test.ts` | 13 | Concurrency, latency, throughput |
| **Sprint Total** | | **~338** | New tests from sprints 1-10 |

## Pre-Existing Test Suite

The project had an existing test baseline before sprint work began:

- **Hounfour framework tests**: Protocol, Redis, routing, middleware
- **Gateway tests**: Authentication, rate limiting, CORS
- **Known failures**: Some pre-existing tests may fail due to upstream dependencies (e.g., `req-hash.test.ts`, `dashboard-integration.test.ts`). These are NOT regressions from sprint work.

## Module Test Coverage

### Billing Track (Sprints 1-3)

| Module | Tests | Key Invariants |
|--------|-------|----------------|
| BillingConservationGuard | ~40 | Budget conservation, cost non-negative, reserve within allocation |
| BillingStateMachine | ~30 | RESERVE→COMMIT/RELEASE/VOID transitions, no double-commit |
| WAL Replay | ~20 | Idempotent replay, state rebuild from WAL |
| Credit Purchase | ~15 | USDC verification, balance update, WAL audit |
| Credit Deduction | ~10 | Atomic deduction, insufficient balance guard |
| BYOK Entitlement | ~5 | Metered but not charged, rate limiting |

### NFT + Onboarding Track (Sprints 4-6)

| Module | Tests | Key Invariants |
|--------|-------|----------------|
| NFT Personality (BEAUVOIR) | ~30 | CRUD, validation, routing |
| Agent Homepage | ~16 | Static HTML, WebSocket, conversation persistence |
| Allowlist | 12 | Address normalization, CRUD, bypass addresses |
| Feature Flags | 8 | Get/set, defaults, getAllFlags |
| Onboarding Wizard | 15 | 6-step flow, step validation, completion |
| Waitlist | 7 | Static page, CSP headers, XSS prevention |

### x402 Payment Track (Sprints 8-9)

| Module | Tests | Key Invariants |
|--------|-------|----------------|
| Quote Service | 6 | Deterministic pricing, caching, markup |
| Payment Verifier | 8 | Signature, nonce replay, EIP-1271 fallback |
| Settlement | 5 | Facilitator primary, direct fallback, circuit breaker |
| x402 Routes | 4 | 402 response, allowlist gating, feature flag |
| Denomination | 8 | MicroUSD↔MicroUSDC, round-trip drift < 1 unit |
| Credit Notes | 7 | Overpayment refund, accumulation, WAL audit |

### Infrastructure (Sprint 7)

| Module | Tests | Key Invariants |
|--------|-------|----------------|
| Prometheus Metrics | 5 | Counter increment, gauge set, exposition format |
| JWKS Service | 5 | Caching, invalidation, error handling |
| WAL Writer Lock | 8 | SETNX acquire, fencing tokens, lock lost detection |

### Integration (Sprint 10)

| Module | Tests | Key Invariants |
|--------|-------|----------------|
| E2E Full Stack | 4 | Cross-system flows: onboarding, x402, BYOK, DLQ |
| Staged Rollout | 10 | Gate 0-4 progressive enablement, rollback |
| Load Testing | 14 | 50 concurrent users, p95 < 200ms, zero 5xx |

## Running Tests

```bash
# Run all sprint tests
npx vitest run tests/finn/ tests/e2e/ tests/load/

# Run specific module
npx vitest run tests/finn/x402.test.ts

# Run with coverage
npx vitest run --coverage tests/finn/

# Run load tests only
npx vitest run tests/load/beta-load.test.ts
```

## Gate Test Mapping

Each deployment gate has associated test suites that MUST pass:

| Gate | Required Tests | Command |
|------|---------------|---------|
| Gate 0 (Smoke) | billing-*.test.ts | `npx vitest run tests/finn/billing-*` |
| Gate 1 (Ignition) | + credit-*.test.ts | `npx vitest run tests/finn/billing-* tests/finn/credit-*` |
| Gate 2 (Warmup) | + nft-*, allowlist, onboarding | `npx vitest run tests/finn/` |
| Gate 4 (Launch) | + x402*, e2e, load | `npx vitest run tests/finn/ tests/e2e/ tests/load/` |

## Known Pre-Existing Failures

These tests existed before sprint work and may fail independently:

| Test File | Issue | Sprint Impact |
|-----------|-------|---------------|
| `req-hash.test.ts` | Missing dependency | None |
| `dashboard-integration.test.ts` | `process.exit(1)` in test | None |
| Pool validation tests | Upstream changes | None |

**Verification**: Run sprint-specific tests to confirm zero regression:
```bash
npx vitest run tests/finn/billing-conservation-guard.test.ts tests/finn/allowlist.test.ts tests/finn/production-deploy.test.ts tests/finn/x402.test.ts tests/finn/x402-denomination.test.ts tests/e2e/ tests/load/
```

## Continuous Integration

The deploy workflow (`.github/workflows/deploy.yml`) runs:
1. `npm ci` — Install dependencies
2. `npx tsc --noEmit` — Type checking
3. `npx vitest run` — Full test suite
4. Deploy only if all checks pass

## Post-Beta Maintenance

When adding new features after beta:
1. Add tests BEFORE implementation (test-first)
2. Run full suite to verify zero regression
3. Update this baseline document with new test counts
4. Verify gate-specific test suites still pass
