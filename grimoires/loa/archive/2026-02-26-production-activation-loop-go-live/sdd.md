# SDD: Production Activation & Loop Go-Live — Deploy, Wire, Graduate, Verify

> **Version**: 1.2.0
> **Date**: 2026-02-26
> **Author**: @janitooor + Claude Opus 4.6 (Bridgebuilder)
> **Status**: Draft
> **Cycle**: cycle-035
> **PRD**: `grimoires/loa/prd.md` v1.1.0 (GPT-5.2 APPROVED iteration 2)
> **Predecessor SDD**: cycle-034 SDD v1.2.0 (archived: `grimoires/loa/archive/2026-02-26-loop-closure-launch-infrastructure/sdd.md`)

---

## 1. Overview

This SDD describes the technical design for activating the mechanisms built in cycle-034: deploying loa-finn to AWS ECS, wiring the live dixie reputation endpoint, graduating from shadow to live routing, verifying the complete autopoietic loop via three-leg E2E, and activating x402 on-chain settlement on Base.

**This is an activation SDD, not a feature SDD.** No new mechanisms are designed. The work is:
- Configure runtime routing mode via Redis (replacing env-var-only kill switch)
- Add two-tier health endpoints for production ALB
- Wire the dixie HTTP adapter with connection pooling and circuit breaker
- Add Prometheus graduation metrics
- Extend E2E compose to three legs (finn + freeside + dixie)
- Make x402 chain/contract configurable for testnet→mainnet migration
- Add admin API for runtime mode changes

**Architectural decisions** (confirmed during HITL architecture phase):
1. **Admin auth**: Separate ES256 admin keypair (not shared with service-to-service JWKS)
2. **Runtime config read**: Direct Redis GET per request (sub-1ms, no polling/caching layer)
3. **Three-leg E2E**: Real Docker images for freeside + dixie (not stubs)

**Existing cycle-034 components referenced but not modified** (unless stated):
- Goodhart Protection Engine (`src/hounfour/goodhart/`)
- Temporal Decay EMA + Redis Lua (`temporal-decay.ts`, `lua/ema-update.lua`)
- Epsilon-Greedy Exploration (`exploration.ts`)
- External Calibration via S3 (`calibration.ts`)
- Mechanism Interaction Rules (`mechanism-interaction.ts`)
- Reputation Adapter (`reputation-adapter.ts`)
- x402 Settlement / Merchant Relayer (`src/x402/settlement.ts`)
- DynamoDB Audit Trail (`src/hounfour/audit/dynamo-audit.ts`)
- S3 Object Lock Anchor (`src/hounfour/audit/s3-anchor.ts`)

---

## 2. System Architecture

### 2.1 Activation Delta — What Changes

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           loa-finn (cycle-035 changes)                   │
│                                                                          │
│  ┌────────────────────────────────┐  ┌──────────────────────────────┐   │
│  │  Hono Gateway (MODIFIED)       │  │  Runtime Config (NEW §3.1)   │   │
│  │                                │  │                              │   │
│  │  GET /healthz        (NEW)     │  │  Redis key per-request GET   │   │
│  │  GET /health/deps    (NEW)     │  │  POST /admin/routing-mode    │   │
│  │  POST /admin/routing-mode (NEW)│  │  Admin ES256 JWT auth        │   │
│  │  GET /metrics         (NEW)    │  │                              │   │
│  └────────────────────────────────┘  └──────────────────────────────┘   │
│                                                                          │
│  ┌────────────────────────────────┐  ┌──────────────────────────────┐   │
│  │  Kill Switch (MODIFIED §3.2)   │  │  Graduation Metrics (NEW §3.5)│  │
│  │                                │  │                              │   │
│  │  Redis-first, env-var fallback │  │  Prometheus counters:        │   │
│  │  Mode: disabled/shadow/enabled │  │    finn_shadow_total         │   │
│  │                                │  │    finn_shadow_diverged      │   │
│  │                                │  │    finn_reputation_query_*   │   │
│  └────────────────────────────────┘  └──────────────────────────────┘   │
│                                                                          │
│  ┌────────────────────────────────┐  ┌──────────────────────────────┐   │
│  │  Dixie HTTP Transport          │  │  x402 Chain Config (MOD §3.7)│   │
│  │  (MODIFIED §3.3)               │  │                              │   │
│  │                                │  │  Configurable chainId +      │   │
│  │  Connection pooling (keep-alive)│  │  token contract address      │   │
│  │  DNS pre-resolve + refresh     │  │  Base Sepolia ↔ Base mainnet │   │
│  │  300ms timeout (from 100ms)    │  │                              │   │
│  └────────────────────────────────┘  └──────────────────────────────┘   │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Three-Leg E2E Compose (NEW §3.6)                                 │  │
│  │  finn + freeside + dixie + redis + postgres + localstack          │  │
│  │  Deterministic ES256 test keypairs, JWKS endpoints, full loop     │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────▼───┐          ┌────▼───┐          ┌────▼────┐
    │ Redis  │          │ Dixie  │          │  Base   │
    │ + config│          │ (live) │          │ (L2)   │
    └────────┘          └────────┘          └─────────┘
```

### 2.2 Request Flow — Shadow vs Live Mode

The routing engine reads the mode from Redis on every request:

```
Request → JWT Auth → Economic Boundary
  │
  ├─ Redis GET finn:config:reputation_routing
  │
  ├─ [disabled] → resolvePool() (deterministic) → Provider → Response
  │
  ├─ [shadow] → resolvePool() (deterministic) → Provider → Response
  │              ALSO: async reputation scoring → compare → increment Prometheus counters
  │              (shadow result is logged, not used for routing)
  │
  └─ [enabled] → Goodhart Protection Engine (cycle-034 §4.1)
                  Kill Switch → Exploration → Reputation Scoring
                  → Provider → Response
```

**Key difference from cycle-034**: The mode is no longer read from `process.env.FINN_REPUTATION_ROUTING` on every call. Instead, Redis is checked first; env var is the cold-start fallback only.

---

## 3. Component Design

### 3.1 Runtime Config Module

**New file**: `src/hounfour/runtime-config.ts`

This module replaces the env-var-only configuration for hot-reloadable settings. The key insight from GPT review: ECS env vars don't hot-reload — changing them requires a redeploy. Redis keys can change instantly.

```typescript
type RoutingMode = "disabled" | "shadow" | "enabled"

interface RuntimeConfigKeys {
  "finn:config:reputation_routing": RoutingMode
  "finn:config:exploration_epsilon": string  // JSON: Record<tier, number>
}

class RuntimeConfig {
  constructor(private redis: RedisCommandClient) {}

  /**
   * Get routing mode. Direct Redis GET per request (~0.2ms on ElastiCache).
   * Falls back to env var on Redis failure or missing key.
   */
  async getRoutingMode(): Promise<RoutingMode> {
    try {
      const mode = await this.redis.get("finn:config:reputation_routing")
      if (mode === "disabled" || mode === "shadow" || mode === "enabled") {
        return mode
      }
      // Key missing or invalid value — fall back to env var
    } catch {
      // Redis unreachable — fall back to env var (best-effort)
    }
    const envMode = process.env.FINN_REPUTATION_ROUTING
    if (envMode === "disabled" || envMode === "shadow" || envMode === "enabled") {
      return envMode
    }
    return "shadow"  // Safe default: shadow mode (score but don't route)
  }

