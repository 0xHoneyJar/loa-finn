# SDD: Staging Readiness — Goodhart Wiring, ECS Staging, Fly.io Cleanup

**Status:** Draft
**Author:** Jani + Claude
**Date:** 2026-02-26
**Cycle:** 036
**PRD:** `grimoires/loa/prd.md`

---

## 1. Executive Summary

This SDD implements 5 functional requirements to bring loa-finn from "Goodhart stack built but disconnected" to "running in shadow mode on staging." The primary engineering challenge is wiring 7 existing Goodhart components into the `src/index.ts` initialization sequence without breaking the deterministic routing path — all components already have constructors, tests, and types; they just need to be instantiated and composed.

Secondary work: parameterize Terraform for multi-environment deployment, remove 14+ stale Fly.io/Railway references, and fix 3 failing CI workflows.

---

## 2. System Architecture

### 2.1 Current State

```
src/index.ts:304 → HounfourRouter({registry, budget, health, cheval, ...})
                     ↓
                   resolvePool() → deterministic routing (no reputation)
```

### 2.2 Target State

```
src/index.ts:~302 → Goodhart Init Block (try/catch, non-fatal)
                       ├── KillSwitch(runtimeConfig)
                       ├── createDixieTransport(DIXIE_BASE_URL)
                       ├── TemporalDecayEngine({redis, halfLifeMs})
                       ├── ExplorationEngine({redis, epsilon})
                       ├── CalibrationEngine({s3, hmac})
                       ├── ReputationAdapter({decay, calibration, transport})
                       └── MechanismConfig (composites all above)
                     ↓
src/index.ts:~310 → HounfourRouter({..., goodhartConfig?})
                     ↓
                   resolvePool() → routing state machine
                     ├── disabled: deterministic (skip Goodhart)
                     ├── shadow: resolveWithGoodhart() → return deterministic result
                     ├── enabled: resolveWithGoodhart() → use reputation result
                     └── init_failed: deterministic + counter
```

### 2.3 Component Dependency Graph

```
KillSwitch ← RuntimeConfig (Redis)
TemporalDecayEngine ← RedisCommandClient
ExplorationEngine ← RedisCommandClient
CalibrationEngine ← S3Reader (optional, startup-only)
DixieTransport ← DIXIE_BASE_URL env var
ReputationAdapter ← {TemporalDecayEngine, CalibrationEngine, DixieTransport}
MechanismConfig ← {all above + optional AuditLogger + optional Metrics}
```

---

## 3. Component Design

### 3.1 Transport Factory

**New file:** `src/hounfour/goodhart/transport-factory.ts`

```typescript
import { DixieStubTransport, DixieHttpTransport } from "./dixie-transport.js"
import type { DixieTransport } from "./dixie-transport.js"

export function createDixieTransport(baseUrl?: string): DixieTransport {
  if (!baseUrl || baseUrl === "stub") {
    return new DixieStubTransport()
  }
  return new DixieHttpTransport({ baseUrl })
}
```

**Rationale:** Single function replaces conditional logic. Existing `DixieHttpTransport` constructor (lines 85-109 of `dixie-transport.ts`) already validates URL, warms DNS, and configures circuit breaker. No new classes needed.

**Export from index:** Add `export { createDixieTransport } from "./transport-factory.js"` to `src/hounfour/goodhart/index.ts`.

### 3.2 Goodhart Initialization Block

**Location:** `src/index.ts`, after Redis init (line 197) and Oracle init (line 302), before HounfourRouter construction (line 304).

**Pattern:** Lazy, non-fatal, try/catch — mirrors existing Redis init pattern.

