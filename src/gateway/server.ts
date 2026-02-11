// src/gateway/server.ts — Hono HTTP server with routes (SDD §3.2.1, T-2.1)

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Hono } from "hono"
import type { FinnConfig } from "../config.js"
import type { WorkerPool } from "../agent/worker-pool.js"
import type { SandboxExecutor } from "../agent/sandbox-executor.js"
import { SessionRouter } from "./sessions.js"
import { authMiddleware, corsMiddleware } from "./auth.js"
import { jwtAuthMiddleware } from "../hounfour/jwt-auth.js"
import { rateLimitMiddleware } from "./rate-limit.js"
import type { HealthAggregator } from "../scheduler/health.js"
import type { ActivityFeed } from "../dashboard/activity-feed.js"
import { createActivityHandler } from "../dashboard/activity-handler.js"
import type { HounfourRouter } from "../hounfour/router.js"
import type { S2SJwtSigner } from "../hounfour/s2s-jwt.js"

export interface AppOptions {
  healthAggregator?: HealthAggregator
  activityFeed?: ActivityFeed
  executor?: SandboxExecutor
  pool?: WorkerPool
  hounfour?: HounfourRouter
  /** S2S JWT signer for JWKS endpoint (Phase 5 T-A.6) */
  s2sSigner?: S2SJwtSigner
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
  app.get("/health", (c) => {
    if (options?.healthAggregator) {
      return c.json(options.healthAggregator.check())
    }
    return c.json({
      status: "healthy",
      uptime: process.uptime(),
      checks: {
        agent: { status: "ok", model: config.model },
        sessions: { active: router.getActiveCount() },
      },
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

  // JWT auth for arrakis-originated requests (T-A.2)
  app.use("/api/v1/*", rateLimitMiddleware(config))
  app.use("/api/v1/*", jwtAuthMiddleware(config))

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
