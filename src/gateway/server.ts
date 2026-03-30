// src/gateway/server.ts — Hono HTTP server with routes (SDD §3.2.1, T-2.1)

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Hono } from "hono"
import type { FinnConfig } from "../config.js"
import type { WorkerPool } from "../agent/worker-pool.js"
import type { SandboxExecutor } from "../agent/sandbox-executor.js"
import { SessionRouter } from "./sessions.js"
import { authMiddleware, corsMiddleware } from "./auth.js"
import { hounfourAuth } from "../hounfour/pool-enforcement.js"
import { rateLimitMiddleware } from "./rate-limit.js"
import type { HealthAggregator } from "../scheduler/health.js"
import type { ActivityFeed } from "../dashboard/activity-feed.js"
import { createActivityHandler } from "../dashboard/activity-handler.js"
import type { HounfourRouter } from "../hounfour/router.js"
import type { S2SJwtSigner } from "../hounfour/s2s-jwt.js"
import type { BillingFinalizeClient } from "../hounfour/billing-finalize-client.js"
import type { BillingConservationGuard } from "../hounfour/billing-conservation-guard.js"
import { createInvokeHandler } from "./routes/invoke.js"
import { createUsageHandler } from "./routes/usage.js"
import { createOracleHandler, oracleCorsMiddleware } from "./routes/oracle.js"
import { oracleAuthMiddleware } from "./oracle-auth.js"
import { oracleRateLimitMiddleware, OracleRateLimiter } from "./oracle-rate-limit.js"
import { oracleConcurrencyMiddleware, ConcurrencyLimiter } from "./oracle-concurrency.js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { getProtocolInfo } from "../hounfour/protocol-handshake.js"
import { economicBoundaryMiddleware } from "../hounfour/economic-boundary.js"
import { createAgentHomepageRoutes, type AgentHomepageDeps } from "./routes/agent-homepage.js"
import { createAgentPublicApiRoutes, type AgentPublicApiDeps } from "./routes/agent-public-api.js"
import { createConversationRoutes, type ConversationRouteDeps } from "./routes/conversations.js"
import { cspMiddleware } from "./csp.js"
import { createAdminRoutes, type AdminRouteDeps } from "./routes/admin.js"
import { x402Routes, createX402InvokeHandler, type X402RouteDeps } from "./x402-routes.js"
import { createIdentityRoutes, type IdentityRouteDeps } from "./routes/identity.js"
import { corpusVersionMiddleware } from "./corpus-version.js"
import type { ConversationManager } from "../nft/conversation.js"
import type { PersonalityProvider } from "../nft/personality-provider.js"
import { createAgentChatRoutes, type AgentChatDeps } from "./routes/agent-chat.js"
import { createOwnershipMiddleware, type OwnershipGateConfig } from "../nft/ownership-gate.js"

