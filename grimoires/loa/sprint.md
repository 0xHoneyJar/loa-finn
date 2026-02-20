# Sprint Plan: Bridgebuilder Findings — Complete Hardening

> **Version**: 2.0.0
> **Date**: 2026-02-19
> **Cycle**: cycle-027 (continued — sprints 68-77 implemented via bridge loop on PR #82)
> **Source**: Bridge iteration 3 deferred findings + Bridgebuilder Deep Review (PR #82 comments)
> **PR**: [#82](https://github.com/0xHoneyJar/loa-finn/pull/82)
> **Deep Review**: [Part I](https://github.com/0xHoneyJar/loa-finn/pull/82#issuecomment-3923996225) | [Part II](https://github.com/0xHoneyJar/loa-finn/pull/82#issuecomment-3924002180)
> **Launch Gaps**: [Issue #66 Gap Map](https://github.com/0xHoneyJar/loa-finn/issues/66#issuecomment-3924004401)
> **Global Sprint IDs**: 78–80
> **Developer**: Claude Opus 4.6 (autonomous via `/run sprint-plan`)

---

## Sprint Overview

| Sprint | Global ID | Label | Goal | Tasks |
|--------|-----------|-------|------|-------|
| sprint-11 | 78 | Security & Infrastructure Hardening | Gate 0 blockers: KMS scoping, SNS wiring, fencing token, code fixes | 5 |
| sprint-12 | 79 | Observability & Testing | Distributed tracing, circuit breaker metrics, E2E test, gate automation | 5 |
| sprint-13 | 80 | Scalability & Quality | NFT batch API, CSP hardening, Docker Redis tests, load test foundation | 4 |

**Total**: 14 tasks across 3 sprints (13 unique findings → 13 finding-mapped tasks + 1 enabler; deepreview-otel decomposed into 2 tasks, medium-7/deepreview-kms merged as same finding)

**Dependencies**: Sprint 11 has no dependencies (all standalone fixes). Sprint 12 depends on Sprint 11 (SNS wiring needed for circuit breaker alarm). Sprint 13 is independent of 12. Task 13.4 depends on Task 13.3 (Docker Redis harness).

**Finding Sources**:
- Bridge iter3 deferred: medium-2, medium-6, medium-7, low-3
- Bridge iter3 new: new-low-1, new-low-2
- Bridgebuilder Deep Review: KMS (elevated), fencing token, distributed tracing, circuit breaker observability, gate automation, E2E integration test, SNS wiring

**Test Baseline**: All existing tests must continue passing. Each task adds targeted tests.

---

## Sprint 11: Security & Infrastructure Hardening (Global ID: 78)

**Objective**: Address all Gate 0 blockers identified in the Bridgebuilder review: scope KMS IAM, wire SNS notifications, add WAL fencing token monotonicity, and fix two code-level findings from bridge iteration 3.

**Gate Impact**: Unblocks Gate 0 → Gate 1 promotion. KMS scoping required before any real value flows.

**Rollback**: Individual Terraform changes can be reverted independently. Code fixes are backward-compatible.

### Task 11.1: Scope KMS IAM to Specific Key ARN (medium-7 / Gate 0 Blocker)

**Description**: Replace `Resource: "*"` in the KMS IAM policy with a scoped reference to the specific KMS key used for JWT signing. Create a `kms_key_arn` variable with validation, and reference it in the `KMSDecrypt` policy statement. This is the most critical security finding — `Resource: *` grants Decrypt/Sign on ANY KMS key in the AWS account.

**Finding**: medium-7 (bridge deferred) + Bridgebuilder Deep Review §VIII.1

**Files modified**:
- `infrastructure/terraform/loa-finn-ecs.tf` — Replace `Resource = "*"` with `var.kms_key_arn`

**Acceptance criteria**:
- [ ] New variable `kms_key_arn` with type `string` and validation (must match `arn:aws:kms:*` pattern)
- [ ] `KMSDecrypt` statement `Resource` references `var.kms_key_arn` instead of `"*"`
- [ ] Backward compatible: variable has no default (forces explicit ARN at apply time)
- [ ] `terraform validate` passes
- [ ] Comment explains why wildcard was removed (Bridgebuilder finding reference)

---

### Task 11.2: Create SNS Topic + Wire to All CloudWatch Alarms

**Description**: Create an SNS topic resource in the monitoring Terraform and wire it to all 5 CloudWatch alarms. Currently `alarm_sns_topic_arn` defaults to empty, meaning alarms exist but don't notify anyone. Alarms without actions are dashboards, not monitoring.

**Finding**: Bridgebuilder Deep Review §VIII (Issue #66 Gap Map — Gate 0 gap)

**Files modified**:
- `infrastructure/terraform/loa-finn-monitoring.tf` — Add `aws_sns_topic` resource, update `alarm_actions`

**Acceptance criteria**:
- [ ] New `aws_sns_topic.loa_finn_alarms` resource with `name = "loa-finn-alarms-${var.environment}"`
- [ ] New `aws_sns_topic_subscription` resource for email (configurable via `alarm_email` variable)
- [ ] All 5 alarm resources (`cpu_high`, `memory_high`, `error_5xx_rate`, `billing_pending_high`, `ecs_desired_count_drift`) have `alarm_actions` pointing to `aws_sns_topic.loa_finn_alarms.arn`
- [ ] Remove conditional `var.alarm_sns_topic_arn != "" ? ...` pattern — SNS is always present
- [ ] `alarm_sns_topic_arn` variable removed (replaced by resource reference)
- [ ] `terraform validate` passes
- [ ] **Completion note**: Email subscription will remain in `PendingConfirmation` state until manually confirmed out-of-band — this is expected and does NOT block sprint completion. The acceptance criterion is `alarm_actions` wiring to the SNS topic ARN, not email delivery. For non-prod environments, an HTTPS webhook endpoint may be used instead of email to enable auto-confirmation.

---

### Task 11.3: WAL Fencing Token Monotonicity Validation

**Description**: Add monotonic fencing token validation to the WAL append path. Currently `validateFencingToken()` in `wal-writer-lock.ts:119-122` only checks equality (`token === this._fencingToken`). After Redis failover (ElastiCache Multi-AZ), two instances could hold valid-looking tokens from different Redis primaries. The WAL storage layer must reject writes with `fencing_token <= last_accepted_token` (Kleppmann's Redlock analysis).

**Finding**: Bridgebuilder Deep Review §II (fencing token gap)

**Files modified**:
- `src/billing/wal-writer-lock.ts` — Add atomic CAS Lua script for `lastAcceptedToken`
- `src/billing/state-machine.ts` — Call CAS validation before every WAL append

**Implementation approach**: Atomic compare-and-set via Redis Lua script. Fencing tokens are monotonically increasing integers bounded to `<= 2^53 - 1` (JS safe integer range). This bound is enforced at token issuance time in `acquireLock()` and validated in the CAS script. The Lua script uses `tonumber()` which is safe within this bound (IEEE-754 doubles represent all integers up to 2^53 exactly). Tokens are stored as decimal strings in Redis for consistency.

**Why 2^53 bound is sufficient**: Fencing tokens increment by 1 per lock acquisition. At 1 acquisition per second (far above realistic load), exhausting 2^53 tokens takes ~285 million years. If a future system needs higher tokens, the CAS script must be upgraded to string comparison — but this is not a realistic concern for this system.

**Key namespace**: `wal:writer:last_accepted:{environment}` (per-environment isolation).

**Acceptance criteria**:
- [ ] New Redis Lua script `WAL_FENCING_CAS` that atomically: (1) reads `wal:writer:last_accepted:{env}` — if key missing, treat stored as `0`; (2) validates stored value: if non-numeric, negative, or `> 9007199254740991` (2^53-1), returns `"CORRUPT"` immediately (fail-closed); (3) parses both stored and incoming token with `tonumber()` (safe because both are validated `<= 2^53-1`); (4) if `incoming > stored` then `SET` to incoming value and returns `"OK"`, else returns `"STALE"` — all in one `EVAL` call (no WATCH/MULTI race window)
- [ ] **Corrupt state handling**: If CAS returns `"CORRUPT"`, caller rejects WAL append (fail-closed), logs `{ metric: "wal.fencing_token.corrupt", stored_value, severity: "critical" }`, and emits alert. Manual operator intervention required to reset the key.
- [ ] Fencing tokens stored as **decimal strings** in Redis for readability and future extensibility
- [ ] **Token issuance bound**: `acquireLock()` validates `Number.isSafeInteger(newToken)` before issuing. If token exceeds 2^53-1, lock acquisition fails with `wal.fencing_token.overflow` error (this is a system-level alert, not a recoverable condition)
- [ ] **CAS input bound**: `validateAndAdvanceFencingToken(token)` validates `Number.isSafeInteger(token)` before calling Lua. Rejects non-safe-integer tokens before they reach Redis.
- [ ] `BillingStateMachine` calls `validateAndAdvanceFencingToken(token)` before every WAL append. If `"STALE"` returned: reject write, do NOT append to WAL, log `{ metric: "wal.fencing_token.stale", token, lastAccepted }`.
- [ ] **Failure semantics**: If WAL append succeeds but Redis CAS update fails (network partition), the write is still valid (WAL is authoritative). Log warning `wal.fencing_token.redis_sync_failed` — next successful CAS will re-establish monotonicity since the token only advances.
- [ ] **Failure semantics**: If Redis CAS succeeds but WAL append fails, this is safe — the token advanced but no data was written. Next writer with a higher token proceeds normally.
- [ ] Tests: stale token rejected (CAS returns STALE), fresh token accepted (CAS returns OK), equal token rejected (must be strictly greater), concurrent writers simulated via sequential CAS calls with interleaved tokens
- [ ] Test: token exceeding `Number.MAX_SAFE_INTEGER` rejected at issuance with `wal.fencing_token.overflow`
- [ ] Test: corrupt stored token in Redis (e.g., `"9007199254740993"` or `"abc"`) → CAS returns `"CORRUPT"`, WAL append rejected, critical metric emitted

---

### Task 11.4: CreditNote BigInt Consistency Fix (new-low-2)

**Description**: Replace `Number(delta)` in `redis.incrby()` call at `src/x402/credit-note.ts:97` with a safe integer path. The rest of the file handles BigInt with discipline; this one conversion breaks that discipline.

**Finding**: new-low-2 (bridge iteration 3)

**Design decision**: Credit note deltas and balances represent USDC amounts in base units (6 decimals). The system enforces a hard cap of `MAX_CREDIT_BALANCE = 1_000_000_000_000` (1M USDC) on accumulated credit note balances per wallet. This cap is well within JS safe integer range (2^53-1 ≈ 9×10^15) and Redis int64 range. The cap is enforced atomically in a Lua script that reads the current balance, checks `balance + delta <= cap`, and only then increments. Individual deltas are bounded by the capped risk limit (currently 100 USDC = 100_000_000 base units) and also validated with `Number.isSafeInteger()`.

**Files modified**:
- `src/x402/credit-note.ts` — Replace `Number(delta)` with atomic Lua script that enforces cap + safe integer guard

**Acceptance criteria**:
- [ ] New constant `MAX_CREDIT_BALANCE = 1_000_000_000_000n` (1M USDC in base units) — well within safe integer range
- [ ] Line 97: `redis.incrby(balanceKey, Number(delta))` replaced with Lua script: reads current balance, validates `balance + delta <= MAX_CREDIT_BALANCE`, if valid performs `INCRBY` + `EXPIRE`, returns new balance; if cap exceeded returns `"CAP_EXCEEDED"`
- [ ] **Delta guard**: Before calling Lua, TypeScript validates `Number.isSafeInteger(Number(delta))` — rejects deltas outside safe integer range
- [ ] **Cap enforcement**: If accumulated balance would exceed `MAX_CREDIT_BALANCE`, credit note issuance is rejected with structured error `{ error: "credit_note_cap_exceeded", balance, delta, cap }` — prevents unbounded accumulation
- [ ] Balance key still expires with `CREDIT_NOTE_TTL` (set via `EXPIRE` inside the Lua script, atomic with INCRBY)
- [ ] Test: issue credit note with normal delta (e.g., 5_000_000 = 5 USDC), verify balance incremented correctly
- [ ] Test: multiple sequential issuances accumulate correctly
- [ ] Test: delta exceeding `Number.MAX_SAFE_INTEGER` rejected before reaching Redis
- [ ] Test: accumulated balance exceeding `MAX_CREDIT_BALANCE` returns `CAP_EXCEEDED`, balance unchanged

---

### Task 11.5: Onboarding Personality Null-Check Fix (new-low-1)

**Description**: Replace the try/catch pattern in `src/nft/onboarding.ts:243-259` with a null check. `PersonalityService.get()` returns `null` when no personality exists — it doesn't throw. The current code takes an unnecessary error path (two function calls + one exception throw/catch) instead of a simple null check. The code works by accident, not by design.

**Finding**: new-low-1 (bridge iteration 3)

**Files modified**:
- `src/nft/onboarding.ts` — Replace try/catch with null check

**Acceptance criteria**:
- [ ] Lines 243-259: `try { get(); update() } catch { create() }` replaced with `const existing = await get(); if (existing) { update() } else { create() }`
- [ ] Personality is created correctly for new NFTs (same behavior, cleaner path)
- [ ] Personality is updated correctly for existing NFTs
- [ ] No exception thrown during normal flow
- [ ] Test: new NFT onboarding creates personality via null-check path
- [ ] Test: existing NFT onboarding updates personality without exception

---

## Sprint 12: Observability & Testing (Global ID: 79)

**Objective**: Add distributed tracing through the x402 payment flow, circuit breaker state observability, a full E2E integration test, and gate promotion automation. These are Gate 1-2 readiness requirements.

**Gate Impact**: Enables operational debugging of payment flows. Required for Gate 2 (Warmup) where real value flows and failures must be traceable.

**Depends on**: Sprint 11 (SNS topic for circuit breaker alarm)

### Task 12.1: OpenTelemetry SDK Setup + Base Configuration

**Description**: Add `@opentelemetry/sdk-node` with console exporter (swappable for OTLP in production). Configure trace provider, span processor, and resource attributes. The existing `correlation_id` field in billing entries should be linked to trace context.

**Finding**: Bridgebuilder Deep Review §VIII.3

**Files created**:
- `src/telemetry/tracing.ts` — OTel setup, trace provider, resource attributes

**Acceptance criteria**:
- [ ] `@opentelemetry/sdk-node`, `@opentelemetry/api`, `@opentelemetry/exporter-trace-otlp-http` as dependencies
- [ ] `initTracing()` function creates `NodeTracerProvider` with `service.name = "loa-finn"`, `service.version`, `deployment.environment`
- [ ] Console exporter by default, OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` env var set
- [ ] `getTracer(name)` helper for creating spans in business logic
- [ ] `correlation_id` from billing entries attached as span attribute
- [ ] Feature-flagged: `OTEL_ENABLED=true` to activate (default off)
- [ ] Test: tracer initializes without error, span creation works

---

### Task 12.2: Trace Context Propagation Through x402 Payment Flow

**Description**: Instrument the full payment pipeline with OpenTelemetry spans: quote generation → payment verification → settlement → DLQ enqueue → finalize → ledger entry. Each stage creates a child span linked to the root `x402.transaction` span. The `correlation_id` already in `DLQEntry` is the natural trace context carrier.

**Finding**: Bridgebuilder Deep Review §VIII.3

**Files modified**:
- `src/x402/middleware.ts` — Root span `x402.quote`
- `src/x402/verify.ts` — Child span `x402.verify`
- `src/x402/settlement.ts` — Child span `x402.settle` with circuit breaker state attribute
- `src/billing/dlq.ts` — Child span `x402.finalize` per DLQ entry
- `src/billing/ledger.ts` — Child span `x402.ledger` per journal append

**Acceptance criteria**:
- [ ] Root span created in middleware with `quote_id`, `model`, `max_cost` attributes
- [ ] Verify span includes `payment_id`, `wallet_address`, `is_replay` attributes
- [ ] Settlement span includes `method` (facilitator/direct), `circuit_state`, `tx_hash` attributes
- [ ] DLQ span includes `attempt`, `billing_entry_id`, `next_retry_at` attributes
- [ ] Ledger span includes `event_type`, `posting_count`, `balance_after` attributes
- [ ] Spans are linked parent→child via context propagation
- [ ] No spans created when `OTEL_ENABLED` is false (zero overhead)
- [ ] Test: mock tracer verifies span hierarchy

---

### Task 12.3: Circuit Breaker State Metrics + CloudWatch Alarm

**Description**: Add Prometheus gauge for settlement circuit breaker state and a CloudWatch alarm that triggers when the circuit opens. When the circuit breaker trips CLOSED → OPEN, this is a P1 operational event (all payments falling back to direct settlement).

**Finding**: Bridgebuilder Deep Review §VIII.4

**Files modified**:
- `src/x402/settlement.ts` — Add state change callbacks and metric emission
- `src/gateway/metrics-endpoint.ts` — Add `settlement_circuit_state` gauge
- `infrastructure/terraform/loa-finn-monitoring.tf` — Add log metric filter + alarm

**Acceptance criteria**:
- [ ] `CircuitBreaker` emits structured log on state change: `{ metric: "settlement.circuit.state_change", from, to, failure_count, timestamp }`
- [ ] Prometheus gauge `settlement_circuit_state` with labels `{state="closed|open|half_open"}` (1 = current state)
- [ ] CloudWatch log metric filter for `"settlement.circuit.state_change"` where `to = "OPEN"`
- [ ] CloudWatch alarm `settlement-circuit-open` triggers on `> 0` in 60s period
- [ ] Alarm action: SNS topic from Task 11.2
- [ ] Test: record 3 failures → circuit opens → metric emitted → structured log output

---

### Task 12.4: E2E-Lite Integration Test — Payment Flow (Orchestration + Conservation)

**Description**: Create an integration test that validates the complete payment pipeline orchestration: quote generation → payment verification → settlement → finalize → ledger entry. Validates end-to-end correlation and conservation invariants using mocked Redis. This test validates what mocks CAN faithfully simulate (orchestration flow, ledger math, correlation). Behavioral properties requiring real Redis (Lua atomicity, XREADGROUP semantics, nonce replay under concurrency) are validated in Task 13.3 (Docker Redis harness).

**Finding**: Bridgebuilder Deep Review §VIII (Issue #66 Gap Map — Gate 1 gap)

**Files created**:
- `tests/finn/x402-e2e-lite.test.ts` — Payment flow orchestration integration test

**Acceptance criteria**:
- [ ] Test scenario: generate quote → construct EIP-3009 auth → verify payment → mock settlement → trigger finalize → verify ledger entry
- [ ] Validates quote_id flows through entire pipeline (correlation)
- [ ] Validates credit note issuance on overpayment (delta = quoted - actual)
- [ ] Validates conservation invariant: `SUM(all postings) === 0n` after complete flow
- [ ] Validates DLQ enqueue on settlement failure (mock failure → entry appears in DLQ)
- [ ] Uses mock Redis (ioredis-mock) — no Docker dependency
- [ ] **Explicitly NOT tested here** (deferred to Task 13.3 Docker Redis tests): nonce replay atomicity under concurrency, Lua script execution, XREADGROUP + XACK DLQ retry flow, WAL fencing CAS atomicity
- [ ] Test passes in CI (<10s)

---

### Task 12.5: Gate Promotion Validation Script

**Description**: Create a script that validates gate readiness criteria against actual system state. Issue #66 defines Gates 0-4 with clear criteria, but the gate *validation* is manual. This script codifies each gate's pass/fail conditions.

**Finding**: Bridgebuilder Deep Review §VIII.5

**Files created**:
- `scripts/gate-check.sh` — Gate validation script

**Acceptance criteria**:
- [ ] `./scripts/gate-check.sh 0` validates Gate 0 (Smoke): ECS service exists, health endpoint returns 200, CloudWatch alarms exist, SNS topic wired
- [ ] `./scripts/gate-check.sh 1` validates Gate 1 (Ignition): billing state machine responds, quote generation works, conservation guard healthy
- [ ] `./scripts/gate-check.sh 2` validates Gate 2 (Warmup): NFT personality CRUD works, onboarding flow completes, credit purchase works
- [ ] `./scripts/gate-check.sh 3` validates Gate 3 (Idle): BYOK validation works, feature flags configurable
- [ ] `./scripts/gate-check.sh 4` validates Gate 4 (Launch): x402 flow completes, multi-model routing works, all alarms green
- [ ] Each gate check outputs PASS/FAIL with specific failed criteria
- [ ] `--json` flag for machine-readable output
- [ ] Requires `aws` CLI and `curl` — no other dependencies
- [ ] Test: `gate-check.sh 0 --dry-run` validates script logic without AWS calls

---

## Sprint 13: Scalability & Quality (Global ID: 80)

**Objective**: Address the remaining deferred findings: NFT batch detection, CSP hardening, Docker-based Redis tests, and load test foundation. These are Gate 3-4 readiness requirements.

**Gate Impact**: NFT batch API required before Gate 3 (>100 users). CSP required for production waitlist. Load tests validate system behavior under stress.

**Independent**: Can run in parallel with Sprint 12.

### Task 13.1: NFT Detection Batch API via Alchemy (medium-2)

**Description**: Replace the O(100×C) per-collection RPC loop with Alchemy's `getNFTsForOwner` batch API. Currently, detecting NFT ownership requires 100 collection checks × N tokens per collection = potentially thousands of RPC calls. Alchemy's API resolves all NFTs for a wallet in 1-2 calls regardless of collection count.

**Finding**: medium-2 (bridge deferred) + Bridgebuilder Deep Review §VIII.2

**Files modified**:
- `src/nft/detection.ts` (or equivalent) — Replace RPC loop with Alchemy batch API

**Acceptance criteria**:
- [ ] New `AlchemyNFTDetector` class implementing the same interface as existing detection
- [ ] Uses Alchemy `getNFTsForOwner` endpoint: single API call returns all NFTs for a wallet
- [ ] Filters response by known collection addresses (maintained in config)
- [ ] Falls back to existing RPC-based detection if Alchemy API unavailable (circuit breaker)
- [ ] `ALCHEMY_API_KEY` env var required; detection disabled if not set
- [ ] Response cached in Redis with 5-minute TTL (NFT ownership doesn't change frequently)
- [ ] Test: mock Alchemy response → correct NFTs detected
- [ ] Test: Alchemy down → fallback to RPC detection
- [ ] Performance: O(1) API calls per wallet instead of O(100×C)

---

### Task 13.2: Waitlist CSP Nonce/Hash Hardening + Violation Reporting (medium-6)

**Description**: Replace `unsafe-inline` in the Content-Security-Policy header for the waitlist page with nonce-based or hash-based CSP. Currently Tailwind's inline styles trigger the CSP violation. The fix requires either build-time Tailwind compilation (extracting styles to a CSS file) or nonce-based CSP with per-request nonce injection. Additionally, implement a CSP violation report endpoint so violations are logged rather than silently dropped.

**Finding**: medium-6 (bridge deferred)

**Files modified**:
- `src/gateway/waitlist.ts` (or equivalent) — CSP header update with `report-to` directive
- Build config — Tailwind compilation to CSS file (if nonce approach not used)

**Files created**:
- `src/gateway/csp-report.ts` — CSP violation report handler endpoint

**Acceptance criteria**:
- [ ] CSP header no longer contains `'unsafe-inline'` for `style-src`
- [ ] Either: (a) Tailwind styles compiled to external CSS file referenced in CSP, or (b) nonce-based CSP with per-request `nonce` attribute on `<style>` tags
- [ ] `script-src` also tightened (no `unsafe-inline` or `unsafe-eval`)
- [ ] Waitlist page renders correctly with new CSP
- [ ] **CSP report endpoint** `/api/v1/csp-report` implemented: accepts `application/csp-report` JSON POST, validates schema (reject payloads > 10KB), logs structured event `{ metric: "csp.violation", document_uri, violated_directive, blocked_uri }`, returns 204 No Content
- [ ] CSP header uses `report-to` directive with `Reporting-Endpoints` header (modern standard), plus `report-uri` fallback for older browsers: `report-uri /api/v1/csp-report; report-to csp-endpoint`
- [ ] `Reporting-Endpoints` header: `csp-endpoint="/api/v1/csp-report"`
- [ ] **Deploy in report-only first**: Use `Content-Security-Policy-Report-Only` header initially to validate no breakage, with a comment/flag to switch to enforcing `Content-Security-Policy` after validation
- [ ] Test: page loads without CSP violations in browser console
- [ ] Test: CSP header present in response with correct directives
- [ ] Test: POST to `/api/v1/csp-report` with valid violation JSON returns 204
- [ ] Test: POST with oversized payload (>10KB) returns 413

---

### Task 13.3: Docker-Based Redis Integration Test Harness (low-3)

**Description**: Create a Docker Compose test harness that runs a real Redis instance for integration testing. Current tests use mocked Redis, which doesn't catch behavioral differences (Lua script execution, MULTI/EXEC, pub/sub). The harness enables running billing, DLQ, and WAL tests against a real Redis.

**Finding**: low-3 (bridge deferred)

**Files created**:
- `tests/docker-compose.test.yml` — Redis + test runner services
- `tests/helpers/redis-integration.ts` — Helper for connecting to Docker Redis
- `scripts/test-integration.sh` — Script to run Docker-based tests

**Acceptance criteria**:
- [ ] `docker-compose.test.yml` defines Redis 7.x service + test runner service
- [ ] `redis-integration.ts` provides `getTestRedis()` returning real ioredis client
- [ ] `test-integration.sh` starts compose, runs tagged tests, tears down
- [ ] At least 3 integration tests run against real Redis: (1) DLQ XREADGROUP + XACK flow, (2) WAL writer lock SETNX + fencing, (3) credit note Lua script atomicity
- [ ] Tests tagged with `@integration` (skipped in normal `vitest run`)
- [ ] CI workflow runs integration tests in separate job (with Docker)
- [ ] Test suite completes in < 30s
- [ ] Teardown is idempotent (handles partial failures)

---

### Task 13.4: Load Test Foundation — Concurrent Payment Scenarios

**Description**: Create a load test that exercises the billing pipeline under concurrent load. Validates circuit breaker behavior, conservation invariant under stress, DLQ backpressure, and capped risk limits. Uses the Docker Redis harness from Task 13.3.

**Finding**: low-3 (bridge deferred, extended scope)

**Files created**:
- `tests/load/billing-concurrent.test.ts` — Concurrent payment load test

**Acceptance criteria**:
- [ ] Scenario 1: 50 concurrent reserve→commit flows — all complete, conservation holds
- [ ] Scenario 2: 50 concurrent reserves with 5 settlement failures — DLQ processes retries, capped risk enforced
- [ ] Scenario 3: Circuit breaker trip under load — settlement falls back to direct, no lost payments
- [ ] Scenario 4: 100 concurrent quote generations — all get unique quote_ids, no collisions
- [ ] Conservation invariant validated after each scenario: `SUM(all postings) === 0n`
- [ ] Tagged `@load` (separate from unit and integration tests)
- [ ] Uses Docker Redis from Task 13.3
- [ ] Completes in < 60s
- [ ] Results include: throughput (ops/sec), P50/P95/P99 latency, error rate

---

## Traceability Matrix

> **Canonical Finding List (14 findings)**:
>
> Bridge iter3 deferred (4): medium-2 (NFT O(100×C) RPC), medium-6 (CSP unsafe-inline), medium-7 (KMS Resource:*), low-3 (load tests)
> Bridge iter3 new (2): new-low-1 (onboarding try/catch), new-low-2 (BigInt Number() conversion)
> Bridgebuilder Deep Review (8): deepreview-kms (== medium-7, elevated to Gate 0), deepreview-fencing (Kleppmann gap), deepreview-sns (SNS wiring), deepreview-otel (distributed tracing — decomposed into setup + propagation = 2 tasks for 1 finding), deepreview-circuit (circuit breaker observability), deepreview-e2e (E2E integration test), deepreview-gate (gate promotion automation)
>
> **Count**: 4 + 2 + 8 = 14, but `deepreview-kms` == `medium-7` (same finding elevated), so **13 unique findings → 13 finding-mapped tasks + 1 enabler task = 14 total tasks**.

| Finding ID | Severity | Source | Sprint | Task | Notes |
|------------|----------|--------|--------|------|-------|
| medium-7 / deepreview-kms | MEDIUM→CRITICAL | Bridge iter3 deferred + Deep Review §VIII.1 | 11 | 11.1 | Same finding — medium-7 elevated to Gate 0 blocker by Deep Review |
| deepreview-sns | HIGH | Deep Review §VIII | 11 | 11.2 | |
| deepreview-fencing | HIGH | Deep Review §II | 11 | 11.3 | |
| new-low-2 | LOW | Bridge iter3 | 11 | 11.4 | |
| new-low-1 | LOW | Bridge iter3 | 11 | 11.5 | |
| deepreview-otel | HIGH | Deep Review §VIII.3 | 12 | 12.1 + 12.2 | Single finding decomposed into 2 tasks (setup + propagation) |
| deepreview-circuit | MEDIUM | Deep Review §VIII.4 | 12 | 12.3 | |
| deepreview-e2e | MEDIUM | Deep Review §VIII / #66 | 12 | 12.4 | |
| deepreview-gate | MEDIUM | Deep Review §VIII.5 | 12 | 12.5 | |
| medium-2 | MEDIUM | Bridge iter3 deferred | 13 | 13.1 | |
| medium-6 | MEDIUM | Bridge iter3 deferred | 13 | 13.2 | |
| low-3 | LOW | Bridge iter3 deferred | 13 | 13.4 | |

**Enabler tasks** (not mapped to findings — implementation dependencies):

| Task | Purpose | Required by |
|------|---------|-------------|
| 13.3 (Docker Redis harness) | Provides real Redis for integration + load tests | 13.4 (load tests), 12.4 deferred assertions |

**Reconciliation**: 13 unique findings mapped to 14 tasks (deepreview-otel decomposed into 2, medium-7/deepreview-kms merged as same finding). All 14 original finding references are accounted for.

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| KMS key ARN not available at plan time | Sprint 11.1 blocked | Use `data "aws_kms_key"` to look up by alias, or accept variable with no default |
| Alchemy API rate limits | Sprint 13.1 degraded | Circuit breaker with RPC fallback; Redis caching reduces call volume |
| OpenTelemetry overhead in production | Sprint 12 performance | Feature-flagged (`OTEL_ENABLED`); console exporter has near-zero overhead |
| Docker not available in CI | Sprint 13.3-13.4 blocked | Tests tagged separately; CI job with Docker support runs them |

## Success Metrics

- All 14 findings addressed with code + tests
- Zero regression on existing test suite
- KMS `Resource: *` eliminated (Gate 0 unblocked)
- SNS wired to all alarms (operational visibility)
- E2E payment flow test passing
- NFT detection reduced from O(100×C) to O(1)
