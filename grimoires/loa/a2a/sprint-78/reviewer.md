# Sprint 78 (local: sprint-11) — Security & Infrastructure Hardening

## Implementation Report

**Sprint**: 11 (global: 78) | **Cycle**: 027 | **Branch**: `feature/protocol-convergence-v7`
**Status**: COMPLETE — all 5 tasks implemented with 17 tests passing

---

## Task Summary

| Task | Title | Status | Files Changed |
|------|-------|--------|---------------|
| 11.1 | KMS IAM Scoping | DONE | `infrastructure/terraform/loa-finn-ecs.tf` |
| 11.2 | SNS Topic + Alarm Wiring | DONE | `infrastructure/terraform/loa-finn-monitoring.tf`, `loa-finn-ecs.tf` |
| 11.3 | WAL Fencing Token Monotonicity | DONE | `src/billing/wal-writer-lock.ts` |
| 11.4 | CreditNote BigInt Consistency | DONE | `src/x402/credit-note.ts` |
| 11.5 | Onboarding Personality Null-Check | DONE | `src/nft/onboarding.ts` |

---

## Task Details

### Task 11.1: KMS IAM Scoping (Gate 0 Blocker)

**Finding**: `medium-7` — KMS IAM policy used `Resource: "*"` (wildcard).

**Changes**:
- Added `kms_key_arn` variable with `arn:aws:kms:` pattern validation
- Replaced `Resource = "*"` with `Resource = var.kms_key_arn` in KMSDecrypt statement
- Terraform `variable.validation` block rejects malformed ARNs at plan time

**File**: `infrastructure/terraform/loa-finn-ecs.tf`

### Task 11.2: SNS Topic + Alarm Wiring

**Finding**: `medium-6` — CloudWatch alarms had no SNS action target.

**Changes**:
- Created `aws_sns_topic.loa_finn_alarms` resource (environment-scoped)
- Created `aws_sns_topic_subscription.alarm_email` (conditional on `var.alarm_email`)
- Wired all 5 CloudWatch alarms (`cpu_high`, `memory_high`, `error_5xx_rate`, `billing_pending_high`, `ecs_desired_count_drift`) directly to SNS topic
- Replaced conditional alarm_actions with direct reference

**Files**: `infrastructure/terraform/loa-finn-monitoring.tf`, `infrastructure/terraform/loa-finn-ecs.tf`

### Task 11.3: WAL Fencing Token Monotonicity

**Finding**: `critical-1` — Fencing token validation was in-memory only; post-failover stale writers undetected.

**Changes**:
- Added `WAL_FENCING_CAS_SCRIPT` Lua constant — atomic compare-and-swap with 3 return states:
  - `OK`: token fresh, advanced
  - `STALE`: token <= last accepted, rejected
  - `CORRUPT`: stored state invalid (non-numeric, negative, >2^53-1), fail-closed
- Added `environment` field for per-environment key namespacing (`wal:writer:last_accepted:{env}`)
- Added `Number.isSafeInteger` guard in `acquire()` for token overflow at issuance
- Added `validateAndAdvanceFencingToken()` method with input validation + CAS + structured logging
- Kept `validateFencingToken()` (marked @deprecated) for backward compatibility
- Redis connectivity failures fail-open (WAL is authoritative)

**File**: `src/billing/wal-writer-lock.ts`

**Tests** (9):
- Fresh token accepted (CAS returns OK)
- Stale token rejected (CAS returns STALE)
- Equal token rejected (must be strictly greater)
- Corrupt stored token returns CORRUPT (non-numeric)
- Corrupt stored token returns CORRUPT (exceeds 2^53-1)
- Token exceeding MAX_SAFE_INTEGER rejected at issuance
- Non-holder returns STALE without calling Redis
- Negative token rejected as CORRUPT at input validation
- Per-environment key namespace isolation

### Task 11.4: CreditNote BigInt Consistency Fix

**Finding**: `high-2` — `redis.incrby()` used Number(delta) which silently truncates BigInt values, and no cap on accumulated balance.

**Changes**:
- Added `MAX_CREDIT_BALANCE = 1_000_000_000_000` constant (1M USDC in base units)
- Added `CREDIT_BALANCE_INCR_SCRIPT` Lua script: atomic cap validation + INCRBY + EXPIRE
- Replaced `redis.incrby(balanceKey, Number(delta))` with:
  - `Number.isSafeInteger()` guard on delta (throws if unsafe)
  - Lua script call with cap enforcement
  - Error handling for `CAP_EXCEEDED` response
- BigInt arithmetic for quoted/actual comparison, Number conversion only for Redis delta

**File**: `src/x402/credit-note.ts`

**Tests** (5):
- Issues credit note with normal delta
- Multiple sequential issuances accumulate correctly
- Rejects delta exceeding Number.MAX_SAFE_INTEGER
- Rejects balance exceeding MAX_CREDIT_BALANCE (CAP_EXCEEDED)
- No credit note issued when actual >= quoted

### Task 11.5: Onboarding Personality Null-Check Fix

**Finding**: `low-13` — try/catch used for control flow in personality config.

**Changes**:
- Replaced try/catch pattern with explicit null-check:
  - `const existing = await this.personality.get(collection, tokenId)`
  - `if (existing)` → update, `else` → create
- Semantically clearer, no exception-driven control flow

**File**: `src/nft/onboarding.ts`

**Tests** (3):
- Creates personality via null-check when none exists
- Updates personality via null-check when one exists
- No exception thrown during normal null-check flow

---

## Test Results

```
Test File: tests/finn/sprint-11-hardening.test.ts
Tests: 17 passed (17)
Duration: 31ms
```

All 17 targeted tests pass. Full regression suite shows 45 pre-existing failures unrelated to sprint-11 changes (dashboard-integration.test.ts process.exit error pattern).

---

## Acceptance Criteria Verification

| Criterion | Met | Evidence |
|-----------|-----|----------|
| KMS Resource scoped to specific key ARN | YES | `var.kms_key_arn` with validation block |
| All 5 CloudWatch alarms wired to SNS | YES | Direct `alarm_actions` reference |
| Fencing token CAS with STALE/CORRUPT/OK | YES | Lua script + 9 tests |
| CreditNote BigInt-safe with cap enforcement | YES | Lua script + 5 tests |
| Personality config uses null-check not try/catch | YES | Explicit `if (existing)` pattern + 3 tests |
| Per-environment namespace isolation | YES | `wal:writer:last_accepted:{env}` key + test |
| Token overflow at issuance rejected | YES | `Number.isSafeInteger` guard + test |
