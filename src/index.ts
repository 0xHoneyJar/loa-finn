// src/index.ts — loa-finn entry point (SDD §10.2)
// Boot sequence: config → validate → identity → persistence → recovery → gateway → scheduler → serve

import { loadConfig } from "./config.js"
import { IdentityLoader } from "./agent/identity.js"
import { createWALManager } from "./persistence/upstream.js"
import { walPath } from "./persistence/wal-path.js"
import { validateUpstreamPersistence } from "./persistence/upstream-check.js"
import { ObjectStoreSync } from "./persistence/r2-sync.js"
import { GitSync } from "./persistence/git-sync.js"
import { runRecovery } from "./persistence/recovery.js"
import { WALPruner } from "./persistence/pruner.js"
import { createApp } from "./gateway/server.js"
import { handleWebSocket } from "./gateway/ws.js"
import { validateWsToken } from "./gateway/auth.js"
import { Scheduler } from "./scheduler/scheduler.js"
import { HealthAggregator } from "./scheduler/health.js"
import { BeadsBridge } from "./beads/bridge.js"
import { CompoundLearning } from "./learning/compound.js"
import { ActivityFeed } from "./dashboard/activity-feed.js"
import { ResilientHttpClient } from "./bridgebuilder/adapters/resilient-http.js"
import { WorkerPool } from "./agent/worker-pool.js"
import { createExecutor } from "./agent/sandbox-executor.js"
import type { SandboxExecutor } from "./agent/sandbox-executor.js"
import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