```typescript
// Goodhart Protection Stack (FR-1)
let goodhartConfig: MechanismConfig | undefined
let routingState: RoutingState = "disabled"
const requestedMode = process.env.FINN_REPUTATION_ROUTING ?? "shadow"

if (requestedMode !== "disabled") {
  try {
    const transport = createDixieTransport(process.env.DIXIE_BASE_URL)

    const decay = redis ? new TemporalDecayEngine({
      redis,
      halfLifeMs: 7 * 24 * 60 * 60 * 1000,      // 7 days
      aggregateHalfLifeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    }) : undefined

    const exploration = redis ? new ExplorationEngine({
      redis,
      defaultEpsilon: parseFloat(process.env.FINN_EXPLORATION_EPSILON ?? "0.05"),
      epsilonByTier: {},
      blocklist: new Set(),
      costCeiling: 2.0,
    }) : undefined

    // CalibrationEngine: only construct when explicitly configured
    const calibBucket = process.env.FINN_CALIBRATION_BUCKET_NAME
    const calibHmac = process.env.FINN_CALIBRATION_HMAC_KEY
    const calibration = (calibBucket && calibHmac)
      ? new CalibrationEngine({
          s3Bucket: calibBucket,
          s3Key: "finn/calibration.jsonl",
          pollIntervalMs: 60_000,
          calibrationWeight: 3.0,
          hmacSecret: calibHmac,
        })
      : new NoopCalibrationEngine()  // returns neutral scores, no polling

    const killSwitch = new KillSwitch(runtimeConfig)

    if (decay && exploration) {
      goodhartConfig = {
        decay,
        exploration,
        calibration,
        killSwitch,
        explorationFeedbackWeight: 0.5,
      }
      routingState = requestedMode as "shadow" | "enabled"
      console.log(`[finn] goodhart: initialized (state=${routingState})`)
    } else {
      console.warn("[finn] goodhart: redis unavailable, degrading to deterministic")
      // routingState stays "disabled" — no init_failed because it's a known condition
    }
  } catch (err) {
    console.warn(`[finn] goodhart: init failed (non-fatal): ${(err as Error).message}`)
    routingState = "init_failed"
    goodhartInitFailedCounter.inc()
    // goodhartConfig remains undefined → deterministic routing
  }
}

console.log(`[finn] routing state resolved: ${routingState} (requested: ${requestedMode})`)
```

**Key decisions:**
- `requestedMode === "disabled"` skips construction entirely (AC4)
- Redis null → no decay/exploration → stays "disabled" with log (AC5)
- Init exception → explicit `init_failed` state + counter (distinguishable from disabled)
- CalibrationEngine gated: only constructed when both `FINN_CALIBRATION_BUCKET_NAME` and `FINN_CALIBRATION_HMAC_KEY` are set; otherwise `NoopCalibrationEngine` (returns neutral scores, no polling, no log spam)
- Transport factory respects `DIXIE_BASE_URL` (AC6)
- Startup log prints both requested mode and resolved state for operator visibility

### 3.3 Router Integration

**File:** `src/hounfour/router.ts`

**Change 1: Add optional fields to HounfourRouterOptions (line ~55)**

```typescript
export type RoutingState = "disabled" | "shadow" | "enabled" | "init_failed"

export interface HounfourRouterOptions {
  // ... existing fields ...
  goodhartConfig?: MechanismConfig
  routingState?: RoutingState
}
```

**Change 2: Store in constructor + expose state (line ~208)**

```typescript
this.goodhartConfig = options.goodhartConfig
this.routingState = options.routingState ?? "disabled"

// Export routing state as gauge for observability
routingModeGauge.set({ mode: this.routingState }, 1)
console.log(`[finn] routing state: ${this.routingState}`)
```

**Change 3: Modify routing path in resolvePool (or wrapper)**

The routing state machine from PRD FR-1:

```typescript
async resolvePoolForRequest(/* existing params */): Promise<PoolResolutionResult> {
  // init_failed or disabled: deterministic routing
  if (this.routingState === "disabled") {
    return this.resolvePool(/* existing deterministic path */)
  }
  if (this.routingState === "init_failed") {
    goodhartInitFailedRequestCounter.inc()
    return this.resolvePool(/* existing deterministic path */)
  }

  const deterministicResult = this.resolvePool(/* existing */)

  // Shadow or enabled: invoke Goodhart with mode context
  const reputationResult = await resolveWithGoodhart(
    this.goodhartConfig!,
    tier, nftId, taskType, nftPreferences,
    accessiblePools, circuitBreakerStates,
    poolCosts, defaultPoolCost, poolCapabilities,
    abortSignal,
    {
      mode: this.routingState,            // "shadow" | "enabled"
      seed: requestId,                    // deterministic RNG seed
      allowWrites: this.routingState === "enabled",  // no writes in shadow
    },
  )

  if (this.routingState === "shadow") {
    // Shadow: log divergence, return deterministic
    shadowTotalCounter.inc()
    if (reputationResult.pool !== deterministicResult.pool) {
      shadowDivergedCounter.inc()
    }
    return deterministicResult
  }

  // Enabled: use reputation result
  return reputationResult
}
```

