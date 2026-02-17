# Sprint Plan — Bridge Iteration 1 Fix Sprint

## Sprint 6: Bridgebuilder Hardening

**Goal**: Address 3 MEDIUM and 2 LOW findings from Bridgebuilder review iteration 1.

### Task 6.1: Atomic cost reconciliation via Lua script
**File**: `src/gateway/oracle-rate-limit.ts`
**Finding**: BB-025-001
**Description**: Replace the non-atomic GET → compute → INCRBY pattern in `release()` with an atomic Lua script that reads, clamps, and decrements in a single operation.
**Acceptance Criteria**:
- [ ] New Lua script `RECONCILE_COST_LUA` handles negative deltas atomically
- [ ] Clamp prevents counter going below 0
- [ ] Existing tests still pass
- [ ] New test: concurrent releases converge to correct value

### Task 6.2: Replace IPv6 regex with net.isIP()
**File**: `src/gateway/oracle-auth.ts`
**Finding**: BB-025-002
**Description**: Replace the permissive regex in `isValidIp()` with Node.js stdlib `net.isIP()` for robust IP validation.
**Acceptance Criteria**:
- [ ] `isValidIp()` uses `import { isIP } from 'node:net'`
- [ ] Returns true for valid IPv4 and IPv6, false for malformed
- [ ] Existing auth tests pass
- [ ] New test: malformed IPs (`:::::`, `aaa:bbb`, empty string) return false

### Task 6.3: Document concurrency limiter limitation + update NOTES.md
**File**: `src/gateway/oracle-concurrency.ts`, `grimoires/loa/NOTES.md`
**Finding**: BB-025-003
**Description**: Add JSDoc documenting the global-not-per-identity limitation. Add NOTES.md entry for Phase 2 per-identity concurrency.
**Acceptance Criteria**:
- [ ] JSDoc on ConcurrencyLimiter class documents the design choice
- [ ] NOTES.md records Phase 2 improvement item

### Task 6.4: Fix require() to ESM import in E2E harness
**File**: `tests/finn/e2e-harness.ts`
**Finding**: BB-025-004
**Description**: Replace `require("node:crypto")` with top-level ESM `import { createHash } from "node:crypto"`.
**Acceptance Criteria**:
- [ ] No more `require()` calls in the file
- [ ] All E2E tests pass

### Task 6.5: Fix S3 sync order in deploy workflow
**File**: `deploy/workflows/deploy-dixie.yml`
**Finding**: BB-025-005
**Description**: Reverse S3 sync order: sync HTML/JSON first (short cache), then sync everything else (immutable cache).
**Acceptance Criteria**:
- [ ] HTML/JSON synced first with 5min cache
- [ ] Other assets synced second with immutable cache
- [ ] CloudFront invalidation unchanged
