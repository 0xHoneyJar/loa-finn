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
import { createInvokeHandler } from "./routes/invoke.js"
import { createUsageHandler } from "./routes/usage.js"
import { createOracleHandler, oracleCorsMiddleware } from "./routes/oracle.js"
import { oracleAuthMiddleware } from "./oracle-auth.js"
import { oracleRateLimitMiddleware, OracleRateLimiter } from "./oracle-rate-limit.js"
import { oracleConcurrencyMiddleware, ConcurrencyLimiter } from "./oracle-concurrency.js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { getProtocolInfo } from "../hounfour/protocol-handshake.js"

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
  /** Oracle rate limiter (Phase 1) */
  oracleRateLimiter?: OracleRateLimiter
  /** Redis client for Oracle auth (Phase 1) */
  redisClient?: RedisCommandClient
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

  // Health endpoint (no auth required)
  // NOTE: dlq_store_type exposed intentionally for ops monitoring (Datadog, Grafana).
  // This is not sensitive — it reveals "redis" vs "in-memory", not connection strings.
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

    if (options?.healthAggregator) {
      let health = options.healthAggregator.check()
      // Oracle Phase 1 async enrichment (rate limiter health, daily usage)
      if (health.checks.oracle && options.oracleRateLimiter) {
        health = await options.healthAggregator.enrichOracleHealth(health)
      }
      return c.json({ ...health, billing, protocol })
    }
    return c.json({
      status: "healthy",
      uptime: process.uptime(),
      checks: {
        agent: { status: "ok", model: config.model },
        sessions: { active: router.getActiveCount() },
      },
      billing,
      protocol,
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
    oracleApp.use("*", oracleAuthMiddleware(options.redisClient, { trustXff: config.oracle.trustXff }))
    oracleApp.use("*", oracleRateLimitMiddleware(options.oracleRateLimiter))
    oracleApp.use("*", oracleConcurrencyMiddleware(concurrencyLimiter))
    oracleApp.post("/", createOracleHandler(options.hounfour, options.oracleRateLimiter, config))
    app.route("/api/v1/oracle", oracleApp)
  }

  // Skip guard for Oracle path — defense-in-depth against Hono routing edge cases
  const isOraclePath = (path: string) =>
    path === "/api/v1/oracle" || path.startsWith("/api/v1/oracle/")

  // WHY: Zero-trust defense — strip x-internal-reservation-id before ANY processing.
  // External clients could inject this header to spoof reservations. Even though JWT
  // claims are the primary trust boundary, defense-in-depth means removing the attack
  // surface entirely. Google BeyondCorp: "never trust the network."
  // See Bridgebuilder Finding #4 PRAISE + Finding #9 (PR #68).
  app.use("/api/v1/*", async (c, next) => {
    if (isOraclePath(c.req.path)) return next()
    c.req.raw.headers.delete("x-internal-reservation-id")
    return next()
  })

  // JWT auth for arrakis-originated requests (T-A.2)
  // Skip Oracle path — handled by oracleApp's own middleware chain
  app.use("/api/v1/*", async (c, next) => {
    if (isOraclePath(c.req.path)) return next()
    return rateLimitMiddleware(config)(c, next)
  })
  app.use("/api/v1/*", async (c, next) => {
    if (isOraclePath(c.req.path)) return next()
    return hounfourAuth(config)(c, next)
  })

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

  // POST /api/sessions — create session
  app.post("/api/sessions", async (c) => {
    try {
      const { sessionId } = await router.create()
      return c.json(
        {
          sessionId,
          created: new Date().toISOString(),
          wsUrl: `ws://${c.req.header("Host") ?? "localhost:3000"}/ws/${sessionId}`,
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

  return { app, router }
}