**Shadow mode write contract (mechanism-enforced):**
- Shadow mode passes `allowWrites: false` to resolveWithGoodhart
- Exploration engine uses seeded PRNG (from `requestId`) instead of `Math.random()`
- Exploration counters are NOT incremented in shadow mode
- EMA feedback writes are NOT executed in shadow mode
- Redis operations are strictly read-only: GET for kill switch, GET for EMA state
- Metrics (prom-client in-process counters) are the only "writes" — these are process-local, not shared state
- **Enforcement:** In shadow mode, components receive a `ReadOnlyRedisClient` wrapper that only exposes `get`, `mget`, `hget`, `hgetall`, and `exists`. All mutating methods (`set`, `incr`, `hset`, `del`, etc.) throw `Error("Redis writes blocked in shadow mode")`. This prevents accidental writes by future code paths that forget to check `allowWrites`.

```typescript
// src/hounfour/goodhart/read-only-redis.ts
export function createReadOnlyRedisClient(redis: RedisCommandClient): RedisCommandClient {
  return new Proxy(redis, {
    get(target, prop: string) {
      const readMethods = new Set(["get", "mget", "hget", "hgetall", "exists", "ttl", "type"])
      if (readMethods.has(prop)) return target[prop].bind(target)
      if (typeof target[prop] === "function") {
        return () => { throw new Error(`Redis writes blocked in shadow mode (attempted: ${prop})`) }
      }
      return target[prop]
    }
  })
}
```

**KillSwitch integration (runtime override):**

KillSwitch takes **highest precedence** in the routing state machine. Before evaluating shadow/enabled paths, the router checks the kill switch:

```typescript
// In resolvePoolForRequest, before shadow/enabled evaluation:
if (this.goodhartConfig?.killSwitch) {
  const killState = await this.goodhartConfig.killSwitch.getMode()
  if (killState === "kill") {
    killSwitchActivatedCounter.inc()
    return this.resolvePool(/* deterministic fallback */)
  }
}
```

**Precedence order:** KillSwitch > routingState > env var. This ensures operators can always force-disable reputation routing at runtime via Redis key, without redeployment.

### 3.3.1 `resolveWithGoodhart()` — Typed Contract

**File:** `src/hounfour/goodhart/resolve.ts`

This is the core integration function that connects the deterministic router to all 7 Goodhart components. Its contract must be explicit:

```typescript
export interface GoodhartOptions {
  /** Current routing mode: "shadow" runs read-only, "enabled" allows writes */
  mode: "shadow" | "enabled"
  /** Deterministic seed for PRNG (requestId in shadow, Math.random in enabled) */
  seed: string
  /** Whether exploration counters, EMA feedback, etc. may write to Redis */
  allowWrites: boolean
}

export interface GoodhartResult {
  /** Selected pool ID */
  pool: string
  /** Reputation score that drove the selection */
  score: number
  /** Whether exploration (epsilon-greedy) overrode the score-based pick */
  explored: boolean
  /** Per-pool scored breakdown for observability */
  scoredPools: ScoredPool[]
}

/**
 * Invoke the full Goodhart protection stack to select a pool.
 *
 * Error contract:
 *   - On individual pool scoring failure → that pool is excluded (partial degradation)
 *   - On ALL pool scoring failures → returns null (caller falls back to deterministic)
 *   - On timeout (50ms per Redis op) → same as scoring failure
 *   - Never throws — all errors are caught and logged
 *
 * Timeout contract:
 *   - Each Redis GET has a 50ms per-command timeout (configurable via FINN_REDIS_TIMEOUT_MS)
 *   - Total function timeout: 200ms (hardcoded ceiling)
 *   - On timeout: logs warning, returns null (deterministic fallback)
 */
export async function resolveWithGoodhart(
  config: MechanismConfig,
  tier: string,
  nftId: string,
  taskType: string,
  nftPreferences: NftPreferences,
  accessiblePools: readonly PoolId[],
  circuitBreakerStates: Map<string, CircuitBreakerState>,
  poolCosts: Map<string, number>,
  defaultPoolCost: number,
  poolCapabilities: Map<string, PoolCapability>,
  abortSignal: AbortSignal | undefined,
  options: GoodhartOptions,
): Promise<GoodhartResult | null> {
  // ...implementation: score pools, apply exploration, return result or null
}
```

**Fallback behavior:** When `resolveWithGoodhart` returns `null`, the caller (`resolvePoolForRequest`) uses the deterministic result. This is the same path as disabled/init_failed — no special handling needed.

### 3.4 Parallel Reputation Scoring (FR-2)

**File:** `src/hounfour/router.ts` — `resolvePoolWithReputation()` method

**Current:** Sequential `for...of` loop scoring pools one at a time.