  /**
   * Set routing mode via Redis. No TTL — persists until changed.
   * Called by admin endpoint or direct Redis CLI.
   */
  async setRoutingMode(mode: RoutingMode): Promise<void> {
    await this.redis.set("finn:config:reputation_routing", mode)
  }
}
```

**Redis key schema** (additions to cycle-034 §5.1):

| Key | Value | TTL | Purpose |
|-----|-------|-----|---------|
| `finn:config:reputation_routing` | `"disabled" \| "shadow" \| "enabled"` | None | Routing mode (hot-reloadable) |
| `finn:config:exploration_epsilon` | JSON `Record<tier, number>` | None | Per-tier epsilon override |

**Why direct GET, not polling/caching**: ElastiCache p99 for a GET is <1ms. Adding a polling layer would introduce stale reads (up to poll interval), complexity, and a timer that needs cleanup on shutdown. The Redis roundtrip is already on the hot path (EMA reads are more expensive). The admin endpoint is called rarely; the per-request cost is negligible.

### 3.2 Kill Switch Modification

**Modified file**: `src/hounfour/goodhart/kill-switch.ts`

The cycle-034 kill switch reads `process.env.FINN_REPUTATION_ROUTING` on every call. This cycle upgrades it to use `RuntimeConfig`:

```typescript
class KillSwitch {
  constructor(private runtimeConfig: RuntimeConfig) {}

  /**
   * Check current routing mode. Redis-first, env-var fallback.
   * Replaces the cycle-034 process.env.FINN_REPUTATION_ROUTING check.
   */
  async getMode(): Promise<RoutingMode> {
    return this.runtimeConfig.getRoutingMode()
  }

  /** Check if reputation routing is disabled. */
  async isDisabled(): Promise<boolean> {
    const mode = await this.getMode()
    return mode === "disabled"
  }

  /** Check if in shadow mode (score but don't route). */
  async isShadow(): Promise<boolean> {
    const mode = await this.getMode()
    return mode === "shadow"
  }
}
```

**Breaking change**: `isDisabled()` becomes `async` (was sync). Callers in `mechanism-interaction.ts` already `await` the surrounding function, so threading the `await` is straightforward. The hot-path impact is <0.5ms (Redis GET).

### 3.3 Admin API

**New file**: `src/gateway/routes/admin.ts`

A separate Hono sub-app mounted at `/admin` for operator-only endpoints.

```typescript
import { Hono } from "hono"
import { createLocalJWKSet, jwtVerify } from "jose"

interface AdminRouteConfig {
  /**
   * Admin JWKS — stored as JSON in Secrets Manager (not a single PEM).
   * Contains one or more ES256 public keys with `kid` for rotation.
   * Refreshed on SecretsLoader TTL (default: 1 hour) without restart.
   */
  getAdminJwks: () => Promise<ReturnType<typeof createLocalJWKSet>>
  /** Expected issuer claim. */
  adminIssuer: string  // "loa-admin"
  runtimeConfig: RuntimeConfig
}

function createAdminRoutes(config: AdminRouteConfig): Hono {
  const app = new Hono()

  // Admin JWT middleware — separate from service-to-service auth
  // Uses JWKS with kid selection for safe key rotation
  app.use("/*", async (c, next) => {
    const authHeader = c.req.header("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing admin token" }, 401)
    }

    const token = authHeader.slice(7)
    try {
      const jwks = await config.getAdminJwks()
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.adminIssuer,
        audience: "loa-finn",
        algorithms: ["ES256"],
        clockTolerance: 30,
      })
      // Require admin role claim
      if (payload.role !== "admin") {
        return c.json({ error: "Insufficient role" }, 403)
      }
      c.set("adminSub", payload.sub)
    } catch (err) {
      return c.json({ error: "Invalid admin token" }, 401)
    }

    await next()
  })

  // POST /admin/routing-mode — change routing mode
  // Audit-first: write tamper-evident record BEFORE applying change.
  // Fail closed: if audit write fails, reject the mode change (503).
  app.post("/routing-mode", async (c) => {
    const body = await c.req.json<{ mode: string }>()
    const mode = body.mode
    if (mode !== "disabled" && mode !== "shadow" && mode !== "enabled") {
      return c.json({ error: "Invalid mode. Must be: disabled, shadow, enabled" }, 400)
    }

    const previousMode = await config.runtimeConfig.getRoutingMode()
    const operator = c.get("adminSub")

    // 1. Write to tamper-evident audit trail FIRST (fail closed)
    try {
      await config.auditChain.append("routing_mode_change", {
        previousMode,
        newMode: mode,
        changedBy: operator,
        timestamp: new Date().toISOString(),
        phase: "intent",  // Records intent before effect
      })
    } catch (err) {
      // Audit unavailable — reject the mode change (fail closed)
      return c.json({ error: "Audit trail unavailable — mode change rejected" }, 503)
    }

    // 2. Apply the mode change to Redis
    await config.runtimeConfig.setRoutingMode(mode)

    // 3. Write confirmation audit entry (best-effort — change already applied)
    try {
      await config.auditChain.append("routing_mode_change", {
        previousMode,
        newMode: mode,
        changedBy: operator,
        timestamp: new Date().toISOString(),
        phase: "confirmed",
      })
    } catch {
      // Log warning but don't roll back — the intent record exists
      console.warn(JSON.stringify({
        component: "admin",
        event: "audit_confirmation_failed",
        previousMode,
        newMode: mode,
      }))
    }

    return c.json({ previousMode, newMode: mode, effectiveImmediately: true })
  })

  // GET /admin/routing-mode — read current mode
  app.get("/routing-mode", async (c) => {
    const mode = await config.runtimeConfig.getRoutingMode()
    return c.json({ mode })
  })

  return app
}
```

**Auth model**: The admin JWKS is separate from service-to-service JWKS. This prevents a compromised service JWT from being used to change routing mode. The admin JWKS is stored in Secrets Manager (`finn/admin-jwks`) as a JSON Web Key Set containing one or more ES256 public keys with `kid` identifiers. The `SecretsLoader` refreshes this on its TTL (default: 1 hour), so rotation does **not** require a restart.

**Admin key rotation procedure**:
1. Generate new ES256 keypair with unique `kid`
2. Add new public key to JWKS in Secrets Manager (both old and new present)
3. Wait for SecretsLoader TTL refresh (~1 hour max, or trigger manual refresh)
4. Start issuing admin tokens with new `kid`
5. After old tokens expire (5min + 30s skew), remove old key from JWKS
6. No restart or redeploy required at any step

**Admin JWT claims**:

| Claim | Value | Purpose |
|-------|-------|---------|
| `iss` | `loa-admin` | Distinguishes from service-to-service tokens |
| `aud` | `loa-finn` | Target service |
| `sub` | Operator identifier | Audit trail |
| `role` | `admin` | Authorization |
| `kid` | Key identifier (header) | Selects verification key from JWKS |
| `exp` | 5 minutes | Short-lived |

### 3.4 Two-Tier Health Endpoints

**Modified file**: `src/gateway/server.ts`

Cycle-034 has a single `/health` endpoint. This cycle splits it into two:

```typescript
// Liveness — ALB target group health check
// No dependency checks. Returns 200 if process can respond.
app.get("/healthz", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() }, 200)
})

