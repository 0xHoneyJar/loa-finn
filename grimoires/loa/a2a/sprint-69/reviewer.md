# Sprint 69 (sprint-2): Credit Denomination + Purchase Flow — Implementation Report

## Summary

Implemented CreditUnit and MicroUSDC branded types with 3-layer enforcement, model pricing table with rate freeze, SIWE wallet authentication with EIP-1271 smart wallet support, credit purchase with on-chain USDC verification, reorg detection background job, and daily reconciliation service.

## Tasks Completed

### Task 2.1: CreditUnit + MicroUSDC Branded Types
- **Files**: `src/hounfour/wire-boundary.ts`
- **AC Coverage**: CreditUnit branded type (100 CU = $1), MicroUSDC branded type (6-decimal USDC), parseCreditUnit/serializeCreditUnit, parseMicroUSDC/serializeMicroUSDC, MAX_CREDIT_UNIT_LENGTH symmetric with MAX_MICRO_USD_LENGTH, convertMicroUSDtoCreditUnit (ceil/floor rounding), convertCreditUnitToMicroUSD, convertMicroUSDtoMicroUSDC, addCreditUnit/subtractCreditUnit arithmetic helpers.

### Task 2.2: Pricing Table + Cost Estimation
- **Files**: `src/billing/pricing.ts`
- **AC Coverage**: Model pricing table (claude-sonnet-4, claude-haiku-4, gpt-4.1, gpt-4.1-mini). estimateReserveCost (ceil), computeActualCost (floor), estimateReserveCostCU, computeActualCostCU, computeX402Quote with markup factor. freezeRates() captures CREDIT_UNITS_PER_USD + USD_USDC_RATE at RESERVE time. FINN_MODEL_PRICING_JSON env var override.

### Task 2.3: Minimal SIWE Verify + EIP-1271 Signature Validation
- **Files**: `src/gateway/wallet-auth.ts`
- **AC Coverage**: GET /api/v1/auth/nonce (random 32-byte nonce, Redis 5min TTL). POST /api/v1/auth/verify (SIWE message validation, domain/chainId/nonce/expiration checks, EOA ecrecover, EIP-1271 smart wallet fallback). JWT with refresh token (Flatline IMP-003): access JWT (ES256, 15min), refresh token (opaque, 24h Redis). POST /api/v1/auth/refresh, POST /api/v1/auth/logout (session revocation). Rate limit 10 req/min per IP on nonce (Flatline IMP-007).

### Task 2.4: Credit Purchase — On-Chain USDC Verification
- **Files**: `src/credits/purchase.ts`, `src/credits/types.ts`
- **AC Coverage**: POST /api/v1/credits/purchase with CreditPurchaseRequest schema. Pack sizes: 500, 1000, 2500 CU ($5, $10, $25). On-chain verification via viem: getTransactionReceipt, parse Transfer event logs, verify contract/recipient/amount. 12+ L2 confirmations required. Idempotency via (tx_hash, log_index). Sender must match authenticated wallet. Double-entry ledger: treasury:usdc_received -N, user:available +N. Fail-closed error responses (400/402/409/503). Rate limit 5 req/min per wallet (Flatline IMP-007). Multi-RPC consistency check (Flatline SKP-004).

### Task 2.5: On-Chain Reorg Detection
- **Files**: `src/credits/reorg-detector.ts`
- **AC Coverage**: Background cron (croner) every 5 minutes. Checks mints < 1 hour old. Fetches eth_getBlockByNumber, compares block_hash. On mismatch: re-fetch receipt, re-verify. If tx invalid: freeze credits, alert admin, create credit_mint_reverted WAL entry. Multi-RPC consistency.

### Task 2.6: Daily Reconciliation Job
- **Files**: `src/billing/reconciliation.ts`
- **AC Coverage**: Daily cron (02:00 UTC). Derives all account balances from WAL. Compares against Redis cached balances. On divergence: overwrite Redis, alert. Rounding drift report with 1000 MicroUSD threshold. Reconciliation logged to WAL.

### Task 2.7: Credit Purchase Test Suite
- **Files**: `tests/finn/credit-purchase.test.ts`
- **52 tests**: CreditUnit (11), MicroUSDC (4), denomination conversion (7), pricing (11), credit purchase service (7), reorg detector (6), reconciliation (4), conservation guard post-mint (1).

## Test Results

- **New tests**: 52 tests, all passing
- **Existing tests**: 84 wire-boundary, 45 billing-state-machine, 108 conservation-guard — all passing
- **Regressions**: Zero

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/hounfour/wire-boundary.ts` | Modified | +160 |
| `src/billing/pricing.ts` | Created | ~170 |
| `src/billing/reconciliation.ts` | Created | ~150 |
| `src/billing/index.ts` | Modified | +24 |
| `src/gateway/wallet-auth.ts` | Created | ~310 |
| `src/credits/types.ts` | Created | ~110 |
| `src/credits/purchase.ts` | Created | ~270 |
| `src/credits/reorg-detector.ts` | Created | ~170 |
| `src/credits/index.ts` | Created | ~35 |
| `tests/finn/credit-purchase.test.ts` | Created | ~590 |

## Dependencies Added

- `viem` — Ethereum library for on-chain verification (getTransactionReceipt, EIP-1271)
- `siwe` — Sign-In with Ethereum message parsing and verification
