# SDD: The Oracle — From Engine to Product (Phase 1)

> **Version**: 3.0.0
> **Date**: 2026-02-17
> **Author**: @janitooor + Bridgebuilder
> **Status**: Draft
> **Cycle**: cycle-025 (extended)
> **PRD**: `grimoires/loa/prd.md` (v3.0.0, GPT-5.2 APPROVED iteration 2, Flatline APPROVED)
> **Predecessor**: SDD v2.0.0 — Oracle Knowledge Engine (Phase 0, IMPLEMENTED in PR #75)
> **Grounding**: `src/gateway/server.ts` (235 lines), `src/gateway/routes/invoke.ts` (97 lines), `src/gateway/rate-limit.ts` (99 lines), `src/gateway/auth.ts` (85 lines), `src/config.ts` (247 lines), `src/scheduler/health.ts` (203 lines), `deploy/Dockerfile` (77 lines), `deploy/terraform/finn.tf` (471 lines)

---

## 1. Executive Summary

Phase 0 (SDD v2.0.0) built the Oracle's brain — a knowledge enrichment engine inside the Hounfour router. That work is complete: 600 lines of TypeScript, 107 tests, 10 curated knowledge sources, fully reviewed and approved in PR #75.

Phase 1 gives the Oracle a body. This SDD designs the product surface that makes the engine accessible:

**Backend (loa-finn):**
1. `src/gateway/routes/oracle.ts` — BFF endpoint (`POST /api/v1/oracle`) wrapping the invoke pipeline (~120 lines)
2. `src/gateway/oracle-rate-limit.ts` — Redis-backed per-IP / per-key / global rate limiter with fail-closed semantics (~200 lines)
3. `src/gateway/oracle-auth.ts` — Oracle API key validation middleware (~80 lines)
4. `src/gateway/oracle-concurrency.ts` — Semaphore for max 3 concurrent Oracle requests per ECS task (~60 lines)

**Infrastructure (deploy/terraform/):**
5. `deploy/terraform/modules/dnft-site/` — Reusable Terraform module (S3 + CloudFront + Route 53 + CSP headers)
6. Module invocation for `oracle.arrakis.community`
7. ACM wildcard certificate for `*.arrakis.community`
8. GitHub Actions OIDC role for loa-dixie → S3 deployment

**Build Pipeline:**
9. Dockerfile changes — CI-fetched loa-dixie knowledge via `COPY` from build context (no `ADD` from GitHub)
10. Docker labels for provenance (`dixie.ref`, `dixie.commit`, `build.timestamp`)

**Frontend (loa-dixie/site/):**
11. Next.js static export — chat interface, source attribution panel, abstraction level selector
12. Deployed to S3 + CloudFront, migration-ready for Cloudflare Pages

**Scripts:**
13. `scripts/oracle-keys.sh` — Admin CLI for API key create/revoke/list

**Modified files** (~120 lines of changes across 4 existing files):
- `src/config.ts` — Oracle Phase 1 env vars (~30 lines)
- `src/gateway/server.ts` — Oracle route + middleware registration (~20 lines)
- `src/scheduler/health.ts` — Rate limiter + dixie ref health fields (~15 lines)
- `deploy/Dockerfile` — `COPY` loa-dixie knowledge from build context (~10 lines)

Phase 0 components are fully retained. No changes to the knowledge enrichment pipeline, types, loader, registry, or enricher. The Oracle product API delegates to the same `HounfourRouter.invokeForTenant()` that the existing invoke endpoint uses.

---

## 2. System Architecture

### 2.1 Phase 1 Request Flow

```
┌─────────────────────────────────────────────────────┐
│            oracle.arrakis.community                  │
│            Next.js static on S3 + CloudFront         │
│            CSP + HSTS response headers               │
└─────────────────────┬───────────────────────────────┘
                      │ HTTPS (cross-origin)
                      ▼
┌─────────────────────────────────────────────────────┐
│            finn.arrakis.community                    │
│            ALB → ECS (existing)                      │
│                                                      │
│  ┌─ CORS middleware ─────────────────────────────┐  │
│  │  Origin: https://oracle.arrakis.community     │  │
│  └───────────────────────────────────────────────┘  │
│                      │                               │
│  ┌─ Oracle Auth middleware ──────────────────────┐  │
│  │  dk_live_* → SHA-256 lookup in Redis          │  │
│  │  No token → IP-based public tier              │  │
│  └───────────────────────────────────────────────┘  │
│                      │                               │
│  ┌─ Oracle Rate Limiter ─────────────────────────┐  │
│  │  Redis-backed: IP (5/day), Key (50/day),      │  │
│  │  Global (200/day). Fail-closed on Redis err.  │  │
│  └───────────────────────────────────────────────┘  │
│                      │                               │
│  ┌─ Concurrency Limiter ─────────────────────────┐  │
│  │  Semaphore: max 3 concurrent Oracle requests  │  │
│  └───────────────────────────────────────────────┘  │
│                      │                               │
│  ┌─ Oracle Route Handler ────────────────────────┐  │
│  │  POST /api/v1/oracle                          │  │
│  │  { question, context? } → { answer, sources } │  │
│  │  Translates to invokeForTenant("oracle", ...) │  │
│  └───────────────────┬───────────────────────────┘  │
│                      │ internal call                 │
│                      ▼                               │
│  ┌─ HounfourRouter.invokeForTenant() ────────────┐  │
│  │  Pool selection → Budget → Persona → Knowledge │  │
│  │  enrichment → Model invoke → Billing finalize  │  │
│  │  (Phase 0 — EXISTING, unchanged)               │  │
│  └───────────────────────────────────────────────┘  │
│                      │ reads at startup              │
│                      ▼                               │
│  ┌─ Knowledge Corpus ───────────────────────────────┐
│  │  20+ sources from loa-dixie (build-time COPY)    │
│  │  ~150K tokens, all 7 abstraction levels          │
│  └──────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────┘
```

### 2.2 Phase 1 Change Map

```
┌────────────────────────────────────────────────────────────┐
│ Phase 1 Changes (6 new backend, 4 modified, infra + site)  │
│                                                             │
│ NEW TypeScript (loa-finn):                                  │
│   src/gateway/routes/oracle.ts           ~120 lines         │
│   src/gateway/oracle-rate-limit.ts       ~200 lines         │
│   src/gateway/oracle-auth.ts             ~80 lines          │
│   src/gateway/oracle-concurrency.ts      ~60 lines          │
│   scripts/oracle-keys.sh                 ~120 lines         │
│                                                             │
│ MODIFIED TypeScript:                                        │
│   src/config.ts                          +30 lines          │
│   src/gateway/server.ts                  +20 lines          │
│   src/scheduler/health.ts                +15 lines          │
│   deploy/Dockerfile                      +10 lines          │
│                                                             │
│ NEW Infrastructure:                                         │
│   deploy/terraform/modules/dnft-site/                       │
│     main.tf                              ~200 lines         │
│     variables.tf                         ~50 lines          │
│     outputs.tf                           ~20 lines          │
│   deploy/terraform/oracle-site.tf        ~50 lines          │
│   deploy/terraform/oracle-cert.tf        ~30 lines          │
│   deploy/terraform/dixie-oidc.tf         ~60 lines          │
│                                                             │
│ NEW Frontend (loa-dixie/site/):                             │
│   package.json, next.config.js           Config             │
│   src/app/page.tsx                       Chat UI            │
│   src/components/ChatMessage.tsx         Message render      │
│   src/components/SourceAttribution.tsx   Source panel        │
│   src/components/LevelSelector.tsx       Abstraction picker  │
│   src/lib/oracle-client.ts              API client          │
│   src/lib/markdown-sanitizer.ts         XSS prevention      │
│                                                             │
│ TESTS (loa-finn):                                           │
│   tests/finn/oracle-api.test.ts          API handler tests  │
│   tests/finn/oracle-rate-limit.test.ts   Rate limiter tests │
│   tests/finn/oracle-auth.test.ts         API key auth tests │
│   tests/finn/oracle-xss.test.ts          XSS prevention     │
└────────────────────────────────────────────────────────────┘
```

### 2.3 Invariants

1. **Phase 0 untouched**: No changes to `knowledge-{types,loader,registry,enricher}.ts`. PR #75 code remains exactly as approved.
2. **Existing invoke unaffected**: The `/api/v1/invoke` endpoint, its middleware chain (hounfourAuth + existing rate limiter), and all non-Oracle agents work identically.
3. **Oracle endpoint separation**: `/api/v1/oracle` has its OWN middleware stack (oracle-auth + oracle-rate-limit + concurrency). It does NOT share the existing `hounfourAuth` or `rateLimitMiddleware`.
4. **Redis fail-closed**: If Redis is unreachable, Oracle returns 503. Other endpoints are not affected (they use in-memory rate limiting).

---

## 3. Component Design

### 3.1 Oracle API Route Handler (`src/gateway/routes/oracle.ts`)

BFF endpoint that translates the product-facing Oracle contract into the internal invoke pipeline. Follows the same factory pattern as `createInvokeHandler()` in `invoke.ts:34`.

```typescript
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { HounfourRouter } from "../../hounfour/router.js"
import type { TenantContext } from "../../hounfour/jwt-auth.js"
import { HounfourError } from "../../hounfour/errors.js"

const API_VERSION = "2026-02-17"
const MAX_QUESTION_LENGTH = 10_000
const MAX_CONTEXT_LENGTH = 5_000

interface OracleRequest {
  question: string
  context?: string
  session_id?: string  // reserved, ignored in Phase 1
}

interface OracleResponse {
  answer: string
  sources: Array<{
    id: string
    tags: string[]
    tokens_used: number
  }>
  metadata: {
    knowledge_mode: "full" | "reduced"
    total_knowledge_tokens: number
    knowledge_budget: number
    retrieval_ms: number
    model: string
    session_id: null  // null until sessions implemented
  }
}

export function createOracleHandler(router: HounfourRouter, rateLimiter: OracleRateLimiter) {
  return async (c: Context) => {
    // Oracle uses its own auth — tenant comes from oracle-auth middleware
    const oracleTenant = c.get("oracleTenant") as OracleTenantContext | undefined
    if (!oracleTenant) {
      return c.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, 401)
    }

    let body: OracleRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON body", code: "INVALID_REQUEST" }, 400)
    }

    // Validate question
    if (!body.question || typeof body.question !== "string" || !body.question.trim()) {
      return c.json(
        { error: "question is required and must be a non-empty string", code: "INVALID_REQUEST" },
        400,
      )
    }
    if (body.question.length > MAX_QUESTION_LENGTH) {
      return c.json(
        { error: `question must be ≤${MAX_QUESTION_LENGTH} characters`, code: "INVALID_REQUEST" },
        400,
      )
    }
    if (body.context && body.context.length > MAX_CONTEXT_LENGTH) {
      return c.json(
        { error: `context must be ≤${MAX_CONTEXT_LENGTH} characters`, code: "INVALID_REQUEST" },
        400,
      )
    }

    // Build prompt: question + optional context
    const prompt = body.context
      ? `${body.question}\n\nAdditional context: ${body.context}`
      : body.question

    // Cost reservation: atomic check-and-reserve before invoking model (Flatline IMP-002/SKP-004)
    const reservation = await rateLimiter.reserveCost(
      config.oracle.estimatedCostCents,
      config.oracle.costCeilingCents,
    )
    if (!reservation.allowed) {
      return c.json({ error: "Daily cost ceiling reached", code: "COST_CEILING_EXCEEDED" }, 503)
    }

    try {
      // Delegate to existing invoke pipeline with "oracle" agent
      // Use a synthetic TenantContext for Oracle public/authenticated tiers
      const result = await router.invokeForTenant("oracle", prompt, oracleTenant.asTenant(), "invoke")

      // Reconcile actual cost (best-effort refund of overestimate)
      const actualCostCents = result.metadata.cost_cents ?? config.oracle.estimatedCostCents
      await reservation.release(actualCostCents)

      // Reshape response for product API
      const knowledge = result.metadata.knowledge
      const response: OracleResponse = {
        answer: result.content,
        sources: (knowledge?.knowledge_sources_used ?? []).map((id, i) => ({
          id,
          tags: knowledge?.tags_matched ?? [],
          tokens_used: 0,  // individual source tokens from enricher metadata
        })),
        metadata: {
          knowledge_mode: knowledge?.knowledge_mode ?? "full",
          total_knowledge_tokens: knowledge?.knowledge_tokens_used ?? 0,
          knowledge_budget: knowledge?.knowledge_tokens_budget ?? 0,
          retrieval_ms: knowledge?.knowledge_retrieval_ms ?? 0,
          model: result.metadata.model,
          session_id: null,
        },
      }

      // API version header (PRD §FR-2, Flatline IMP-002)
      c.header("X-Oracle-API-Version", API_VERSION)

      return c.json(response)
    } catch (err) {
      // Release reservation on failure (full refund)
      await reservation.release(0)

      if (err instanceof HounfourError) {
        const statusMap: Record<string, ContentfulStatusCode> = {
          BUDGET_EXCEEDED: 402,
          ORACLE_MODEL_UNAVAILABLE: 422,
          ORACLE_KNOWLEDGE_UNAVAILABLE: 503,
          CONTEXT_OVERFLOW: 413,
          RATE_LIMITED: 429,
        }
        const status = statusMap[err.code] ?? 502
        return c.json({ error: err.message, code: err.code }, status)
      }
      console.error("[oracle] unexpected error:", err)
      return c.json({ error: "Internal error", code: "INTERNAL_ERROR" }, 500)
    }
  }
}
```

**Key design decisions**:
- Separate handler from invoke (not shared middleware) because the request/response contracts differ
- `oracleTenant` is set by `oracleAuthMiddleware`, NOT by `hounfourAuth` — the Oracle has its own auth chain
- `.asTenant()` converts Oracle identity (IP or API key) into a synthetic `TenantContext` for the invoke pipeline. The synthetic tenant MUST conform to the existing `TenantContext` interface (`tenantId`, `scope`, `poolId`, `endpointType`) and pass any downstream validation — tests should assert `invokeForTenant` accepts the synthetic tenant without error (Flatline IMP-003)
- `session_id` accepted but ignored — API contract reserves it for future use
- API version header on every response per Flatline IMP-002
- Cost reservation (`reserveCost` → invoke → `release`) is wired directly into the handler, not as middleware, because it needs access to the model result for reconciliation (Flatline IMP-002/SKP-004)

### 3.2 Oracle Rate Limiter (`src/gateway/oracle-rate-limit.ts`)

Redis-backed rate limiter with three tiers and fail-closed semantics. This is a **new, separate module** from the existing in-memory `RateLimiter` in `rate-limit.ts:11-58`.

```typescript
import type { Context, Next } from "hono"
import type { RedisClient } from "../redis-client.js"

export interface OracleRateLimitConfig {
  dailyCap: number             // Global daily cap (default: 200)
  publicDailyLimit: number     // Per-IP limit (default: 5)
  authenticatedDailyLimit: number  // Per-key limit (default: 50)
  costCeilingCents: number     // Daily cost circuit breaker (default: 2000 = $20)
}

export class OracleRateLimiter {
  constructor(
    private redis: RedisClient,
    private config: OracleRateLimitConfig,
  ) {}

  /**
   * Check all rate limit tiers ATOMICALLY via Redis Lua script.
   * Returns allow/deny with reason.
   *
   * The Lua script checks identity limit, cost ceiling, and global cap
   * in a single atomic operation. Global counter is ONLY incremented
   * if the identity check passes — preventing global counter inflation
   * from over-limit identities. (GPT-5.2 Fix #2)
   *
   * Check order inside Lua (atomic, no partial state):
   *   1. Cost circuit breaker → COST_CEILING_EXCEEDED
   *   2. Per-identity limit → IDENTITY_LIMIT_EXCEEDED
   *   3. Global daily cap → GLOBAL_CAP_EXCEEDED
   *   4. All pass → increment identity + global, return allowed
   */
  private static readonly RATE_LIMIT_LUA = `
    local costKey = KEYS[1]
    local identityKey = KEYS[2]
    local globalKey = KEYS[3]
    local costCeiling = tonumber(ARGV[1])
    local identityLimit = tonumber(ARGV[2])
    local globalCap = tonumber(ARGV[3])
    local ttl = 86400

    -- 1. Cost circuit breaker (read-only check)
    local costCents = tonumber(redis.call('GET', costKey) or '0')
    if costCents >= costCeiling then
      return {'COST_CEILING_EXCEEDED', 0, 0}
    end

    -- 2. Per-identity limit (read-only check)
    local identityCount = tonumber(redis.call('GET', identityKey) or '0')
    if identityCount >= identityLimit then
      return {'IDENTITY_LIMIT_EXCEEDED', identityLimit, 0}
    end

    -- 3. Global daily cap (read-only check)
    local globalCount = tonumber(redis.call('GET', globalKey) or '0')
    if globalCount >= globalCap then
      return {'GLOBAL_CAP_EXCEEDED', 0, 0}
    end

    -- All checks passed — atomically increment both counters
    local newIdentity = redis.call('INCR', identityKey)
    if newIdentity == 1 then redis.call('EXPIRE', identityKey, ttl) end
    local newGlobal = redis.call('INCR', globalKey)
    if newGlobal == 1 then redis.call('EXPIRE', globalKey, ttl) end

    return {'ALLOWED', identityLimit, identityLimit - newIdentity}
  `

  async check(identity: OracleIdentity): Promise<RateLimitResult> {
    const dateKey = utcDateKey()
    const costKey = `oracle:cost:${dateKey}`
    const globalKey = `oracle:global:${dateKey}`
    const { key: identityKey, limit } = identity.type === "api_key"
      ? { key: `oracle:ratelimit:key:${identity.keyHash}:${dateKey}`, limit: this.config.authenticatedDailyLimit }
      : { key: `oracle:ratelimit:ip:${identity.ip}:${dateKey}`, limit: this.config.publicDailyLimit }

    const [reason, luaLimit, remaining] = await this.redis.eval(
      OracleRateLimiter.RATE_LIMIT_LUA,
      3, costKey, identityKey, globalKey,
      this.config.costCeilingCents, limit, this.config.dailyCap,
    ) as [string, number, number]

    if (reason === "ALLOWED") {
      return { allowed: true, reason: null, limit, remaining }
    }

    return {
      allowed: false,
      reason: reason as RateLimitResult["reason"],
      retryAfterSeconds: secondsUntilMidnightUTC(),
      limit: reason === "IDENTITY_LIMIT_EXCEEDED" ? limit : undefined,
      remaining: 0,
    }
  }

  /**
   * Atomic check-and-reserve: reserve estimated cost BEFORE invoking the model,
   * deny if reservation would exceed the ceiling, reconcile after.
   * Uses Lua to guarantee no concurrent overshoot. (GPT-5.2 Fix #3, iteration 2)
   *
   * @param estimatedCostCents - Pessimistic estimate (e.g., max cost for the model)
   * @param costCeilingCents - Daily ceiling from config (e.g., 2000 for $20)
   * @returns { allowed, release } — if !allowed, do NOT invoke the model
   */
  private static readonly RESERVE_COST_LUA = `
    local costKey = KEYS[1]
    local estimatedCost = tonumber(ARGV[1])
    local ceiling = tonumber(ARGV[2])
    local ttl = 86400

    local current = tonumber(redis.call('GET', costKey) or '0')
    if (current + estimatedCost) > ceiling then
      return {0, current}
    end

    local newVal = redis.call('INCRBY', costKey, estimatedCost)
    if newVal == estimatedCost then
      redis.call('EXPIRE', costKey, ttl)
    end
    return {1, newVal}
  `

  async reserveCost(
    estimatedCostCents: number,
    costCeilingCents: number,
  ): Promise<{ allowed: boolean; release: (actualCostCents: number) => Promise<void> }> {
    const costKey = `oracle:cost:${utcDateKey()}`
    const [allowed, _currentCost] = await this.redis.eval(
      OracleRateLimiter.RESERVE_COST_LUA,
      { keys: [costKey], arguments: [String(estimatedCostCents), String(costCeilingCents)] },
    ) as [number, number]

    if (!allowed) {
      return {
        allowed: false,
        release: async () => {}, // no-op, nothing was reserved
      }
    }

    return {
      allowed: true,
      release: async (actualCostCents: number) => {
        // Reconcile: adjust by the difference (may be negative = refund)
        const delta = actualCostCents - estimatedCostCents
        if (delta !== 0) {
          await this.redis.incrBy(costKey, delta).catch(() => {})
        }
      },
    }
  }

  /** Health check: is Redis reachable? */
  async isHealthy(): Promise<boolean> {
    try {
      await this.redis.ping()
      return true
    } catch {
      return false
    }
  }
}

export type OracleIdentity =
  | { type: "ip"; ip: string }
  | { type: "api_key"; keyHash: string; ip: string }

interface RateLimitResult {
  allowed: boolean
  reason: "GLOBAL_CAP_EXCEEDED" | "COST_CEILING_EXCEEDED" | "IDENTITY_LIMIT_EXCEEDED" | null
  retryAfterSeconds?: number
  limit?: number
  remaining?: number
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10) // "2026-02-17"
}

function secondsUntilMidnightUTC(): number {
  const now = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000)
}
```

**Middleware wrapper**:

```typescript
export function oracleRateLimitMiddleware(limiter: OracleRateLimiter) {
  return async (c: Context, next: Next) => {
    const identity = c.get("oracleIdentity") as OracleIdentity | undefined
    if (!identity) {
      // Should never happen — auth middleware sets this
      return c.json({ error: "Identity not established", code: "INTERNAL_ERROR" }, 500)
    }

    let result: RateLimitResult
    try {
      result = await limiter.check(identity)
    } catch {
      // Redis unreachable — FAIL CLOSED (PRD NFR-2, Flatline IMP-003)
      return c.json(
        { error: "Service temporarily unavailable", code: "RATE_LIMITER_UNAVAILABLE" },
        503,
      )
    }

    if (!result.allowed) {
      const status = result.reason === "IDENTITY_LIMIT_EXCEEDED" ? 429 : 503
      if (result.retryAfterSeconds) {
        c.header("Retry-After", String(result.retryAfterSeconds))
      }
      return c.json({ error: "Rate limit exceeded", code: result.reason }, status)
    }

    // Expose remaining for response headers
    if (result.remaining !== undefined) {
      c.header("X-RateLimit-Remaining", String(result.remaining))
      c.header("X-RateLimit-Limit", String(result.limit))
    }

    return next()
  }
}
```

**Redis key schema**:

| Key Pattern | TTL | Type | Purpose |
|-------------|-----|------|---------|
| `oracle:global:{YYYY-MM-DD}` | 24h | counter | Global daily invocation count |
| `oracle:cost:{YYYY-MM-DD}` | 24h | counter | Cumulative daily cost in cents |
| `oracle:ratelimit:ip:{ip}:{YYYY-MM-DD}` | 24h | counter | Per-IP daily request count |
| `oracle:ratelimit:key:{sha256}:{YYYY-MM-DD}` | 24h | counter | Per-API-key daily request count |
| `oracle:apikeys:{sha256}` | none | hash | API key metadata (see §3.3) |

**Design rationale**:
- 24h TTL on date-keyed counters auto-cleans without cron
- **Atomic multi-tier check via Lua script** (GPT-5.2 Fix #2): identity + global counters are incremented atomically only when ALL checks pass. No global counter inflation from over-limit identities.
- **Pessimistic cost reservation** (GPT-5.2 Fix #3): cost is reserved before invoke and reconciled after, preventing concurrent overshoot of the $20 ceiling.
- Fail-closed: any Redis error → 503, never 200 (PRD NFR-2)
- Separate from existing `RateLimiter` because: different algorithm (daily counters vs token bucket), different backing store (Redis vs in-memory), different failure semantics (fail-closed vs continue)

### 3.3 Oracle API Key Auth (`src/gateway/oracle-auth.ts`)

Validates `Authorization: Bearer dk_live_...` tokens against Redis-stored SHA-256 hashes. Falls back to IP-based public tier when no token is provided.

```typescript
import { createHash } from "node:crypto"
import type { Context, Next } from "hono"
import type { RedisClient } from "../redis-client.js"
import type { OracleIdentity } from "./oracle-rate-limit.js"

const API_KEY_PREFIX_LIVE = "dk_live_"
const API_KEY_PREFIX_TEST = "dk_test_"

interface ApiKeyRecord {
  status: "active" | "revoked"
  owner: string
  created_at: string
  last_used_at: string | null
}

export interface OracleTenantContext {
  tier: "public" | "authenticated"
  identity: OracleIdentity
  /** Convert to TenantContext for the invoke pipeline */
  asTenant(): TenantContext
}

export function oracleAuthMiddleware(redis: RedisClient) {
  return async (c: Context, next: Next) => {
    const ip = extractClientIp(c)
    const authHeader = c.req.header("Authorization")

    // Check for API key
    if (authHeader?.startsWith("Bearer dk_")) {
      const token = authHeader.slice(7)
      if (!token.startsWith(API_KEY_PREFIX_LIVE) && !token.startsWith(API_KEY_PREFIX_TEST)) {
        // Invalid prefix — fall through to IP-based
      } else {
        const keyHash = createHash("sha256").update(token).digest("hex")
        try {
          const record = await redis.hGetAll(`oracle:apikeys:${keyHash}`)
          if (record?.status === "active") {
            // Valid API key — authenticated tier
            // Update last_used_at (fire and forget)
            redis.hSet(`oracle:apikeys:${keyHash}`, "last_used_at", new Date().toISOString()).catch(() => {})

            const identity: OracleIdentity = { type: "api_key", keyHash, ip }
            const tenant: OracleTenantContext = {
              tier: "authenticated",
              identity,
              asTenant: () => ({
                tenantId: `dk:${keyHash.slice(0, 12)}`,
                scope: "oracle",
                poolId: "default",
                endpointType: "invoke" as const,
              }),
            }
            c.set("oracleTenant", tenant)
            c.set("oracleIdentity", identity)
            return next()
          }
          // Invalid or revoked key — fall through to IP-based
        } catch {
          // Redis error with Authorization header present — FAIL CLOSED.
          // Do NOT silently downgrade to IP-based (GPT-5.2 Fix #5):
          // a revoked key would regain access as public during partial Redis outage.
          return c.json(
            { error: "Service temporarily unavailable", code: "AUTH_UNAVAILABLE" },
            503,
          )
        }
      }
    }

    // Public tier — IP-based
    const identity: OracleIdentity = { type: "ip", ip }
    const tenant: OracleTenantContext = {
      tier: "public",
      identity,
      asTenant: () => ({
        tenantId: `ip:${ip}`,
        scope: "oracle",
        poolId: "default",
        endpointType: "invoke" as const,
      }),
    }
    c.set("oracleTenant", tenant)
    c.set("oracleIdentity", identity)
    return next()
  }
}

/**
 * Extract client IP from X-Forwarded-For using AWS standard behavior.
 *
 * IP extraction strategy: rightmost-untrusted-hop (Flatline SKP-001b hardening).
 *
 * Our proxy chain is: Client → CloudFront → ALB → ECS.
 * CloudFront and ALB each append one entry to XFF. With TRUSTED_PROXY_COUNT=2,
 * the true client IP is at position parts[parts.length - TRUSTED_PROXY_COUNT - 1].
 * This is immune to client-prepended XFF spoofing because attackers can only
 * add entries to the LEFT; the rightmost entries are always from trusted proxies.
 *
 * Fallback: If CloudFront-Viewer-Address header is available (set by CloudFront,
 * cannot be spoofed), prefer it over XFF parsing.
 *
 * TRUST_XFF env var (default: true in production behind ALB) gates XFF parsing.
 * In local/test environments, falls back to connection remote address.
 *
 * (PRD §3 Rate Limiting, Flatline SKP-001/SKP-001b, GPT-5.2 Fix #1)
 */
const TRUSTED_PROXY_COUNT = 2 // CloudFront + ALB

function extractClientIp(c: Context): string {
  // Prefer CloudFront-Viewer-Address if available (unspoofable)
  const cfViewer = c.req.header("CloudFront-Viewer-Address")
  if (cfViewer) {
    const ip = cfViewer.split(":")[0] // "ip:port" format
    if (ip && isValidIp(ip)) return ip
  }

  const xff = c.req.header("X-Forwarded-For")
  if (xff && config.oracle.trustXff) {
    const parts = xff.split(",").map((s) => s.trim())
    // Rightmost-untrusted-hop: skip the known trusted proxy entries from the right
    const clientIndex = parts.length - TRUSTED_PROXY_COUNT - 1
    if (clientIndex >= 0) {
      const candidate = parts[clientIndex]
      if (candidate && isValidIp(candidate)) return candidate
    }
  }

  // Fall back to connection remote address (not X-Real-IP, which is client-settable)
  return c.env?.remoteAddr ?? "unknown"
}

/** Validate IPv4 or IPv6 address format (reject garbage/spoofed non-IP values) */
function isValidIp(ip: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return true
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return true
  return false
}
```

**API key hash scheme**: `dk_live_<32 hex chars>` → SHA-256 → Redis lookup. The raw key is never stored. SHA-256 is one-way and collision-resistant. Timing-safe comparison is not needed because we're doing a hash lookup, not a string comparison.

**Fallback behavior** (GPT-5.2 Fix #5):
- **No Authorization header**: Public tier (IP-based). Normal path for unauthenticated users.
- **Authorization header with valid `dk_*` prefix but Redis reachable**: Validate key. If active → authenticated tier. If revoked/invalid → fall through to IP-based public tier (no info leakage about key validity).
- **Authorization header with valid `dk_*` prefix but Redis unreachable**: Return 503. Do NOT silently downgrade to IP-based — this would allow revoked keys to regain access during partial Redis outages.
- **Authorization header with non-`dk_*` prefix**: Ignored, fall through to IP-based (not an Oracle key).

### 3.4 Oracle Concurrency Limiter (`src/gateway/oracle-concurrency.ts`)

In-memory semaphore preventing Oracle traffic from starving non-Oracle invoke requests on the shared ECS task (PRD NFR-1, Flatline IMP-010).

```typescript
import type { Context, Next } from "hono"

export class ConcurrencyLimiter {
  private active = 0

  constructor(private maxConcurrent: number) {}

  acquire(): boolean {
    if (this.active >= this.maxConcurrent) return false
    this.active++
    return true
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }

  getActive(): number {
    return this.active
  }
}

export function oracleConcurrencyMiddleware(limiter: ConcurrencyLimiter) {
  return async (c: Context, next: Next) => {
    if (!limiter.acquire()) {
      c.header("Retry-After", "5")
      return c.json(
        { error: "Too many concurrent Oracle requests", code: "ORACLE_CONCURRENCY_EXCEEDED" },
        429,
      )
    }
    try {
      return await next()
    } finally {
      limiter.release()
    }
  }
}
```

**Why in-memory, not Redis**: Concurrency is per-ECS-task (PRD says "per ECS task"), not global. With `desired_count=1` (finn.tf:329), in-memory is correct. If scaling to multiple tasks, each gets its own independent semaphore — which is the desired behavior (max 3 per task, not max 3 globally).

### 3.5 Config Extensions (`src/config.ts`)

Extend `FinnConfig` (currently at config.ts:6-114) with Oracle Phase 1 fields:

```typescript
/** Oracle Phase 1 product surface (Cycle 025 Phase 1) */
oracle: {
  enabled: boolean                // Master toggle (Phase 0, existing)
  sourcesConfigPath: string       // Path to sources.json (Phase 0, existing)
  minContextWindow: number        // Min context for full mode (Phase 0, existing)
  dailyCap: number                // Global daily cap (Phase 1, NEW)
  costCeilingCents: number        // Cost circuit breaker in cents (Phase 1, NEW)
  maxConcurrent: number           // Max concurrent Oracle requests (Phase 1, NEW)
  publicDailyLimit: number        // Per-IP daily limit (Phase 1, NEW)
  authenticatedDailyLimit: number // Per-API-key daily limit (Phase 1, NEW)
  dixieRef: string                // Build-time loa-dixie commit ref (Phase 1, NEW)
}
```

Extension to `loadConfig()` (config.ts:231-235):

```typescript
oracle: {
  enabled: process.env.FINN_ORACLE_ENABLED === "true",
  sourcesConfigPath: process.env.FINN_ORACLE_SOURCES_CONFIG ?? "grimoires/oracle/sources.json",
  minContextWindow: parseIntEnv("FINN_ORACLE_MIN_CONTEXT", "30000"),
  // Phase 1 additions
  dailyCap: parseIntEnv("FINN_ORACLE_DAILY_CAP", "200"),
  costCeilingCents: parseIntEnv("FINN_ORACLE_COST_CEILING_CENTS", "2000"),
  maxConcurrent: parseIntEnv("FINN_ORACLE_MAX_CONCURRENT", "3"),
  publicDailyLimit: parseIntEnv("FINN_ORACLE_PUBLIC_DAILY_LIMIT", "5"),
  authenticatedDailyLimit: parseIntEnv("FINN_ORACLE_AUTH_DAILY_LIMIT", "50"),
  estimatedCostCents: parseIntEnv("FINN_ORACLE_ESTIMATED_COST_CENTS", "50"),
  trustXff: process.env.FINN_ORACLE_TRUST_XFF !== "false",  // default: true
  corsOrigins: (process.env.FINN_ORACLE_CORS_ORIGINS ?? "https://oracle.arrakis.community").split(","),
  dixieRef: process.env.DIXIE_REF ?? "unknown",
},
```

**Environment variables (new)**:

| Variable | Default | Description |
|----------|---------|-------------|
| `FINN_ORACLE_DAILY_CAP` | `200` | Global daily invocation cap |
| `FINN_ORACLE_COST_CEILING_CENTS` | `2000` | Daily cost circuit breaker ($20) |
| `FINN_ORACLE_MAX_CONCURRENT` | `3` | Max concurrent Oracle requests per ECS task |
| `FINN_ORACLE_PUBLIC_DAILY_LIMIT` | `5` | Per-IP daily limit (public tier) |
| `FINN_ORACLE_AUTH_DAILY_LIMIT` | `50` | Per-API-key daily limit (authenticated tier) |
| `FINN_ORACLE_ESTIMATED_COST_CENTS` | `50` | Pessimistic per-request cost estimate for reservation |
| `FINN_ORACLE_TRUST_XFF` | `true` | Parse X-Forwarded-For (disable for local dev) |
| `FINN_ORACLE_CORS_ORIGINS` | `https://oracle.arrakis.community` | Comma-separated allowed CORS origins |
| `DIXIE_REF` | `unknown` | Loa-dixie commit SHA (set at Docker build time) |

### 3.6 Server Registration (`src/gateway/server.ts`)

Register Oracle routes with a separate middleware chain. Insertion point: after the existing invoke registration (server.ts:126-128).

```typescript
// src/gateway/server.ts additions

import { createOracleHandler } from "./routes/oracle.js"
import { oracleAuthMiddleware } from "./oracle-auth.js"
import { oracleRateLimitMiddleware, OracleRateLimiter } from "./oracle-rate-limit.js"
import { oracleConcurrencyMiddleware, ConcurrencyLimiter } from "./oracle-concurrency.js"

// In AppOptions interface (server.ts:22-34):
export interface AppOptions {
  // ... existing fields ...
  /** Oracle rate limiter (Phase 1) */
  oracleRateLimiter?: OracleRateLimiter
  /** Redis client for Oracle auth (Phase 1) */
  redisClient?: RedisClient
}

// In createApp() — BEFORE the existing /api/v1/* middleware (server.ts:116-123):

// Oracle product endpoint — dedicated sub-app with its own middleware chain.
// MUST be registered BEFORE the /api/v1/* wildcard middleware to prevent
// hounfourAuth and rateLimitMiddleware from executing on Oracle requests.
// Using app.route() guarantees middleware isolation regardless of registration order.
// (GPT-5.2 Fix #4)
if (options.hounfour && config.oracle.enabled && options.oracleRateLimiter && options.redisClient) {
  const oracleApp = new Hono()
  const concurrencyLimiter = new ConcurrencyLimiter(config.oracle.maxConcurrent)

  oracleApp.use("*", oracleCorsMiddleware(config.oracle.corsOrigins))  // Flatline IMP-001
  oracleApp.use("*", oracleAuthMiddleware(options.redisClient))
  oracleApp.use("*", oracleRateLimitMiddleware(options.oracleRateLimiter))
  oracleApp.use("*", oracleConcurrencyMiddleware(concurrencyLimiter))
  oracleApp.post("/", createOracleHandler(options.hounfour, options.oracleRateLimiter))
  app.route("/api/v1/oracle", oracleApp)
}

// Existing /api/v1/* middleware — add explicit skip guard for Oracle path
// to prevent double-processing in case of Hono routing edge cases:
const isOraclePath = (path: string) =>
  path === "/api/v1/oracle" || path.startsWith("/api/v1/oracle/")

app.use("/api/v1/*", async (c, next) => {
  if (isOraclePath(c.req.path)) return next() // Handled by oracleApp
  return rateLimitMiddleware(config)(c, next)
})
app.use("/api/v1/*", async (c, next) => {
  if (isOraclePath(c.req.path)) return next() // Handled by oracleApp
  return hounfourAuth(config)(c, next)
})
```

**Middleware isolation** (GPT-5.2 Fix #4, hardened in iteration 2): The Oracle uses a dedicated Hono sub-app mounted via `app.route()`. This guarantees that `hounfourAuth` and `rateLimitMiddleware` (the existing `/api/v1/*` middleware) never execute on Oracle requests. An additional explicit skip guard using a prefix check (`isOraclePath` — matches both `/api/v1/oracle` and `/api/v1/oracle/...`) provides defense-in-depth against trailing slashes and future subpaths. A test MUST assert that the wildcard middleware is not invoked for `/api/v1/oracle` or `/api/v1/oracle/`.

**CORS middleware** (Flatline IMP-001): The Oracle frontend (loa-dixie, hosted on a different subdomain) makes cross-origin requests to the Oracle API. The `oracleCorsMiddleware` handles preflight (`OPTIONS`) and actual requests:

```typescript
function oracleCorsMiddleware(allowedOrigins: string[]) {
  return async (c: Context, next: Next) => {
    const origin = c.req.header("Origin")
    if (origin && allowedOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Access-Control-Allow-Methods", "POST, OPTIONS")
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Oracle-API-Version")
      c.header("Access-Control-Max-Age", "86400")
      // No credentials — API keys are passed via Authorization header, not cookies
    }
    if (c.req.method === "OPTIONS") return c.text("", 204)
    return next()
  }
}
```

`config.oracle.corsOrigins` defaults to `["https://oracle.arrakis.community"]` in production and `["http://localhost:3000"]` in development.

### 3.7 Health Extensions (`src/scheduler/health.ts`)

Extend health status (health.ts:12-66) with Oracle Phase 1 fields:

```typescript
// Add to HealthStatus.checks:
oracle?: {
  ready: boolean
  sources_loaded: number
  total_tokens: number
  missing_required: string[]
  // Phase 1 additions:
  rate_limiter_healthy: boolean
  knowledge_dixie_ref: string
  daily_usage: {
    global_count: number
    global_cap: number
    cost_cents: number
    cost_ceiling_cents: number
  } | null
}
```

**HealthDeps extension** (health.ts:68-83):

```typescript
getOracleRateLimiterHealth?: () => Promise<boolean>
getOracleDailyUsage?: () => Promise<{ globalCount: number; costCents: number } | null>
dixieRef?: string
```

**Health aggregation** — Oracle rate limiter health does NOT affect overall status. The Oracle section is informational only (per PRD: "Oracle degradation is isolated"):

```typescript
// After existing oracle health block:
if (oracleHealth) {
  const rateLimiterHealthy = await this.deps.getOracleRateLimiterHealth?.() ?? false
  const dailyUsage = await this.deps.getOracleDailyUsage?.() ?? null

  checks.oracle = {
    ...checks.oracle,
    rate_limiter_healthy: rateLimiterHealthy,
    knowledge_dixie_ref: this.deps.dixieRef ?? "unknown",
    daily_usage: dailyUsage ? {
      global_count: dailyUsage.globalCount,
      global_cap: config.oracle.dailyCap,
      cost_cents: dailyUsage.costCents,
      cost_ceiling_cents: config.oracle.costCeilingCents,
    } : null,
  }
}
```

### 3.8 Oracle API Key CLI (`scripts/oracle-keys.sh`)

Admin script for minimal key lifecycle management (PRD §3, Flatline SKP-006).

```bash
#!/usr/bin/env bash
# scripts/oracle-keys.sh — Oracle API key management
# Usage: ./scripts/oracle-keys.sh create|revoke|list [options]

set -euo pipefail

REDIS_URL="${REDIS_URL:?REDIS_URL required}"
PREFIX_LIVE="dk_live_"
PREFIX_TEST="dk_test_"

case "${1:-}" in
  create)
    owner="${2:?Usage: oracle-keys.sh create <owner> [--test]}"
    prefix="${PREFIX_LIVE}"
    [[ "${3:-}" == "--test" ]] && prefix="${PREFIX_TEST}"

    # Generate 32-byte hex key
    raw_key="${prefix}$(openssl rand -hex 32)"
    key_hash=$(echo -n "$raw_key" | sha256sum | cut -d' ' -f1)

    # Store in Redis
    redis-cli -u "$REDIS_URL" HSET "oracle:apikeys:${key_hash}" \
      status active \
      owner "$owner" \
      created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      last_used_at ""

    echo "Created key for ${owner}:"
    echo "  Key:  ${raw_key}"
    echo "  Hash: ${key_hash}"
    echo ""
    echo "IMPORTANT: Store this key securely. It cannot be recovered."
    ;;

  revoke)
    key_hash="${2:?Usage: oracle-keys.sh revoke <key_hash>}"
    redis-cli -u "$REDIS_URL" HSET "oracle:apikeys:${key_hash}" status revoked
    echo "Revoked key: ${key_hash}"
    ;;

  list)
    echo "Active Oracle API keys:"
    for key in $(redis-cli -u "$REDIS_URL" --scan --pattern "oracle:apikeys:*"); do
      status=$(redis-cli -u "$REDIS_URL" HGET "$key" status)
      owner=$(redis-cli -u "$REDIS_URL" HGET "$key" owner)
      created=$(redis-cli -u "$REDIS_URL" HGET "$key" created_at)
      last_used=$(redis-cli -u "$REDIS_URL" HGET "$key" last_used_at)
      hash=${key#oracle:apikeys:}
      echo "  ${hash:0:12}... | ${status} | ${owner} | created: ${created} | last used: ${last_used:-never}"
    done
    ;;

  *)
    echo "Usage: oracle-keys.sh create|revoke|list"
    exit 1
    ;;
esac
```

---

## 4. Data Architecture

### 4.1 Knowledge Sources Config

Retained from SDD v2.0.0 §4.1. The `sources.json` format, provenance frontmatter, and citation substrate are unchanged.

**Phase 1 change**: The canonical `sources.json` moves from `grimoires/oracle/sources.json` (loa-finn) to `loa-dixie/knowledge/sources.json`. The Docker image copies it to the same path. The `FINN_ORACLE_SOURCES_CONFIG` env var still defaults to `grimoires/oracle/sources.json` — the path inside the container remains the same.

### 4.2 Redis Key Schema (Phase 1)

All Oracle Redis keys use the `oracle:` prefix for namespace isolation:

| Key Pattern | Type | TTL | Content |
|-------------|------|-----|---------|
| `oracle:global:{date}` | string (counter) | 24h | Daily global invocation count |
| `oracle:cost:{date}` | string (counter) | 24h | Daily cumulative cost in cents |
| `oracle:ratelimit:ip:{ip}:{date}` | string (counter) | 24h | Per-IP daily count |
| `oracle:ratelimit:key:{hash}:{date}` | string (counter) | 24h | Per-API-key daily count |
| `oracle:apikeys:{hash}` | hash | none | `{ status, owner, created_at, last_used_at }` |

**Date format**: `YYYY-MM-DD` in UTC. TTL set on first `INCR` (atomic creation). Keys auto-expire — no cleanup cron needed.

**Cost tracking with atomic check-and-reserve** (GPT-5.2 Fix #3, hardened in iteration 2): `oracle:cost:{date}` accumulates model inference cost in cents. The Oracle handler uses an **atomic check-and-reserve pattern** via a dedicated Lua script: (1) before invoking the model, call `rateLimiter.reserveCost(estimatedCostCents, costCeilingCents)` which atomically reads the current cost, verifies `(current + estimate) <= ceiling`, and only INCRBYs if allowed — returning `{ allowed: false }` if the ceiling would be exceeded, (2) if allowed, after the invoke completes, call `reservation.release(actualCostCents)` to reconcile the difference. This guarantees no concurrent overshoot of the $20 ceiling because the Lua script is atomic in Redis. If the invoke fails, the reservation is released with `actualCostCents=0` (full refund). The estimated cost per model is derived from the pool configuration's max output tokens and per-token pricing.

### 4.3 Extended Knowledge Corpus

Phase 1 expands from 10 to 20+ sources. The source taxonomy (7 abstraction levels), gold-set contract, and deterministic ordering contract are defined in PRD §FR-3 and implemented by the Phase 0 enricher (SDD v2.0.0 §3.4). No enricher changes needed — the additional sources are loaded by the existing `KnowledgeRegistry.fromConfig()` at startup.

**Corpus location**: All sources move to `loa-dixie/knowledge/sources/`. The `sources.json` registry is at `loa-dixie/knowledge/sources.json`. These are copied into the Docker image at build time (see §7).

---

## 5. API Design

### 5.1 Oracle Product API

**Request**:
```http
POST /api/v1/oracle
Content-Type: application/json
Authorization: Bearer dk_live_a1b2c3... (optional)

{
  "question": "How does the billing settlement flow work?",
  "context": "I'm looking at the arrakis credit ledger",
  "session_id": "abc-123"
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `question` | string | Yes | 1-10,000 chars |
| `context` | string | No | 0-5,000 chars |
| `session_id` | string | No | Ignored in Phase 1, reserved for future |

**Response** (200):
```json
{
  "answer": "The billing settlement flow...",
  "sources": [
    { "id": "code-reality-arrakis", "tags": ["billing", "arrakis"], "tokens_used": 5200 },
    { "id": "rfcs", "tags": ["billing", "architecture"], "tokens_used": 3100 }
  ],
  "metadata": {
    "knowledge_mode": "full",
    "total_knowledge_tokens": 8300,
    "knowledge_budget": 30000,
    "retrieval_ms": 12,
    "model": "claude-sonnet-4-5-20250929",
    "session_id": null
  }
}
```

**Response headers**:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Oracle-API-Version` | `2026-02-17` | Date-based API versioning (Flatline IMP-002) |
| `X-RateLimit-Remaining` | `4` | Remaining requests in daily quota |
| `X-RateLimit-Limit` | `5` or `50` | Total daily quota for this identity |
| `Retry-After` | `3600` | Seconds until rate limit resets (only on 429/503) |

**Error responses**:

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_REQUEST` | Missing/invalid `question`, body parse failure |
| 401 | `AUTH_REQUIRED` | Auth middleware failed to establish identity |
| 402 | `BUDGET_EXCEEDED` | Hounfour scope budget exhausted |
| 413 | `CONTEXT_OVERFLOW` | Enriched prompt exceeds model context window |
| 422 | `ORACLE_MODEL_UNAVAILABLE` | Routed model has < 30K context |
| 429 | `IDENTITY_LIMIT_EXCEEDED` | Per-IP or per-key daily limit hit |
| 429 | `ORACLE_CONCURRENCY_EXCEEDED` | Max concurrent Oracle requests reached |
| 503 | `GLOBAL_CAP_EXCEEDED` | 200 daily Oracle invocations reached |
| 503 | `COST_CEILING_EXCEEDED` | $20 daily cost ceiling reached |
| 503 | `AUTH_UNAVAILABLE` | Redis unreachable during API key validation (GPT-5.2 Fix #5) |
| 503 | `RATE_LIMITER_UNAVAILABLE` | Redis unreachable during rate limit check (fail-closed) |
| 502 | (varies) | Upstream provider error |

### 5.2 API Versioning (Flatline IMP-002)

Date-based versioning per PRD §FR-2:

- Every Oracle response includes `X-Oracle-API-Version: 2026-02-17`
- Clients can send `Oracle-API-Version` request header to pin behavior
- Old versions supported for 90 days after successor ships
- Sunset header (`Sunset: <HTTP-date>`) added when a version is deprecated (per RFC 8594)

Phase 1 ships a single version. The versioning infrastructure is in place for future iterations.

### 5.3 Health Endpoint Extension

The existing `/health` endpoint (server.ts:56-91) is extended with Phase 1 Oracle fields:

```json
{
  "status": "healthy",
  "checks": {
    "oracle": {
      "ready": true,
      "sources_loaded": 22,
      "total_tokens": 148000,
      "missing_required": [],
      "rate_limiter_healthy": true,
      "knowledge_dixie_ref": "a1b2c3d4e5f6",
      "daily_usage": {
        "global_count": 47,
        "global_cap": 200,
        "cost_cents": 812,
        "cost_ceiling_cents": 2000
      }
    }
  }
}
```

---

## 6. Security Architecture

### 6.1 Phase 0 Security (Retained)

All Phase 0 security measures from SDD v2.0.0 §6 remain in force:
- Knowledge loader 5-gate security (absolute path, path escape, symlink file, symlink parent, injection)
- Trust boundary template (`<reference_material>` data/instruction separation)
- Red-team test suite (10+ adversarial prompts)
- Advisory mode for curated sources under `grimoires/oracle/`
- `detectInjection()` reused from persona-loader.ts

### 6.2 Redis Fail-Closed & Connection Lifecycle (Flatline IMP-003, IMP-004, SKP-003)

**Policy**: If Redis is unreachable, the Oracle API returns HTTP 503 — never 200. This is enforced at the rate limiter middleware level: any exception from `limiter.check()` triggers a 503 response.

**Rationale**: Fail-open on a public endpoint with expensive model inference is a denial-of-wallet risk. An attacker who can disrupt Redis would get unlimited free Oracle queries.

**Monitoring**: The health endpoint reports `rate_limiter_healthy: true/false` AND `oracle_status: "healthy" | "degraded" | "unavailable"`. A CloudWatch alarm fires if Redis is unreachable for >60s. The `/health` oracle_status MUST be wired to operational alerts so Redis outages are visible as user-impacting events (Flatline SKP-003).

**Redis Connection Lifecycle** (Flatline IMP-004):
- **Client creation**: A single `ioredis` client is created at server startup in `src/gateway/server.ts` and injected into `OracleRateLimiter` and `oracleAuthMiddleware` via `AppOptions.redisClient`. No per-request connections.
- **Connection reuse**: All Oracle components share the same Redis client instance. The client maintains a persistent TCP connection with automatic reconnection (ioredis default: exponential backoff, max 20 retries).
- **Timeouts**: `connectTimeout: 5000ms`, `commandTimeout: 2000ms`. Commands that exceed timeout trigger fail-closed 503.
- **Retry strategy**: ioredis built-in retry with `retryStrategy: (times) => Math.min(times * 200, 3000)`. After max retries exhausted, client emits `error` event and subsequent commands fail immediately until reconnected.
- **Lifecycle**: Client is created in `buildServer()`, passed to Oracle components, and closed in the server shutdown handler (`process.on("SIGTERM")`).

**Redis Deployment Topology** (Flatline SKP-003):
- **Production**: Amazon ElastiCache Redis with Multi-AZ enabled (automatic failover). Single-node cluster mode disabled (simple primary + read replica). This provides sub-second failover on primary failure.
- **Connection string**: `REDIS_URL` env var points to the ElastiCache primary endpoint. On failover, the DNS endpoint automatically resolves to the new primary.
- **Terraform**: The existing `finn.tf` ElastiCache resource MUST be configured with `automatic_failover_enabled = true` and `num_cache_clusters = 2` (primary + replica).
- **Development/staging**: Single Redis instance (no replication). Acceptable because cost protection is less critical in non-production.

### 6.3 Client IP Extraction (Flatline SKP-001/SKP-001b, GPT-5.2 Fix #1)

The request path is: Client → CloudFront → ALB → ECS (TRUSTED_PROXY_COUNT = 2).

**Strategy: rightmost-untrusted-hop** (Flatline SKP-001b hardening). Attackers can prepend arbitrary entries to the left of XFF, but the rightmost entries are always appended by trusted proxies. With 2 known trusted proxies, the true client is at `parts[parts.length - 3]`.

```
X-Forwarded-For: <spoofed>, <true-client-ip>, <cloudfront-ip>, <alb-ip>
                              ^^^^^^^^^^^^^^^^
                              parts[length - TRUSTED_PROXY_COUNT - 1]
```

**Preferred: CloudFront-Viewer-Address** header (set by CloudFront, cannot be spoofed by clients). If present, extract IP from `"ip:port"` format. This completely bypasses XFF parsing and is immune to spoofing.

**XFF gating**: The `TRUST_XFF` config flag (default: `true` in production behind ALB) controls whether XFF is parsed at all. In local/test environments, falls back to connection remote address.

**Validation**: The extracted IP is validated as a syntactically correct IPv4 or IPv6 address. If validation fails (garbage value, non-IP string), fall back to the connection remote address from the runtime. `X-Real-IP` is NOT used as a fallback because it is client-settable.

**Network-level invariant**: ECS security groups MUST only accept traffic from the ALB. ALB MUST only accept traffic from CloudFront (via AWS-managed prefix list or WAF). This ensures XFF is always set by trusted infrastructure.

**Acceptance tests** (PRD §3):
1. Spoofed `X-Forwarded-For` headers (`"evil-ip, real-ip, cf-ip, alb-ip"`) — rightmost-untrusted-hop correctly extracts `real-ip`, not attacker-controlled `evil-ip`
2. CloudFront-Viewer-Address header takes precedence over XFF when present
3. Integration test with real ALB + CloudFront header chain to lock the algorithm
4. Invalid/expired API keys fall back to IP-based limiting
5. The 6th request from the same IP within 24h returns HTTP 429
6. Non-IP values in `X-Forwarded-For` fall back to connection remote address
7. Direct-to-ECS requests (bypassing ALB) are rejected by security group

### 6.4 Browser Security Headers (Flatline IMP-004)

Applied via CloudFront response header policy on the Oracle frontend distribution:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://finn.arrakis.community; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

**CSP key decisions**:
- `connect-src` allows `finn.arrakis.community` for API calls
- `frame-ancestors 'none'` prevents clickjacking
- `'unsafe-inline'` for style-src only (required for CSS-in-JS patterns in Next.js)
- No `'unsafe-eval'` — Next.js static export does not require it

### 6.5 UI Rendering Safety (PRD NFR-2)

**Non-negotiable rule**: The frontend renders model-generated `answer` text as **sanitized markdown** with HTML tags stripped. No `dangerouslySetInnerHTML`, no raw HTML passthrough.

The source attribution panel renders only `source.id`, `source.tags`, and `source.tokens_used` — no raw knowledge excerpts in Phase 1.

**Implementation**: A `markdown-sanitizer.ts` utility in loa-dixie/site/ strips all HTML tags from the markdown before rendering. This is defense-in-depth — the model boundary (Phase 0 trust envelope) already prevents injection, but the UI boundary adds a second layer.

**Automated test**: An XSS test injects `<script>alert(1)</script>` in a knowledge source and confirms it cannot execute in the browser DOM.

### 6.6 API Key Security

- Keys are 32-byte hex with a recognizable prefix (`dk_live_`, `dk_test_`)
- Server stores SHA-256 hash only — raw key never persisted
- Revocation is immediate (Redis `HSET status revoked`)
- Invalid keys fall back to IP-based limiting (no information leakage about key validity)
- Key creation and revocation events logged as structured JSON to CloudWatch
- No rotation or scoped keys for Phase 1

---

## 7. Knowledge Sync Pipeline

### 7.1 CI-Fetch Strategy (Flatline SKP-003)

The knowledge sync happens in a **CI step before the Docker build**, not inside the Dockerfile. This eliminates outbound network access during image construction.

**CI pipeline**:

```yaml
# .github/workflows/build.yml (relevant steps)
- name: Fetch loa-dixie knowledge
  env:
    DIXIE_REF: ${{ vars.DIXIE_REF }}
  run: |
    # Enforce immutable ref for production builds
    if [[ "$GITHUB_REF" == "refs/heads/main" ]]; then
      if [[ ! "$DIXIE_REF" =~ ^[0-9a-f]{40}$ ]] && [[ ! "$DIXIE_REF" =~ ^v[0-9] ]]; then
        echo "ERROR: DIXIE_REF must be a commit SHA or semver tag for production builds"
        exit 1
      fi
    fi

    # Fetch archive
    curl -fsSL "https://github.com/0xHoneyJar/loa-dixie/archive/${DIXIE_REF}.tar.gz" \
      -o /tmp/dixie.tar.gz

    # Extract knowledge into build context
    tar -xzf /tmp/dixie.tar.gz -C /tmp
    cp -r /tmp/loa-dixie-*/knowledge deploy/build-context/oracle-knowledge
    cp -r /tmp/loa-dixie-*/persona deploy/build-context/oracle-persona

    # Record provenance
    echo "$DIXIE_REF" > deploy/build-context/DIXIE_REF

- name: Build Docker image
  run: |
    docker build \
      --build-arg DIXIE_REF=$(cat deploy/build-context/DIXIE_REF) \
      --label "dixie.ref=${DIXIE_REF}" \
      --label "dixie.commit=$(git -C /tmp/loa-dixie-* rev-parse HEAD 2>/dev/null || echo ${DIXIE_REF})" \
      --label "build.timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      -f deploy/Dockerfile .
```

### 7.2 Dockerfile Changes

Modify `deploy/Dockerfile` to `COPY` from build context instead of `ADD` from GitHub:

```dockerfile
# After COPY grimoires/ ./grimoires/ (line 50):

# Oracle knowledge corpus from loa-dixie (CI-fetched, no network)
COPY deploy/build-context/oracle-knowledge/ ./grimoires/oracle-dixie/
COPY deploy/build-context/oracle-persona/ ./grimoires/oracle-persona/

# Provenance
ARG DIXIE_REF=unknown
ENV DIXIE_REF=${DIXIE_REF}
```

**Source path migration**: The `FINN_ORACLE_SOURCES_CONFIG` env var should point to `grimoires/oracle-dixie/sources.json` (the loa-dixie version). The existing `grimoires/oracle/sources.json` in loa-finn is replaced by a README pointing to loa-dixie.

### 7.3 Freshness Checker

A **separate CI job** (not inside the Docker build) runs daily:

```yaml
# .github/workflows/dixie-freshness.yml
name: Check Dixie Freshness
on:
  schedule:
    - cron: '0 9 * * *'  # Daily at 9am UTC

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Compare pinned ref vs HEAD
        run: |
          PINNED_REF="${{ vars.DIXIE_REF }}"
          HEAD_SHA=$(gh api repos/0xHoneyJar/loa-dixie/commits/main --jq .sha)

          # Check if pinned ref is >7 days behind HEAD
          PINNED_DATE=$(gh api "repos/0xHoneyJar/loa-dixie/commits/${PINNED_REF}" --jq .commit.committer.date)
          DAYS_BEHIND=$(( ($(date +%s) - $(date -d "$PINNED_DATE" +%s)) / 86400 ))

          if [[ $DAYS_BEHIND -gt 7 ]]; then
            echo "DIXIE_REF is ${DAYS_BEHIND} days behind HEAD — opening bump PR"
            # Create PR to bump DIXIE_REF
          fi
```

### 7.4 Sync Failure Semantics (Flatline IMP-001)

- **CI**: If the fetch fails, CI fails fast. No stale-cache fallback.
- **Local dev**: `DIXIE_FALLBACK_LOCAL=true` allows using a previously-fetched local copy with a WARN log.
- **Error message**: `"DIXIE_REF fetch failed: {HTTP status}"` — clear and actionable.

---

## 8. Infrastructure Architecture

### 8.1 Terraform Module: dNFT Site (`deploy/terraform/modules/dnft-site/`)

Reusable module parameterized by subdomain name. Adding the next dNFT website = one module block.

**`modules/dnft-site/variables.tf`**:

```hcl
variable "subdomain" {
  description = "Subdomain for the dNFT site (e.g., 'oracle' → oracle.arrakis.community)"
  type        = string
}

variable "domain" {
  description = "Base domain"
  type        = string
  default     = "arrakis.community"
}

variable "zone_id" {
  description = "Route 53 hosted zone ID"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (wildcard)"
  type        = string
}

variable "api_domain" {
  description = "Backend API domain for CSP connect-src"
  type        = string
  default     = "finn.arrakis.community"
}

variable "environment" {
  description = "Environment (production, staging)"
  type        = string
  default     = "production"
}
```

**`modules/dnft-site/main.tf`**:

```hcl
# S3 bucket — private, CloudFront OAI only
# Bucket name includes account ID for global uniqueness (GPT-5.2 Fix #6)
resource "aws_s3_bucket" "site" {
  bucket = "${var.subdomain}-site-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "${var.subdomain}-site"
    Type = "dnft-site"
  }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront Origin Access Identity
resource "aws_cloudfront_origin_access_identity" "site" {
  comment = "${var.subdomain}.${var.domain} OAI"
}

# S3 bucket policy — CloudFront OAI only
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontOAI"
      Effect    = "Allow"
      Principal = { AWS = aws_cloudfront_origin_access_identity.site.iam_arn }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
    }]
  })
}

# CloudFront response headers policy (CSP + HSTS)
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.subdomain}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://${var.api_domain}; frame-ancestors 'none'"
      override                = true
    }
  }
}

