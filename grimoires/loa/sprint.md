# Sprint Plan: Staging Readiness — Goodhart Wiring, ECS Staging, Fly.io Cleanup

**Cycle:** 036
**PRD:** `grimoires/loa/prd.md`
**SDD:** `grimoires/loa/sdd.md`
**Date:** 2026-02-26
**Team:** 1 AI developer + 1 human reviewer
**Sprint duration:** ~2-4 hours each (AI-paced)
**Status:** SPRINTS 1-7 COMPLETE, SPRINT 8 PENDING (8 total)

---

## Sprint 1: Goodhart Stack Wiring + Router Integration [COMPLETED]

**Goal:** Wire the 7 existing Goodhart components into the live routing path with full state machine support.

**Risk:** Highest — touches core routing logic. Must not break deterministic path.

### Tasks

#### T-1.1: Transport Factory
- **Description:** Create `src/hounfour/goodhart/transport-factory.ts` with `createDixieTransport()` function. Re-export from `src/hounfour/goodhart/index.ts`.
- **Acceptance Criteria:**
  - `createDixieTransport()` returns `DixieStubTransport` when `baseUrl` is undefined, empty, or `"stub"`
  - `createDixieTransport(url)` returns `DixieHttpTransport` with given URL
  - Exported from goodhart barrel file
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/transport-factory.test.ts` — stub selection, HTTP selection, empty string, `"stub"` string

#### T-1.2: ReadOnlyRedisClient Wrapper
- **Description:** Create `src/hounfour/goodhart/read-only-redis.ts` implementing the Proxy-based read-only wrapper per SDD §3.3. Only exposes `get`, `mget`, `hget`, `hgetall`, `exists`, `ttl`, `type`. All mutating methods throw. Explicitly handles bypass vectors (`multi`, `pipeline`, `sendCommand`, `eval`/`evalsha`).
- **Acceptance Criteria:**
  - Read methods (`get`, `mget`, `hget`, `hgetall`, `exists`) pass through to underlying client
  - Mutating methods (`set`, `incr`, `hset`, `del`, `lpush`, etc.) throw `Error("Redis writes blocked in shadow mode (attempted: <method>)")`
  - Bypass vectors blocked: `multi()`, `pipeline()`, `sendCommand()`, `eval()`, `evalsha()` all throw
  - Non-function properties pass through unchanged
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/read-only-redis.test.ts` — read pass-through, write blocking, error message format, multi/pipeline/sendCommand/eval blocked

#### T-1.3: PrefixedRedisClient Wrapper
- **Description:** Create `src/hounfour/infra/prefixed-redis.ts` implementing runtime key prefix enforcement per SDD §4.1.2. All key-bearing commands prepend the configured prefix. Startup assertion rejects empty/short prefix.
- **Acceptance Criteria:**
  - `get("foo")` becomes `get("armitage:foo")` when prefix is `armitage:`
  - `mget(["a", "b"])` becomes `mget(["armitage:a", "armitage:b"])`
  - Prefix < 2 chars throws at construction time
  - `select(dbIndex)` called on construction
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/infra/prefixed-redis.test.ts` — prefix prepending, mget array handling, short prefix rejection, DB selection

#### T-1.4: resolveWithGoodhart Function
- **Description:** Create `src/hounfour/goodhart/resolve.ts` implementing the typed contract from SDD §3.3.1. Core integration function connecting router to all Goodhart components. Uses seeded PRNG in shadow, has 200ms hard timeout ceiling with AbortController propagation. Catches operational errors but allows programmer errors to surface.
- **Acceptance Criteria:**
  - Exports `GoodhartOptions`, `GoodhartResult` interfaces exactly as defined in SDD §3.3.1
  - Accepts `MechanismConfig` + routing params + `GoodhartOptions`
  - Returns `GoodhartResult | null` (null = fallback to deterministic)
  - Uses seeded PRNG (deterministic for fixed seed) when `options.mode === "shadow"` — same seed produces same exploration decision
  - Has 200ms overall timeout via `AbortController.timeout(200)` propagated to Redis calls
  - On all-pools-failed, returns `null` and increments counter
  - On timeout, returns `null` and increments `finn_goodhart_timeout_total`
  - On operational error (timeout, Redis failure, etc.): catches, logs structured warning with error type/count, returns null
  - On programmer error (TypeError, ReferenceError): allows to propagate (fail-fast for bugs)
  - Emits `finn_goodhart_unavailable` gauge (1 when returning null due to error, 0 on success)
  - In `enabled` mode: if error rate exceeds 10% over 1-minute window, logs critical warning (auto-downgrade is future work)
- **Effort:** Medium
- **Dependencies:** T-1.1, T-1.2
- **Tests:** `tests/finn/goodhart/resolve.test.ts` — happy path, shadow mode deterministic PRNG (same seed = same result), timeout with AbortController, all-failed fallback, operational-error catch, programmer-error propagation, unavailable gauge behavior

#### T-1.5: Goodhart Initialization Block
- **Description:** Add Goodhart init block to `src/index.ts` per SDD §3.2. Construct all 7 components inside try/catch, set `routingState`, gate CalibrationEngine behind env vars.
- **Acceptance Criteria:**
  - `FINN_REPUTATION_ROUTING=disabled` → no Goodhart construction, routingState="disabled"
  - `FINN_REPUTATION_ROUTING=shadow` (default) → full construction, routingState="shadow"
  - `FINN_REPUTATION_ROUTING=enabled` → full construction, routingState="enabled"
  - Redis unavailable → routingState="disabled" with warning log
  - Init exception → routingState="init_failed" + `finn_goodhart_init_failed` counter
  - CalibrationEngine only constructed when both `FINN_CALIBRATION_BUCKET_NAME` AND `FINN_CALIBRATION_HMAC_KEY` are set; otherwise NoopCalibrationEngine
  - Startup log: `[finn] routing state resolved: <state> (requested: <mode>)`
  - `FINN_REDIS_PREFIX` validated and used via PrefixedRedisClient
- **Effort:** Medium
- **Dependencies:** T-1.1, T-1.2, T-1.3, T-1.4
- **Tests:** Integration tests in `tests/finn/goodhart/init.test.ts` — all 4 states, CalibrationEngine gating, prefix validation

#### T-1.6: Router State Machine + KillSwitch Integration
- **Description:** Extend `HounfourRouterOptions` with `goodhartConfig?` and `routingState?`. Implement `resolvePoolForRequest()` with 4-state machine per SDD §3.3. Wire KillSwitch as highest-precedence override with concrete key/value semantics.
- **Acceptance Criteria:**
  - `RoutingState` type exported: `"disabled" | "shadow" | "enabled" | "init_failed"`
  - `routingState="disabled"` → deterministic only, no Goodhart invocation
  - `routingState="init_failed"` → deterministic + `finn_goodhart_init_failed_requests` counter
  - `routingState="shadow"` → invoke `resolveWithGoodhart()`, increment `finn_shadow_total`, compare results, return deterministic
  - `routingState="enabled"` → invoke `resolveWithGoodhart()`, return reputation result
  - KillSwitch "kill" → deterministic fallback regardless of routingState
  - KillSwitch checked BEFORE shadow/enabled evaluation
  - Shadow divergence: increment `finn_shadow_diverged` when results differ
  - `resolveWithGoodhart` returns null → fall back to deterministic
  - **KillSwitch contract:**
    - Redis key: `finn:killswitch:mode` (prefixed via PrefixedRedisClient)
    - Values: `"normal"` (default/missing) | `"kill"` (force-disable)
    - Check frequency: every request (single Redis GET, <50ms timeout)
    - Missing key = `"normal"` (safe default: Goodhart stays active)
    - Redis unavailable during check = treat as `"normal"` (fail-open for the switch, not for routing)
  - **Layered rollback plan documented in code comments:**
    1. KillSwitch Redis SET (instant, <1s)
    2. `FINN_REPUTATION_ROUTING=disabled` env override (requires redeploy, ~5min)
    3. If both Redis AND SSM unavailable: boot defaults to `"disabled"` when Redis is unreachable (existing T-1.5 behavior)
- **Effort:** Medium-Large
- **Dependencies:** T-1.4, T-1.5
- **Tests:** `tests/finn/goodhart/routing-state.test.ts` — all 4 states, KillSwitch override, KillSwitch key missing = normal, KillSwitch Redis timeout = normal, shadow divergence counting, null-result fallback

#### T-1.7: Parallel Scoring with Concurrency Limit
- **Description:** Replace sequential `for...of` pool scoring in `resolvePoolWithReputation()` with `Promise.allSettled` + `p-limit(5)` + per-pool 50ms timeout per SDD §3.4.
- **Acceptance Criteria:**
  - Uses `p-limit` for concurrency control (max 5 concurrent)
  - Each pool scoring has 50ms `Promise.race` timeout
  - Individual failures don't block other pools
  - All failures → empty array + `finn_reputation_scoring_failed_total` counter
  - `p-limit` added as dependency in `package.json`
- **Effort:** Small
- **Dependencies:** None (can be done in parallel with T-1.4)
- **Tests:** `tests/finn/hounfour/parallel-scoring.test.ts` — concurrency limit, timeout behavior, partial failure, total failure

#### T-1.8: Prometheus Metrics
- **Description:** Add all 9 new metrics from SDD §3.5 + Flatline additions to the existing metrics file. Includes counters, gauge, and histogram.
- **Acceptance Criteria:**
  - 9 metrics registered with correct types:
    - Counter: `finn_shadow_total`, `finn_shadow_diverged`, `finn_goodhart_init_failed`, `finn_goodhart_init_failed_requests`, `finn_reputation_scoring_failed_total`, `finn_goodhart_timeout_total`, `finn_killswitch_activated_total`
    - Gauge: `finn_goodhart_routing_mode` (label: `mode`)
    - Histogram: `finn_routing_duration_seconds` (label: `path` with values: shadow/enabled/deterministic)
  - Routing mode gauge set to 1 for current state on startup
  - Each metric has correct name, type, and label set (assert in tests)
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/metrics.test.ts` — assert each metric name exists with correct type (counter/gauge/histogram), assert histogram has `path` label, assert routing mode gauge is set to expected value after init