**Change:** Replace with concurrency-limited `Promise.allSettled`:

```typescript
import pLimit from "p-limit"

const SCORING_CONCURRENCY = 5  // max concurrent Redis/Dixie lookups per request
const PER_POOL_TIMEOUT_MS = 50 // per-pool scoring timeout

async resolvePoolWithReputation(
  pools: readonly PoolId[],
  queryFn: ReputationQueryFn,
): Promise<ScoredPool[]> {
  const limit = pLimit(SCORING_CONCURRENCY)

  const results = await Promise.allSettled(
    pools.map((pool) => limit(async () => {
      const score = await Promise.race([
        queryFn(pool),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`scoring timeout for ${pool}`)), PER_POOL_TIMEOUT_MS)
        ),
      ])
      return { pool, score }
    }))
  )

  const scored = results
    .filter((r): r is PromiseFulfilledResult<ScoredPool> => r.status === "fulfilled")
    .map(r => r.value)

  // Fallback: if all scorings failed, return empty list
  // Caller (resolveWithGoodhart) handles empty scored list → deterministic fallback
  if (scored.length === 0 && pools.length > 0) {
    reputationScoringFailedCounter.inc()
    console.warn(`[finn] reputation: all ${pools.length} pool scorings failed, falling back to deterministic`)
  }

  return scored
}
```

**Fallback contract:** When `resolvePoolWithReputation` returns an empty list, `resolveWithGoodhart` falls back to deterministic pool selection (existing `resolvePool()`). This ensures enabled mode cannot hard-fail routing due to scoring dependency failures. The `finn_reputation_scoring_failed_total` counter provides observability for this degradation.

**Impact:** Individual pool scoring failures no longer block other pools (AC8). Total failure degrades gracefully to deterministic (no request-level errors).

### 3.5 Prometheus Metrics

**New counters (add to existing metrics file):**

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `finn_shadow_total` | Counter | — | Shadow mode invocations |
| `finn_shadow_diverged` | Counter | — | Shadow result != deterministic |
| `finn_goodhart_init_failed` | Counter | — | Init-time failures (set once at startup) |
| `finn_goodhart_init_failed_requests` | Counter | — | Requests routed through init_failed state |
| `finn_goodhart_routing_mode` | Gauge | `mode` | Current routing state (disabled/shadow/enabled/init_failed) |
| `finn_routing_duration_seconds` | Histogram | `path` | Per-request routing latency |
| `finn_reputation_scoring_failed_total` | Counter | — | All pool scorings failed, fell back to deterministic |

---

## 4. Deployment Architecture

### 4.1 Terraform Parameterization

**Canonical Terraform:** `infrastructure/terraform/` (has Redis, DynamoDB, KMS, monitoring). `deploy/terraform/finn.tf` is a review artifact, not the deployment source.

**Strategy:** Parameterize existing modules with `environment` variable. Staging reuses existing cluster/ALB/VPC.

**New/modified files:**

| File | Change |
|------|--------|
| `infrastructure/terraform/variables.tf` | Add `environment` variable (default: "production") |
| `infrastructure/terraform/loa-finn-ecs.tf` | Parameterize service name, task def name, container env |
| `infrastructure/terraform/loa-finn-alb.tf` | Parameterize host header, target group name, Route53 record |
| `infrastructure/terraform/loa-finn-env.tf` | Parameterize SSM paths with `{env}` |
| `infrastructure/terraform/environments/armitage.tfvars` | New: staging-specific overrides |

**Key parameterization:**

```hcl
variable "environment" {
  type    = string
  default = "production"
}

locals {
  service_name = "loa-finn-${var.environment}"
  hostname     = var.environment == "production" ? "finn.arrakis.community" : "finn-${var.environment}.arrakis.community"
  ssm_prefix   = "/loa-finn/${var.environment}"
}
```

**Staging overrides (`armitage.tfvars`):**

```hcl
environment = "armitage"
finn_cpu    = 256
finn_memory = 512
```

### 4.1.1 Environment Isolation (Terraform-Enforced)

Each environment gets its own isolated resources to prevent cross-environment contamination:

| Resource | Production | Staging (armitage) |
|----------|-----------|-------------------|
| ECS Service | `loa-finn-production` | `loa-finn-armitage` |
| Redis | Shared ElastiCache, logical DB 0, prefix `prod:` | Same cluster, logical DB 1 + key prefix `armitage:` (see §4.1.2 for runtime enforcement) |
| S3 Calibration | `finn-calibration-<account>` | `finn-calibration-<account>/armitage/` (prefix isolation) |
| DynamoDB | `finn-scoring-path-log` | `finn-scoring-path-log-armitage` (separate table) |
| SSM Parameters | `/loa-finn/production/*` | `/loa-finn/armitage/*` |
| CloudWatch Logs | `/ecs/finn` | `/ecs/finn-armitage` |
| Task IAM Role | Scoped to production SSM/S3/DynamoDB | Scoped to armitage SSM/S3/DynamoDB |

**IAM scoping (task role):**

```hcl
resource "aws_iam_policy" "finn_task" {
  statement {
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:*:*:parameter/loa-finn/${var.environment}/*"]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::finn-calibration-*/${var.environment}/*"]
  }
  statement {
    actions   = ["dynamodb:*"]
    resources = ["arn:aws:dynamodb:*:*:table/finn-*-${var.environment}*"]
  }
}
```

**Terraform validation (prevent cross-env references):**

```hcl
variable "redis_url" {
  type = string
  validation {
    condition     = var.environment == "production" || !can(regex("production", var.redis_url))
    error_message = "Non-production environments cannot reference production Redis URL."
  }
}
```

### 4.1.2 Redis Runtime Isolation (Prefix Enforcement)

While §4.1.1 defines Terraform-level isolation, Redis logical DB + key prefix on a shared cluster is fragile if misconfigured. Runtime enforcement adds defense-in-depth:

```typescript
// src/hounfour/infra/prefixed-redis.ts
export function createPrefixedRedisClient(
  redis: RedisCommandClient,
  prefix: string,
  dbIndex: number,
): RedisCommandClient {
  // SELECT the correct DB on connection
  redis.select(dbIndex)

  // Startup assertion: verify prefix is non-empty
  if (!prefix || prefix.length < 2) {
    throw new Error(`Redis prefix must be >= 2 chars, got: "${prefix}"`)
  }

  return new Proxy(redis, {
    get(target, prop: string) {
      // Intercept key-bearing commands to prepend prefix
      const keyCommands = new Set(["get", "set", "del", "incr", "hget", "hset", "hgetall", "exists", "ttl", "mget"])
      if (keyCommands.has(prop)) {
        return (...args: unknown[]) => {
          // First arg is always the key (or array of keys for mget)
          if (prop === "mget" && Array.isArray(args[0])) {
            args[0] = args[0].map((k: string) => `${prefix}${k}`)
          } else if (typeof args[0] === "string") {
            args[0] = `${prefix}${args[0]}`
          }
          return (target as any)[prop](...args)
        }
      }
      return (target as any)[prop]
    }
  })
}
```

**Startup assertion:** `src/index.ts` validates the prefix is set and matches the expected environment:

```typescript
const redisPrefix = process.env.FINN_REDIS_PREFIX
if (!redisPrefix) throw new Error("FINN_REDIS_PREFIX must be set")
const prefixedRedis = createPrefixedRedisClient(redis, redisPrefix, parseInt(process.env.FINN_REDIS_DB ?? "0"))
```

**Production uses `prod:` prefix**, staging uses `armitage:` prefix. Even if an operator accidentally points staging at the production Redis URL, the key prefix prevents data contamination.

**Upgrade path:** When budget allows, migrate staging to a separate ElastiCache replication group (smaller node type, e.g. `cache.t3.micro`). The prefix wrapper remains as defense-in-depth.

### 4.1.3 Terraform State Migration Plan

**Risk:** Retroactively adding an `environment` variable and renaming resources (e.g., `loa-finn` → `loa-finn-production`) causes Terraform to propose destroying and recreating the existing production service.

**Mitigation — separate state file approach (recommended):**

1. **Do NOT modify the existing production Terraform state.** Production continues using the current resource names without an environment suffix.
2. **Create a new Terraform workspace for staging:**
   ```bash
   cd infrastructure/terraform
   terraform workspace new armitage
   ```
3. **Staging resources use the `environment` variable** (`loa-finn-armitage`). Production resources are untouched.
4. **Conditional naming in Terraform:**
   ```hcl
   locals {
     # Production keeps legacy names for zero-risk migration
     service_name = var.environment == "production" ? "loa-finn" : "loa-finn-${var.environment}"
   }
   ```
5. **Future unification (optional):** After staging is validated, run `terraform state mv` to rename production resources to include the environment suffix. This is a separate, low-priority task.

**Key principle:** This cycle's staging work must not touch production Terraform state in any way.

### 4.2 ALB + TLS Configuration