// Readiness — monitoring dashboards and alerts
// Checks critical and non-critical dependencies.
app.get("/health/deps", async (c) => {
  const deps: Record<string, { status: string; latencyMs?: number }> = {}
  let hasCriticalFailure = false

  // Critical: Redis (routing mode, EMA state, nonce dedup)
  try {
    const start = performance.now()
    await redis.ping()
    deps.redis = { status: "ok", latencyMs: Math.round(performance.now() - start) }
  } catch {
    deps.redis = { status: "unreachable" }
    hasCriticalFailure = true
  }

  // Non-critical: DynamoDB (audit trail — buffers locally if unavailable)
  // Uses data-plane GetItem (not control-plane DescribeTable) to avoid
  // API throttling and rate-limit flapping on frequent scrapes.
  try {
    const start = performance.now()
    await dynamoClient.send(new GetItemCommand({
      TableName: auditTableName,
      Key: marshall({ partitionId: "__health__", sequenceNumber: 0 }),
    }))
    // Missing item is fine — we're testing connectivity, not data
    deps.dynamodb = { status: "ok", latencyMs: Math.round(performance.now() - start) }
  } catch {
    deps.dynamodb = { status: "unreachable" }
    // NOT critical — audit buffers in-memory (see §3.10 Audit Resilience)
  }

  // Non-critical: Dixie (reputation — falls back to deterministic routing)
  try {
    const start = performance.now()
    const resp = await fetch(`${dixieEndpoint}/healthz`, { signal: AbortSignal.timeout(2000) })
    deps.dixie = { status: resp.ok ? "ok" : "degraded", latencyMs: Math.round(performance.now() - start) }
  } catch {
    deps.dixie = { status: "unreachable" }
    // NOT critical — routing degrades to deterministic
  }

  const statusCode = hasCriticalFailure ? 503 : 200
  return c.json({
    status: hasCriticalFailure ? "degraded" : "ok",
    dependencies: deps,
    timestamp: new Date().toISOString(),
  }, statusCode)
})

// Legacy /health — redirect to /healthz for backward compat
app.get("/health", (c) => c.redirect("/healthz", 301))
```

**ALB configuration change**: The ALB target group health check path must be updated from `/health` to `/healthz` in the `ecs-finn.tf` Terraform file in loa-freeside. This is an infrastructure change, not a code change.

| Endpoint | ALB? | Status Codes | Dependencies Checked |
|----------|------|-------------|---------------------|
| `/healthz` | Yes | Always 200 (unless process crashed) | None |
| `/health/deps` | No (monitoring) | 200 if all OK, 503 if Redis down | Redis (critical), DynamoDB, Dixie |

### 3.5 Dixie HTTP Transport — Connection Optimization

**Modified file**: `src/hounfour/goodhart/reputation-adapter.ts` (transport layer)

The cycle-034 adapter uses `fetch()` with a per-request `AbortController` timeout. This cycle adds connection pooling and DNS pre-resolution for production performance.

```typescript
import { Agent } from "undici"

interface DixieTransportConfig {
  /** Base URL for dixie reputation endpoint. */
  endpoint: string  // https://dixie.production.local/api/reputation/query
  /** Per-request timeout in ms. */
  timeoutMs: number  // 300 (up from 100 — headroom for TLS/DNS/network)
  /** Circuit breaker: failures before open. */
  circuitBreakerThreshold: number  // 3
  /** Circuit breaker: half-open probe interval in ms. */
  halfOpenIntervalMs: number  // 30000
  /** ES256 JWT signing for service-to-service auth. */
  jwtSigner: JWTSigner
  /** DNS refresh interval in ms (Cloud Map resolves can change). */
  dnsRefreshIntervalMs: number  // 30000
}

class DixieHttpTransport {
  private agent: Agent
  private resolvedHost: string | null = null
  private dnsRefreshTimer: ReturnType<typeof setInterval> | null = null
  private circuitBreaker: CircuitBreaker

  constructor(private config: DixieTransportConfig) {
    // undici Agent with keep-alive connection pooling
    this.agent = new Agent({
      keepAliveTimeout: 60_000,     // Reuse connections for 60s
      keepAliveMaxTimeout: 120_000,
      pipelining: 1,                // HTTP/1.1 keep-alive, no pipelining
      connections: 10,              // Max 10 concurrent connections to dixie
    })

    this.circuitBreaker = new CircuitBreaker({
      threshold: config.circuitBreakerThreshold,
      halfOpenIntervalMs: config.halfOpenIntervalMs,
    })

    // Pre-resolve DNS at startup and refresh periodically
    this.refreshDns()
    this.dnsRefreshTimer = setInterval(() => this.refreshDns(), config.dnsRefreshIntervalMs)
  }

  /**
   * Pre-resolve Cloud Map DNS to warm the OS DNS cache.
   * Does NOT rewrite the URL hostname — that would break TLS SNI/cert
   * verification for HTTPS connections. Instead, the periodic lookup
   * ensures the OS resolver cache stays warm, avoiding cold-cache latency
   * (5-50ms) on the hot path. For HTTP-only (E2E compose), this is a no-op
   * optimization since OS caching handles it.
   */
  private async refreshDns(): Promise<void> {
    try {
      const url = new URL(this.config.endpoint)
      await dns.promises.lookup(url.hostname)
      // Result is not stored — the purpose is to warm the OS DNS cache.
      // OS cache TTL is typically >= 30s, matching our refresh interval.
    } catch {
      // DNS failure — no action needed, OS resolver will retry on next request
    }
  }

  /**
   * Query dixie for reputation score.
   * Uses keep-alive connection pooling (eliminates TLS handshake on
   * repeated queries) and DNS cache warming (eliminates cold-cache latency).
   * URL hostname is never rewritten to preserve TLS SNI/certificate matching.
   */
  async query(q: ReputationQuery, signal?: AbortSignal): Promise<ReputationResponse | null> {
    if (this.circuitBreaker.isOpen()) return null

    try {
      const jwt = await this.config.jwtSigner.sign({
        iss: "loa-finn",
        aud: "loa-dixie",
        sub: q.nftId,
      })

      const url = new URL(this.config.endpoint)
      url.searchParams.set("nftId", q.nftId)
      url.searchParams.set("poolId", q.poolId)
      url.searchParams.set("routingKey", q.routingKey)

      // URL hostname is NOT rewritten — TLS SNI and certificate validation
      // require the original hostname. Connection pooling via undici Agent
      // eliminates repeated TLS handshakes; DNS cache warming via refreshDns()
      // eliminates cold-cache DNS latency.

      const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs)
      const composedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
        signal: composedSignal,
        // @ts-expect-error — undici dispatcher
        dispatcher: this.agent,
      })

      if (!response.ok) {
        this.circuitBreaker.recordFailure()
        return null
      }

      this.circuitBreaker.recordSuccess()
      const data = await response.json()
      return parseReputationResponse(data)
    } catch {
      this.circuitBreaker.recordFailure()
      return null
    }
  }

  /** Graceful shutdown — close connections and stop DNS refresh. */
  async shutdown(): Promise<void> {
    if (this.dnsRefreshTimer) clearInterval(this.dnsRefreshTimer)
    await this.agent.close()
  }
}
```

**Graceful shutdown wiring** (ECS SIGTERM):

The `DixieHttpTransport.shutdown()` method must be called during process termination. This is wired via a centralized shutdown handler in the boot sequence:

```typescript
// src/boot/shutdown.ts — new file
interface ShutdownTarget {
  name: string
  shutdown: () => Promise<void>
}

