# Sprint Plan: Staging Readiness — Goodhart Wiring, ECS Staging, Fly.io Cleanup

**Cycle:** 036
**PRD:** `grimoires/loa/prd.md`
**SDD:** `grimoires/loa/sdd.md`
**Date:** 2026-02-26
**Team:** 1 AI developer + 1 human reviewer
**Sprint duration:** ~2-4 hours each (AI-paced)
**Status:** ALL SPRINTS COMPLETE (4/4)

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

## Success Criteria (End of Cycle)

1. All existing tests pass (no regression)
2. New unit + integration tests for Goodhart wiring
3. `finn-armitage.arrakis.community/health` returns 200
4. `finn_shadow_total` counter increments on staging
5. Zero Fly.io/Railway references in source
6. CI E2E workflows pass or gracefully skip
7. Production untouched throughout
8. All Bridgebuilder review findings addressed (Sprint 4)