**Existing ALB:** Shared across arrakis services, has HTTPS:443 listener.

**New listener rule:**
- Priority: 210 (production is 200, staging lower priority)
- Condition: Host header matching staging hostname
- Action: Forward to `finn-armitage-tg`

**ACM certificate:** A `*.arrakis.community` wildcard cert only covers single-level subdomains. `finn.armitage.arrakis.community` is two levels deep and would NOT be covered. Two options:

**Option A (recommended):** Use `finn-armitage.arrakis.community` (single-level subdomain, covered by existing wildcard `*.arrakis.community`). Pattern: `finn-<gibson-name>.arrakis.community`.

**Option B:** Request explicit SAN cert for `finn.armitage.arrakis.community`.

**SDD assumes Option A** (`finn-armitage.arrakis.community`) unless user specifies otherwise. The Gibson naming convention adapts: `finn-armitage`, `finn-chiba`, `finn-dixieflat`, etc.

### 4.3 Route53

**New ALIAS record:**
- Name: `finn-armitage.arrakis.community`
- Type: A (ALIAS)
- Target: ALB DNS name
- Evaluate health: Yes

### 4.4 Staging Environment Variables

**File:** `deploy/staging.env.example`

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
DATA_DIR=/data

# Routing — FINN_REPUTATION_ROUTING is the single source of truth
# (ROUTING_MODE is a legacy alias; if both are set, FINN_REPUTATION_ROUTING wins)
FINN_REPUTATION_ROUTING=shadow
X402_SETTLEMENT_MODE=verify_only

# Goodhart (shadow mode defaults)
FINN_EXPLORATION_EPSILON=0.05
# DIXIE_BASE_URL intentionally unset → DixieStubTransport
# FINN_CALIBRATION_BUCKET_NAME intentionally unset → graceful degrade

# Auth
FINN_S2S_JWT_ALG=ES256
FINN_AUTH_TOKEN=                    # Set via SSM/Secrets Manager

# Redis
REDIS_URL=                          # Set via SSM/Secrets Manager

# Tracing
OTLP_ENDPOINT=http://tempo.arrakis.local:4317
```

### 4.5 Staging Deploy Workflow

**New file:** `.github/workflows/deploy-staging.yml`

**Trigger:** Manual dispatch (`workflow_dispatch`) with `environment` input.

**Flow:**
1. Build & test (same as production)
2. Docker build → ECR push (same tag format)
3. Update task definition: `loa-finn-armitage`
4. Deploy to ECS service: `loa-finn-armitage`
5. Smoke test: `https://finn-armitage.arrakis.community/health`

---

## 5. Fly.io / Railway Removal

### 5.1 Files to Delete

| File | Reason |
|------|--------|
| `railway.toml` (root) | Railway cron config — not used |
| `deploy/railway.toml` | Duplicate Railway config |
| `deploy/wrangler.jsonc` | Cloudflare Workers config — not used |
| `grimoires/loa/context/bridgebuilder-minimal-railway.md` | Railway-specific context doc |

### 5.2 Files to Edit

| File | Change |
|------|--------|
| `deploy/BRIDGEBUILDER.md` | Remove Railway sections, update for ECS |
| `deploy/vllm/README.md` | Remove Fly.io GPU section |
| `README.md` | Remove Railway/Fly.io deployment references |
| `.claude/settings.json` | Remove `fly:*`, `railway:*` permission entries |
| `docs/operations.md` | Remove Railway section |
| `docs/modules/bridgebuilder.md` | Update deployment references |
| `grimoires/loa/context/research-minimal-pi.md` | Remove Fly.io fallback references |
| `grimoires/loa/sdd-bridgebuilder-refactor.md` | Remove Railway references |
| `grimoires/loa/sdd-product-launch.md` | Remove Fly.io references |

### 5.3 Files to Preserve

| File | Reason |
|------|--------|
| `CHANGELOG.md` | Historical entries are factual — never rewrite history |

---

## 6. CI E2E Fixes

### 6.1 e2e-smoke.yml — Conditional Cross-Repo Checkout

**Current failure:** `ARRAKIS_CHECKOUT_TOKEN` secret missing in fork/public PRs.

**Fix:** Wrap cross-repo steps in conditional block. Skip entire job with clear message when secret unavailable.

