// scripts/playtest/cop-local-server.ts — minimal local finn gateway for the
// phase-0 smoke (sprint-169 T5.E2E). Serves the REAL createApp (server.ts
// composition, including the /api/v1/score mount + CostAtom middleware) with
// no optional subsystems — the same route surface the Railway deploy exposes.
//
// Usage:
//   SCORE_API_URL=http://localhost:4010 FINN_AUTH_TOKEN=smoke DATA_DIR=./tmp/cop-smoke \
//     pnpm tsx scripts/playtest/cop-local-server.ts

import { serve } from "@hono/node-server"
import { loadConfig } from "../../src/config.js"
import { createApp } from "../../src/gateway/server.js"

const config = loadConfig()
const { app } = createApp(config, {})
app.onError((err, c) => {
  console.error(`[cop-local-server] error on ${c.req.method} ${c.req.path}:`, err)
  return c.json({ error: "INTERNAL_ERROR", detail: String(err) }, 500)
})

const port = Number.parseInt(process.env.PORT ?? "3000", 10)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `[cop-local-server] listening on :${info.port} — SCORE_API_URL=${process.env.SCORE_API_URL ?? "(unset)"} DATA_DIR=${process.env.DATA_DIR ?? "./data"}`,
  )
})