# CloudFront distribution
resource "aws_cloudfront_distribution" "site" {
  origin {
    domain_name = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id   = "s3-${var.subdomain}"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.site.cloudfront_access_identity_path
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = ["${var.subdomain}.${var.domain}"]

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "s3-${var.subdomain}"
    viewer_protocol_policy     = "redirect-to-https"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  # SPA fallback — serve index.html for all unmatched routes
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "${var.subdomain}-site-cdn"
    Type = "dnft-site"
  }
}

# Route 53 record
resource "aws_route53_record" "site" {
  zone_id = var.zone_id
  name    = "${var.subdomain}.${var.domain}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
```

**`modules/dnft-site/outputs.tf`**:

```hcl
output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "s3_bucket_name" {
  value = aws_s3_bucket.site.id
}

output "s3_bucket_arn" {
  value = aws_s3_bucket.site.arn
  description = "S3 bucket ARN for IAM policies (GPT-5.2 Fix #8)"
}

output "site_url" {
  value = "https://${var.subdomain}.${var.domain}"
}
```

### 8.2 Oracle Site Invocation (`deploy/terraform/oracle-site.tf`)

```hcl
# CloudFront requires ACM certs in us-east-1 (GPT-5.2 Fix #7)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

# Wildcard certificate for all dNFT subdomains — MUST be in us-east-1 for CloudFront
resource "aws_acm_certificate" "wildcard" {
  provider          = aws.us_east_1
  domain_name       = "*.arrakis.community"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "arrakis-wildcard"
  }
}