---

## Sprint 2: Fly.io/Railway Cleanup + CI E2E Fixes [COMPLETED]

**Goal:** Remove stale deployment references and fix CI workflows. Low-risk, high-confidence.

### Tasks

#### T-2.1: Delete Stale Files
- **Description:** Delete 4 files per SDD §5.1: `railway.toml`, `deploy/railway.toml`, `deploy/wrangler.jsonc`, `grimoires/loa/context/bridgebuilder-minimal-railway.md`.
- **Acceptance Criteria:**
  - All 4 files deleted
  - No broken imports or references to deleted files
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** Verify files don't exist post-deletion

#### T-2.2: Edit Files to Remove Fly.io/Railway References
- **Description:** Edit 9 files per SDD §5.2 to remove Fly.io and Railway references. Preserve CHANGELOG.md historical entries.
- **Acceptance Criteria:**
  - All 9 files edited per SDD table
  - `grep -r "fly.io\|flyctl\|railway.toml\|railway.app" src/ deploy/ .github/ docs/` returns 0 matches
  - CHANGELOG.md unchanged
  - `.claude/settings.json` has no `fly:*` or `railway:*` entries
- **Effort:** Medium (many files, but straightforward edits)
- **Dependencies:** T-2.1
- **Tests:** Grep verification (AC9, AC10, AC11)

#### T-2.3: CI Fix — e2e-smoke.yml Conditional Checkout
- **Description:** Wrap cross-repo checkout in `e2e-smoke.yml` behind token availability check per SDD §6.1.
- **Acceptance Criteria:**
  - Job checks for `ARRAKIS_CHECKOUT_TOKEN` availability
  - If unavailable: skip with `::warning::` message (not failure)
  - If available: proceed normally
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Manual: push PR without token, verify skip message

#### T-2.4: CI Fix — e2e.yml Oracle Directory Fixtures
- **Description:** Commit `.gitkeep` files per SDD §6.2 so Docker COPY succeeds with empty oracle directories.
- **Acceptance Criteria:**
  - `deploy/build-context/oracle-knowledge/.gitkeep` exists
  - `deploy/build-context/oracle-persona/.gitkeep` exists
  - Docker build succeeds with empty oracle directories
  - Oracle init degrades gracefully (existing behavior at `src/index.ts:289-301`)
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** Docker build verification

#### T-2.5: CI Fix — e2e-v2.yml GHCR Login
- **Description:** Add GHCR login step to `e2e-v2.yml` per SDD §6.3. Skip job when token unavailable.
- **Acceptance Criteria:**
  - GHCR login step added with `docker/login-action@v3`
  - Token availability check gates GHCR-dependent steps
  - Missing token → skip with warning (not failure)
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Manual: push PR, verify graceful skip or successful login

#### T-2.6: staging.env.example
- **Description:** Create `deploy/staging.env.example` per SDD §4.4 documenting all staging environment variables. Add `FINN_REDIS_PREFIX` and `FINN_REDIS_DB` variables from §4.1.2.
- **Acceptance Criteria:**
  - File exists at `deploy/staging.env.example`
  - Contains all env vars from SDD §4.4 + `FINN_REDIS_PREFIX=armitage:` + `FINN_REDIS_DB=1`
  - Comments explain which vars are set via SSM
  - `DIXIE_BASE_URL` intentionally absent (stub by default)
  - `FINN_CALIBRATION_BUCKET_NAME` intentionally absent (noop by default)
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** File exists, contains expected keys

---

## Sprint 3: Terraform + ECS Staging + Deploy Workflow [COMPLETED]

**Goal:** Stand up the staging environment on ECS with Terraform workspace isolation.

**Risk:** Medium — IaC changes. Must not touch production state.

### Tasks

#### T-3.1: Terraform Environment Variable + Workspace + Safety Runbook
- **Description:** Add `environment` variable to `infrastructure/terraform/variables.tf`. Create new Terraform workspace `armitage` per SDD §4.1.3. Conditional naming: production keeps legacy names, staging uses suffixed names. Document step-by-step safety runbook.
- **Acceptance Criteria:**
  - `variable "environment"` with default `"production"` exists
  - `locals.service_name` uses conditional: production → `"loa-finn"`, staging → `"loa-finn-${var.environment}"`
  - `terraform workspace new armitage` documented in runbook
  - Production Terraform state UNTOUCHED
  - Safety runbook at `infrastructure/terraform/STAGING-RUNBOOK.md` includes:
    1. `terraform workspace list` — confirm current workspace before any operation
    2. `terraform workspace select armitage` — explicit select before plan/apply
    3. Pre-apply check: script or manual step that verifies `terraform.workspace == var.environment`
    4. Exact commands for `terraform plan -var-file=environments/armitage.tfvars`
    5. Exact commands for `terraform apply -var-file=environments/armitage.tfvars`
    6. Backend configuration confirmation (same state backend, different workspace key)
    7. Warning: NEVER run `terraform apply` without `-var-file` in the armitage workspace
  - CI deploy workflow (T-3.4) enforces workspace/environment match via env var
  - **Hard guard in Terraform:** validation rule requiring `var.environment == terraform.workspace` — plan/apply fails if mismatch:
    ```hcl
    variable "environment" {
      validation {
        condition     = var.environment == terraform.workspace || terraform.workspace == "default"
        error_message = "Environment must match workspace. Use: terraform workspace select ${var.environment}"
      }
    }
    ```
- **Effort:** Medium
- **Dependencies:** None
- **Tests:** `terraform plan -var-file=environments/armitage.tfvars` shows staging resources only; runbook review; validation rule rejects mismatched workspace

#### T-3.2: Terraform Staging Resources (ECS + ALB + Route53)
- **Description:** Parameterize ECS service, ALB target group, Route53 record for environment. Create `environments/armitage.tfvars`. Add Redis validation rule.
- **Acceptance Criteria:**
  - `armitage.tfvars` exists with `environment = "armitage"`, CPU/memory overrides
  - ECS service name parameterized: `loa-finn-armitage`
  - ALB listener rule with host header `finn-armitage.arrakis.community`
  - Route53 ALIAS record for `finn-armitage.arrakis.community`
  - Redis URL validation rejects production URLs in non-production workspaces
  - SSM paths scoped: `/loa-finn/armitage/*`
- **Effort:** Large
- **Dependencies:** T-3.1
- **Tests:** `terraform plan` shows expected resources, no production changes

#### T-3.3: IAM Scoping for Staging
- **Description:** Scope staging task role IAM policy to armitage-specific resources per SDD §4.1.1. Apply least-privilege with explicit resource ARN constraints — no wildcard resources unless justified and documented.
- **Acceptance Criteria:**
  - SSM access limited to `/loa-finn/armitage/*` (explicit ARN, no `*` resource)
  - S3 access limited to `finn-calibration-*/armitage/*` (bucket + prefix scoped)
  - DynamoDB access limited to `finn-*-armitage*` tables (explicit table ARNs)
  - No wildcard `Resource: "*"` statements — every action scoped to specific ARNs
  - IAM policy uses `aws:RequestedRegion` condition to restrict to deployment region
  - Session duration limited: staging task role max 1 hour
  - Policy reviewed: `terraform plan` output shows no production ARNs in staging policies
- **Effort:** Medium
- **Dependencies:** T-3.1
- **Tests:** IAM policy review, `terraform plan` shows scoped policies, IAM Policy Simulator validation (or manual equivalent)

#### T-3.4: Staging Deploy Workflow
- **Description:** Create `.github/workflows/deploy-staging.yml` per SDD §4.5. Manual dispatch trigger, builds same as production, deploys to `loa-finn-armitage` ECS service. Includes rollback, health gating, and immutable image tags.
- **Acceptance Criteria:**
  - `workflow_dispatch` trigger with `environment` input
  - Build + test + Docker build + ECR push with immutable image tag (git SHA, not `latest`)
  - Deploy to `loa-finn-armitage` service
  - ALB target group health check gating: deployment waits for healthy targets before completing
  - Post-deploy smoke test: curl `/health` endpoint, verify 200 + expected version
  - Automatic rollback on failed health check: ECS circuit breaker enabled (`deployment_circuit_breaker { enable = true, rollback = true }`)
  - Uses existing ECR repository
- **Effort:** Medium
- **Dependencies:** T-3.2
- **Tests:** Workflow syntax validation (`act` or manual test)

#### T-3.5: Environment Isolation Verification
- **Description:** End-to-end verification that staging cannot access production resources. Validate all isolation mechanisms from SDD §4.1.1, §4.1.2, §4.1.3. Produce a concrete checklist with pass/fail evidence.
- **Acceptance Criteria:**
  - Redis prefix isolation: staging `GET armitage:*` succeeds, `GET` without prefix returns different keyspace (or empty). Verified via Redis CLI or integration test.
  - SSM path isolation: staging IAM role `GetParameter` for `/loa-finn/production/*` returns AccessDenied. Verified via `aws ssm get-parameter` with staging role.
  - Terraform workspace separation: `terraform workspace select default && terraform plan` shows zero staging resources. Verified via plan output.
  - DynamoDB table isolation: staging code references `finn-*-armitage` tables only. Verified via grep of task definition env vars.
  - Network isolation: staging ECS tasks resolve to staging ALB only (Route53 record check).
  - Secrets isolation: staging SSM parameters at `/loa-finn/armitage/*` contain staging-only values (not production secrets).
- **Effort:** Small-Medium
- **Dependencies:** T-3.2, T-3.3
- **Tests:** Verification script (`scripts/verify-staging-isolation.sh`) or documented manual checklist with pass/fail evidence

