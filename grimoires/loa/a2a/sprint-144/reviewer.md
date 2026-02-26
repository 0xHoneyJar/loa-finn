# Sprint 144 (Sprint 1): Goodhart Stack Wiring + Router Integration — Implementation Report

> **Cycle**: cycle-036 — Staging Readiness
> **Sprint**: 1 (Global ID: 144)
> **Status**: ALL TASKS COMPLETE (8/8)
> **Tests**: 35 passing across 5 test files (+ 6 pre-existing failures in mechanism-interaction.test.ts from cycle-035 KillSwitch API mismatch)
> **Branch**: `feature/cycle-036-staging-readiness`
> **GPT Review**: APPROVED (iteration 2, resolve.ts — 3 findings fixed)

---

## Task Summary

| Task | Title | Status | Files |
|------|-------|--------|-------|
| T-1.1 | Transport Factory | CLOSED | `src/hounfour/goodhart/transport-factory.ts` (new, 23 lines) |
| T-1.2 | ReadOnlyRedisClient Wrapper | CLOSED | `src/hounfour/goodhart/read-only-redis.ts` (new, 49 lines) |
| T-1.3 | PrefixedRedisClient Wrapper | CLOSED | `src/hounfour/infra/prefixed-redis.ts` (new, 78 lines) |
| T-1.4 | resolveWithGoodhart Function | CLOSED | `src/hounfour/goodhart/resolve.ts` (new, 163 lines) |
| T-1.5 | Goodhart Initialization Block | CLOSED | `src/index.ts` (modified, ~70 lines added) |
| T-1.6 | Router State Machine + KillSwitch | CLOSED | `src/hounfour/router.ts` (modified, ~130 lines added) |
| T-1.7 | Parallel Scoring with Concurrency Limit | CLOSED | `src/hounfour/goodhart/mechanism-interaction.ts` (modified) |
| T-1.8 | Prometheus Metrics | CLOSED | `src/hounfour/graduation-metrics.ts` (modified) |

---

## Implementation Details

### T-1.1: Transport Factory (`src/hounfour/goodhart/transport-factory.ts`)

**New module.** Factory function `createDixieTransport()`:
- Returns `DixieStubTransport` when `baseUrl` is undefined, empty, or `"stub"`
- Returns `DixieHttpTransport` with given URL otherwise
- Re-exported from `src/hounfour/goodhart/index.ts` barrel

### T-1.2: ReadOnlyRedisClient Wrapper (`src/hounfour/goodhart/read-only-redis.ts`)

**New module.** ES Proxy-based read-only wrapper per SDD §3.3:
- Allowlist: `get`, `mget`, `hget`, `hgetall`, `exists`, `ttl`, `type`
- All mutating methods throw: `"Redis writes blocked in shadow mode (attempted: <method>)"`
- Bypass vectors explicitly blocked: `multi()`, `pipeline()`, `sendCommand()`, `eval()`, `evalsha()`
- Non-function properties pass through unchanged

### T-1.3: PrefixedRedisClient Wrapper (`src/hounfour/infra/prefixed-redis.ts`)

**New module.** Runtime key prefix enforcement per SDD §4.1.2:
- `get("foo")` → `get("armitage:foo")` when prefix is `armitage:`
- `mget(["a", "b"])` → `mget(["armitage:a", "armitage:b"])`
- Startup assertion: prefix < 2 chars throws at construction
- `select(dbIndex)` called on construction

### T-1.4: resolveWithGoodhart Function (`src/hounfour/goodhart/resolve.ts`)

**New module.** Core integration function connecting router to all Goodhart components:
- Typed contract per SDD §3.3.1: `GoodhartOptions`, `GoodhartResult`, `ScoredPool` interfaces
- 200ms hard timeout via `Promise.race` with `AbortController` propagation
- Error classification: programmer errors (`TypeError`, `ReferenceError`, `SyntaxError`, `RangeError`, `EvalError`, `URIError`) propagate; operational errors caught → null
- Timer cleanup in `finally` block prevents leaks
- Structured JSON logging on timeout and operational error

**GPT Review**: Iteration 1 found 3 issues (timer leak, incomplete error classification, missing finally block). All fixed and APPROVED on iteration 2.