async function main() {
  const bootStart = Date.now()
  console.log("[finn] booting loa-finn...")

  // 1. Load config
  const config = loadConfig()
  console.log(`[finn] config loaded: model=${config.model}, port=${config.port}`)

  // 1b. Validate upstream persistence framework (DD-1)
  validateUpstreamPersistence()
  console.log("[finn] upstream persistence validated")

  // 2. Load identity (upstream IdentityLoader with FileWatcher hot-reload)
  const identity = new IdentityLoader({
    beauvoirPath: config.beauvoirPath,
    notesPath: "grimoires/loa/NOTES.md",
  })
  const identityDoc = await identity.load()
  const validation = identity.validate()
  console.log(`[finn] identity loaded: v${identityDoc.version}, checksum=${identityDoc.checksum.slice(0, 8)}, valid=${validation.valid}`)

  // 3. Initialize persistence (upstream WALManager)
  const walDir = join(config.dataDir, "wal")
  const wal = createWALManager(walDir)
  await wal.initialize()

  const r2Sync = new ObjectStoreSync(config, wal)
  const gitSync = new GitSync(config, wal)
  const pruner = new WALPruner(wal)

  const walStatus = wal.getStatus()
  console.log(`[finn] persistence initialized: wal seq=${walStatus.seq}, segments=${walStatus.segmentCount}`)

  // 4. Recovery cascade (upstream RecoveryEngine)
  const recoveryResult = await runRecovery(config, wal, r2Sync, gitSync)
  console.log(`[finn] recovery: source=${recoveryResult.source}, mode=${recoveryResult.mode}, state=${recoveryResult.state}, entries=${recoveryResult.walEntriesReplayed}`)

  // 5. Initialize beads bridge (with WAL-backed transition logging)
  const beads = new BeadsBridge()
  await beads.init(wal)
  console.log(`[finn] beads: available=${beads.isAvailable}`)

  // 6. Initialize compound learning
  const compound = new CompoundLearning(config.dataDir, wal)

  // 6b. Initialize dashboard activity feed (optional — requires GITHUB_TOKEN)
  let activityFeed: ActivityFeed | undefined
  const ghToken = process.env.GITHUB_TOKEN
  const bbRepos = process.env.BRIDGEBUILDER_REPOS
  const bbBotUser = process.env.BRIDGEBUILDER_BOT_USER
  if (ghToken && bbRepos && bbBotUser) {
    const http = new ResilientHttpClient(ghToken)
    activityFeed = new ActivityFeed(
      {
        githubToken: ghToken,
        repos: bbRepos.split(",").map(r => r.trim()).filter(Boolean),
        botUsername: bbBotUser,
        cacheTtlMs: 300_000,
        minRefreshIntervalMs: 60_000,
        idempotencyMarkerPrefix: "<!-- finn-review: ",
      },
      http,
    )
    console.log(`[finn] dashboard: activity feed initialized for ${bbBotUser}`)
  } else {
    console.log("[finn] dashboard: activity feed disabled (set GITHUB_TOKEN, BRIDGEBUILDER_REPOS, BRIDGEBUILDER_BOT_USER)")
  }

  // 6c. Initialize worker pool and executor (Cycle 005 — SDD §3.1, §5.3)
  let pool: WorkerPool | undefined
  let executor: SandboxExecutor | undefined
  if (config.sandboxMode !== "disabled") {
    const workerScript = fileURLToPath(new URL("./agent/sandbox-worker.js", import.meta.url))
    try {
      const { accessSync } = await import("node:fs")
      accessSync(workerScript)
    } catch {
      throw new Error(`[finn] worker script not found at ${workerScript}. Check build output paths.`)
    }
    pool = new WorkerPool({
      interactiveWorkers: config.workerPool.interactiveWorkers,
      workerScript,
      shutdownDeadlineMs: config.workerPool.shutdownDeadlineMs,
      maxQueueDepth: config.workerPool.maxQueueDepth,
    })
    // Wire executor via factory — routes to WorkerExecutor or ChildProcessExecutor
    // based on SANDBOX_MODE (SD-013, SDD §5.3)
    executor = createExecutor(config.sandboxMode, pool)
    console.log(`[finn] worker pool initialized: mode=${config.sandboxMode}, ${config.workerPool.interactiveWorkers} interactive + 1 system`)
  } else {
    console.log(`[finn] worker pool skipped: SANDBOX_MODE=disabled`)
  }

  // 6d. Wire pool into GitSync for async git operations
  if (pool) gitSync.setPool(pool)

  // 7. Create gateway (with executor for sandbox, pool for health stats)
  const { app, router } = createApp(config, { activityFeed, executor, pool })

  // 8. Set up scheduler with registered tasks (T-4.4)
  const scheduler = new Scheduler()
  let identityWatching = false
  const healthAggregator = new HealthAggregator({
    config,
    wal,
    r2Sync,
    gitSync,
    scheduler,
    getSessionCount: () => router.getActiveCount(),
    getBeadsAvailable: () => beads.isAvailable,
    getRecoveryState: () => ({
      state: recoveryResult.state,
      source: recoveryResult.source,
    }),
    getIdentityStatus: () => ({
      checksum: identity.getIdentity()?.checksum ?? "",
      watching: identityWatching,
    }),
    getLearningCounts: () => ({ total: 0, active: 0 }), // Updated async by health task
    getWorkerPoolStats: () => pool?.stats(),
  })

  // Log circuit breaker transitions to WAL
  scheduler.onCircuitTransition((taskId, from, to) => {
    console.log(`[scheduler] circuit breaker ${taskId}: ${from} -> ${to}`)
    wal.append("write", walPath("config", `circuit-breaker-${taskId}`), Buffer.from(JSON.stringify({ taskId, from, to })))
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
        // Report confirmed seq to pruner
        const cp = r2Sync.getLastCheckpoint()
        if (cp?.walHeadSeq) pruner.setConfirmedR2Seq(cp.walHeadSeq)
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
        const pushed = await gitSync.push()
        if (pushed) {
          // Report confirmed seq to pruner
          const seq = parseInt(snapshot.walCheckpoint, 10)
          if (!isNaN(seq)) pruner.setConfirmedGitSeq(seq)
          console.log(`[git-sync] snapshot ${snapshot.snapshotId} pushed`)
        }
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
    id: "wal_prune",
    name: "WAL Prune",
    intervalMs: 3600_000,
    jitterMs: 300_000,
    handler: async () => {
      const result = await pruner.pruneConfirmed()
      if (result.segmentsPruned > 0) {
        console.log(`[wal-prune] pruned ${result.segmentsPruned} entries (ratio: ${result.compactionRatio.toFixed(2)})`)
      }
    },
  })

  scheduler.start()
  console.log(`[finn] scheduler started: ${scheduler.getStatus().length} tasks`)

  // 9. Start watching identity file (FileWatcher with polling fallback)
  identity.startWatching(() => {
    const doc = identity.getIdentity()
    console.log(`[finn] identity reloaded: v${doc?.version}, checksum=${doc?.checksum.slice(0, 8)}`)
  })
  identityWatching = true

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
  // Shutdown order (SD-014): close inbound first, drain internal, flush outbound.
  //   1. Stop scheduler (no new cron tasks)
  //   2. Stop identity watcher
  //   3. Close HTTP server (stop accepting new connections — prevents requests hitting dead pool)
  //   4. Shutdown worker pool (abort running jobs, terminate workers)
  //   5. Final R2 sync (flush outbound state)
  //   6. Drain WAL writes
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
    identityWatching = false

    // Close HTTP server first — stop accepting new connections before
    // killing the pool, so in-flight requests don't hit POOL_SHUTTING_DOWN (SD-014)
    server.close()

    // Shutdown worker pool (abort running, terminate workers)
    if (pool) {
      try { await pool.shutdown() } catch (err) { console.error("[finn] pool shutdown error:", err) }
    }

    // Final R2 sync
    try {
      const syncResult = await r2Sync.sync()
      console.log(`[finn] final sync: ${syncResult.filesUploaded} files`)
    } catch (err) {
      console.error("[finn] final sync failed:", err)
    }

    // Drain pending WAL writes before shutdown (defensive for upstream #12:
    // writeChain is private, but compact() awaits it internally)
    try { await wal.compact() } catch { /* ok if nothing to compact */ }
    await wal.shutdown()

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