resource "aws_route53_record" "wildcard_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.arrakis.zone_id
}

resource "aws_acm_certificate_validation" "wildcard" {
  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for record in aws_route53_record.wildcard_validation : record.fqdn]
}

data "aws_route53_zone" "arrakis" {
  name = "arrakis.community"
}

# Oracle site — first dNFT using the module
module "oracle_site" {
  source = "./modules/dnft-site"

  subdomain           = "oracle"
  domain              = "arrakis.community"
  zone_id             = data.aws_route53_zone.arrakis.zone_id
  acm_certificate_arn = aws_acm_certificate.wildcard.arn
  api_domain          = "finn.arrakis.community"
  environment         = var.environment

  depends_on = [aws_acm_certificate_validation.wildcard]
}
```

### 8.3 GitHub Actions OIDC for loa-dixie Deployment (`deploy/terraform/dixie-oidc.tf`)

```hcl
# OIDC provider for GitHub Actions (may already exist in arrakis account)
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# IAM role for loa-dixie site deployment
resource "aws_iam_role" "dixie_site_deploy" {
  name = "dixie-site-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:0xHoneyJar/loa-dixie:ref:refs/heads/main"
        }
      }
    }]
  })
}

# Least-privilege: S3 PutObject + CloudFront InvalidateCache only
resource "aws_iam_role_policy" "dixie_site_deploy" {
  name = "dixie-site-deploy-policy"
  role = aws_iam_role.dixie_site_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [
          module.oracle_site.s3_bucket_arn,
          "${module.oracle_site.s3_bucket_arn}/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${module.oracle_site.cloudfront_distribution_id}"
      },
    ]
  })
}
```

---

## 9. Frontend Architecture (loa-dixie/site/)

### 9.1 Technology Choices

| Choice | Rationale |
|--------|-----------|
| Next.js | Standard React meta-framework, static export for S3, large ecosystem |
| Static export (`output: "export"`) | S3-friendly, no server required, Cloudflare Pages compatible |
| Tailwind CSS | Utility-first, dark mode built-in, no component library lock-in |
| No heavy component libraries | Keeps bundle small, avoids framework lock-in (PRD FR-5) |

### 9.2 Component Structure

```
loa-dixie/site/
├── next.config.js               # output: "export", basePath: ""
├── package.json
├── tailwind.config.ts
├── src/
│   ├── app/
│   │   ├── layout.tsx           # Dark mode default, Oracle branding
│   │   └── page.tsx             # Main chat interface
│   ├── components/
│   │   ├── ChatInput.tsx        # Question input + level selector
│   │   ├── ChatMessage.tsx      # Sanitized markdown render
│   │   ├── SourceAttribution.tsx # Collapsible source panel
│   │   ├── LevelSelector.tsx    # Technical/Product/Cultural/All
│   │   └── RateLimitBanner.tsx  # Friendly rate limit messaging
│   └── lib/
│       ├── oracle-client.ts     # fetch wrapper for /api/v1/oracle
│       └── markdown-sanitizer.ts # Strip HTML tags from answer
```

### 9.3 Oracle API Client

```typescript
// src/lib/oracle-client.ts
const ORACLE_API = process.env.NEXT_PUBLIC_ORACLE_API_URL
  ?? "https://finn.arrakis.community/api/v1/oracle"