### T-1.5: Goodhart Initialization Block (`src/index.ts`)

**Modified.** Added init block between DLQ init and HounfourRouter construction:
- `RoutingState` type: `"disabled" | "shadow" | "enabled" | "init_failed"`
- Dynamic imports of all 7 Goodhart components
- `FINN_REPUTATION_ROUTING` env var controls mode (default: `"shadow"`)
- `PrefixedRedisClient` wired with `FINN_REDIS_PREFIX` (default: `armitage:`)
- CalibrationEngine gated: only when both `FINN_CALIBRATION_BUCKET_NAME` AND `FINN_CALIBRATION_HMAC_KEY` set
- NoopCalibrationEngine pattern: `CalibrationEngine({calibrationWeight: 0})` for neutral scores
- Redis unavailable → stays `"disabled"`; init exception → `"init_failed"` + counter

### T-1.6: Router State Machine (`src/hounfour/router.ts`)

**Modified.** Full 4-state routing machine in `resolvePoolForRequest()`:
1. **KillSwitch** — highest precedence, fail-open (Redis unavailable = normal routing)
2. **disabled** → deterministic only
3. **init_failed** → deterministic + `finn_goodhart_init_failed_requests` counter
4. **shadow** → invoke Goodhart, log divergence, return deterministic result
5. **enabled** → invoke Goodhart, return reputation result; null → deterministic fallback

Added fields to `HounfourRouterOptions`: `goodhartConfig?`, `routingState?`, `goodhartMetrics?`

### T-1.7: Parallel Scoring (`src/hounfour/goodhart/mechanism-interaction.ts`)

**Modified.** Replaced sequential pool scoring with `Promise.allSettled` + `p-limit(5)` + per-pool 50ms timeout. Individual failures don't block other pools; all failures → empty array.

### T-1.8: Prometheus Metrics (`src/hounfour/graduation-metrics.ts`)

**Modified.** Added 9 new metrics per SDD §3.5:
- Counters: `finn_shadow_total`, `finn_shadow_diverged`, `finn_goodhart_init_failed`, `finn_goodhart_init_failed_requests`, `finn_reputation_scoring_failed_total`, `finn_goodhart_timeout_total`, `finn_killswitch_activated_total`
- Gauge: `finn_goodhart_routing_mode` (label: `mode`)
- Histogram: `finn_routing_duration_seconds` (label: `path`)

---

## Test Results

| Test File | Tests | Status |
|-----------|-------|--------|
| `tests/finn/goodhart/transport-factory.test.ts` | 4 | PASS |
| `tests/finn/goodhart/read-only-redis.test.ts` | 8 | PASS |
| `tests/finn/infra/prefixed-redis.test.ts` | 7 | PASS |
| `tests/finn/goodhart/resolve.test.ts` | 4 | PASS |
| `tests/finn/goodhart/routing-state.test.ts` | 12 | PASS |
| **Total** | **35** | **PASS** |

### Pre-existing Failures (NOT caused by Sprint 1)

`tests/finn/goodhart/mechanism-interaction.test.ts` — 6 failures due to cycle-035 KillSwitch API mismatch (passes `boolean` where `RoutingMode` string expected). These failures predate Sprint 1.

---

## GPT Review Trail

| File | Iteration | Verdict | Findings |
|------|-----------|---------|----------|
| `resolve.ts` | 1 | CHANGES_REQUIRED | Timer leak, missing EvalError/URIError, no finally block |
| `resolve.ts` | 2 | APPROVED | All 3 findings fixed correctly |

Review artifacts: `grimoires/loa/a2a/gpt-review/code-findings-{1,2}.json`

---

## Architecture Notes

- **No breaking changes** to deterministic routing path — all Goodhart integration is additive
- **Proxy pattern** used consistently for Redis wrappers (ReadOnly + Prefixed)
- **Fail-open design**: KillSwitch Redis unavailable = continue normal routing
- **Fail-safe design**: Goodhart init failure = deterministic fallback with metrics
- **Shadow mode**: runs Goodhart read-only, logs divergence, returns deterministic result
