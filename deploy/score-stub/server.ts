// deploy/score-stub/server.ts — payload-realistic stub Score API
// (sprint-169 T5.2 — Finn cost-of-play V1)
//
// Minimal standalone Hono service emitting the layered fact-sheet contract
// from score-api PR #263. Zero Finn imports. Deterministic: the same agentId
// always returns the same fixture (size class + claim derived from id hash).
//
// Env knobs:
//   STUB_LATENCY_MS — simulated producer latency (default 80)
//   PORT            — listen port (default 4010)

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { buildFactSheet, sizeClassFor } from "./fixtures.js"

const LATENCY_MS = (() => {
  const raw = process.env.STUB_LATENCY_MS
  const v = raw === undefined ? 80 : Number.parseInt(raw, 10)
  return Number.isSafeInteger(v) && v >= 0 ? v : 80
})()

export function createStubApp(latencyMs: number = LATENCY_MS): Hono {
  const app = new Hono()

  app.get("/health", (c) => c.json({ status: "ok", service: "score-stub" }))

  app.get("/verdict/:agentId", async (c) => {
    const agentId = c.req.param("agentId")
    if (!agentId || agentId.length > 256) {
      return c.json({ error: "invalid agentId" }, 400)
    }
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs))
    }
    const sheet = buildFactSheet(agentId)
    c.header("x-stub-size-class", sizeClassFor(agentId))
    return c.json(sheet)
  })

  return app
}

// Start only when executed directly (not when imported by tests).
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")
if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? "4010", 10)
  serve({ fetch: createStubApp().fetch, port }, (info) => {
    console.log(`[score-stub] listening on :${info.port} (latency ${LATENCY_MS}ms)`)
  })
}