#### T-3.6: Staging Auth + x402 + Audit Verification
- **Description:** Verify that existing security features (ES256 JWT S2S auth, audit chain hash integrity, x402 settlement) are correctly wired on staging. These features already exist in code — this task verifies they work end-to-end in the staging environment.
- **Acceptance Criteria:**
  - ES256 JWT auth enforced on staging: unauthenticated request to a protected endpoint returns 401/403
  - ES256 JWT auth accepted: valid JWT returns 200
  - x402 settlement runs in `verify_only` mode: env var `X402_SETTLEMENT_MODE=verify_only` confirmed in staging task definition
  - Audit chain hash integrity: staging produces audit log entries with valid hash chain (verify via log inspection or integration test)
- **Effort:** Small
- **Dependencies:** T-3.4 (staging must be deployed)
- **Tests:** Scripted smoke tests against staging endpoint: 1) auth reject, 2) auth accept, 3) verify_only confirmation, 4) audit hash chain validation

#### T-3.7: Shadow→Enabled Graduation Protocol Implementation
- **Description:** Implement the graduation protocol from SDD §11: define exit criteria evaluation, create promotion runbook, configure metrics-based gates, document rollback procedures.
- **Acceptance Criteria:**
  - Exit criteria from SDD §11.1 encoded as queryable Prometheus expressions (e.g., Grafana alert rules or scripted checks)
  - Graduation runbook at `docs/graduation-runbook.md` with:
    1. Pre-graduation checklist (48-hour criteria window)
    2. Step-by-step promotion procedure (SSM parameter update, redeploy)
    3. Post-promotion monitoring checklist (1-hour watch)
    4. Three-tier rollback paths (P0: KillSwitch, P1: SSM+redeploy, P2: next deploy)
  - KillSwitch "kill" command documented with exact Redis key and value
  - Metric queries for each exit criterion documented (copy-paste into Prometheus/Grafana)
- **Effort:** Medium
- **Dependencies:** T-1.6 (KillSwitch integration), T-1.8 (metrics)
- **Tests:** Runbook review; verify documented Prometheus queries return valid results against staging metrics endpoint

#### T-3.8: Staging Readiness Gate
- **Description:** Terminal acceptance gate that aggregates all staging readiness checks into a single pass/fail verdict. Ensures "all tasks done" equals "staging actually works." Added per Flatline Beads IMP-011.
- **Acceptance Criteria:**
  - Staging health endpoint returns 200 with expected version (`/health` response includes git SHA)
  - `finn_shadow_total` counter increments on staging (route a test request, verify counter > 0)
  - KillSwitch toggle works: set `finn:killswitch:mode` to `"kill"`, verify deterministic-only routing, reset to `"normal"`
  - ES256 JWT auth rejects unauthenticated requests (401/403) and accepts valid JWT (200)
  - Zero Fly.io/Railway references: `grep -r "fly.io\|flyctl\|railway" src/ deploy/` returns 0
  - CI workflows pass or gracefully skip on PR
  - All Sprint 1-3 tasks marked complete in beads
- **Effort:** Small
- **Dependencies:** T-3.5, T-3.6, T-3.7
- **Tests:** Readiness checklist script or manual verification with documented evidence

---

## Risk Assessment

| Risk | Sprint | Mitigation |
|------|--------|------------|
| Routing regression | Sprint 1 | Existing deterministic tests must pass; shadow returns deterministic result |
| Redis connection issues | Sprint 1 | Graceful degradation already coded (routingState="disabled") |
| Production Terraform impact | Sprint 3 | Separate workspace, conditional naming, no state modifications |
| CI token availability | Sprint 2 | Conditional steps skip gracefully |

## Dependencies & Blocking Order

```
Sprint 1 (Goodhart wiring) → Sprint 2 (cleanup) → Sprint 3 (staging infra)
         ↓
T-1.1 ─→ T-1.4 ─→ T-1.5 ─→ T-1.6
T-1.2 ─↗         ↗
T-1.3 ──────────↗
T-1.7 (parallel)
T-1.8 (parallel)

Sprint 2: All tasks can run in parallel (no interdependencies except T-2.2 after T-2.1)
Sprint 3: T-3.1 → T-3.2 → T-3.4, T-3.3 parallel with T-3.2
```

---

## Sprint 4: Bridgebuilder Excellence Fixes

**Goal:** Address all findings from the Bridgebuilder review of PR #109 — observability blind spots, resilience gaps, and type safety issues identified during peer review.

