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
import { handleWebSocket } from "./gateway/ws.js"
import { validateWsToken } from "./gateway/auth.js"
import { Scheduler } from "./scheduler/scheduler.js"
import { HealthAggregator } from "./scheduler/health.js"
import { BeadsBridge } from "./beads/bridge.js"
import { CompoundLearning } from "./learning/compound.js"
import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"

async function main() {
  const bootStart = Date.now()
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

  // 7. Create gateway (with health aggregator once available)
  // We create a placeholder and update after scheduler init
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
  const bootDuration = Date.now() - bootStart
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    const health = healthAggregator.check()
    console.log(`[finn] loa-finn ready on :${info.port} (boot: ${bootDuration}ms, status: ${health.status})`)
    console.log(`[finn] webchat: http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${info.port}/`)
  })

  // 10b. WebSocket upgrade handler
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
    const match = url.pathname.match(/^\/ws\/(.+)$/)
    if (!match) {
      socket.destroy()
      return
    }

    const sessionId = match[1]
    const token = url.searchParams.get("token") ?? undefined

    // Validate auth if configured
    if (!validateWsToken(token, config)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    const clientIp = request.headers["cf-connecting-ip"] as string
      ?? (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? request.socket.remoteAddress
      ?? "unknown"

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleWebSocket(ws, sessionId, clientIp, {
        config,
        getSession: (id) => router.get(id),
        resumeSession: (id) => router.resume(id),
      })
    })
  })
  console.log(`[finn] websocket handler attached`)

  // 11. Graceful shutdown handler (T-5.8)
  let shuttingDown = false
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    const start = Date.now()
    console.log(`[finn] ${signal} received, shutting down gracefully...`)

    // Stop scheduler (no new tasks)
    scheduler.stop()

    // Stop identity watcher
    identity.stopWatching()

    // Close HTTP server (stop accepting new connections)
    server.close()

    // Final R2 sync
    try {
      const syncResult = await r2Sync.sync()
      console.log(`[finn] final sync: ${syncResult.filesUploaded} files`)
    } catch (err) {
      console.error("[finn] final sync failed:", err)
    }

    const duration = Date.now() - start
    console.log(`[finn] shutdown complete in ${duration}ms`)
    process.exit(0)
  }

  const handleSignal = (signal: string) => {
    // Start force-exit timer on first signal
    setTimeout(() => {
      console.error("[finn] forced shutdown after 30s timeout")
      process.exit(1)
    }, 30_000).unref()

    gracefulShutdown(signal)
  }

  process.on("SIGTERM", () => handleSignal("SIGTERM"))
  process.on("SIGINT", () => handleSignal("SIGINT"))
}

main().catch((err) => {
  console.error("[finn] fatal:", err)
  process.exit(1)
})