class GracefulShutdown {
  private targets: ShutdownTarget[] = []
  private shutdownDeadlineMs: number  // Default: 25000 (ECS stopTimeout is 30s)

  register(target: ShutdownTarget): void {
    this.targets.push(target)
  }

  /**
   * Install SIGTERM/SIGINT handlers. On signal:
   * 1. Stop accepting new HTTP requests (Hono server close)
   * 2. Await in-flight requests with deadline
   * 3. Shut down all registered targets in parallel
   * 4. Exit process
   */
  install(): void {
    const handler = async () => {
      console.log(JSON.stringify({ event: "shutdown_start", targets: this.targets.map(t => t.name) }))
      const deadline = setTimeout(() => process.exit(1), this.shutdownDeadlineMs)
      await Promise.allSettled(this.targets.map(t => t.shutdown()))
      clearTimeout(deadline)
      process.exit(0)
    }
    process.on("SIGTERM", handler)
    process.on("SIGINT", handler)
  }
}

// Boot sequence registers all targets:
// gracefulShutdown.register({ name: "dixie-transport", shutdown: () => dixieTransport.shutdown() })
// gracefulShutdown.register({ name: "calibration-poller", shutdown: () => calibration.stopPolling() })
// gracefulShutdown.register({ name: "relayer-monitor", shutdown: () => relayerMonitor.stopMonitoring() })
// gracefulShutdown.register({ name: "reconciler", shutdown: () => reconciler.stopPeriodicReconciliation() })
// gracefulShutdown.register({ name: "audit-buffer", shutdown: () => auditBuffer.flushBuffer() })
// gracefulShutdown.install()
```

**ECS alignment**: The default `shutdownDeadlineMs` (25s) leaves 5s headroom within ECS's default `stopTimeout` (30s). If the deadline expires, `process.exit(1)` forces termination so ECS doesn't SIGKILL the container.

**Transport changes from cycle-034**:

| Parameter | Cycle-034 | Cycle-035 | Why |
|-----------|-----------|-----------|-----|
| Per-request timeout | 100ms | 300ms | Headroom for TLS/DNS/network variance (GPT review fix #4) |
| Connection reuse | None (new conn per request) | `undici` Agent keep-alive pool | Eliminates TLS handshake on repeated queries |
| DNS resolution | Per-request OS resolver | Pre-resolved, refreshed every 30s | Avoids 5-50ms DNS lookup on hot path |
| Connection limit | Unbounded | 10 concurrent | Prevents connection exhaustion to dixie |

### 3.6 Graduation Metrics (Prometheus)

**New file**: `src/hounfour/graduation-metrics.ts`

Prometheus counters are the canonical source of truth for graduation evaluation (PRD FR3.1). Logs are supplementary and may drop.

```typescript
import { Counter, Histogram, Registry } from "prom-client"

const registry = new Registry()

// Shadow comparison counters
const shadowTotal = new Counter({
  name: "finn_shadow_total",
  help: "Total shadow routing decisions",
  labelNames: ["tier"],
  registers: [registry],
})

const shadowDiverged = new Counter({
  name: "finn_shadow_diverged",
  help: "Shadow decisions that diverged from deterministic routing",
  labelNames: ["tier"],
  registers: [registry],
})

// Reputation query metrics
const reputationQueryDuration = new Histogram({
  name: "finn_reputation_query_duration_seconds",
  help: "Dixie reputation query latency",
  labelNames: ["status"],  // "success", "timeout", "error", "circuit_open"
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5],
  registers: [registry],
})

const reputationQueryTotal = new Counter({
  name: "finn_reputation_query_total",
  help: "Total reputation queries to dixie",
  labelNames: ["status"],
  registers: [registry],
})

// Exploration metrics
const explorationTotal = new Counter({
  name: "finn_exploration_total",
  help: "Total exploration decisions",
  labelNames: ["tier", "outcome"],  // outcome: "explored", "skipped", "no_candidates"
  registers: [registry],
})

// EMA metrics
const emaUpdates = new Counter({
  name: "finn_ema_updates_total",
  help: "Total EMA update operations",
  labelNames: ["outcome"],  // "updated", "duplicate", "stale", "cold_start"
  registers: [registry],
})

// Routing mode
const routingMode = new Counter({
  name: "finn_routing_mode_transitions_total",
  help: "Routing mode changes",
  labelNames: ["from", "to"],
  registers: [registry],
})

export { registry, shadowTotal, shadowDiverged, reputationQueryDuration,
         reputationQueryTotal, explorationTotal, emaUpdates, routingMode }
```

**Metrics endpoint**: `GET /metrics` returns Prometheus text format from the registry.

```typescript
// Added to server.ts
app.get("/metrics", async (c) => {
  const metrics = await registry.metrics()
  return c.text(metrics, 200, {
    "Content-Type": registry.contentType,
  })
})
```

**Prometheus scraping infrastructure** (required for graduation):

The `/metrics` endpoint is for local/dev use only. Production graduation requires a Prometheus server (or AWS Managed Prometheus / AMP) that scrapes the finn ECS tasks. This is necessary because:
- **Counter resets**: ECS task restarts (deploys, scale events, crashes) reset in-process counters. A Prometheus server with `increase()` / `rate()` functions handles resets correctly via its staleness/reset detection.
- **72-hour retention**: In-process counters only live as long as the process. Prometheus retains scraped data for the full graduation window.
- **Multi-task aggregation**: If multiple ECS tasks run, Prometheus aggregates across instances.

**Prometheus scrape target discovery**: Use ECS service discovery (Cloud Map `finn.production.local`) or the ALB metrics endpoint. Scrape interval: 15s (default).

**Graduation evaluation script**: `scripts/evaluate-graduation.ts`

Queries the Prometheus API (not `/metrics` directly) using PromQL range vectors for the 72-hour graduation window:

```typescript
interface GraduationResult {
  verdict: "GRADUATE" | "NOT_READY" | "INSUFFICIENT_DATA"
  thresholds: {
    id: string
    metric: string
    promql: string
    target: string
    actual: string | number
    passed: boolean
  }[]
  window: { start: string; end: string }
  totalShadowDecisions: number
}

