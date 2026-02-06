// src/index.ts — loa-finn entry point (SDD §10.2)
// Boot sequence: config → identity → persistence → recovery → gateway → scheduler → serve

import { loadConfig } from "./config.js"
import { IdentityLoader } from "./agent/identity.js"
import { WAL } from "./persistence/wal.js"
import { ObjectStoreSync } from "./persistence/r2-sync.js"
import { GitSync } from "./persistence/git-sync.js"
import { RecoveryCascade } from "./persistence/recovery.js"
import { WALPruner } from "./persistence/pruner.js"
import { createApp } from "./gateway/server.js"
import { Scheduler } from "./scheduler/scheduler.js"
import { HealthAggregator } from "./scheduler/health.js"
import { BeadsBridge } from "./beads/bridge.js"
import { CompoundLearning } from "./learning/compound.js"
import { serve } from "@hono/node-server"

async function main() {
  console.log("[finn] booting loa-finn...")

  // 1. Load config
  const config = loadConfig()
  console.log(`[finn] config loaded: model=${config.model}, port=${config.port}`)

  // 2. Load identity
  const identity = new IdentityLoader(config.beauvoirPath)
  await identity.load()
  console.log(`[finn] identity loaded: checksum=${identity.getChecksum().slice(0, 8)}`)

  // 3. Initialize persistence
  const wal = new WAL(config.dataDir)
  const r2Sync = new ObjectStoreSync(config, wal)
  const gitSync = new GitSync(config, wal)
  const pruner = new WALPruner(wal, r2Sync, gitSync)
  console.log(`[finn] persistence initialized: wal=${wal.getSegments().length} segments`)

  // 4. Recovery cascade
  const recovery = new RecoveryCascade(config, wal, r2Sync, gitSync)
  const recoveryResult = await recovery.recover("strict")
  console.log(`[finn] recovery: source=${recoveryResult.source}, mode=${recoveryResult.mode}, entries=${recoveryResult.walEntriesReplayed}`)

  // 5. Initialize beads bridge
  const beads = new BeadsBridge()
  await beads.init()
  console.log(`[finn] beads: available=${beads.isAvailable}`)

  // 6. Initialize compound learning
  const compound = new CompoundLearning(config.dataDir, wal)

  // 7. Create gateway
  const { app, router } = createApp(config)

  // 8. Set up scheduler with registered tasks (T-4.4)
  const scheduler = new Scheduler()
  const healthAggregator = new HealthAggregator({
    config,
    wal,
    r2Sync,
    gitSync,
    scheduler,
    getSessionCount: () => router.getActiveCount(),
    getBeadsAvailable: () => beads.isAvailable,
  })

  // Log circuit breaker transitions to WAL
  scheduler.onCircuitTransition((taskId, from, to) => {
    console.log(`[scheduler] circuit breaker ${taskId}: ${from} -> ${to}`)
    wal.append("config", "update", `circuit-breaker/${taskId}`, { taskId, from, to })
  })

  // Register scheduled tasks
  scheduler.register({
    id: "r2_sync",
    name: "R2 Sync",
    intervalMs: config.syncIntervalMs,
    jitterMs: 5000,
    handler: async () => {
      const result = await r2Sync.sync()
      if (result.filesUploaded > 0) {
        console.log(`[r2-sync] uploaded ${result.filesUploaded} files (${result.bytesUploaded}B) in ${result.duration}ms`)
      }
    },
  })

  scheduler.register({
    id: "git_sync",
    name: "Git Sync",
    intervalMs: config.gitSyncIntervalMs,
    jitterMs: 300_000,
    handler: async () => {
      const snapshot = await gitSync.snapshot()
      if (snapshot) {
        await gitSync.push()
        console.log(`[git-sync] snapshot ${snapshot.snapshotId} pushed`)
      }
    },
  })

  scheduler.register({
    id: "health",
    name: "Health Check",
    intervalMs: config.healthIntervalMs,
    jitterMs: 30_000,
    handler: async () => {
      const status = healthAggregator.check()
      if (status.status !== "healthy") {
        console.warn(`[health] system status: ${status.status}`)
      }
    },
  })

  scheduler.register({
    id: "identity_reload",
    name: "Identity Reload",
    intervalMs: 60_000,
    jitterMs: 5000,
    handler: async () => {
      await identity.checkAndReload()
    },
  })

  scheduler.register({
    id: "wal_prune",
    name: "WAL Prune",
    intervalMs: 3600_000,
    jitterMs: 300_000,
    handler: async () => {
      const result = await pruner.pruneConfirmed()
      if (result.segmentsPruned > 0) {
        console.log(`[wal-prune] pruned ${result.segmentsPruned} segments`)
      }
    },
  })

  scheduler.start()
  console.log(`[finn] scheduler started: ${scheduler.getStatus().length} tasks`)

  // 9. Start watching identity file
  identity.watch((content) => {
    console.log(`[finn] identity updated (${content.length} chars)`)
  })

  // 10. Start HTTP server
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[finn] loa-finn ready on :${info.port}`)
  })
}

main().catch((err) => {
  console.error("[finn] fatal:", err)
  process.exit(1)
})
