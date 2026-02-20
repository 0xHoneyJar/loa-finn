# Bridge Iteration 2: Bridgebuilder Finding Fixes

**Iteration**: 2 of `/run-bridge` excellence loop
**PR**: #82 (feature/protocol-convergence-v7)
**Cycle**: cycle-027 "Full Stack Launch"
**Date**: 2026-02-19

## Summary

Addressed all 13 findings from Bridgebuilder Deep Review (iteration 1):
- 1 CRITICAL, 4 HIGH, 5 MEDIUM, 3 LOW findings
- All fixes implemented with targeted tests
- 74/74 affected tests passing (13 + 22 + 22 + 17)

## Findings Addressed

### CRITICAL (1)

| # | Finding | File(s) | Fix |
|---|---------|---------|-----|
| 1 | redis.eval() array-arg signature mismatch | `wal-writer-lock.ts`, `credit-note.ts` | Changed 5 eval calls from `eval(script, [keys], [args])` to `eval(script, numkeys, ...keys, ...args)` matching `RedisCommandClient` interface |

### HIGH (4)

| # | Finding | File(s) | Fix |
|---|---------|---------|-----|
| 2 | SimpleSpanProcessor in production OTLP path | `otlp.ts` | Changed to `BatchSpanProcessor` for remote exporter; kept `SimpleSpanProcessor` for console-only path |
| 3 | CSP blocks Tailwind CDN sub-resources | `waitlist.ts` | Added `cdn.tailwindcss.com` to `script-src`, `style-src`, `connect-src`; added `font-src` for Google Fonts |
| 4 | NFT detection doesn't paginate Alchemy API | `detection.ts` | Added `contractAddresses[]` server-side filter + `pageKey` pagination loop |
| 5 | WAL fencing CAS returns "OK" on Redis error (fail-open) | `wal-writer-lock.ts` | Changed catch block to return `"STALE"` (fail-closed); upgraded to `console.error` with `severity: "critical"` |

### MEDIUM (5)

| # | Finding | File(s) | Fix |
|---|---------|---------|-----|
| 6 | CreditNote stored before cap check (orphan risk) | `credit-note.ts` | Reordered: cap check via eval BEFORE note creation and `redis.set()` |
| 7 | gate-check.sh uses eval (injection risk) | `gate-check.sh` | Full rewrite: removed `run_cmd()`, replaced with direct command execution |
| 8 | Unused `reportOnly` CSP parameter | `waitlist.ts` | Removed parameter from `buildCSPHeader()` and call site |
| 9 | RESP parser can't handle array responses | `redis-integration.ts` | Rewrote with recursive `parseOne()` supporting arrays, bulk strings, errors |
| 10 | NFT cache set+expire not atomic | `detection.ts` | Changed to `redis.set(key, value, "EX", ttl)` single command |

### LOW (3)

| # | Finding | File(s) | Fix |
|---|---------|---------|-----|
| 11 | CreditNote ID collision under concurrent load | `credit-note.ts` | Added `randomBytes(4).toString("hex")` suffix to ID generator |
| 12 | getTracer returns untyped `any` | `otlp.ts` | Added `MinimalTracer` interface; typed return as `MinimalTracer \| null` |
| 13 | Settlement swallows facilitator error details | `settlement.ts` | Captured facilitator error, included in structured log and final error message |

## Files Changed (15)

### Source (7)
- `src/billing/wal-writer-lock.ts` — Findings 1, 5
- `src/x402/credit-note.ts` — Findings 1, 6, 11
- `src/tracing/otlp.ts` — Findings 2, 12
- `src/gateway/waitlist.ts` — Findings 3, 8
- `src/nft/detection.ts` — Findings 4, 10
- `scripts/gate-check.sh` — Finding 7
- `src/x402/settlement.ts` — Finding 13

### Tests (4)
- `tests/finn/bridge-iter2-fixes.test.ts` — NEW: 13 targeted tests for all findings
- `tests/finn/sprint-13-scalability.test.ts` — +2 tests (pagination, atomic cache)
- `tests/finn/sprint-11-hardening.test.ts` — Updated WAL mock to flat-arg signature
- `tests/finn/x402-denomination.test.ts` — Updated CreditNote mock for reordered cap check

### State (4)
- `grimoires/loa/sprint.md` — Bridge iteration 2 sprint plan
- `grimoires/loa/ledger.json` — Updated sprint state
- `.run/bridge-state.json` — Bridge iteration state
- `.run/sprint-plan-state.json` — Sprint plan state

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| bridge-iter2-fixes.test.ts | 13/13 | PASS |
| sprint-13-scalability.test.ts | 22/22 | PASS |
| sprint-11-hardening.test.ts | 17/17 | PASS |
| x402-denomination.test.ts | 22/22 | PASS |
| **Total affected** | **74/74** | **PASS** |

40 pre-existing failures in unrelated suites (jwt, pool-registry, req-hash, dashboard) — not caused by this iteration.

## Risk Assessment

- **CRITICAL fix (redis.eval)**: High confidence — matches the `RedisCommandClient` interface exactly. All 5 call sites verified against `dlq.ts` reference pattern.
- **Fail-closed CAS**: Intentionally conservative — returns STALE on Redis errors rather than allowing potentially stale writes.
- **Credit note reorder**: Cap check before storage prevents orphaned notes on CAP_EXCEEDED.
- **gate-check.sh rewrite**: No `eval` command anywhere in the script; all commands use direct argument passing.