interface GraduationConfig {
  /** Prometheus query API endpoint. */
  prometheusUrl: string  // e.g., "http://prometheus:9090" or AMP workspace query URL
  /** Redis client for T5 (EMA CV) and T7/T8 spot checks. */
  redisClient: RedisCommandClient
  /** Admin endpoint for T7 spot check. */
  adminEndpoint: string
}

/**
 * Evaluate all 8 graduation thresholds using Prometheus range queries.
 * Counter-based thresholds use `increase()` to handle task restarts correctly.
 *
 * T1: Routing divergence <15%
 *     PromQL: sum(increase(finn_shadow_diverged[72h])) / sum(increase(finn_shadow_total[72h]))
 * T2: Reputation query p99 <100ms
 *     PromQL: histogram_quantile(0.99, sum(rate(finn_reputation_query_duration_seconds_bucket[72h])) by (le))
 * T3: Latency impact <50ms delta
 *     PromQL: (histogram_quantile(0.99, ..._with_reputation) - histogram_quantile(0.99, ..._baseline))
 * T4: Error rate <0.1%
 *     PromQL: sum(increase(finn_reputation_query_total{status="error"}[72h])) / sum(increase(finn_reputation_query_total[72h]))
 * T5: EMA CV <0.3 (computed from Redis EMA state samples — not Prometheus)
 * T6: Exploration rate within [3%, 7%]
 *     PromQL: sum(increase(finn_exploration_total{outcome="explored"}[72h])) / sum(increase(finn_shadow_total[72h]))
 * T7: Kill switch responsiveness <1s (spot check via admin endpoint round-trip — not Prometheus)
 * T8: Calibration freshness <60s (S3 ETag polling timestamp check — not Prometheus)
 *
 * Outputs GRADUATE when all 8 pass. Outputs NOT_READY with failing thresholds.
 * Outputs INSUFFICIENT_DATA if sum(increase(finn_shadow_total[72h])) < 1000.
 */
async function evaluateGraduation(
  config: GraduationConfig,
  window: { start: Date; end: Date },
): Promise<GraduationResult>
```

### 3.7 Three-Leg E2E Compose

**New file**: `tests/e2e/docker-compose.e2e-v3.yml`

Extends the cycle-034 two-leg compose (`docker-compose.e2e-v2.yml`) to three legs.

```yaml
services:
  # === Infrastructure ===

  redis-e2e:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 3

  postgres-e2e:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - ./init-db.sql:/docker-entrypoint-initdb.d/01-init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5

  localstack-e2e:
    image: localstack/localstack:3
    ports:
      - "4566:4566"
    environment:
      SERVICES: dynamodb,s3,kms,secretsmanager
      DEFAULT_REGION: us-east-1
    volumes:
      - ./localstack-init.sh:/etc/localstack/init/ready.d/init.sh
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 3s
      retries: 5

  # === Application Services ===

  loa-finn-e2e:
    build:
      context: ../../
      dockerfile: deploy/Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: test
      REDIS_URL: redis://redis-e2e:6379
      FINN_REPUTATION_ENDPOINT: http://loa-dixie-e2e:5000/api/reputation/query
      FINN_REPUTATION_ROUTING: shadow
      FINN_S2S_PRIVATE_KEY_FILE: /keys/finn-private.pem
      FINN_ADMIN_PUBLIC_KEY_FILE: /keys/admin-public.pem
      AWS_ENDPOINT_URL: http://localstack-e2e:4566
      AWS_REGION: us-east-1
      AWS_ACCESS_KEY_ID: test
      AWS_SECRET_ACCESS_KEY: test
      DYNAMODB_AUDIT_TABLE: finn-audit-e2e
      S3_AUDIT_BUCKET: finn-audit-e2e
      S3_CALIBRATION_BUCKET: finn-calibration-e2e
      X402_CHAIN_ID: "84532"
      X402_USDC_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
      X402_SETTLEMENT_MODE: verify_only
    volumes:
      - ./keys:/keys:ro
    depends_on:
      redis-e2e:
        condition: service_healthy
      localstack-e2e:
        condition: service_healthy
      loa-dixie-e2e:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  loa-freeside-e2e:
    image: ${FREESIDE_IMAGE:-ghcr.io/0xhoneyjar/loa-freeside:latest}
    ports:
      - "4000:4000"
    environment:
      NODE_ENV: test
      REDIS_URL: redis://redis-e2e:6379
      DATABASE_URL: postgres://postgres:postgres@postgres-e2e:5432/freeside_test
      FINN_URL: http://loa-finn-e2e:3000
      FREESIDE_S2S_PRIVATE_KEY_FILE: /keys/freeside-private.pem
    volumes:
      - ./keys:/keys:ro
    depends_on:
      redis-e2e:
        condition: service_healthy
      postgres-e2e:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/healthz"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  loa-dixie-e2e:
    image: ${DIXIE_IMAGE:-ghcr.io/0xhoneyjar/loa-dixie:latest}
    ports:
      - "5000:5000"
    environment:
      NODE_ENV: test
      DATABASE_URL: postgres://postgres:postgres@postgres-e2e:5432/dixie_test
      REDIS_URL: redis://redis-e2e:6379
      DIXIE_S2S_PRIVATE_KEY_FILE: /keys/dixie-private.pem
    volumes:
      - ./keys:/keys:ro
    depends_on:
      redis-e2e:
        condition: service_healthy
      postgres-e2e:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/healthz"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
```

**init-db.sql** — Creates databases for both freeside and dixie:

```sql
CREATE DATABASE freeside_test;
CREATE DATABASE dixie_test;
```

#### 3.6.1 Deterministic Test Keypairs

**Directory**: `tests/e2e/keys/`

Pre-generated ES256 keypairs for deterministic E2E testing. Same trust model as production (JWKS validation) but with known keys.

```
tests/e2e/keys/
├── finn-private.pem        # finn service signing key
├── finn-public.pem         # finn service verification key
├── freeside-private.pem    # freeside service signing key
├── freeside-public.pem     # freeside service verification key
├── dixie-private.pem       # dixie service signing key
├── dixie-public.pem        # dixie service verification key
├── admin-private.pem       # admin operator signing key (for routing mode changes)
├── admin-public.pem        # admin operator verification key
└── generate-keys.sh        # Regeneration script (openssl ecparam -genkey)
```

**JWKS endpoint** (`GET /.well-known/jwks.json`): Each service reads its own public key from the mounted volume and serves it as JWKS. In E2E, all services also mount each other's public keys for issuer verification (mirroring production JWKS fetching).

**Generate script**: `tests/e2e/keys/generate-keys.sh`

```bash
#!/bin/bash
set -euo pipefail

for service in finn freeside dixie admin; do
  openssl ecparam -genkey -name prime256v1 -noout \
    | openssl pkcs8 -topk8 -nocrypt -out "${service}-private.pem"
  openssl ec -in "${service}-private.pem" -pubout -out "${service}-public.pem"
  echo "Generated ${service} keypair"