```yaml
- name: Check cross-repo token
  id: check-token
  run: |
    if [ -n "${{ secrets.ARRAKIS_CHECKOUT_TOKEN }}" ]; then
      echo "available=true" >> $GITHUB_OUTPUT
    else
      echo "available=false" >> $GITHUB_OUTPUT
      echo "::warning::ARRAKIS_CHECKOUT_TOKEN not available — skipping e2e-smoke"
    fi
```

### 6.2 e2e.yml — Oracle Directory Fixtures

**Current failure:** `deploy/build-context/oracle-knowledge/` and `deploy/build-context/oracle-persona/` directories missing.

**Fix:** Commit `.gitkeep` fixtures so Docker COPY succeeds with empty directories. The `src/index.ts:289-301` Oracle init already degrades gracefully when corpus is empty.

```bash
deploy/build-context/oracle-knowledge/.gitkeep
deploy/build-context/oracle-persona/.gitkeep
```

### 6.3 e2e-v2.yml — GHCR Authentication

**Current failure:** `loa-freeside:v7.11.0` pull denied.

**Fix:** Add GHCR login step using `ARRAKIS_CHECKOUT_TOKEN`. Skip job when token unavailable.

```yaml
- name: Login to GHCR
  if: env.HAS_TOKEN == 'true'
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.ARRAKIS_CHECKOUT_TOKEN }}
```

---

## 7. Security Architecture

### 7.1 No New Attack Surface

This cycle introduces **no new network listeners, endpoints, or auth flows**. All changes are internal wiring:

- Transport factory: DixieStubTransport returns `null` (no network)
- Shadow mode: reads from Redis (existing connection), writes metrics only
- Staging: same TLS/auth as production, just different hostname

### 7.2 Staging Isolation

| Concern | Mitigation |
|---------|------------|
| Staging accesses production Redis | Separate Redis logical DB + key prefix, enforced by Terraform IAM scoping (§4.1.1) |
| Staging receives real traffic | Different hostname, no DNS overlap |
| x402 settlements in staging | `X402_SETTLEMENT_MODE=verify_only` — no real payments |
| Shadow mode writes to shared state | Shadow mode is strictly read-only for Redis (§3.3 write contract): `allowWrites: false` passed to resolveWithGoodhart; exploration counters and EMA feedback writes are disabled; only process-local prom-client metrics are written |
| Cross-environment SSM leakage | Task IAM role scoped to `/loa-finn/${environment}/*` only (§4.1.1) |

### 7.3 Secret Management

Staging secrets use the same SSM Parameter Store pattern as production, with `/loa-finn/armitage/` prefix:

```
/loa-finn/armitage/ANTHROPIC_API_KEY
/loa-finn/armitage/FINN_S2S_SECRET
/loa-finn/armitage/REDIS_URL
/loa-finn/armitage/FINN_AUTH_TOKEN
```

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component | Test File | What's Tested |
|-----------|-----------|---------------|
| Transport factory | `tests/finn/goodhart/transport-factory.test.ts` | Stub selection, HTTP selection, empty string, URL parsing |
| Routing state machine | `tests/finn/goodhart/routing-state.test.ts` | All 4 states: disabled, shadow, enabled, init_failed |
| Shadow divergence | `tests/finn/goodhart/shadow-mode.test.ts` | Counter increments, deterministic result returned |
| Parallel scoring | `tests/finn/hounfour/parallel-scoring.test.ts` | allSettled behavior, individual failure isolation |

### 8.2 Integration Tests

| Test | Validates |
|------|-----------|
| Goodhart init with mock Redis | Full composition chain, MechanismConfig created |
| Goodhart init without Redis | Graceful degradation, deterministic fallback |
| Shadow mode routing | End-to-end shadow path with mock pools |

### 8.3 E2E Validation (on staging)

| Check | Method |
|-------|--------|
| Health endpoint | `curl https://finn-armitage.arrakis.community/health` |
| Shadow metrics | `curl .../metrics \| grep finn_shadow_total` |
| Routing mode | `curl .../metrics \| grep finn_goodhart_routing_mode` |
| No Fly.io references | `grep -r "fly.io\|railway\|flyctl" src/ deploy/ .github/ docs/` |

---

## 9. Performance Considerations

### 9.1 Request Path

| Operation | Latency | Blocking? |
|-----------|---------|-----------|
| KillSwitch mode check | ~0.1ms (Redis GET) | Yes (50ms timeout) |
| EMA lookup | ~0.1ms (Redis GET) | Yes (50ms timeout) |
| Exploration coin flip | ~0us (Math.random) | No |
| Calibration lookup | ~0us (in-memory Map) | No |
| DixieStubTransport | ~0us (`return null`) | No |
| Shadow divergence check | ~0us (string compare) | No |
| Metric increment | ~0us (prom-client) | No |