export interface AppOptions {
  healthAggregator?: HealthAggregator
  activityFeed?: ActivityFeed
  executor?: SandboxExecutor
  pool?: WorkerPool
  hounfour?: HounfourRouter
  /** S2S JWT signer for JWKS endpoint (Phase 5 T-A.6) */
  s2sSigner?: S2SJwtSigner
  /** Billing finalize client for health metrics (Sprint 2 T3) */
  billingFinalizeClient?: BillingFinalizeClient
  /** Path to JSONL cost ledger for usage endpoint (cycle-024 T2) */
  ledgerPath?: string
  /** Billing conservation guard for billing endpoint gating (SDD §4.2) */
  billingConservationGuard?: BillingConservationGuard
  /** Oracle rate limiter (Phase 1) */
  oracleRateLimiter?: OracleRateLimiter
  /** Redis client for Oracle auth (Phase 1) */
  redisClient?: RedisCommandClient
  /** Personality provider for agent homepage & public API (Sprint 2) */
  personalityProvider?: PersonalityProvider
  /** Conversation manager for CRUD routes (Sprint 2) */
  conversationManager?: ConversationManager
  /** x402 route dependencies — when provided, x402 and /pay/chat routes are mounted */
  x402Deps?: X402RouteDeps
  /** Identity route dependencies — when provided, /api/identity routes are mounted (Sprint 3 T3.2) */
  identityDeps?: IdentityRouteDeps
  /** Agent chat dependencies — when provided, /api/v1/agent/chat route is mounted (Cycle 040) */
  agentChatDeps?: AgentChatDeps
  /** Ownership gate config — when provided, ownership middleware is applied to chat routes (Cycle 040) */
  ownershipGateConfig?: OwnershipGateConfig
  /** Goodhart engine health (Sprint 5 T-5.6) */
  goodhartHealth?: () => { status: string; killSwitch: string; explorationEnabled: boolean }
  /** Audit chain health (Sprint 5 T-5.6) */
  auditHealth?: () => { state: string; partitionId: string; sequenceNumber: number; fallbackCount: number }
  /** Relayer health (Sprint 5 T-5.6) */
  relayerHealth?: () => { canSettle: boolean; balanceWei?: string; alertLevel: string }
  /** Redis health for /health/deps (cycle-035 T-1.3) */
  redisHealth?: () => Promise<{ connected: boolean; latencyMs: number }>
  /** DynamoDB health for /health/deps (cycle-035 T-1.3) */
  dynamoHealth?: () => Promise<{ reachable: boolean; latencyMs: number }>
  /** Admin JWKS key resolver for JWT auth (cycle-035 T-2.1) */
  adminJwksResolver?: (protectedHeader: { kid?: string; alg?: string }, token: { payload: unknown }) => Promise<import("jose").KeyLike | Uint8Array>
  /** RuntimeConfig for admin mode changes (cycle-035 T-2.1) */
  runtimeConfig?: import("../hounfour/runtime-config.js").RuntimeConfig
  /** Audit append function for admin audit-first semantics (cycle-035 T-2.1) */
  auditAppend?: (action: string, payload: Record<string, unknown>) => Promise<string | null>
  /** Graduation metrics for /metrics endpoint (cycle-035 T-2.5) */
  graduationMetrics?: import("../hounfour/graduation-metrics.js").GraduationMetrics
}