done
```

These keys are checked into the repo (test-only, clearly in `tests/e2e/keys/`). Production keys are in AWS Secrets Manager.

#### 3.6.2 Autopoietic Path E2E Test

**New file**: `tests/e2e/autopoietic-loop.test.ts`

Verifies the complete 6-stage loop in the three-leg compose:

```typescript
describe("Autopoietic Loop E2E", () => {
  it("closes the feedback loop across finn → dixie → finn", async () => {
    // 1. Seed: Create a test NFT with a known nftId in dixie
    // 2. First request: deterministic routing (no reputation data yet)
    //    → verify ScoringPathLog.path === "deterministic"
    // 3. Quality signal: scoreToObservation produces quality score
    //    → verify reputation event sent to dixie
    // 4. Wait: dixie processes and stores reputation
    // 5. Subsequent requests: shadow mode scores reputation
    //    → verify finn_shadow_total counter increments
    //    → verify dixie receives reputation query
    // 6. After N requests: verify EMA converges
    //    → verify routing decisions shift (not always same pool)
    // 7. Check ScoringPathLog progression: "stub" → "reputation"
  })
})
```

### 3.8 x402 Chain Configuration

**Modified files**: `src/x402/verify.ts`, `src/x402/settlement.ts`

Cycle-034 hardcodes Base mainnet chain ID (`8453`) and USDC address. This cycle makes them configurable for testnet→mainnet migration.

```typescript
interface ChainConfig {
  chainId: bigint
  usdcAddress: `0x${string}`
  rpcUrl: string
  chainName: string
}

const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  // Base mainnet
  "8453": {
    chainId: 8453n,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    chainName: "Base",
  },
  // Base Sepolia (testnet)
  "84532": {
    chainId: 84532n,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    chainName: "Base Sepolia",
  },
}

function getChainConfig(): ChainConfig {
  const chainId = process.env.X402_CHAIN_ID ?? "8453"
  const config = CHAIN_CONFIGS[chainId]
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`)
  }
  // Allow override of USDC address for custom deployments
  const usdcOverride = process.env.X402_USDC_ADDRESS
  if (usdcOverride) {
    return { ...config, usdcAddress: usdcOverride as `0x${string}` }
  }
  return config
}
```

**Verify changes**: The hardcoded `8453n` and `USDC_BASE_ADDRESS` constants in `verify.ts` are replaced with `chainConfig.chainId` and `chainConfig.usdcAddress`. Same for the `EIP-712 domain separator.

**Settlement changes**: The `MerchantRelayer.submitOnChain()` method uses `chainConfig.rpcUrl` and `chainConfig.chainId` instead of hardcoded values. The `viem` chain configuration is constructed dynamically.

**Settlement timeout alignment** (GPT review fix #7):

| Parameter | Cycle-034 | Cycle-035 | Why |
|-----------|-----------|-----------|-----|
| `confirmationTimeoutMs` | 30000 | 60000 | Headroom for Base congestion (GPT review: 30s timeout with 35s SLO was guaranteed-failure) |
| NFR1 p99 SLO | <35s | <20s | Realistic target — Base typical is 2-5s |

### 3.10 Audit Resilience — Bounded Buffer (replaces CloudWatch fallback)

**Modified behavior** from cycle-034 §4.6.3: Cycle-034 specified CloudWatch as the audit fallback when DynamoDB is unavailable. GPT review correctly identified that CloudWatch is not tamper-evident and cannot substitute for the DynamoDB hash chain + S3 Object Lock guarantees. This cycle replaces the CloudWatch fallback with a bounded in-memory buffer.

```typescript
interface AuditBufferConfig {
  /** Max entries to buffer before applying backpressure. Default: 1000. */
  maxBufferSize: number
  /** Retry interval for flushing buffer to DynamoDB. Default: 5000ms. */
  retryIntervalMs: number
  /** Max age for buffered entries before discarding. Default: 300000ms (5 min). */
  maxEntryAgeMs: number
}

class BufferedAuditChain {
  private buffer: AuditEntry[] = []
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private inner: DynamoAuditChain,  // cycle-034 §4.6.1
    private config: AuditBufferConfig,
  ) {}

  /**
   * Append to audit trail. If DynamoDB is unreachable, buffer in memory.
   * Buffer is bounded — when full, new entries are rejected (fail closed
   * for admin actions, degrade for telemetry).
   */
  async append(action: string, payload: Record<string, unknown>): Promise<void> {
    try {
      // First try to flush any buffered entries
      await this.flushBuffer()
      // Then append the new entry
      await this.inner.append(action, payload)
    } catch {
      // DynamoDB unreachable — buffer the entry
      if (this.buffer.length >= this.config.maxBufferSize) {
        // Buffer full — behavior depends on action criticality
        if (action === "routing_mode_change" || action === "settlement") {
          throw new Error("Audit trail unavailable for critical action")
        }
        // Non-critical: log warning, drop entry
        console.warn(JSON.stringify({
          component: "audit-buffer",
          event: "buffer_full_drop",
          action,
          bufferSize: this.buffer.length,
        }))
        return
      }
      this.buffer.push({ action, payload, bufferedAt: Date.now() } as any)
      this.startRetry()
    }
  }

  /** Flush buffered entries to DynamoDB in order. */
  private async flushBuffer(): Promise<void> {
    while (this.buffer.length > 0) {
      const entry = this.buffer[0]
      if (Date.now() - entry.bufferedAt > this.config.maxEntryAgeMs) {
        this.buffer.shift()  // Discard expired entries
        continue
      }
      await this.inner.append(entry.action, entry.payload)
      this.buffer.shift()  // Remove after successful write
    }
    this.stopRetry()
  }
}
```

**Critical actions** (routing mode changes, x402 settlements): If the buffer is full and DynamoDB is unreachable, these actions **fail closed** — the operation is rejected rather than proceeding without an audit record. This prevents unauditable admin actions.

**Non-critical actions** (shadow comparison logs, exploration counters): If the buffer is full, entries are dropped with a structured warning log. CloudWatch receives the warning for operational alerting, but is not treated as an audit record.

**Admin endpoint integration**: The `POST /admin/routing-mode` handler writes to the `BufferedAuditChain` **before** returning success. If the audit write fails (buffer full + DynamoDB down), the mode change is rejected with 503.

### 3.9 Secrets Management

No new module — this section documents the three-category split from PRD NFR3.

**Startup sequence** (`src/boot/secrets.ts` — new file):

```typescript
interface SecretsConfig {
  /** AWS Secrets Manager client. */
  smClient: SecretsManagerClient
  /** Secret names to retrieve. */
  secretNames: {
    s2sPrivateKey: string       // "finn/s2s-private-key"
    calibrationHmac: string     // "finn/calibration-hmac"
    merchantPrivateKey?: string  // "finn/merchant-private-key" (only for x402 on_chain mode)
    adminJwks: string           // "finn/admin-jwks" (JWKS JSON with kid — NOT a single PEM)
  }
  /** Cache TTL for secrets (default: 1 hour). */
  cacheTtlMs: number
}

class SecretsLoader {
  private cache: Map<string, { value: string; expiresAt: number }> = new Map()