**Total shadow overhead:** <1ms typical, <50ms worst case (Redis timeout).

**Timeout enforcement:**
- Per Redis command: `FINN_REDIS_TIMEOUT_MS` env var (default: 50ms). Applied via `ioredis` `commandTimeout` option.
- Per `resolveWithGoodhart` call: 200ms hard ceiling. Uses `Promise.race` with `AbortController.timeout(200)`.
- On timeout: log warning, increment `finn_goodhart_timeout_total` counter, return `null` → deterministic fallback.
- Per pool scoring: 50ms timeout via `Promise.race` in `resolvePoolWithReputation` (§3.4).

### 9.2 Startup Path

| Operation | Latency | Notes |
|-----------|---------|-------|
| Import Goodhart modules | ~50ms | Dynamic import |
| KillSwitch construction | ~0ms | No async |
| TemporalDecayEngine construction | ~1ms | Reads Lua script from disk |
| ExplorationEngine construction | ~0ms | No async |
| CalibrationEngine construction | ~0ms | Polling starts separately |

**Total startup overhead:** <100ms.

---

## 10. Design Decisions

### D1: Subdomain Format

`finn-armitage.arrakis.community` (hyphenated, single-level) instead of `finn.armitage.arrakis.community` (dotted, multi-level). Reason: existing `*.arrakis.community` wildcard ACM cert covers single-level subdomains only. Multi-level would require a new SAN cert.

### D2: Canonical Terraform

Use `infrastructure/terraform/` as the canonical source (comprehensive: Redis, DynamoDB, KMS, monitoring). The `deploy/terraform/finn.tf` is a review artifact — mark as deprecated or delete.

### D3: Goodhart Config as Optional Field

Add `goodhartConfig?: MechanismConfig` to `HounfourRouterOptions` rather than creating a new wrapper class. This preserves backward compatibility and follows the existing optional-composition pattern.

---

## 11. Shadow → Enabled Graduation Protocol

### 11.1 Exit Criteria (all must be met for ≥48 hours)

| Metric | Threshold | Source |
|--------|-----------|--------|
| Shadow overhead p99 | < 10ms | `finn_routing_duration_seconds{path="shadow"}` |
| Shadow error rate | < 0.1% | `finn_goodhart_timeout_total / finn_shadow_total` |
| Divergence rate | Stable (not trending up) | `finn_shadow_diverged / finn_shadow_total` |
| Init failure rate | 0 | `finn_goodhart_init_failed` |
| KillSwitch state | "normal" | Redis key check |
| Scoring failure rate | < 1% | `finn_reputation_scoring_failed_total / finn_shadow_total` |

### 11.2 Graduation Runbook

1. **Validate exit criteria** for 48 continuous hours on staging
2. **Update SSM parameter:** `/loa-finn/armitage/FINN_REPUTATION_ROUTING` from `shadow` to `enabled`
3. **ECS redeploy** to pick up new env (or use runtime config if KillSwitch supports mode switching)
4. **Monitor for 1 hour:** watch all metrics above, plus `finn_goodhart_routing_mode{mode="enabled"}`
5. **Rollback trigger:** If any threshold exceeded, set KillSwitch to "kill" (instant, no redeploy)
6. **Post-graduation:** Keep shadow metrics active for 7 days (they'll read zero, confirming mode)

### 11.3 Rollback Paths

| Severity | Method | Speed |
|----------|--------|-------|
| P0 (routing broken) | KillSwitch → "kill" via Redis SET | < 1 second |
| P1 (degraded quality) | SSM parameter → "shadow", redeploy | ~5 minutes |
| P2 (non-urgent) | SSM parameter → "disabled", next deploy | ~30 minutes |

---

## 12. Implementation Order

1. **Transport factory** — new file, re-export (no existing code changes)
2. **Goodhart init block** — src/index.ts insertion (main wiring)
3. **Router integration** — HounfourRouterOptions extension + state machine
4. **Parallel scoring** — Promise.allSettled replacement
5. **Prometheus metrics** — new counters/histogram
6. **Unit tests** — transport factory, routing states, shadow mode
7. **Fly.io/Railway removal** — file deletions and edits
8. **Terraform parameterization** — environment variable, tfvars
9. **Staging deploy workflow** — new GitHub Actions workflow
10. **CI E2E fixes** — conditional secrets, .gitkeep fixtures, GHCR login
11. **staging.env.example** — documentation