**Source:** [Bridgebuilder Review PR #109](https://github.com/0xHoneyJar/loa-finn/pull/109#issuecomment-3965544585)

**Risk:** Low — surgical fixes to existing code with no new architectural patterns. All changes are additive (new metrics, new fields, new safety checks) with zero breaking surface.

### Tasks

#### T-4.1: Propagate scoredPools Through Resolve Boundary (CRITICAL-01)
- **Description:** The `scoredPools: []` in `resolve.ts:136` discards per-pool scoring data at the boundary. Modify `_scorePools()` in `mechanism-interaction.ts` to collect individual pool scores, thread them through `ReputationScoringResult`, and populate `GoodhartResult.scoredPools` in `resolve.ts`. Also emit per-pool scores in the router's shadow divergence log.
- **Pre-step:** Dependency scan — grep all files importing `PoolScoringResult` and `ReputationScoringResult` to enumerate all call sites requiring updates. Expected: `mechanism-interaction.ts` (internal), `resolve.ts` (boundary), `router.ts` (consumer), tests. Verify no external consumers exist.
- **Acceptance Criteria:**
  - AC1: `PoolScoringResult` includes `allScores: Array<{poolId: PoolId, score: number}>` alongside existing `bestPool`/`bestScore`
  - AC2: `ReputationScoringResult` includes `scoredPools: Array<{poolId: PoolId, score: number}>` threaded from `_scorePools`
  - AC3: `resolve.ts` maps `result.scoredPools` into `GoodhartResult.scoredPools` (no longer empty `[]`)
  - AC4: Router shadow path (`router.ts:331-336`) logs `scoredPools` in the structured divergence output
  - AC5: TypeScript build passes with no `any` escapes; all call sites importing these types compile cleanly
  - AC6: Existing tests pass; new test verifies scoredPools contains actual pool/score pairs
- **Effort:** Medium
- **Dependencies:** None
- **Tests:** Update `tests/finn/goodhart/resolve.test.ts` to assert `scoredPools` is non-empty when pools score successfully. Update `tests/finn/goodhart/mechanism-interaction.test.ts` to verify `scoredPools` in result.

#### T-4.2: KillSwitch Observability (CRITICAL-02)
- **Description:** The empty `catch {}` in `router.ts:281-283` for KillSwitch failures is fail-silent. Add a `killswitchCheckFailedTotal` counter to the existing `GraduationMetrics` class (the single canonical metrics module from Sprint 1 T-1.8) and increment it in the catch block. Add structured JSON log for operator visibility.
- **Acceptance Criteria:**
  - AC1: New counter `finn_killswitch_check_failed_total` added to `GraduationMetrics` in `src/hounfour/graduation-metrics.ts` (same module as existing `killswitchActivatedTotal` — no duplicate registry)
  - AC2: KillSwitch catch block increments counter and emits structured JSON log with `{component, event, error, timestamp}`
  - AC3: Counter appears in `/metrics` Prometheus output alongside existing `finn_killswitch_activated_total`
  - AC4: No duplicate metric registration — metrics test asserts new counter exists alongside existing killswitch metrics
  - AC5: Existing tests pass; new test verifies counter increments on KillSwitch error
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/routing-state.test.ts` — add case for KillSwitch error path verifying counter increment.

#### T-4.3: init_failed Recovery Probe (CRITICAL-03)
- **Description:** `init_failed` is currently terminal — no recovery without restart. Extract Goodhart init logic into a reusable function and implement a background recovery scheduler with exponential backoff.
- **Design Decisions (from GPT review):**
  - **State ownership:** Introduce a `GoodhartRuntime` mutable holder object `{requestedMode, routingState, goodhartConfig, goodhartMetrics}` shared between `src/index.ts` and the router. The router reads from this holder. Recovery updates the holder atomically (swap whole config object, not individual fields).
  - **Request-time behavior during recovery:** Requests continue using deterministic routing until `routingState` flips. No request-path retries.
  - **Shutdown:** `initGoodhartStack()` returns a `GoodhartRecoveryScheduler` with a `stop()` method. `src/index.ts` calls `stop()` on SIGTERM/SIGINT (existing shutdown path or new one if none exists). Tests assert `clearTimeout` called via fake timers.
- **Acceptance Criteria:**
  - AC1: Goodhart init logic extracted into `initGoodhartStack(env, redis)` in `src/hounfour/goodhart/init.ts`, returning `{config, routingState, metrics, scheduler}`
  - AC2: `GoodhartRuntime` interface defined and used as the shared mutable holder between index.ts and router
  - AC3: On `init_failed`, scheduler retries after 60s (then 120s, 240s — exponential backoff, capped at 5 retries)
  - AC4: New counters in `GraduationMetrics`: `finn_goodhart_recovery_attempt_total`, `finn_goodhart_recovery_success_total`
  - AC5: On successful recovery, scheduler atomically swaps `GoodhartRuntime.routingState` and `.goodhartConfig`; router reads updated config on next request
  - AC6: Scheduler exposes `stop()` method; `src/index.ts` calls it on shutdown; test asserts cleanup
  - AC7: Router test asserts it reads updated config after recovery (not just that init function returns success)
- **Effort:** Medium-Large
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/init-recovery.test.ts` — mock Redis availability, verify recovery attempt after timeout, verify max retries, verify state transition on success, verify router reads recovered config.

#### T-4.4: Explicit Routing Mode Default (CRITICAL-04)
- **Description:** `process.env.FINN_REPUTATION_ROUTING ?? "shadow"` silently defaults to shadow mode on fresh deploys. Change default to `"disabled"`. Add startup warning when the env var is absent. Update `staging.env.example` and `graduation-runbook.md` to document the explicit opt-in requirement. Verify the actual deployed staging config.
- **Acceptance Criteria:**
  - AC1: Default changed from `"shadow"` to `"disabled"` in `src/index.ts`
  - AC2: When `FINN_REPUTATION_ROUTING` is not set, emit `console.warn` with message: `"[finn] FINN_REPUTATION_ROUTING not set — defaulting to disabled. Set explicitly for shadow/enabled mode."`
  - AC3: `deploy/staging.env.example` updated with comment documenting the explicit requirement
  - AC4: `docs/graduation-runbook.md` updated with pre-deploy checklist item for this env var
  - AC5: Existing routing-state tests updated to reflect new default
  - AC6: Verify `FINN_REPUTATION_ROUTING=shadow` is present in `infrastructure/terraform/environments/armitage.tfvars` or ECS task definition env vars (not just the example file). If missing, add it to the Terraform staging config so the default change doesn't silently break shadow telemetry.
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update `tests/finn/goodhart/routing-state.test.ts` — verify default is `"disabled"` when env var absent.

#### T-4.5: Proxy Symbol Handling (ADVISORY)
- **Description:** The Proxy `get` trap in `read-only-redis.ts:20` and `prefixed-redis.ts` types `prop` as `string` but ES Proxy actually passes `string | symbol`. Fix both Proxy implementations to handle Symbol properties correctly by passing them through to the target unchanged.
- **Acceptance Criteria:**
  - AC1: `read-only-redis.ts` Proxy handles `Symbol` props — passes through to target without blocking
  - AC2: `prefixed-redis.ts` Proxy handles `Symbol` props — passes through to target without prefixing
  - AC3: `typeof prop === 'symbol'` guard added before string-based logic in both files
  - AC4: Existing tests pass; new tests verify Symbol.toPrimitive and Symbol.toStringTag pass through
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update `tests/finn/goodhart/read-only-redis.test.ts` and `tests/finn/infra/prefixed-redis.test.ts` with Symbol property tests.

#### T-4.6: Routing State Transition Structured Events (Gap)
- **Description:** Routing state transitions (`disabled → shadow`, `init_failed → shadow` on recovery, etc.) should be recorded as structured JSON events for queryability in incident review. Add structured event emission at all state transition points.
- **Design Decision (from GPT review):** KillSwitch is a *routing-path override*, not a state transition. `RoutingState` union (`disabled | shadow | enabled | init_failed`) remains unchanged. KillSwitch events use a separate event type `{event: "override", kind: "killswitch", active: true}` without mutating `routingState`. This prevents type cascade and event spam (killswitch checked per-request but state transitions are rare).
- **Acceptance Criteria:**
  - AC1: New exported function `emitRoutingStateTransition(from, to, trigger, metadata)` in `src/hounfour/goodhart/routing-events.ts` that writes structured JSON to stdout. Injectable for testing (tests spy on the function, not `console.*`).
  - AC2: All state transitions in `src/index.ts` init block emit events: `disabled → shadow/enabled`, `* → init_failed`
  - AC3: Recovery probe transitions (T-4.3) emit events: `init_failed → shadow/enabled`
  - AC4: KillSwitch override emits a separate *override event* (`{event: "override", kind: "killswitch", active: true}`) — NOT a state transition. Only emitted on first activation per request batch, not per-request, to prevent spam.
  - AC5: Transition events include: `{component: "routing-state", event: "transition", from, to, trigger, timestamp}`
  - AC6: `routingModeTransitionsTotal` counter (already exists) incremented on each real state transition (not overrides)
- **Effort:** Small-Medium
- **Dependencies:** T-4.3 (recovery transitions), T-4.2 (KillSwitch events)
- **Tests:** Tests spy on `emitRoutingStateTransition` and `emitRoutingOverride` functions directly (not `console.*`). Verify structured payload shape and transition correctness.

### Task Dependencies

```
T-4.1 (parallel — no deps)
T-4.2 (parallel — no deps)
T-4.3 (parallel — no deps)
T-4.4 (parallel — no deps)
T-4.5 (parallel — no deps)
T-4.6 (depends on T-4.2, T-4.3 for KillSwitch/recovery transition events)
```

### Sprint 4 Success Criteria

1. `GoodhartResult.scoredPools` contains actual per-pool scores (not empty array)
2. `finn_killswitch_check_failed` counter visible in `/metrics`
3. `init_failed` state recovers automatically within 60s of Redis becoming available
4. Fresh deploy without `FINN_REPUTATION_ROUTING` defaults to `disabled` (not shadow)
5. Symbol properties pass through Proxy wrappers without throwing
6. All routing state transitions emitted as structured JSON events
7. All existing tests pass (zero regression)

---

## Sprint 5: Staging-Blocking Fixes (Before Activation)

**Goal:** Fix all issues that would prevent staging from functioning correctly. These are blocking bugs — staging cannot safely accept traffic until resolved.

**Source:** [Unbounded Depth Review PR #109](https://github.com/0xHoneyJar/loa-finn/pull/109)

**Risk:** Medium — core metrics and recovery fixes touch critical code paths. All changes are surgical with focused test coverage.

### Tasks

#### T-5.1: Fix Histogram Double-Accumulation (C-1)
- **Description:** `graduation-metrics.ts:112-119` — the `observe()` method increments the +Inf bucket unconditionally (line 118) and `toPrometheus()` at line 138 re-accumulates cumulatively. This produces inflated histogram values in Prometheus output. Fix by making `observe()` only increment the first matching bucket and +Inf, then computing cumulative sums only in `toPrometheus()`.
- **Acceptance Criteria:**
  - AC1: `observe(0.5)` with boundaries `[0.1, 0.5, 1.0]` increments bucket `le=0.5` count by 1 and `+Inf` by 1 — not `le=0.1`
  - AC2: `toPrometheus()` output shows correct cumulative counts matching Prometheus histogram spec
  - AC3: Existing metrics tests updated to assert exact bucket values after multiple observations
  - AC4: No double-counting: N observations = N total count in `+Inf` bucket
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update `tests/finn/goodhart/graduation-metrics.test.ts` with multi-observation histogram assertions

#### T-5.2: Fix Recovery Scheduler → Router Disconnect (C-2)
- **Description:** `index.ts:355-363` — recovery callback updates local closure variables (`goodhartConfig`, `routingState`, `goodhartMetrics`) but HounfourRouter was initialized with the *old* values and never receives updates. Fix by having the recovery callback update the `GoodhartRuntime` mutable holder (from T-4.3) which the router already reads from.
- **Acceptance Criteria:**
  - AC1: Recovery callback writes to the shared `GoodhartRuntime` holder, not local variables
  - AC2: Router reads `routingState` and `goodhartConfig` from the holder on each request (not cached at construction)
  - AC3: Integration test: init fails → `init_failed` state → Redis becomes available → recovery fires → next request uses recovered config
  - AC4: No stale references — `grep` for direct assignment to module-level `goodhartConfig =` or `routingState =` in the recovery path returns 0 matches (only holder updates)
- **Effort:** Medium
- **Dependencies:** T-4.3 (GoodhartRuntime holder pattern)
- **Tests:** `tests/finn/goodhart/init-recovery.test.ts` — add test asserting router behavior changes after recovery

#### T-5.3: Fix ECS Health Check (C-5)
- **Description:** `loa-finn-ecs.tf:215` — ECS container health check uses `curl -f` but `curl` is not installed in the production Docker image (multi-stage build strips it). Replace with `wget` (available in Alpine/Debian slim) or Node.js HTTP check.
- **Acceptance Criteria:**
  - AC1: Health check command uses tool available in the Docker image (verify via `docker run --rm <image> which wget` or equivalent)
  - AC2: Health check correctly detects unhealthy state (non-200 response → exit 1)
  - AC3: `startPeriod` remains ≥60s to allow for cold start
  - AC4: Terraform plan shows only health check change, no resource recreation
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `terraform plan` shows health check update only; manual Docker verification

#### T-5.4: Align KillSwitch Key Between Code, Runbook, and Sprint 1 Contract (H-1)
- **Description:** There is a three-way mismatch: Sprint 1 T-1.6 defines the KillSwitch contract as `finn:killswitch:mode` with `"kill"/"normal"` values. The runbook at `docs/graduation-runbook.md:126-131` documents `finn:killswitch:mode`. But the current router implementation may use a different key. This task first verifies the actual implementation, then aligns all three (code, runbook, contract) to a single source of truth.
- **Pre-step:** `grep -rn "killswitch\|kill_switch\|killSwitch" src/hounfour/` to identify the exact key, value, and Redis command used in the implementation. Document findings before making changes.
- **Acceptance Criteria:**
  - AC1: Single source of truth established — code uses `finn:killswitch:mode` with values `"kill"` (force-disable) and `"normal"` (default), matching the T-1.6 contract
  - AC2: If code uses a different key (e.g., `finn:config:reputation_routing`), update the implementation to match the T-1.6 contract. The KillSwitch is a separate mechanism from the routing mode env var — they must be independent controls.
  - AC3: Runbook updated to match the verified implementation: correct key, correct values, correct Redis command
  - AC4: Tests updated to verify the canonical key name and both values
  - AC5: All three rollback tiers documented: (1) Redis KillSwitch `SET finn:killswitch:mode kill` — instant, (2) SSM `FINN_REPUTATION_ROUTING=disabled` — ~5min redeploy, (3) Revert deploy
- **Effort:** Small-Medium
- **Dependencies:** None
- **Tests:** Integration test: set killswitch key → routing uses deterministic; clear key → routing resumes state machine

#### T-5.5: Fix Shadow Metrics Double-Count (H-6)
- **Description:** `router.ts:364` calls `recordShadowDecision()` and the same metric is also incremented inside `mechanism-interaction.ts:108` during the Goodhart resolve path. This double-counts every shadow decision.
- **Acceptance Criteria:**
  - AC1: Shadow decision metric is incremented exactly once per routing request in shadow mode
  - AC2: Choose canonical location: either router (after the full shadow comparison) or mechanism-interaction (during resolution) — not both
  - AC3: Test asserts `finn_shadow_total` counter == request count after N shadow requests
  - AC4: `finn_shadow_diverged` counter is only incremented in the comparison site (router), not in mechanism-interaction
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update routing-state and mechanism-interaction tests to verify single-increment

#### T-5.6: Add Missing Goodhart SSM Parameters (M-5)
- **Description:** ECS task definition in Terraform is missing SSM parameter references for `FINN_REPUTATION_ROUTING`, `FINN_REDIS_PREFIX`, `FINN_REDIS_DB`, `FINN_GOODHART_EPSILON`, and `FINN_CALIBRATION_HMAC_KEY`. Without these, staging uses env defaults instead of SSM-managed values.
- **Acceptance Criteria:**
  - AC1: ECS task definition includes `valueFrom` SSM references for all Goodhart env vars
  - AC2: SSM paths scoped to `/loa-finn/${var.environment}/*`
  - AC3: `terraform plan` shows container definition update with new environment entries
  - AC4: `deploy/staging.env.example` updated with comments explaining SSM source
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `terraform plan` output review; staging env var verification post-deploy

#### T-5.7: Fix armitage.tfvars Missing Variables (M-12)
- **Description:** `infrastructure/terraform/environments/armitage.tfvars` is missing several variables that have been added since Sprint 3: Goodhart-specific settings, S3 bucket environment scoping, Redis prefix config.
- **Acceptance Criteria:**
  - AC1: `armitage.tfvars` includes `reputation_routing = "shadow"` (explicit, not default)
  - AC2: `armitage.tfvars` includes `redis_prefix = "armitage:"` and `redis_db = 1`
  - AC3: `armitage.tfvars` includes environment-scoped S3 bucket names (linking to T-6.4)
  - AC4: `terraform plan -var-file=environments/armitage.tfvars` succeeds with no variable warnings
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `terraform validate` and `terraform plan` pass

### Sprint 5 Task Dependencies

```
T-5.1 (parallel — no deps)
T-5.2 (depends on T-4.3 from Sprint 4)
T-5.3 (parallel — no deps)
T-5.4 (parallel — no deps)
T-5.5 (parallel — no deps)
T-5.6 (parallel — no deps)
T-5.7 (parallel — no deps)
```

### Sprint 5 Success Criteria

1. Histogram `+Inf` count equals total observations (no inflation)
2. Recovery scheduler updates propagate to router (integration test passes)
3. ECS health check works in Docker image without `curl`
4. Runbook emergency commands match actual implementation
5. Shadow metrics increment exactly once per request
6. All Goodhart SSM parameters present in Terraform
7. `terraform plan -var-file=environments/armitage.tfvars` clean

---

## Sprint 6: Shadow Traffic Safety (Before First Shadow Traffic)

**Goal:** Fix data isolation, timer leaks, security issues, and supply chain risks that must be resolved before shadow traffic flows through the Goodhart stack.

**Source:** [Unbounded Depth Review PR #109](https://github.com/0xHoneyJar/loa-finn/pull/109)

**Risk:** Medium-High — the `eval` bypass (T-6.1) is a data isolation bug that could corrupt production Redis if staging shares the same instance.

### Tasks

#### T-6.1: Fix eval/evalsha Prefix Bypass (C-3)
- **Description:** `prefixed-redis.ts` — Lua scripts via `eval`/`evalsha` fall through to the pass-through branch of the Proxy, bypassing the prefix enforcement entirely. Any Goodhart component that uses Lua scripting (e.g., `temporal-decay.ts:55`) writes unprefixed keys to Redis, violating staging/production isolation on shared Redis instances.
- **Acceptance Criteria:**
  - AC1: `eval` and `evalsha` are explicitly handled in the Proxy: either blocked with descriptive error, or key arguments are prefixed (KEYS array at positions defined by `numkeys`)
  - AC2: Test verifies that `client.eval("return 1", 1, "foo")` either throws or produces `eval("return 1", 1, "armitage:foo")`
  - AC3: `temporal-decay.ts` Lua scripts use prefixed keys (verify with grep for raw key access patterns)
  - AC4: No unprefixed Redis writes possible through any PrefixedRedisClient method
- **Effort:** Medium
- **Dependencies:** None
- **Tests:** `tests/finn/infra/prefixed-redis.test.ts` — add eval/evalsha test cases

#### T-6.2: Fix Per-Pool Timeout Timer Leak (C-4)
- **Description:** `mechanism-interaction.ts:269-273` — `Promise.race` between pool scoring and a `setTimeout` timer. When scoring completes first, the timer is never cleared. At 5 concurrent pools per request × request rate, this leaks timers.
- **Acceptance Criteria:**
  - AC1: `setTimeout` timer is cleared via `clearTimeout()` when the scoring promise resolves first
  - AC2: Pattern uses AbortController or explicit cleanup wrapper (not bare `setTimeout`)
  - AC3: Test with fake timers verifies no pending timers after successful scoring
  - AC4: `Promise.race` cleanup pattern applied consistently (verify no other instances in codebase via grep)
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/mechanism-interaction.test.ts` — fake timer test for cleanup

#### T-6.3: Pin GitHub Actions to SHA (H-2)
- **Description:** `deploy-staging.yml` uses unpinned `@v4`, `@v2`, `@v1` action tags at lines 43, 46, 73, 76, 83, 134, 141. Pin all actions to exact commit SHAs per supply chain security best practice.
- **Acceptance Criteria:**
  - AC1: All `uses:` entries in `deploy-staging.yml` reference exact commit SHA (e.g., `actions/checkout@a81bbbf8298c...`)
  - AC2: Comment after SHA identifies the version tag for readability (e.g., `# v4.1.7`)
  - AC3: Check other workflow files (`deploy.yml`, `e2e*.yml`) and pin those too if unpinned
  - AC4: `actionlint` or manual review passes
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Grep for `@v[0-9]` in `.github/workflows/` returns 0 matches

#### T-6.4: Scope S3 Buckets by Environment (H-4)
- **Description:** `loa-finn-s3.tf:10,56` — S3 bucket names don't include environment. Staging and production would use the same buckets.
- **Design Decision:** Use conditional bucket naming: production (default workspace) keeps existing bucket names exactly unchanged; non-default workspaces append `-${var.environment}`. This avoids forced replacement of production buckets.
- **Acceptance Criteria:**
  - AC1: Bucket name uses conditional: `terraform.workspace == "default" ? "finn-audit-anchors-${data.aws_caller_identity.current.account_id}" : "finn-audit-anchors-${var.environment}-${data.aws_caller_identity.current.account_id}"`
  - AC2: Same conditional pattern for calibration bucket
  - AC3: `terraform plan` in **default workspace** shows **zero changes** (production buckets untouched, names unchanged)
  - AC4: `terraform plan` in **armitage workspace** shows new staging buckets with `-armitage` suffix
  - AC5: IAM policies use conditional ARNs matching the bucket name pattern
  - AC6: No `moved` or `import` blocks needed — production resources are not renamed
- **Effort:** Medium
- **Dependencies:** T-5.7 (armitage.tfvars)
- **Tests:** `terraform plan` in default workspace = 0 changes; `terraform plan -var-file=environments/armitage.tfvars` in armitage workspace shows correctly named staging buckets

#### T-6.5: Await Redis select() (H-5)
- **Description:** `prefixed-redis.ts:40-41` — `select(dbIndex)` is called without `await`. The returned Promise is discarded, so DB selection may not complete before subsequent commands, causing them to run on the wrong DB.
- **Design Decision:** Introduce `createPrefixedRedisClient(redis, prefix, dbIndex)` async factory function. Keep the Proxy construction synchronous internally, but gate it behind the async factory that awaits `select()` before returning the client.
- **Acceptance Criteria:**
  - AC1: New `createPrefixedRedisClient()` async factory exported; constructor marked private/internal
  - AC2: Factory awaits `select(dbIndex)` before returning the proxied client
  - AC3: All instantiation call sites updated: `index.ts` and `init.ts` Goodhart init blocks `await createPrefixedRedisClient(...)` instead of `new PrefixedRedisClient(...)`
  - AC4: All test files updated to use async factory
  - AC5: Test verifies `select()` is called and awaited before first command (spy on select, assert call order)
- **Effort:** Small-Medium
- **Dependencies:** None
- **Tests:** Update `tests/finn/infra/prefixed-redis.test.ts` and all instantiation sites

#### T-6.6: Add Metrics Endpoint Authentication (H-3)
- **Description:** The Prometheus `/metrics` endpoint is unauthenticated, exposing internal system state. Implement app-level bearer token authentication using `FINN_METRICS_BEARER_TOKEN` from SSM.
- **Acceptance Criteria:**
  - AC1: `/metrics` requires `Authorization: Bearer <token>` header; token sourced from `FINN_METRICS_BEARER_TOKEN` env var (SSM-managed)
  - AC2: Missing or invalid token returns HTTP 401 with `{"error": "unauthorized"}`
  - AC3: Valid token returns Prometheus metrics output (200)
  - AC4: Health endpoint (`/health`) remains unauthenticated (ALB needs it)
  - AC5: Prometheus scrape config documented: `authorization: { credentials: <token> }` in `prometheus.yml`
  - AC6: SSM parameter `/loa-finn/${var.environment}/FINN_METRICS_BEARER_TOKEN` added to Terraform ECS task definition
- **Effort:** Small-Medium
- **Dependencies:** None
- **Tests:** Supertest integration tests: unauthenticated → 401, valid bearer → 200, invalid bearer → 401, `/health` → 200 without auth

#### T-6.7: Fix Package Manager Mismatch (H-7)
- **Description:** `deploy-staging.yml` uses `npm ci` but Dockerfile and `pnpm-lock.yaml` use `pnpm`. This installs different dependency versions in CI vs Docker, potentially masking bugs.
- **Acceptance Criteria:**
  - AC1: CI workflow uses `pnpm install --frozen-lockfile` instead of `npm ci`
  - AC2: pnpm setup step added to workflow (e.g., `pnpm/action-setup@v4`)
  - AC3: Verify `package-lock.json` doesn't exist (or remove it) — single lock file
  - AC4: All workflow files use consistent package manager
- **Effort:** Small
- **Dependencies:** None
- **Tests:** CI workflow passes with pnpm; no `package-lock.json` in repo

#### T-6.8: Fix DEL Command Duplication (M-8)
- **Description:** `prefixed-redis.ts` — `del` appears in both `SINGLE_KEY_COMMANDS` (line 11) and `MULTI_KEY_COMMANDS` (line 21). The Proxy checks single-key first, so multi-key `del("a", "b", "c")` only prefixes the first argument.
- **Acceptance Criteria:**
  - AC1: `del` removed from `SINGLE_KEY_COMMANDS` (it's a multi-key command: `DEL key [key ...]`)
  - AC2: Multi-key `del("a", "b")` correctly prefixes all arguments
  - AC3: Test verifies `del("a", "b")` becomes `del("prefix:a", "prefix:b")`
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update `tests/finn/infra/prefixed-redis.test.ts` with multi-key DEL test

#### T-6.9: Terraform Backend Workspace Isolation (M-11)
- **Description:** Terraform backend configuration should use workspace-keyed state to prevent accidental state collision between production and staging.
- **Acceptance Criteria:**
  - AC1: Backend config uses workspace-prefixed key (e.g., `key = "loa-finn/${terraform.workspace}/terraform.tfstate"` or equivalent)
  - AC2: Production state untouched (verify via `terraform state list` in default workspace)
  - AC3: Staging state is isolated — `terraform destroy` in armitage workspace cannot affect production
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `terraform workspace select armitage && terraform state list` shows only staging resources

### Sprint 6 Task Dependencies

```
T-6.1 (parallel — no deps)
T-6.2 (parallel — no deps)
T-6.3 (parallel — no deps)
T-6.4 (depends on T-5.7 for armitage.tfvars)
T-6.5 (parallel — no deps)
T-6.6 (parallel — no deps)
T-6.7 (parallel — no deps)
T-6.8 (parallel — no deps)
T-6.9 (parallel — no deps)
```

### Sprint 6 Success Criteria

1. No unprefixed Redis writes possible through PrefixedRedisClient (including eval/evalsha)
2. Zero timer leaks in pool scoring (fake timer test passes)
3. All GitHub Actions pinned to exact SHA
4. S3 buckets environment-scoped; production unchanged
5. Redis DB selection completes before first command
6. `/metrics` endpoint authenticated
7. CI uses pnpm consistently
8. Multi-key `del` prefixes all arguments
9. Terraform state workspace-isolated

---

## Sprint 7: Excellence & Test Coverage (Before Graduation)

**Goal:** Address all remaining MEDIUM and LOW findings. Fill critical test coverage gaps across 13 source files. Achieve graduation-ready code quality.

**Source:** [Unbounded Depth Review PR #109](https://github.com/0xHoneyJar/loa-finn/pull/109)

**Risk:** Low — all changes are additive (tests, type safety, cleanup). No architectural changes.

### Tasks

#### T-7.1: Fix ReadOnlyRedis Blocked Method Return Type (M-1)
- **Description:** `read-only-redis.ts` — blocked methods (set, del, etc.) throw synchronously, but Redis client methods return Promises. Callers using `.catch()` or `await` won't catch synchronous throws properly. Change to return rejected Promises.
- **Acceptance Criteria:**
  - AC1: All blocked methods return `Promise.reject(new Error(...))` instead of `throw`
  - AC2: `await client.set("key", "val")` catches with standard async error handling
  - AC3: Error messages unchanged: `"Redis writes blocked in shadow mode (attempted: <method>)"`
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update `tests/finn/goodhart/read-only-redis.test.ts` — test both `await` and `.catch()` patterns

#### T-7.2: Fix Mutable let Exports in routing-events.ts (M-2)
- **Description:** `routing-events.ts:29-30,50-51` — `export let` functions break when re-assigned because ES module imports cache the original binding. Refactor to use a setter/getter pattern or injectable dependency.
- **Acceptance Criteria:**
  - AC1: Event emitters are no longer mutable `let` exports
  - AC2: Test injection still works (via `setRoutingStateTransitionEmitter()` or equivalent)
  - AC3: Runtime reassignment in one module propagates to all importers
  - AC4: TypeScript build passes; no `any` escapes
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update `tests/finn/goodhart/routing-events.test.ts`

#### T-7.3: Consolidate Duplicate RoutingState Type (M-3)
- **Description:** `RoutingState` type is defined in `routing-events.ts:6`, `init.ts`, `router.ts`, and `index.ts` without coordination. Consolidate to a single canonical export.
- **Acceptance Criteria:**
  - AC1: Single `RoutingState` type definition in `src/hounfour/goodhart/types.ts` (or appropriate shared module)
  - AC2: All files import from the canonical source — `grep 'type RoutingState' src/` returns exactly 1 definition
  - AC3: TypeScript build passes with no type errors
- **Effort:** Small
- **Dependencies:** None
- **Tests:** TypeScript compilation; grep verification

#### T-7.4: Fix computeEventHash Collision (M-4)
- **Description:** `mechanism-interaction.ts` — event hash computed by concatenating fields without delimiters. `hash("ab" + "c")` === `hash("a" + "bc")`. Add delimiters between fields.
- **Acceptance Criteria:**
  - AC1: Hash computation includes a delimiter character (e.g., `\0` or `|`) between concatenated fields
  - AC2: `computeEventHash("ab", "c") !== computeEventHash("a", "bc")`
  - AC3: Existing hash-dependent tests updated if hash values change
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/mechanism-interaction.test.ts` — collision resistance test

#### T-7.5: Remove Unused options.seed / options.allowWrites (M-6)
- **Description:** `resolve.ts` accepts `options.seed` and `options.allowWrites` in the function signature but never passes them to internal components. Either wire them through or remove from the interface.
- **Acceptance Criteria:**
  - AC1: `seed` is passed to PRNG for deterministic shadow mode (if useful) OR removed from `GoodhartOptions`
  - AC2: `allowWrites` gates Redis writes in enabled mode OR removed from `GoodhartOptions`
  - AC3: No dead parameters in the public API
  - AC4: TypeScript build passes
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Update resolve.test.ts to test wired-through options or verify removal

#### T-7.6: Remove Unsafe `as any` Casts (M-7)
- **Description:** `init.ts:56` and `init.ts:107` use `as any` casts for Redis client and routing state. Replace with proper type narrowing or generic constraints.
- **Acceptance Criteria:**
  - AC1: Zero `as any` in `init.ts`
  - AC2: Redis client typed as `RedisCommandClient` or appropriate interface
  - AC3: Routing state typed as `RoutingState` (from T-7.3 canonical source)
  - AC4: TypeScript build passes in strict mode
- **Effort:** Small
- **Dependencies:** T-7.3 (consolidated RoutingState)
- **Tests:** TypeScript compilation with `--strict`

#### T-7.7: Unref CalibrationEngine pollTimer (M-9)
- **Description:** `CalibrationEngine` creates a recurring `setInterval` for calibration data refresh. This timer prevents Node.js from exiting cleanly. Add `.unref()`.
- **Acceptance Criteria:**
  - AC1: `setInterval` timer has `.unref()` called
  - AC2: Process exits cleanly when all other work is complete (timer doesn't keep it alive)
  - AC3: `stop()` method clears the timer
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** Verify with fake timers

#### T-7.8: Deduplicate init.ts / index.ts Goodhart Init (M-10)
- **Description:** `index.ts:200-370` contains a 160+ line Goodhart init block that substantially duplicates `init.ts:43-116`. Refactor so `index.ts` calls `initGoodhartStack()` from `init.ts` and the duplicated inline code is removed.
- **Acceptance Criteria:**
  - AC1: `src/index.ts` Goodhart section reduced to <20 lines calling `initGoodhartStack()`
  - AC2: All Goodhart init logic lives in `src/hounfour/goodhart/init.ts`
  - AC3: Existing behavior unchanged (all routing states still work)
  - AC4: No duplicate variable declarations for Goodhart components
- **Effort:** Medium
- **Dependencies:** T-5.2 (recovery-router fix already touches this area)
- **Tests:** Existing init tests pass; integration test covers the deduplication

#### T-7.9: Router Integration Test Suite (78 test gaps — highest priority)
- **Description:** `router.ts` has ZERO direct test coverage for `resolvePoolForRequest()` — the most critical function in the codebase. Create a comprehensive integration test suite covering the 4-state routing machine, KillSwitch override, shadow divergence logging, and fallback behavior.
- **Acceptance Criteria:**
  - AC1: `tests/finn/hounfour/router.test.ts` exists with ≥20 test cases
  - AC2: All 4 routing states tested: `disabled`, `shadow`, `enabled`, `init_failed`
  - AC3: KillSwitch override tested: `"kill"` → deterministic, `"normal"` → state machine, missing key → default
  - AC4: Shadow path tested: divergence detection, metrics increment, deterministic result returned
  - AC5: Enabled path tested: reputation result used, fallback on null
  - AC6: Edge cases: concurrent requests, Redis timeout during KillSwitch check, all pools failed
  - AC7: Coverage for `resolvePoolForRequest()` ≥80%
- **Effort:** Large
- **Dependencies:** T-5.5 (shadow metrics deduplication — affects assertion values)
- **Tests:** Self-contained test file

#### T-7.10: Mechanism-Interaction Test Suite Expansion
- **Description:** `mechanism-interaction.ts` has 354 lines with partial test coverage. Expand tests to cover the precedence chain (Kill switch → Exploration → Reputation → Deterministic fallback), partial failures, and concurrent scoring edge cases.
- **Acceptance Criteria:**
  - AC1: Precedence chain tested: KillSwitch active → skip all; Exploration fires → use exploration; Reputation scores → use reputation; All fail → deterministic
  - AC2: Partial scoring failure: 3 of 5 pools score, 2 timeout → result uses 3 scored pools
  - AC3: Event hash uniqueness test (after T-7.4 delimiter fix)
  - AC4: Coverage ≥80% for mechanism-interaction.ts
- **Effort:** Medium
- **Dependencies:** T-6.2 (timer leak fix), T-7.4 (hash collision fix)
- **Tests:** Expand `tests/finn/goodhart/mechanism-interaction.test.ts`

#### T-7.11: PrefixedRedis + ReadOnlyRedis Full Test Coverage
- **Description:** `read-only-redis.ts` tests only 3 of 7 read methods and 1 of 5 bypass vectors. `prefixed-redis.ts` lacks eval/evalsha and multi-key DEL tests (added in Sprint 6 but need comprehensive suite).
- **Acceptance Criteria:**
  - AC1: All 7 read methods tested: `get`, `mget`, `hget`, `hgetall`, `exists`, `ttl`, `type`
  - AC2: All 5 bypass vectors tested: `multi`, `pipeline`, `sendCommand`, `eval`, `evalsha`
  - AC3: All mutating methods tested: `set`, `del`, `incr`, `hset`, `lpush`, `rpush`, `sadd`, etc.
  - AC4: Symbol property pass-through tested (from T-4.5)
  - AC5: Coverage ≥90% for both files
- **Effort:** Medium
- **Dependencies:** T-6.1 (eval fix), T-6.5 (select fix), T-6.8 (DEL fix)
- **Tests:** Expand both test files

#### T-7.12: Add Container Vulnerability Scanning to CI
- **Description:** `deploy-staging.yml` builds and pushes Docker images without vulnerability scanning. Add a scan step between build and push.
- **Acceptance Criteria:**
  - AC1: `docker scout` or `trivy` scan step added after Docker build, before ECR push
  - AC2: HIGH/CRITICAL CVEs fail the workflow (configurable threshold)
  - AC3: Scan results uploaded as workflow artifact for review
  - AC4: Existing deploy.yml also updated with scan step
- **Effort:** Small
- **Dependencies:** T-6.3 (pinned actions — scan action should also be pinned)
- **Tests:** CI workflow passes with scan step

### Sprint 7 Task Dependencies

```
T-7.1 (parallel — no deps)
T-7.2 (parallel — no deps)
T-7.3 (parallel — no deps)
T-7.4 (parallel — no deps)
T-7.5 (parallel — no deps)
T-7.6 (depends on T-7.3 for RoutingState type)
T-7.7 (parallel — no deps)
T-7.8 (depends on T-5.2 for recovery fix area)
T-7.9 (depends on T-5.5 for metrics dedup)
T-7.10 (depends on T-6.2 timer fix, T-7.4 hash fix)
T-7.11 (depends on T-6.1, T-6.5, T-6.8 from Sprint 6)
T-7.12 (depends on T-6.3 for pinned actions)
```

### Sprint 7 Success Criteria

1. Zero `as any` casts in Goodhart stack
2. Single canonical `RoutingState` type definition
3. No timer leaks, no memory leaks, no event hash collisions
4. `router.ts:resolvePoolForRequest()` coverage ≥80%
5. `mechanism-interaction.ts` coverage ≥80%
6. `read-only-redis.ts` and `prefixed-redis.ts` coverage ≥90%
7. All blocked Redis methods return rejected Promises
8. Container vulnerability scanning in CI
9. Zero duplicate code between index.ts and init.ts for Goodhart initialization
10. All existing tests pass (zero regression)

---

## Sprint 8: Pre-Merge Polish & CI Fixes

**Goal:** Address all remaining MEDIUM and LOW findings from the Unbounded Depth Review. Fix failing CI checks. Prepare PR #109 for merge.

**Source:** [Unbounded Depth Review PR #109](https://github.com/0xHoneyJar/loa-finn/pull/109), [Sprint Response](https://github.com/0xHoneyJar/loa-finn/pull/109#issuecomment-3968754028)

**Risk:** Low — all changes are small, surgical, non-architectural. No new patterns introduced.

**Note:** Verification confirmed M-6, M-10, L-10, L-11 are already fixed. This sprint addresses the 10 remaining items plus the misleading comment.

### Tasks

#### T-8.1: Validate Epsilon Against NaN/Infinity (M-4)
- **Description:** `exploration.ts:61` — `const epsilon = this.config.epsilonByTier[tier] ?? this.config.defaultEpsilon` does not validate epsilon is a finite number. NaN or Infinity epsilon silently disables or corrupts the Bernoulli coin flip at line 65.
- **Acceptance Criteria:**
  - AC1: After epsilon lookup, validate with `Number.isFinite(epsilon)` — if invalid, log warning and fall through to reputation scoring (safe default: don't explore with broken config)
  - AC2: Same validation for cost comparison at lines 83-84 (L-5): `if (!Number.isFinite(cost)) continue` before the cost ceiling check
  - AC3: Test with NaN epsilon → no exploration, falls through to reputation
  - AC4: Test with Infinity cost → candidate filtered out
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/exploration.test.ts` — NaN epsilon, Infinity epsilon, NaN cost, Infinity cost

#### T-8.2: Remove DynamoDB DeleteItem from Audit Trail IAM (M-9)
- **Description:** `infrastructure/terraform/loa-finn-kms.tf:70-76` — IAM policy includes `dynamodb:DeleteItem` on the audit trail table (`finn_scoring_path_log`, `finn_x402_settlements`). Audit trails must be append-only; the application should never delete records.
- **Acceptance Criteria:**
  - AC1: `dynamodb:DeleteItem` removed from the DynamoDBAccess IAM statement for audit tables
  - AC2: If `DeleteItem` is needed for non-audit tables (e.g., session data), create a separate IAM statement scoped only to those tables
  - AC3: `terraform plan` shows only IAM policy change, no resource recreation
  - AC4: Application code has no `DeleteItem` calls on audit tables (verify with grep)
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `terraform plan` review; grep verification

#### T-8.3: Replace readFileSync with Embedded Lua String (L-2)
- **Description:** `temporal-decay.ts:50` — `readFileSync(join(dir, "lua", "ema-update.lua"), "utf-8")` blocks the event loop during construction. The Lua script is static and small — embed it as a template literal instead of reading from disk.
- **Pre-step:** Run `grep -rn "ema-update.lua" .` to verify no other consumers (build scripts, tests, Docker COPY, docs, or runtime packaging) reference the file before deletion. If references exist, update or remove them in the same task.
- **Acceptance Criteria:**
  - AC1: Lua script content inlined as a `const EMA_UPDATE_LUA = \`...\`` string in temporal-decay.ts
  - AC2: No `readFileSync` calls in any Goodhart component
  - AC3: Existing EMA tests pass unchanged (the Lua content is identical)
  - AC4: `grep -rn "ema-update.lua" .` returns 0 matches (all references removed/updated)
  - AC5: Remove the `lua/ema-update.lua` file only after AC4 is confirmed; if references cannot be safely removed, keep the file but still inline the content
  - AC6: CI build and all tests pass after deletion
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Existing temporal-decay tests pass; grep for `readFileSync` in `src/hounfour/` returns 0 matches; grep for `ema-update.lua` returns 0 matches

#### T-8.4: Make Exploration Randomness Observable (L-3)
- **Description:** `exploration.ts:102` — `Math.floor(Math.random() * candidates.length)` is unobservable. Make the random index selection injectable (via optional config callback) for testing and debugging.
- **Acceptance Criteria:**
  - AC1: `ExplorationConfig` accepts optional `randomFn?: () => number` (defaults to `Math.random`)
  - AC2: Both random calls (line 62 Bernoulli flip, line 102 candidate selection) use the injected function
  - AC3: Tests can inject deterministic random for reproducibility
  - AC4: No behavior change when `randomFn` is not provided
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/exploration.test.ts` — inject deterministic random, verify exact candidate selection

#### T-8.5: Strict ISO 8601 Date-Time Validation (L-4)
- **Description:** `reputation-response.ts:59` — `!isNaN(Date.parse(obj.asOfTimestamp))` accepts nonsensical inputs like `Date.parse("1")`. Replace with strict RFC 3339 / ISO 8601 date-time regex validation.
- **Pre-step:** Grep all callers of the validation function to enumerate which timestamp formats are actually used in tests and production. Expected: all timestamps are full RFC 3339 (`YYYY-MM-DDTHH:mm:ss.sssZ` or `YYYY-MM-DDTHH:mm:ss±HH:MM`).
- **Acceptance Criteria:**
  - AC1: Timestamp validation uses fully-anchored RFC 3339 regex: `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/`
  - AC2: Explicit test vectors — **accepted**: `"2026-02-27T12:00:00Z"`, `"2026-02-27T12:00:00.123Z"`, `"2026-02-27T12:00:00+05:30"` — **rejected**: `"1"`, `"abc"`, `"2026"`, `"2026-02-27"`, `"12:00:00Z"`
  - AC3: Existing valid timestamps in tests still pass (verify no false rejections before deploying the stricter check)
  - AC4: If any existing test uses a non-RFC3339 format, update the test data (not the validation)
- **Effort:** Small
- **Dependencies:** None
- **Tests:** `tests/finn/goodhart/reputation-response.test.ts` (or add new test file) — comprehensive date validation vectors

#### T-8.6: Remove Unnecessary Async from loadFromLocal (L-7)
- **Description:** `calibration.ts:87-92` — `async loadFromLocal(content: string): Promise<void>` contains no `await`. Remove `async` keyword to clarify the synchronous nature of the method.
- **Acceptance Criteria:**
  - AC1: Method signature changed to `loadFromLocal(content: string): void`
  - AC2: All call sites updated if they `await` the result (should be fine — awaiting a non-Promise is a no-op, but verify)
  - AC3: TypeScript build passes
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** Existing calibration tests pass

#### T-8.7: Remove Dead DNS Pre-Warming (L-8)
- **Description:** `dixie-transport.ts:160-167` — `warmDns()` caches the resolved address in `this.resolvedAddress` but `fetch()` at line 124 never uses it. Remove the dead code path.
- **Acceptance Criteria:**
  - AC1: `warmDns()` method removed
  - AC2: `this.resolvedAddress` property removed
  - AC3: Constructor no longer calls `warmDns()` on init
  - AC4: If DNS pre-warming is actually desired, file a follow-up issue for proper implementation (use resolved IP in fetch URL)
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** Existing transport tests pass; no behavior change since the feature was non-functional

#### T-8.8: Fix staging.env.example Legacy Alias Reference (L-9)
- **Description:** `deploy/staging.env.example:18` mentions `ROUTING_MODE` as a "legacy alias" but no code handles that alias. Remove the misleading reference.
- **Acceptance Criteria:**
  - AC1: Comment on line 18 removed or rewritten to reference only `FINN_REPUTATION_ROUTING`
  - AC2: Grep for `ROUTING_MODE` in `src/` returns 0 matches (confirm no alias handling exists)
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** Grep verification

#### T-8.9: Fix resolve.ts Header Comment (L-10)
- **Description:** `resolve.ts:5` says "AbortController.timeout()" but the implementation uses `setTimeout` with manual `controller.abort()`. The implementation is correct (broader Node.js version compatibility); the comment is misleading.
- **Acceptance Criteria:**
  - AC1: Header comment updated to accurately describe the timeout mechanism: "200ms hard ceiling via setTimeout + AbortController.abort()"
- **Effort:** Tiny
- **Dependencies:** None
- **Tests:** None needed (comment-only change)

#### T-8.10: Add Checksum Verification for beads_rust Binary (L-12)
- **Description:** `deploy/Dockerfile:30` downloads beads_rust binary via `curl -sSL https://github.com/Dicklesworthstone/beads_rust/releases/latest/download/br-linux-amd64` without checksum verification. A supply chain attack could inject a malicious binary. Build targets **linux/amd64 only** (single-arch). The base image `node:22-slim` (Debian bookworm) has `coreutils` with `sha256sum` available by default.
- **Pre-step:** Visit the beads_rust GitHub releases page to identify the current latest version tag and compute `sha256sum` of the downloaded binary locally: `curl -sSL <pinned-url> | sha256sum`
- **Acceptance Criteria:**
  - AC1: Pin download URL to a specific release version (e.g., `https://github.com/Dicklesworthstone/beads_rust/releases/download/v0.1.7/br-linux-amd64`) — no `latest` tag
  - AC2: Store checksum as `ARG BR_SHA256=<hash>` in Dockerfile with inline comment referencing the release version and upstream artifact page
  - AC3: Verification step: `echo "${BR_SHA256}  /usr/local/bin/br" | sha256sum --check --strict` immediately after download
  - AC4: If checksum fails, Docker build fails (not silent degradation — `set -e` in the RUN chain ensures this)
  - AC5: Confirm `sha256sum` exists in build stage: `node:22-slim` (Debian bookworm) ships `coreutils` — verify with `docker run --rm node:22-slim which sha256sum`
- **Effort:** Small
- **Dependencies:** None
- **Tests:** Docker build succeeds with correct binary; tamper test (wrong checksum → build fails)

#### T-8.11: Investigate and Fix CI Secret Scanning Failure
- **Description:** PR #109 has a failing "Scan for Secrets" check. The scanner workflow is `.github/workflows/secret-scanning.yml` which runs **TruffleHog v3.93.0** (primary, always active, uses `--only-verified` flag) and **GitLeaks v2.3.9** (secondary, only runs if `GITLEAKS_LICENSE` secret is configured). TruffleHog scans the diff between default branch and HEAD with `fetch-depth: 0` (full history).
- **Pre-step:** Reproduce locally: `docker run --rm -v "$(pwd):/repo" trufflesecurity/trufflehog:v3.93.0 filesystem /repo --only-verified` to identify exactly what was flagged. Also check the GitHub Actions run logs for the specific failing step output.
- **Acceptance Criteria:**
  - AC1: Identify the exact failing step (TruffleHog or GitLeaks) from the CI run logs and what string/pattern was flagged
  - AC2: **If true positive** (real secret in code or git history):
    - Remove the secret from code and replace with env var reference
    - Rotate the exposed credential immediately
    - If secret is in git history: determine if history rewrite is acceptable for this PR (rebase to squash the offending commit, or use `git filter-repo` — confirm with reviewer before history rewrite)
  - AC3: **If false positive** (e.g., test fixtures, example tokens, hash strings):
    - For TruffleHog: add exclusion in `.trufflehog.yaml` (TruffleHog's native config) with `allow.paths` or `allow.regexes` and a justification comment explaining why the match is a false positive
    - For GitLeaks: add entry in `.gitleaksignore` (one rule per line, format: `<commit>:<file>:<secret>` or regex pattern)
  - AC4: Re-run locally to confirm fix: `docker run --rm -v "$(pwd):/repo" trufflesecurity/trufflehog:v3.93.0 filesystem /repo --only-verified` returns 0 findings
  - AC5: "Scan for Secrets" CI check passes on push
- **Effort:** Small-Medium (depends on findings)
- **Dependencies:** None
- **Tests:** Local reproduction passes clean; CI check passes

### Sprint 8 Task Dependencies

```
T-8.1 (parallel — no deps)
T-8.2 (parallel — no deps)
T-8.3 (parallel — no deps)
T-8.4 (parallel — no deps)
T-8.5 (parallel — no deps)
T-8.6 (parallel — no deps)
T-8.7 (parallel — no deps)
T-8.8 (parallel — no deps)
T-8.9 (parallel — no deps)
T-8.10 (parallel — no deps)
T-8.11 (parallel — no deps)
```

All tasks are independent and can be executed in any order.

### Sprint 8 Success Criteria

1. All `Number.isFinite()` guards in exploration engine (NaN/Infinity safe)
2. Audit trail IAM is append-only (no DeleteItem)
3. Zero `readFileSync` calls in Goodhart stack
4. Exploration randomness injectable for testing
5. Strict RFC 3339 date validation (rejects "1", "abc", "2026-02-27")
6. No unnecessary `async` on synchronous methods
7. No dead code (DNS pre-warming removed)
8. No misleading comments (staging.env, resolve.ts header)
9. beads_rust binary downloaded with pinned version + SHA256 checksum verification
10. CI "Scan for Secrets" check passes (TruffleHog/GitLeaks clean)
11. All CI checks green — PR #109 merge-ready
9. beads_rust binary checksum-verified in Docker build
10. All CI checks pass (including secret scanning)
11. All existing tests pass (zero regression)

---

## Updated Risk Assessment

| Risk | Sprint | Mitigation |
|------|--------|------------|
| Routing regression | Sprint 1 | Existing deterministic tests must pass; shadow returns deterministic result |
| Redis connection issues | Sprint 1 | Graceful degradation already coded (routingState="disabled") |
| Production Terraform impact | Sprint 3, 5, 6 | Separate workspace, conditional naming, no state modifications |
| CI token availability | Sprint 2 | Conditional steps skip gracefully |
| Data isolation breach | Sprint 6 | eval/evalsha blocked or prefixed; S3 scoped; Redis DB isolated |
| Timer/memory pressure | Sprint 6 | clearTimeout on Promise.race; unref on intervals |
| Test false confidence | Sprint 7 | Integration tests verify real behavior, not just unit stubs |

## Updated Dependencies & Blocking Order

```
Sprint 1 → Sprint 2 → Sprint 3 → Sprint 4 → Sprint 5 → Sprint 6 → Sprint 7
                                               ↓
                                   T-5.2 depends on T-4.3 (Sprint 4)
                                               ↓
                                   T-6.4 depends on T-5.7 (Sprint 5)
                                               ↓
                                   T-7.6 depends on T-7.3
                                   T-7.8 depends on T-5.2
                                   T-7.9 depends on T-5.5
                                   T-7.10 depends on T-6.2, T-7.4
                                   T-7.11 depends on T-6.1, T-6.5, T-6.8
                                   T-7.12 depends on T-6.3
```

---

## Success Criteria (End of Cycle)

1. All existing tests pass (no regression)
2. New unit + integration tests for Goodhart wiring
3. `finn-armitage.arrakis.community/health` returns 200
4. `finn_shadow_total` counter increments on staging
5. Zero Fly.io/Railway references in source
6. CI E2E workflows pass or gracefully skip
7. Production untouched throughout
8. All Bridgebuilder review findings addressed (Sprint 4)
9. All unbounded depth review CRITICAL/HIGH findings fixed (Sprints 5-6)
10. Router integration test coverage ≥80% (Sprint 7)
11. Zero unprefixed Redis writes possible (Sprint 6)
12. All GitHub Actions pinned to SHA (Sprint 6)
13. Container vulnerability scanning active in CI (Sprint 7)
14. Graduation runbook matches actual implementation (Sprint 5)