  /**
   * Load all secrets at startup. Fail fast if any required secret is missing.
   * Cache in memory with TTL for rotation support.
   */
  async loadAll(): Promise<LoadedSecrets> {
    // Parallel fetch from Secrets Manager
    const [s2sKey, hmac, merchantKey, adminPubKey] = await Promise.all([
      this.getSecret(this.config.secretNames.s2sPrivateKey),
      this.getSecret(this.config.secretNames.calibrationHmac),
      this.config.secretNames.merchantPrivateKey
        ? this.getSecret(this.config.secretNames.merchantPrivateKey)
        : Promise.resolve(null),
      this.getSecret(this.config.secretNames.adminPublicKey),
    ])

    return { s2sPrivateKey: s2sKey, calibrationHmac: hmac, merchantPrivateKey: merchantKey, adminJwks: adminJwksJson }
  }

  /** Refresh cached secrets (for key rotation). Called on timer. */
  async refresh(): Promise<void> {
    // Re-fetch expired secrets only
  }
}
```

**Category summary** (from PRD NFR3):

| Category | Mechanism | Items |
|----------|-----------|-------|
| Secrets | AWS Secrets Manager | `FINN_S2S_PRIVATE_KEY`, `FINN_MERCHANT_PRIVATE_KEY`, API keys, `FINN_CALIBRATION_HMAC_KEY`, `finn/admin-jwks` (JWKS JSON with `kid`) |
| Non-secret config | ECS env vars / SSM | `FINN_REPUTATION_ENDPOINT`, `FINN_KMS_KEY_ID`, `AWS_REGION`, `X402_CHAIN_ID`, `X402_USDC_ADDRESS` |
| Runtime config | Redis | `finn:config:reputation_routing`, `finn:config:exploration_epsilon` |

---

## 4. API Design

### 4.1 New Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/healthz` | None | ALB liveness probe |
| `GET` | `/health/deps` | None | Dependency readiness check |
| `GET` | `/metrics` | None (internal) | Prometheus metrics |
| `POST` | `/admin/routing-mode` | Admin ES256 JWT | Set routing mode |
| `GET` | `/admin/routing-mode` | Admin ES256 JWT | Get routing mode |
| `GET` | `/.well-known/jwks.json` | None | Public keys for JWT verification |

### 4.2 Modified Endpoints

| Method | Path | Change |
|--------|------|--------|
| `GET` | `/health` | Redirects 301 → `/healthz` |
| `POST` | `/api/v1/invoke` | Routing engine reads mode from Redis (not env var) |
| `POST` | `/api/v1/x402/invoke` | Chain/contract configurable via env vars |

---

## 5. Data Architecture

### 5.1 Redis Keys — Additions

| Key | Value | TTL | Purpose |
|-----|-------|-----|---------|
| `finn:config:reputation_routing` | `"disabled" \| "shadow" \| "enabled"` | None | Runtime routing mode |
| `finn:config:exploration_epsilon` | JSON `Record<tier, number>` | None | Per-tier epsilon override |

(All existing keys from cycle-034 §5.1 are unchanged.)

### 5.2 Environment Variables — New/Changed

| Variable | Source | Required | Default | Purpose |
|----------|--------|----------|---------|---------|
| `X402_CHAIN_ID` | ECS env / compose | No | `"8453"` | Target chain for settlement |
| `X402_USDC_ADDRESS` | ECS env / compose | No | Chain-specific default | USDC contract override |
| `BASE_SEPOLIA_RPC_URL` | ECS env / compose | No | `https://sepolia.base.org` | Base Sepolia RPC |
| `FINN_ADMIN_JWKS` | Secrets Manager (`finn/admin-jwks`) | Yes (prod) | Test JWKS (E2E) | Admin JWT verification (JWKS JSON with `kid`) |

---

## 6. Deployment Architecture

### 6.1 Infrastructure Changes (in loa-freeside)

| Resource | Change | File |
|----------|--------|------|
| ALB health check path | `/health` → `/healthz` | `ecs-finn.tf` |
| Secrets Manager | Add `finn/admin-jwks` (JWKS JSON, not single PEM) | Terraform or manual |
| ECS task env vars | Add `X402_CHAIN_ID` | `ecs-finn.tf` |

### 6.2 Deployment Order (with verification gates and rollback)

Each step includes a **verify** gate and **rollback** procedure. Do not proceed past a gate that fails.

| Step | Action | Verify Gate | Rollback |
|------|--------|------------|----------|
| 1 | Merge PR #108 to main | CI passes, no merge conflicts | `git revert` the merge commit |
| 2 | Push Docker image to ECR (GitHub Actions) | `aws ecr describe-images` shows new tag | Re-push from previous commit |
| 3 | **CRITICAL**: Update ALB health check `/health` → `/healthz` (Terraform) | `aws elbv2 describe-target-health` shows targets healthy within 60s | `terraform apply` with old health check path; **do this before ECS deploys new image** to avoid draining all targets |
| 4 | Deploy cycle-035 code (ECS force-new-deployment) | New task starts, passes `/healthz`, stays healthy 5min | ECS rolls back automatically (minimum healthy percent); or manually update to previous image tag |
| 5 | Verify `/healthz` returns 200, `/health/deps` all green | `curl` from bastion/VPN; check CloudWatch for errors | Roll back to step 4 image |
| 6 | Set `finn:config:reputation_routing = "shadow"` (admin endpoint) | `GET /admin/routing-mode` returns `shadow`; Prometheus `finn_shadow_total` increments | Set mode to `disabled` via Redis CLI |
| 7 | 72-hour shadow observation | Prometheus metrics accumulating; no error rate spikes | Set mode to `disabled`; investigate |
| 8 | Run `evaluate-graduation.ts` → `GRADUATE` | All 8 thresholds pass | Extend observation window; tune parameters |
| 9 | Set `finn:config:reputation_routing = "enabled"` (admin endpoint) | Routing decisions use reputation scores (verify via `/metrics`) | Immediate: set mode to `shadow` or `disabled` via admin endpoint or Redis CLI (<1s) |
| 10 | 24h enhanced monitoring (1-min metric windows) | No regression in error rate, latency, divergence | Set mode to `shadow`; post-mortem |

**Step 3 is the highest-risk step**: Changing the ALB health check path while the old code is still running will cause health checks to fail (old code serves `/health` not `/healthz`). The correct sequence is: deploy new code first (step 4) that serves both `/health` and `/healthz`, then update the ALB path. The table above is simplified; in practice steps 3 and 4 should be coordinated:

```
4a. Deploy cycle-035 code (serves both /health and /healthz)
      ↓ verify: both endpoints return 200
3.  Update ALB health check path → /healthz (Terraform)
      ↓ verify: targets stay healthy
4b. (future) Remove legacy /health endpoint
```

---

## 7. Testing Strategy

### 7.1 Unit Tests (new/modified)

| Component | Test File | Key Assertions |
|-----------|-----------|----------------|
| RuntimeConfig | `runtime-config.test.ts` | Redis GET → mode; Redis down → env fallback; invalid value → default |
| KillSwitch (async) | `kill-switch.test.ts` | Async isDisabled/isShadow; mode transitions |
| Admin routes | `admin-routes.test.ts` | Valid JWT → mode change; bad JWT → 401; wrong role → 403 |
| Health endpoints | `health.test.ts` | /healthz always 200; /health/deps 503 on Redis down; dependency latency |
| Graduation metrics | `graduation-metrics.test.ts` | Counter increments; histogram observations |
| ChainConfig | `chain-config.test.ts` | Default to Base mainnet; env override to Sepolia; invalid chain ID throws |
| DixieTransport | `dixie-transport.test.ts` | Keep-alive reuse; DNS pre-resolve; circuit breaker; 300ms timeout |

