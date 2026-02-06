// src/gateway/server.ts — Hono HTTP server with routes (SDD §3.2.1, T-2.1)

import { Hono } from "hono"
import type { FinnConfig } from "../config.js"
import { SessionRouter } from "./sessions.js"
import { authMiddleware, corsMiddleware } from "./auth.js"
import { rateLimitMiddleware } from "./rate-limit.js"
import type { HealthAggregator } from "../scheduler/health.js"

export interface AppOptions {
  healthAggregator?: HealthAggregator
}

export function createApp(config: FinnConfig, options?: AppOptions) {
  const app = new Hono()
  const router = new SessionRouter(config)

  // Global middleware
  app.use("*", corsMiddleware(config))

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

  // Auth + rate limit for API routes
  app.use("/api/*", rateLimitMiddleware(config))
  app.use("/api/*", authMiddleware(config))

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

  return { app, router }
}
