// src/index.ts — loa-finn entry point (SDD §10.2)
// Boot sequence: load config → start gateway → serve

import { loadConfig } from "./config.js"
import { createApp } from "./gateway/server.js"
import { serve } from "@hono/node-server"

async function main() {
  console.log("[finn] booting loa-finn...")

  // 1. Load config from environment
  const config = loadConfig()
  console.log(`[finn] config loaded: model=${config.model}, port=${config.port}`)

  // 2. Create gateway
  const { app } = createApp(config)

  // 3. Start HTTP server
  // Persistence will be added in Sprint 3
  // Scheduler will be added in Sprint 4
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[finn] loa-finn ready on :${info.port}`)
  })
}

main().catch((err) => {
  console.error("[finn] fatal:", err)
  process.exit(1)
})