### 7.2 E2E Tests (three-leg compose)

| Test | Compose File | Verifies |
|------|-------------|----------|
| JWT exchange | `docker-compose.e2e-v3.yml` | finn validates freeside-issued JWT |
| Reputation query | `docker-compose.e2e-v3.yml` | finn queries dixie for live reputation data |
| Autopoietic loop | `docker-compose.e2e-v3.yml` | Full 6-stage feedback loop |
| Shadow metrics | `docker-compose.e2e-v3.yml` | Prometheus counters increment in shadow mode |
| Admin routing mode | `docker-compose.e2e-v3.yml` | Admin JWT flips mode, next request uses new mode |

### 7.3 x402 Tests (Base Sepolia)

| Test | Network | Verifies |
|------|---------|----------|
| Settlement flow | Base Sepolia | Full payment → chain confirm → inference |
| Nonce replay | Base Sepolia | Second submission rejected by contract |
| Expired deadline | Base Sepolia | 402 returned before chain submission |
| Chain config switch | Unit | Same code runs on Sepolia (84532) and mainnet (8453) |

---

## 8. Security Architecture

### 8.1 Admin Endpoint Security

| Control | Implementation |
|---------|---------------|
| Separate JWKS | Admin ES256 JWKS (with `kid`) ≠ service-to-service JWKS |
| Short-lived tokens | 5-minute expiry |
| Role enforcement | `role: "admin"` claim required |
| Issuer isolation | `iss: "loa-admin"` (distinct from service issuers) |
| Tamper-evident audit | Mode changes written to DynamoDB audit chain (fail closed) |
| Network restriction | **Required**: ALB listener rule restricts `/admin/*` — see below |
| Rate limiting | **Required**: AWS WAF + app-layer throttle — see below |

#### 8.1.1 Network Controls (concrete, not advisory)

These are **requirements**, not suggestions. The admin endpoint must not be reachable from the public internet.

| Layer | Control | Configuration |
|-------|---------|---------------|
| ALB listener rule | Path-based routing for `/admin/*` | Forward to finn target group **only** if source IP matches VPN CIDR or internal security group |
| Security group | Ingress restriction | Allow `/admin/*` traffic only from VPN subnet (`10.x.x.x/24`) or bastion host SG |
| AWS WAF (optional) | Rate limiting on `/admin/*` | Max 10 requests/minute per source IP; block after 5 consecutive 401/403 responses for 15 minutes |
| App-layer throttle | Per-subject rate limit | Max 5 mode changes per hour per `sub` claim (tracked in Redis with TTL key `finn:admin:rate:{sub}`) |

If VPN is not available at go-live, an alternative is to use an internal ALB (not internet-facing) for admin traffic, accessible only from the private subnet.

#### 8.1.2 Failed Auth Response

On 401/403, the response body is intentionally minimal (`{ "error": "..." }`) — no token details, no key hints, no JWKS endpoint disclosure. Failed attempts are logged as structured JSON with source IP for CloudWatch alarm ingestion.

### 8.2 Secret Rotation

| Secret | Rotation Strategy |
|--------|------------------|
| `FINN_S2S_PRIVATE_KEY` | Add new key to JWKS, retain old for 10min, remove old |
| `finn/admin-jwks` | Add new key with unique `kid` to JWKS in Secrets Manager; SecretsLoader TTL auto-refreshes (no restart); remove old key after token expiry |
| `FINN_MERCHANT_PRIVATE_KEY` | Generate new wallet, transfer ETH, update Secrets Manager |
| API provider keys | Update in Secrets Manager, TTL cache auto-refreshes |

---

## 9. Technical Risks & Mitigation

| Risk | Mitigation |
|------|-----------|
| Redis unavailable → routing mode unknown | Env var fallback in `getRoutingMode()` (safe default: shadow) |
| Admin endpoint exposed to internet | ALB listener rules: `/admin/*` only from VPN CIDR or internal ALB |
| Prometheus cardinality explosion | Fixed label sets (tier, status); no unbounded labels (nftId, poolId) |
| Three-leg compose flaky on CI | Health checks with `start_period` + `retries`; each service waits for deps |
| DNS cache cold after IP change | 30s cache-warming refresh; URL hostname never rewritten (TLS SNI safe); undici keep-alive pools survive DNS changes |
| ECS task restart resets Prometheus counters | Graduation script queries Prometheus server via `increase()` range vectors, not raw counters |
| DynamoDB outage during admin action | Bounded audit buffer; critical actions (mode change, settlement) fail closed if buffer full + DynamoDB down |
| Process hangs on SIGTERM (timer/socket leak) | Centralized `GracefulShutdown` handler with 25s deadline; all transports/pollers registered at boot |
| Base Sepolia faucet USDC depleted | Keep test amounts small (0.01 USDC per test); reusable test wallet |
| Redis brief outage → all requests fail (no local cache) | **Deferred** (SKP-003): Add bounded stale-while-revalidate cache in future cycle. Current mitigation: env var cold-start fallback to shadow mode |
| x402 chainId/USDC address mismatch (testnet↔mainnet) | **Deferred** (SKP-010): Add startup cross-validation of chainId against known USDC addresses in future cycle. Current mitigation: separate env vars per environment, deployment checklist |

### 9.1 Deferred Concerns (Flatline SKP-003, SKP-010)

The following concerns were identified by Flatline Protocol with HIGH severity and accepted as valid, but deferred out of cycle-035 scope:

1. **SKP-003 — Redis fallback cache** (severity 760): Per-request Redis GET has no bounded local cache. A Redis failover (~1-5s) would fail all concurrent requests. *Rationale for deferral*: The env var fallback guarantees safe-default (shadow mode) on cold start. Redis failovers in ElastiCache are rare (<5s) and the blast radius is limited to a brief period of stale routing decisions. A stale-while-revalidate cache adds complexity to the config read path that isn't justified until we observe Redis instability in production.

2. **SKP-010 — x402 chain config startup validation** (severity 720): Static `x402ChainConfig` has no cross-validation between chainId and USDC contract address. Deploying testnet chainId with mainnet USDC address (or vice versa) could cause settlement failures or, in theory, misrouted funds. *Rationale for deferral*: x402 settlement is behind its own feature flag (`x402.enabled`) and will be activated only after manual verification on Base Sepolia. The deployment checklist (§6.2) includes a chain config verification step. A startup validation lookup table is warranted before mainnet activation but not blocking for the testnet-first approach.

---

## 10. New Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| `prom-client` | Prometheus metrics library | ^15.x |
| `undici` | HTTP client with connection pooling | ^6.x (bundled in Node 22, but explicit for Agent API) |
| `jose` | JWT signing/verification for admin endpoint | ^5.x (already in use via freeside) |

All other dependencies from cycle-034 are unchanged.