export function createApp(config: FinnConfig, options: AppOptions) {
  const app = new Hono()
  const router = new SessionRouter(config, options.executor)

  // Global middleware
  app.use("*", corsMiddleware(config))

  // Serve WebChat UI
  app.get("/", async (c) => {
    try {
      const html = await readFile(resolve("public/index.html"), "utf-8")
      return c.html(html)
    } catch {
      return c.text("WebChat UI not found. Place index.html in public/.", 404)
    }
  })

  // --- Two-tier health endpoints (cycle-035 T-1.3) ---

  // /healthz — ALB liveness probe. No dependency checks. Always 200 if process is alive.
  app.get("/healthz", (c) => {
    return c.json({ status: "ok", uptime: process.uptime() }, 200)
  })

  // /health/deps — Readiness probe. Checks Redis + DynamoDB data-plane.
  // Returns 503 if any critical dependency is unreachable.
  app.get("/health/deps", async (c) => {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {}
    let allHealthy = true

    // Redis health
    if (options?.redisHealth) {
      try {
        const rh = await options.redisHealth()
        checks.redis = { status: rh.connected ? "ok" : "degraded", latencyMs: rh.latencyMs }
        if (!rh.connected) allHealthy = false
      } catch (err) {
        checks.redis = { status: "error", error: (err as Error).message }
        allHealthy = false
      }
    }

    // DynamoDB health (data-plane GetItem, not DescribeTable)
    if (options?.dynamoHealth) {
      try {
        const dh = await options.dynamoHealth()
        checks.dynamodb = { status: dh.reachable ? "ok" : "degraded", latencyMs: dh.latencyMs }
        if (!dh.reachable) allHealthy = false
      } catch (err) {
        checks.dynamodb = { status: "error", error: (err as Error).message }
        allHealthy = false
      }
    }

    const status = allHealthy ? 200 : 503
    return c.json({ status: allHealthy ? "ready" : "not_ready", checks }, status)
  })

  // Legacy /health → 301 → /healthz (backward compat)
  app.get("/health", async (c) => {
    // Billing DLQ metrics — never throws
    let billing: Record<string, unknown> = {
      dlq_size: null,
      dlq_oldest_entry_age_ms: null,
      dlq_store_type: "unknown",
      dlq_durable: false,
      dlq_aof_verified: false,
    }
    if (options?.billingFinalizeClient) {
      try {
        billing = {
          dlq_size: await options.billingFinalizeClient.getDLQSize(),
          dlq_oldest_entry_age_ms: await options.billingFinalizeClient.getDLQOldestAgeMs(),
          dlq_store_type: options.billingFinalizeClient.isDurable() ? "redis" : "in-memory",
          dlq_durable: options.billingFinalizeClient.isDurable(),
          dlq_aof_verified: options.billingFinalizeClient.isAofVerified(),
        }
      } catch {
        // Redis failure — return null/defaults, never throw
      }
    }

    const protocol = getProtocolInfo()

    // Billing evaluator guard health (SDD §4.2)
    const billingEvaluator = options?.billingConservationGuard?.getHealth() ?? null
    const readyForBilling = billingEvaluator
      ? billingEvaluator.billing === "ready"
      : true

    // Goodhart, audit, relayer health (Sprint 5 T-5.6, AC20)
    const goodhart = options?.goodhartHealth?.() ?? null
    const audit = options?.auditHealth?.() ?? null
    const relayer = options?.relayerHealth?.() ?? null

    if (options?.healthAggregator) {
      let health = options.healthAggregator.check()
      // Oracle Phase 1 async enrichment (rate limiter health, daily usage)
      if (health.checks.oracle && options.oracleRateLimiter) {
        health = await options.healthAggregator.enrichOracleHealth(health)
      }
      return c.json({ ...health, billing, protocol, goodhart, audit, relayer })
    }
    return c.json({
      status: "healthy",
      uptime: process.uptime(),
      checks: {
        agent: { status: "ok", model: config.model },
        sessions: { active: router.getActiveCount() },
        ...(billingEvaluator ? { billing_evaluator: billingEvaluator } : {}),
      },
      billing,
      protocol,
      ready_for_billing: readyForBilling,
      goodhart,
      audit,
      relayer,
    })
  })

  // Serve Dashboard UI
  app.get("/dashboard", async (c) => {
    try {
      const html = await readFile(resolve("public/dashboard.html"), "utf-8")
      return c.html(html)
    } catch {
      return c.text("Dashboard UI not found. Place dashboard.html in public/.", 404)
    }
  })

  // JWKS endpoint for loa-finn's S2S public key (T-A.6)
  app.get("/.well-known/jwks.json", (c) => {
    if (!options.s2sSigner?.isReady) {
      return c.json({ keys: [] })
    }
    return c.json(options.s2sSigner.getJWKS())
  })

  // Oracle product endpoint — dedicated sub-app with its own middleware chain.
  // MUST be registered BEFORE the /api/v1/* wildcard middleware to prevent
  // hounfourAuth and rateLimitMiddleware from executing on Oracle requests.
  // Using app.route() guarantees middleware isolation (SDD §3.6, GPT-5.2 Fix #4).
  if (options.hounfour && config.oracle.enabled && options.oracleRateLimiter && options.redisClient) {
    const oracleApp = new Hono()
    const concurrencyLimiter = new ConcurrencyLimiter(config.oracle.maxConcurrent)

    oracleApp.use("*", oracleCorsMiddleware(config.oracle.corsOrigins))
    // Billing guard — 503 when evaluator degraded (SDD §4.2)
    if (options.billingConservationGuard) {
      oracleApp.use("*", async (c, next) => {
        if (!options.billingConservationGuard!.isBillingReady()) {
          return c.json({
            error: "BILLING_EVALUATOR_UNAVAILABLE",
            retry_after_seconds: 30,
          }, 503)
        }
        return next()
      })
    }
    oracleApp.use("*", oracleAuthMiddleware(options.redisClient, { trustXff: config.oracle.trustXff }))
    oracleApp.use("*", oracleRateLimitMiddleware(options.oracleRateLimiter))
    oracleApp.use("*", oracleConcurrencyMiddleware(concurrencyLimiter))
    oracleApp.use("*", corpusVersionMiddleware())
    oracleApp.post("/", createOracleHandler(options.hounfour, options.oracleRateLimiter, config))
    app.route("/api/v1/oracle", oracleApp)
  }

  // Skip guard for Oracle path — defense-in-depth against Hono routing edge cases
  const isOraclePath = (path: string) =>
    path === "/api/v1/oracle" || path.startsWith("/api/v1/oracle/")

  // Skip guard for product/admin/x402/identity paths — these use their own auth (SIWE, none, FINN_AUTH_TOKEN, x402 payment, or public)
  const isProductApiPath = (path: string) =>
    path === "/api/v1/public" || path.startsWith("/api/v1/public/") ||
    path === "/api/v1/conversations" || path.startsWith("/api/v1/conversations/") ||
    path === "/api/v1/admin" || path.startsWith("/api/v1/admin/") ||
    path === "/api/v1/x402" || path.startsWith("/api/v1/x402/") ||
    path === "/api/v1/pay" || path.startsWith("/api/v1/pay/") ||
    path === "/api/identity" || path.startsWith("/api/identity/")

  // WHY: Zero-trust defense — strip x-internal-reservation-id before ANY processing.
  // External clients could inject this header to spoof reservations. Even though JWT
  // claims are the primary trust boundary, defense-in-depth means removing the attack
  // surface entirely. Google BeyondCorp: "never trust the network."
  // See Bridgebuilder Finding #4 PRAISE + Finding #9 (PR #68).
  app.use("/api/v1/*", async (c, next) => {
    if (isOraclePath(c.req.path) || isProductApiPath(c.req.path)) return next()
    c.req.raw.headers.delete("x-internal-reservation-id")
    return next()
  })

  // JWT auth for arrakis-originated requests (T-A.2)
  // Skip Oracle path — handled by oracleApp's own middleware chain
  // Skip product API paths — /public needs no auth, /conversations uses SIWE
  app.use("/api/v1/*", async (c, next) => {
    if (isOraclePath(c.req.path) || isProductApiPath(c.req.path)) return next()
    return rateLimitMiddleware(config)(c, next)
  })
  app.use("/api/v1/*", async (c, next) => {
    if (isOraclePath(c.req.path) || isProductApiPath(c.req.path)) return next()
    return hounfourAuth(config)(c, next)
  })

  // Economic boundary — pre-invocation gate (SDD §6.3, step 2)
  // Chain position: JWT Auth → **Economic Boundary** → Billing Guard → Provider
  // Runs UNCONDITIONALLY (local decision engine, not gated on peer features).
  // Mode controlled by ECONOMIC_BOUNDARY_MODE env var (default: "shadow").
  app.use("/api/v1/invoke", economicBoundaryMiddleware({
    getBudgetSnapshot: async (_tenantId: string) => {
      // SAFETY: HounfourRouter.budgetSnapshot() is scope-bound at construction
      // time (single-tenant-per-instance model). The tenantId parameter is
      // accepted for interface compliance but not used for lookup — the router's
      // scopeMeta already isolates to the correct tenant's budget. If loa-finn
      // moves to multi-tenant-per-instance, this must use tenant-keyed lookup.
      if (!options.hounfour) return null
      try {
        return options.hounfour.budgetSnapshot()
      } catch {
        return null
      }
    },
  }))

  // Billing guard middleware — returns 503 when evaluator degraded (SDD §4.2)
  // Applied to all billing entrypoints: /api/v1/invoke, /api/v1/oracle
  if (options.billingConservationGuard) {
    app.use("/api/v1/invoke", async (c, next) => {
      if (!options.billingConservationGuard!.isBillingReady()) {
        return c.json({
          error: "BILLING_EVALUATOR_UNAVAILABLE",
          retry_after_seconds: 30,
        }, 503)
      }
      return next()
    })
  }

  // Invoke endpoint — tenant-authenticated model routing (cycle-024 T1)
  if (options.hounfour) {
    app.post("/api/v1/invoke", createInvokeHandler(options.hounfour))
  }

  // Usage endpoint — tenant-isolated cost ledger query (cycle-024 T2)
  if (options.ledgerPath) {
    app.get("/api/v1/usage", createUsageHandler(options.ledgerPath))
  }

  // Bearer token auth for direct API access (existing behavior)
  // Skip /api/v1/* paths — already handled by JWT middleware above
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/v1/")) return next()
    return rateLimitMiddleware(config)(c, next)
  })
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/v1/")) return next()
    return authMiddleware(config)(c, next)
  })

  // POST /api/sessions — create session (with optional per-NFT personality, Issue #138)
  app.post("/api/sessions", async (c) => {
    try {
      // Accept optional token_id for per-NFT personality injection
      let systemPromptOverride: string | undefined
      let personalityMeta: { agent_name?: string; archetype?: string; era?: string } | undefined
      try {
        const body = await c.req.json<{ token_id?: string }>()
        if (body?.token_id && options.personalityProvider) {
          const personality = await options.personalityProvider.get(body.token_id)
          if (personality) {
            systemPromptOverride = personality.beauvoir_template
            personalityMeta = {
              agent_name: personality.display_name,
              archetype: personality.archetype,
              era: personality.era,
            }
            console.log(`[api] session with personality: token_id=${body.token_id} name=${personality.display_name}`)
          }
        }
      } catch {
        // No JSON body or parse error — create session without personality (backward compatible)
      }

      const { sessionId } = await router.create({ systemPromptOverride })
      return c.json(
        {
          sessionId,
          created: new Date().toISOString(),
          wsUrl: `ws://${c.req.header("Host") ?? "localhost:3000"}/ws/${sessionId}`,
          ...(personalityMeta && { personality: personalityMeta }),
        },
        201,
      )
    } catch (err) {
      console.error("[api] session create error:", err)
      return c.json({ error: "Failed to create session", code: "SESSION_CREATE_FAILED" }, 500)
    }
  })

  // POST /api/sessions/:id/message — send message (non-streaming)
  app.post("/api/sessions/:id/message", async (c) => {
    const sessionId = c.req.param("id")
    const session = router.get(sessionId) ?? await router.resume(sessionId)
    if (!session) {
      return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404)
    }

    const body = await c.req.json<{ text: string }>().catch(() => null)
    if (!body?.text?.trim()) {
      return c.json({ error: "Message text required", code: "INVALID_REQUEST" }, 400)
    }

    try {
      let responseText = ""
      const toolCalls: Array<{ name: string; args: unknown; result: string }> = []

      const unsub = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          for (const block of event.message.content ?? []) {
            if (block.type === "text") responseText += block.text
          }
        }
        if (event.type === "tool_execution_start") {
          toolCalls.push({ name: event.toolName, args: event.args, result: "" })
        }
        if (event.type === "tool_execution_end" && toolCalls.length > 0) {
          const last = toolCalls[toolCalls.length - 1]
          last.result = typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result)
        }
      })

      await session.prompt(body.text)
      unsub()

      return c.json({ response: responseText, toolCalls })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Prompt failed", code: "PROMPT_FAILED" },
        500,
      )
    }
  })

  // GET /api/sessions — list sessions
  app.get("/api/sessions", (c) => {
    return c.json({ sessions: router.list() })
  })

  // GET /api/sessions/:id — get session info
  app.get("/api/sessions/:id", (c) => {
    const sessionId = c.req.param("id")
    const session = router.get(sessionId)
    if (!session) {
      return c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404)
    }
    return c.json({
      id: sessionId,
      state: session.state,
      isStreaming: session.isStreaming,
      messageCount: session.messages.length,
    })
  })

  // GET /api/dashboard/activity — Bridgebuilder activity feed (SDD §3.2)
  app.get("/api/dashboard/activity", createActivityHandler(options?.activityFeed))

  // ---------------------------------------------------------------------------
  // Sprint 2: Product Experience Routes
  // ---------------------------------------------------------------------------

  // CSP middleware — applies Content-Security-Policy to HTML responses only
  app.use("*", cspMiddleware())

  // Agent chat — ownership-gated, personality-conditioned (Cycle 040 Sprint 1)
  // Middleware MUST be registered before route to ensure execution order (C1 fix)
  if (options.agentChatDeps) {
    if (options.ownershipGateConfig) {
      app.use("/api/v1/agent/chat/*", createOwnershipMiddleware(options.ownershipGateConfig))
    }
    app.route("/api/v1/agent/chat", createAgentChatRoutes(options.agentChatDeps))
  }

  // Public API — no auth required (T2.5)
  if (options.personalityProvider && options.redisClient) {
    const publicApiDeps: AgentPublicApiDeps = {
      personalityProvider: options.personalityProvider,
      redis: options.redisClient,
    }
    app.route("/api/v1", createAgentPublicApiRoutes(publicApiDeps))
  }

  // Conversation CRUD — SIWE auth, mounted under /api/v1/conversations (T2.8)
  if (options.conversationManager && config.siwe.jwtSecret) {
    const convDeps: ConversationRouteDeps = {
      conversationManager: options.conversationManager,
      jwtSecret: config.siwe.jwtSecret,
    }
    app.route("/api/v1/conversations", createConversationRoutes(convDeps))
  }

  // Agent homepage — SSR at /agent/:collection/:tokenId (T2.4)
  if (options.personalityProvider && options.redisClient) {
    const homepageDeps: AgentHomepageDeps = {
      personalityProvider: options.personalityProvider,
      redis: options.redisClient,
      baseUrl: "",
    }
    app.route("/agent", createAgentHomepageRoutes(homepageDeps))
  }

  // Onboarding page (T2.11)
  app.get("/onboarding", async (c) => {
    try {
      const html = await readFile(resolve("public/onboarding.html"), "utf-8")
      return c.html(html)
    } catch {
      return c.text("Onboarding page not found.", 404)
    }
  })

  // Chat page (T2.7) — /chat/:collection/:tokenId
  app.get("/chat/:collection/:tokenId", async (c) => {
    try {
      const html = await readFile(resolve("public/chat.html"), "utf-8")
      return c.html(html)
    } catch {
      return c.text("Chat page not found.", 404)
    }
  })

  // ---------------------------------------------------------------------------
  // x402 Payment Routes (Sprint 2 T2.2)
  // Mounted as isolated sub-app — NOT behind JWT middleware.
  // /api/v1/x402/invoke is canonical, /api/v1/pay/chat is the single alias.
  // ---------------------------------------------------------------------------

  if (options.x402Deps) {
    // Canonical x402 routes: /api/v1/x402/invoke
    app.route("/api/v1/x402", x402Routes(options.x402Deps))

    // Alias: POST /api/v1/pay/chat → same handler as /api/v1/x402/invoke
    const payApp = new Hono()
    payApp.post("/chat", createX402InvokeHandler(options.x402Deps))
    app.route("/api/v1/pay", payApp)
  }

  // ---------------------------------------------------------------------------
  // Sprint 3: Identity / Admin / E2E Support Routes
  // ---------------------------------------------------------------------------

  // Identity resolution — public endpoints, no auth (T3.2)
  if (options.identityDeps) {
    app.route("/api/identity", createIdentityRoutes(options.identityDeps))
  }

  // Admin endpoints — JWKS JWT auth for mode changes, FINN_AUTH_TOKEN for seed-credits (cycle-035 T-2.1/T-2.2)
  {
    const adminDeps: AdminRouteDeps = {
      setCreditBalance: async (_wallet: string, _credits: number) => {
        // TODO: Wire to real credit store when billing is fully integrated.
      },
      runtimeConfig: options.runtimeConfig,
      auditAppend: options.auditAppend,
      jwksKeyResolver: options.adminJwksResolver,
    }
    app.route("/api/v1/admin", createAdminRoutes(adminDeps))
  }

  // Prometheus metrics endpoint (cycle-035 T-2.5, T-6.6: bearer auth)
  if (options.graduationMetrics) {
    const gMetrics = options.graduationMetrics
    const metricsToken = process.env.FINN_METRICS_BEARER_TOKEN
    app.get("/metrics", (c) => {
      // T-6.6: Require bearer token when configured
      if (metricsToken) {
        const authHeader = c.req.header("Authorization")
        if (!authHeader || authHeader !== `Bearer ${metricsToken}`) {
          return c.json({ error: "unauthorized" }, 401)
        }
      }
      c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      return c.text(gMetrics.toPrometheus())
    })
  }

  return { app, router }
}
