# Sprint 43 (Sprint 1): Protocol Package & Foundation — Implementation Report

## Summary

Sprint 1 of Hounfour Phase 5 implements the `loa-hounfour` protocol package and adapts the cheval sidecar modules for production use. All 15 tasks completed with 254 tests passing (157 Python + 97 TypeScript).

## Tasks Completed

### loa-hounfour Package (Tasks 1.1–1.7)

*Completed in prior session.*

| Task | Description | Tests |
|------|-------------|-------|
| 1.1 | Package scaffold & build | — |
| 1.2 | JWT claims schema | — |
| 1.3 | S2S JWT claims schema | — |
| 1.4 | Invoke response schema | — |
| 1.5 | Usage report schema | — |
| 1.6 | Canonical request hash (req-hash.ts) | 14 |
| 1.7 | Idempotency key derivation | 6 |

### Budget Golden Vectors (Task 1.8)

| File | Vectors | Description |
|------|---------|-------------|
| `basic-pricing.json` | 18 | Single cost, total cost, remainder accumulator |
| `streaming-cancel.json` | 10 | Partial response billing scenarios |
| `extreme-tokens.json` | 22 | Boundary values, overflow, BigInt, serialization |
| `price-change-boundary.json` | 8 | Price table versioning, idempotency |
| `provider-correction.json` | 8 | Reconciliation adjustments |

**Total**: 66 vectors across 5 files, 70 tests (66 vectors + 4 cross-file invariants).

### Cheval Adapter Imports (Tasks 1.9–1.12)

| Task | Source | Adapted File | Tests |
|------|--------|-------------|-------|
| 1.9 | `loa_cheval/metering/` | `pricing.py`, `cost_ledger.py`, `usage_calculator.py` | 26 |
| 1.10 | `loa_cheval/routing/circuit_breaker.py` | `circuit_breaker.py` | 23 |
| 1.11 | `loa_cheval/providers/` | `provider_registry.py` | 26 |
| 1.12 | `loa_cheval/config/` | `config_loader.py` | 30 |

**Key adaptations**:
- Fixed imports from `loa_cheval.*` to flat module references
- Added `DEFAULT_PRICING` table and `find_default_pricing()` for fallback
- Usage calculator is observation-only (no budget enforcement)
- Config loader supports `{env:VAR}` and `{file:path}` with allowlist and file safety checks
- Provider registry validates types (openai, anthropic, openai_compat) with per-type defaults

### Integration & Verification (Tasks 1.13–1.15)

| Task | Description | Tests |
|------|-------------|-------|
| 1.13 | Authority boundary verification | 39 |
| 1.14 | Stream abort fix | — (integration) |
| 1.15 | Idempotency cache LRU | 7 |

**Authority boundary** (Task 1.13): 39 tests verify cheval NEVER enforces budget — module scanning, AST analysis, observation-only wire contract, fire-and-forget semantics.

**Stream abort** (Task 1.14): Fixed `CancelledError` handler to explicitly close upstream via `response.aclose()`, added `StreamClosed` handling for race conditions, and abort logging with trace_id.

### cheval_server.py Modifications

1. **Import**: `usage_calculator` (enrich + record), `circuit_breaker` (check/record)
2. **/invoke endpoint**: Circuit breaker check before retry → reject with 503 if OPEN, increment probe if HALF_OPEN, record success/failure after call
3. **/invoke/stream endpoint**: Explicit upstream close on client disconnect, `StreamClosed` race handling, abort logging

## Files Created

### TypeScript (loa-hounfour package)
- `packages/loa-hounfour/vectors/budget/basic-pricing.json`
- `packages/loa-hounfour/vectors/budget/streaming-cancel.json`
- `packages/loa-hounfour/vectors/budget/extreme-tokens.json`
- `packages/loa-hounfour/vectors/budget/price-change-boundary.json`
- `packages/loa-hounfour/vectors/budget/provider-correction.json`
- `packages/loa-hounfour/tests/vectors/budget.test.ts`

### Python (cheval adapters)
- `adapters/pricing.py`
- `adapters/cost_ledger.py`
- `adapters/usage_calculator.py`
- `adapters/usage_calculator_test.py`
- `adapters/circuit_breaker.py`
- `adapters/circuit_breaker_test.py`
- `adapters/provider_registry.py`
- `adapters/provider_registry_test.py`
- `adapters/config_loader.py`
- `adapters/config_loader_test.py`
- `adapters/authority_boundary_test.py`

### Files Modified
- `adapters/cheval_server.py` (circuit breaker + usage calculator integration, stream abort fix)

## Test Results

```
Python (adapters/):  157 passed, 1 pre-existing error
TypeScript (packages/loa-hounfour/ + LRU):  97 passed
Total: 254 tests passing
```

## Design Decisions

1. **Usage calculator is NOT a budget enforcer**: Cheval computes costs and records usage but never rejects requests. Budget enforcement is loa-finn's responsibility.
2. **Circuit breaker uses best-effort counting**: Concurrent read-modify-write races are intentional and self-correcting (unlike cost ledger which uses flock).
3. **Config interpolation allowlist**: Only `LOA_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, and `CHEVAL_*` env vars are allowed.
4. **BigInt vectors use string representation**: Cross-language safety for values > MAX_SAFE_INTEGER.
5. **Stream abort**: Explicit `response.aclose()` on `CancelledError` instead of relying on context manager cleanup.