export async function askOracle(
  question: string,
  options?: { context?: string; apiKey?: string },
): Promise<OracleResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (options?.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`
  }

  const response = await fetch(ORACLE_API, {
    method: "POST",
    headers,
    body: JSON.stringify({
      question,
      context: options?.context,
    }),
  })

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After")
    throw new RateLimitError(retryAfter ? parseInt(retryAfter) : 86400)
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }))
    throw new OracleError(response.status, error.code, error.error)
  }

  return response.json()
}
```

### 9.4 Markdown Sanitizer (Flatline SKP-005)

```typescript
// src/lib/markdown-sanitizer.ts
// Uses DOMPurify for battle-tested HTML sanitization of model-generated content.
// Regex-based stripping is insufficient (malformed tags, HTML entities, javascript: URIs).
import DOMPurify from "dompurify"

const ALLOWED_TAGS = ["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "h1", "h2", "h3", "blockquote"]
const ALLOWED_ATTR = ["href"]

export function sanitizeMarkdown(raw: string): string {
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["style", "onerror", "onclick"],
  })
}
```

The sanitized output is then rendered via `react-markdown` configured with `rehype-sanitize` (using the `defaultSchema` from `hast-util-sanitize`). `rehype-raw` MUST be disabled. The `javascript:` protocol MUST be blocked in link hrefs (DOMPurify handles this by default). The key constraint: **no `dangerouslySetInnerHTML` anywhere in the Oracle UI**. Tests MUST cover OWASP XSS filter evasion vectors including malformed tags, unclosed tags, HTML entities, and `javascript:` protocol URIs.

### 9.5 Abstraction Level Selector

The level selector prepends a context hint to the question:

| Selection | Prepended Context |
|-----------|-------------------|
| All (default) | (nothing prepended) |
| Technical | "Answer from a technical/engineering perspective: " |
| Product | "Answer from a product management perspective: " |
| Cultural | "Answer from a community and cultural perspective: " |

This uses the existing `context` field in the Oracle API request. The enricher's tag classifier picks up the level-specific keywords from the prepended text.

### 9.6 Migration Path to Cloudflare Pages

The frontend is a static Next.js export. Migration requires:
1. Point DNS CNAME from CloudFront to Cloudflare Pages
2. Deploy the same `out/` directory to Cloudflare Pages
3. Remove CloudFront distribution and S3 bucket from Terraform

No code changes required. The API domain (`finn.arrakis.community`) is not affected.

---

## 10. Testing Strategy

### 10.1 Phase 1 Unit Tests

| File | Tests | Focus |
|------|-------|-------|
| `tests/finn/oracle-api.test.ts` | ~15 | Request validation, response reshaping, error mapping, API version header |
| `tests/finn/oracle-rate-limit.test.ts` | ~20 | Per-IP limits, per-key limits, global cap, cost ceiling, fail-closed, counter rollover |
| `tests/finn/oracle-auth.test.ts` | ~12 | dk_live_ validation, dk_test_ validation, revoked key fallback, missing key fallback, Redis error fallback |
| `tests/finn/oracle-concurrency.test.ts` | ~8 | Semaphore acquire/release, overflow returns 429, release on error |
| `tests/finn/oracle-xss.test.ts` | ~5 | Markdown sanitizer strips HTML, script tags, event handlers |

### 10.2 Phase 1 Integration Tests

| File | Tests | Focus |
|------|-------|-------|
| `tests/finn/oracle-e2e-phase1.test.ts` | ~10 | Full Oracle API flow with Redis mock: auth → rate limit → invoke → response |
| `tests/finn/oracle-ip-extraction.test.ts` | ~8 | X-Forwarded-For extraction: spoofed headers, single entry, CloudFront chain |

### 10.3 Gold-Set Expansion (PRD FR-3)

The Phase 0 gold-set (10 queries) is expanded to 20 queries covering all 7 abstraction levels. Gold-set tests run through the Oracle API endpoint (not just the enricher).

**Two-tier strategy** (PRD):
- **Tier 1 — Deterministic**: Tag classifier + enricher unit tests (blocking CI)
- **Tier 2 — Gold-set integration**: Full API flow (non-blocking initially, promoted to blocking after 10+ stable builds)

### 10.4 Phase 0 Backward Compatibility

All existing tests pass unchanged. The Phase 1 Oracle route is additive — it does not modify any existing middleware or handlers.

---

## 11. Deployment Architecture

### 11.1 Environment Variables (Complete Phase 1)

| Variable | Default | Required | Phase | Description |
|----------|---------|----------|-------|-------------|
| `FINN_ORACLE_ENABLED` | `false` | No | 0 | Master toggle |
| `FINN_ORACLE_SOURCES_CONFIG` | `grimoires/oracle/sources.json` | No | 0 | Sources JSON path |
| `FINN_ORACLE_MIN_CONTEXT` | `30000` | No | 0 | Min context for full mode |
| `FINN_ORACLE_DAILY_CAP` | `200` | No | 1 | Global daily invocation cap |
| `FINN_ORACLE_COST_CEILING_CENTS` | `2000` | No | 1 | Cost circuit breaker ($20) |
| `FINN_ORACLE_MAX_CONCURRENT` | `3` | No | 1 | Max concurrent per ECS task |
| `FINN_ORACLE_PUBLIC_DAILY_LIMIT` | `5` | No | 1 | Per-IP daily limit |
| `FINN_ORACLE_AUTH_DAILY_LIMIT` | `50` | No | 1 | Per-API-key daily limit |
| `FINN_ORACLE_ESTIMATED_COST_CENTS` | `50` | No | 1 | Pessimistic per-request cost estimate |
| `FINN_ORACLE_TRUST_XFF` | `true` | No | 1 | Parse X-Forwarded-For |
| `FINN_ORACLE_CORS_ORIGINS` | `https://oracle.arrakis.community` | No | 1 | Comma-separated CORS origins |
| `DIXIE_REF` | `unknown` | No | 1 | Build-time loa-dixie commit |
| `REDIS_URL` | (existing) | Yes | 0 | Redis connection (existing) |

### 11.2 Rollout Strategy

1. **Merge PR #75** — Oracle engine → main (no risk, already approved)
2. **Deploy loa-finn with `FINN_ORACLE_ENABLED=true`** — Oracle invoke works, rate limiter active
3. **Create wildcard cert** — `*.arrakis.community` via Terraform
4. **Deploy Terraform module** — S3 + CloudFront + Route 53 for `oracle.arrakis.community`
5. **Deploy frontend** — loa-dixie Next.js static export → S3
6. **Verify end-to-end** — oracle.arrakis.community → API → Oracle response with sources
7. **Monitor** — `/health` for Oracle readiness, CloudWatch for rate limiter, daily usage

### 11.3 Rollback Plan

| Failure | Rollback Action |
|---------|----------------|
| Oracle API errors | Set `FINN_ORACLE_ENABLED=false` — disables Oracle, other agents unaffected |
| Rate limiter Redis failure | Auto-handled: fail-closed returns 503 |
| Cost ceiling breach | Auto-handled: circuit breaker returns 503 |
| Frontend issues | Revert loa-dixie deployment, CloudFront serves cached version |
| Terraform issues | `terraform destroy` module invocation — isolated from finn ECS |

---

## 12. File Inventory

### New Files (loa-finn)

| File | Lines | Purpose |
|------|-------|---------|
| `src/gateway/routes/oracle.ts` | ~120 | Oracle product API handler |
| `src/gateway/oracle-rate-limit.ts` | ~200 | Redis-backed rate limiter |
| `src/gateway/oracle-auth.ts` | ~80 | Oracle API key validation |
| `src/gateway/oracle-concurrency.ts` | ~60 | Concurrency semaphore |
| `scripts/oracle-keys.sh` | ~120 | API key management CLI |
| `tests/finn/oracle-api.test.ts` | ~200 | API handler tests |
| `tests/finn/oracle-rate-limit.test.ts` | ~250 | Rate limiter tests |
| `tests/finn/oracle-auth.test.ts` | ~150 | Auth middleware tests |
| `tests/finn/oracle-concurrency.test.ts` | ~80 | Concurrency limiter tests |
| `tests/finn/oracle-xss.test.ts` | ~60 | XSS prevention tests |
| `tests/finn/oracle-e2e-phase1.test.ts` | ~150 | End-to-end integration |
| `tests/finn/oracle-ip-extraction.test.ts` | ~100 | IP extraction tests |

### New Files (Infrastructure)

| File | Lines | Purpose |
|------|-------|---------|
| `deploy/terraform/modules/dnft-site/main.tf` | ~200 | Reusable site module |
| `deploy/terraform/modules/dnft-site/variables.tf` | ~50 | Module inputs |
| `deploy/terraform/modules/dnft-site/outputs.tf` | ~20 | Module outputs |
| `deploy/terraform/oracle-site.tf` | ~80 | Oracle site + wildcard cert |
| `deploy/terraform/dixie-oidc.tf` | ~60 | OIDC for loa-dixie deploys |

### New Files (Frontend — loa-dixie/site/)

| File | Lines | Purpose |
|------|-------|---------|
| `src/app/layout.tsx` | ~30 | App layout, dark mode default |
| `src/app/page.tsx` | ~100 | Main chat page |
| `src/components/ChatInput.tsx` | ~60 | Question input + send |
| `src/components/ChatMessage.tsx` | ~80 | Sanitized markdown render |
| `src/components/SourceAttribution.tsx` | ~70 | Collapsible source panel |
| `src/components/LevelSelector.tsx` | ~40 | Abstraction level picker |
| `src/components/RateLimitBanner.tsx` | ~30 | Rate limit messaging |
| `src/lib/oracle-client.ts` | ~50 | API client |
| `src/lib/markdown-sanitizer.ts` | ~10 | HTML tag stripping |

### Modified Files (loa-finn)

| File | Changes | Lines Added |
|------|---------|-------------|
| `src/config.ts` | Oracle Phase 1 env vars in FinnConfig + loadConfig() | ~30 |
| `src/gateway/server.ts` | Oracle route + middleware registration | ~20 |
| `src/scheduler/health.ts` | Rate limiter health, dixie ref, daily usage | ~15 |
| `deploy/Dockerfile` | COPY loa-dixie knowledge from build context | ~10 |

---

## 13. Technical Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Redis outage blocks all Oracle queries | Low | High | Fail-closed is intentional — prevents cost explosion. CloudWatch alarm + existing Redis monitoring. |
| X-Forwarded-For extraction off-by-one | Medium | Medium | Integration test with real ALB + CloudFront header chains. Configurable index if needed. |
| Rate limit bypass via IP rotation | Medium | Low | Global daily cap (200) is the real protection. Per-IP is defense-in-depth. |
| CloudFront cache invalidation lag | Low | Low | Only affects static assets. API calls go directly to ALB. |
| Wildcard cert complications | Low | Medium | Fall back to per-subdomain cert. ACM + Route 53 validation is automated. |
| Frontend scope creep | Medium | Medium | Phase 1 UI is minimal: chat + sources + level selector. No auth UI. |
| Knowledge sync drift (dixie HEAD ≠ deployed) | Medium | Medium | Daily freshness check opens bump PR. Health reports `knowledge_dixie_ref`. |
| Cost ceiling not tight enough | Low | Medium | Configurable via env var. CloudWatch alarm on approach. Start conservative ($20). |

---

## 14. Future Considerations

| Feature | Phase | Dependency |
|---------|-------|-----------|
| Streaming responses (SSE) | Post-Phase 1 | Hounfour streaming interface |
| Session-based conversations | Phase 2 | Redis session store |
| NFT-gated Community tier | Phase 3 | On-chain identity verification |
| Developer/Enterprise tiers | Phase 4-5 | Arrakis billing integration |
| Cloudflare Pages migration | Any time | DNS change only |
| Hot-reload knowledge | Phase 5 | File watcher + registry reload |
| Vector search (embeddings) | Phase 2 | Embedding model + vector store |
| Second dNFT site | Any time | One `module` block in Terraform |

---

*This SDD was designed by analyzing the actual source files listed in the Grounding section. Phase 0 (SDD v2.0.0) is fully retained — no changes to the knowledge enrichment pipeline. Phase 1 adds product surface: API endpoint, rate limiting, infrastructure, and frontend. Every integration point references real file locations from the current codebase.*
