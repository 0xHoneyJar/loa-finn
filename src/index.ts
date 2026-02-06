// src/index.ts — loa-finn entry point (SDD §10.2)
// Boot sequence: load config → create session → start gateway (Sprint 2+)

import { loadConfig } from "./config.js"

async function main() {
  console.log("[finn] booting loa-finn...")

  // 1. Load config from environment
  const config = loadConfig()
  console.log(`[finn] config loaded: model=${config.model}, port=${config.port}`)

  // Gateway will be added in Sprint 2
  // Persistence will be added in Sprint 3
  // Scheduler will be added in Sprint 4

  console.log("[finn] loa-finn ready (agent core only — gateway pending sprint 2)")
}

main().catch((err) => {
  console.error("[finn] fatal:", err)
  process.exit(1)
})
