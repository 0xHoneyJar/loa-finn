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
import { ResilientHttpClient } from "./shared/http-client.js"
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

  // 1a. Initialize OTLP tracing (non-fatal, cycle-024 T4)
  const { initTracing } = await import("./tracing/otlp.js")
  await initTracing({
    endpoint: process.env.OTLP_ENDPOINT,
    environment: process.env.NODE_ENV ?? "development",
  })

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
    const http = new ResilientHttpClient({
      maxRetries: 3,
      baseDelayMs: 1000,
      rateLimitBuffer: 10,
      redactPatterns: [],
    })
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

  // 6d2. Initialize Redis state backend (Phase 3 Sprint 2, SDD §2.3, §4.6)
  let redis: import("./hounfour/redis/client.js").RedisStateBackend | null = null
  if (config.redis.enabled) {
    try {
      const { RedisStateBackend, DEFAULT_REDIS_CONFIG } = await import("./hounfour/redis/client.js")
      const { createIoredisFactory } = await import("./hounfour/redis/ioredis-factory.js")

      const factory = await createIoredisFactory()
      redis = new RedisStateBackend(
        {
          url: config.redis.url,
          ...DEFAULT_REDIS_CONFIG,
          connectTimeoutMs: config.redis.connectTimeoutMs,
          commandTimeoutMs: config.redis.commandTimeoutMs,
        },
        factory,
      )
      await redis.connect()

      if (redis.isConnected()) {
        const ping = await redis.ping()
        console.log(`[finn] redis connected: latency=${ping.latencyMs}ms`)
      } else {
        console.warn("[finn] redis: connection failed, components will use fallbacks")
      }
    } catch (err) {
      console.warn(`[finn] redis: initialization failed (non-fatal): ${(err as Error).message}`)
      redis = null
    }
  } else {
    console.log("[finn] redis: disabled (set REDIS_URL to enable)")
  }

  // 6d3. Initialize DLQ Store — mode set once at startup, never switches (PRD §5, SDD §3.1)
  let dlqStore: import("./hounfour/dlq-store.js").DLQStore
  let dlqAofVerified = false
  if (redis?.isConnected()) {
    const { RedisDLQStore } = await import("./hounfour/redis/dlq.js")
    const redisDlq = new RedisDLQStore(redis)
    const persistenceCheck = await redisDlq.validatePersistence()
    dlqAofVerified = persistenceCheck.aofVerified
    dlqStore = redisDlq
    console.log(`[finn] dlq store: type=redis durable=true aof_verified=${persistenceCheck.aofVerified} checked=${persistenceCheck.checked}${persistenceCheck.reason ? ` reason="${persistenceCheck.reason}"` : ""}`)
  } else {
    const { InMemoryDLQStore } = await import("./hounfour/dlq-store.js")
    dlqStore = new InMemoryDLQStore()
    console.log("[finn] dlq store: type=in-memory durable=false (redis unavailable)")
  }

  // 6e. Initialize Hounfour multi-model routing (SDD §4, T-15.9)
  let hounfour: import("./hounfour/router.js").HounfourRouter | undefined
  try {
    const { existsSync: exists, readFileSync: readSync } = await import("node:fs")
    const providerConfigPath = join(process.cwd(), ".loa.config.json")
    if (exists(providerConfigPath)) {
      const rawConfig = JSON.parse(readSync(providerConfigPath, "utf-8"))
      if (rawConfig.providers && Object.keys(rawConfig.providers).length > 0) {
        const { ProviderRegistry } = await import("./hounfour/registry.js")
        const { BudgetEnforcer } = await import("./hounfour/budget.js")
        const { ChevalInvoker } = await import("./hounfour/cheval-invoker.js")
        const { FullHealthProber } = await import("./hounfour/health.js")
        const { ProviderRateLimiter } = await import("./hounfour/rate-limiter.js")
        const { HounfourRouter } = await import("./hounfour/router.js")

        const registry = ProviderRegistry.fromConfig(rawConfig)
        const budgetDir = join(config.dataDir, "hounfour")
        const budget = new BudgetEnforcer({
          ledgerPath: join(budgetDir, "cost-ledger.jsonl"),
          checkpointPath: join(budgetDir, "budget-checkpoint.json"),
          onLedgerFailure: rawConfig.metering?.on_failure ?? "fail-open",
          warnPercent: rawConfig.metering?.warn_percent ?? 80,
          budgets: rawConfig.metering?.budgets ?? {},
        })

        // Restore budget state from checkpoint (O(1))
        await budget.initFromCheckpoint()

        // Full health prober with circuit breaker and WAL logging (T-16.2, T-16.4)
        const healthConfig = rawConfig.routing?.health ?? {}
        // Adapt upstream WALManager to WALLike interface for HealthProber
        const walAdapter = {
          append(_type: string, _operation: string, path: string, data: unknown): string {
            wal.append("write", path, Buffer.from(JSON.stringify(data)))
            return `wal-${Date.now()}`
          },
        }
        const healthProber = new FullHealthProber(
          {
            unhealthy_threshold: healthConfig.failure_threshold ?? 3,
            recovery_threshold: 1,
            recovery_interval_ms: healthConfig.recovery_interval_ms ?? 30_000,
            recovery_jitter_percent: 20,
          },
          { wal: walAdapter },
        )

        // Per-provider rate limiter (T-16.3)
        const rateLimitConfigs: Record<string, { rpm: number; tpm: number; queue_timeout_ms: number }> = {}
        for (const [name, pConfig] of Object.entries(rawConfig.providers ?? {})) {
          const rl = (pConfig as Record<string, unknown>).rate_limit as Record<string, number> | undefined
          if (rl) {
            rateLimitConfigs[name] = {
              rpm: rl.rpm ?? 60,
              tpm: rl.tpm ?? 100_000,
              queue_timeout_ms: rl.queue_timeout_ms ?? 30_000,
            }
          }
        }
        const rateLimiter = new ProviderRateLimiter(rateLimitConfigs)
        const hmacSecret = process.env.CHEVAL_HMAC_SECRET
        if (!hmacSecret) {
          console.warn("[finn] CHEVAL_HMAC_SECRET not set — hounfour disabled")
        } else {
          const invoker = new ChevalInvoker({ hmac: { secret: hmacSecret } })
          const scopeMeta = {
            project_id: rawConfig.project_id ?? "default",
            phase_id: rawConfig.phase_id ?? "phase-0",
            sprint_id: rawConfig.sprint_id ?? "sprint-0",
          }

          // 6d-oracle. Oracle Knowledge Registry bootstrap (Cycle 025 §3)
          let knowledgeRegistry: import("./hounfour/knowledge-registry.js").KnowledgeRegistry | undefined
          if (config.oracle.enabled) {
            try {
              const { KnowledgeRegistry: KR, shouldRegisterOracle } = await import("./hounfour/knowledge-registry.js")
              const kr = await KR.fromConfig(config.oracle.sourcesConfigPath, process.cwd())
              if (shouldRegisterOracle(config.oracle.enabled, kr)) {
                knowledgeRegistry = kr
                const health = kr.isHealthy()
                console.log(`[finn] oracle: registry loaded (${health.totalTokens} tokens, ${health.missing.length} missing)`)
              } else {
                console.warn("[finn] oracle: enabled but registry unhealthy — oracle disabled")
              }
            } catch (err) {
              console.warn(`[finn] oracle: registry initialization failed — oracle disabled: ${(err as Error).message}`)
            }
          }

          hounfour = new HounfourRouter({
            registry, budget, health: healthProber, cheval: invoker,
            scopeMeta, rateLimiter,
            projectRoot: process.cwd(),
            knowledgeRegistry,
          })

          // Validate all bindings at startup
          hounfour.validateBindings()
          console.log(`[finn] hounfour initialized: ${Object.keys(rawConfig.providers).length} providers, ${Object.keys(rawConfig.agents ?? {}).length} agents${knowledgeRegistry ? ", oracle enabled" : ""}`)
        }
      } else {
        console.log("[finn] hounfour: no providers configured — skipped")
      }
    } else {
      console.log("[finn] hounfour: .loa.config.json not found — skipped")
    }
  } catch (err) {
    console.error(`[finn] hounfour initialization failed (non-fatal):`, (err as Error).message)
    // Non-fatal — loa-finn works without hounfour (backward compatible per NFR-3)
  }

  // 6e-guard. BillingConservationGuard — evaluator wrapper (SDD §4.2)
  // Init after hounfour (needs constraint evaluator), before gateway (needs to gate billing routes).
  // Pod always becomes READY — init() never throws, never crashes the process.
  let billingGuard: import("./hounfour/billing-conservation-guard.js").BillingConservationGuard | undefined
  if (hounfour) {
    try {
      const { BillingConservationGuard } = await import("./hounfour/billing-conservation-guard.js")
      billingGuard = new BillingConservationGuard({
        podId: process.env.POD_ID,
        buildSha: process.env.BUILD_SHA,
      })
      await billingGuard.init()
      billingGuard.startRecoveryTimer()
      const guardHealth = billingGuard.getHealth()
      console.log(`[finn] billing guard: state=${guardHealth.state}, compiled=${guardHealth.evaluator_compiled}, billing=${guardHealth.billing}`)
    } catch (err) {
      console.error(`[finn] billing guard init failed (non-fatal):`, (err as Error).message)
      billingGuard = undefined
    }
  }

  // 6e-bis. Initialize S2S Billing Finalize Client (Phase 5 T5, Sprint B T3)
  // Algorithm selection: FINN_S2S_JWT_ALG (explicit) > auto-detect from key material
  let billingFinalizeClient: import("./hounfour/billing-finalize-client.js").BillingFinalizeClient | undefined
  let s2sSigner: import("./hounfour/s2s-jwt.js").S2SJwtSigner | undefined
  const billingUrl = process.env.ARRAKIS_BILLING_URL
  if (billingUrl && hounfour) {
    const s2sPrivateKey = process.env.FINN_S2S_PRIVATE_KEY
    const s2sJwtSecret = process.env.FINN_S2S_JWT_SECRET
    const rawAlg = process.env.FINN_S2S_JWT_ALG
    const explicitAlg = rawAlg === "ES256" || rawAlg === "HS256" ? rawAlg : undefined
    if (rawAlg && !explicitAlg) {
      throw new Error(`Invalid FINN_S2S_JWT_ALG="${rawAlg}" — must be "ES256" or "HS256"`)
    }
    // T3: ES256-only enforcement in production — HS256 gated behind NODE_ENV !== "production"
    const isProduction = (process.env.NODE_ENV ?? "").toLowerCase() === "production"
    if (isProduction && explicitAlg === "HS256") {
      throw new Error("FINN_S2S_JWT_ALG=HS256 is not permitted in production — use ES256")
    }
    if (isProduction && !s2sPrivateKey && s2sJwtSecret && !explicitAlg) {
      throw new Error("HS256 auto-detection blocked in production — set FINN_S2S_JWT_ALG=ES256 and provide FINN_S2S_PRIVATE_KEY")
    }

    try {
      const { S2SJwtSigner } = await import("./hounfour/s2s-jwt.js")
      const { BillingFinalizeClient } = await import("./hounfour/billing-finalize-client.js")
      type S2SConfig = import("./hounfour/s2s-jwt.js").S2SConfig

      let s2sConfig: S2SConfig | null = null

      if (explicitAlg === "HS256") {
        if (!s2sJwtSecret) throw new Error("FINN_S2S_JWT_ALG=HS256 requires FINN_S2S_JWT_SECRET")
        s2sConfig = { alg: "HS256", secret: s2sJwtSecret, issuer: "loa-finn", audience: "arrakis" }
      } else if (explicitAlg === "ES256") {
        if (!s2sPrivateKey) throw new Error("FINN_S2S_JWT_ALG=ES256 requires FINN_S2S_PRIVATE_KEY")
        s2sConfig = { alg: "ES256", privateKeyPem: s2sPrivateKey, kid: process.env.FINN_S2S_KID ?? "loa-finn-v1", issuer: "loa-finn", audience: "arrakis" }
      } else if (s2sPrivateKey && s2sJwtSecret) {
        // Ambiguity guard: both keys set without explicit alg → startup error
        throw new Error("Both FINN_S2S_PRIVATE_KEY and FINN_S2S_JWT_SECRET set — set FINN_S2S_JWT_ALG to resolve ambiguity")
      } else if (s2sJwtSecret) {
        // Auto-detect HS256
        s2sConfig = { alg: "HS256", secret: s2sJwtSecret, issuer: "loa-finn", audience: "arrakis" }
      } else if (s2sPrivateKey) {
        // Auto-detect ES256 (backward compatible)
        s2sConfig = { alg: "ES256", privateKeyPem: s2sPrivateKey, kid: process.env.FINN_S2S_KID ?? "loa-finn-v1", issuer: "loa-finn", audience: "arrakis" }
      }

      if (s2sConfig) {
        s2sSigner = new S2SJwtSigner(s2sConfig)
        await s2sSigner.init()
        billingFinalizeClient = new BillingFinalizeClient({
          billingUrl,  // base URL — client appends /api/internal/finalize
          s2sSigner,
          dlqStore,
          aofVerified: dlqAofVerified,
        })
        billingFinalizeClient.startReplayTimer()
        hounfour.setBillingFinalize(billingFinalizeClient)
        console.log(`[finn] billing finalize client initialized: alg=${s2sConfig.alg} url=${billingUrl}`)
      } else {
        console.warn("[finn] ARRAKIS_BILLING_URL set but no S2S key material — billing finalize disabled")
      }
    } catch (err) {
      console.error(`[finn] billing finalize init failed (non-fatal):`, (err as Error).message)
    }
  }

  // 6f. Initialize Cheval sidecar + Orchestrator (Phase 3, T-1.3/T-1.4/T-1.5/T-1.7)
  let sidecarManager: import("./hounfour/sidecar-manager.js").SidecarManager | undefined
  let orchestrator: import("./hounfour/orchestrator.js").Orchestrator | undefined

  if (config.chevalMode === "sidecar" && hounfour) {
    const hmacSecret = process.env.CHEVAL_HMAC_SECRET
    if (hmacSecret) {
      try {
        const { SidecarManager } = await import("./hounfour/sidecar-manager.js")
        const { SidecarClient } = await import("./hounfour/sidecar-client.js")
        const { Orchestrator } = await import("./hounfour/orchestrator.js")
        const { IdempotencyCache } = await import("./hounfour/idempotency.js")
        const { RedisIdempotencyCache } = await import("./hounfour/redis/idempotency.js")

        const chevalPort = parseInt(process.env.CHEVAL_PORT ?? "3001", 10)
        sidecarManager = new SidecarManager({
          port: chevalPort,
          env: {
            CHEVAL_HMAC_SECRET: hmacSecret,
            ...(process.env.CHEVAL_HMAC_SECRET_PREV ? { CHEVAL_HMAC_SECRET_PREV: process.env.CHEVAL_HMAC_SECRET_PREV } : {}),
          },
        })

        await sidecarManager.start()

        const sidecarClient = new SidecarClient({
          baseUrl: sidecarManager.baseUrl,
          hmac: { secret: hmacSecret, secretPrev: process.env.CHEVAL_HMAC_SECRET_PREV },
        })

        // Idempotency cache: Redis-backed with memory fallback, or memory-only
        const idempotencyCache = redis
          ? new RedisIdempotencyCache(redis)
          : new IdempotencyCache()

        // Tool executor: delegates to SandboxExecutor if available
        const toolExecutor: import("./hounfour/orchestrator.js").ToolExecutor = {
          async execute(toolName: string, _args: Record<string, unknown>) {
            return { output: `Tool ${toolName} not wired yet`, is_error: true }
          },
        }

        // Model adapter delegates to HounfourRouter (which selects provider + model)
        const modelAdapter: import("./hounfour/types.js").ModelPortBase = {
          async complete(req: import("./hounfour/types.js").CompletionRequest) {
            return hounfour!.invoke(req.metadata.agent, req.messages[req.messages.length - 1]?.content ?? "")
          },
          capabilities() { return { tool_calling: true, thinking_traces: false, vision: false, streaming: false } },
          async healthCheck() { return { healthy: sidecarManager!.isRunning, latency_ms: 0 } },
        }

        orchestrator = new Orchestrator({
          model: modelAdapter,
          toolExecutor,
          idempotencyCache,
        })

        console.log(`[finn] sidecar started on port ${chevalPort}, orchestrator ready (idempotency: ${redis ? "redis" : "memory"})`)
      } catch (err) {
        console.error(`[finn] sidecar initialization failed (non-fatal):`, (err as Error).message)
      }
    }
  } else if (config.chevalMode === "sidecar") {
    console.log("[finn] sidecar mode requested but hounfour not available — skipped")
  }

  // 7. Create gateway (with executor for sandbox, pool for health stats)
  const ledgerPath = join(config.dataDir, "hounfour", "cost-ledger.jsonl")
  const { app, router } = createApp(config, { activityFeed, executor, pool, hounfour, s2sSigner, billingFinalizeClient, billingConservationGuard: billingGuard, ledgerPath })

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
    getBillingGuardHealth: billingGuard ? () => billingGuard!.getHealth() : undefined,
    getProviderHealth: hounfour ? () => hounfour!.healthSnapshot().providers : undefined,
    getBudgetSnapshot: hounfour ? () => hounfour!.budgetSnapshot() : undefined,
    getRedisHealth: redis ? async () => redis!.ping() : undefined,
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

  // 9b. Protocol version handshake — MUST run before server.listen() (Phase 5 T5)
  // WHY: Kubernetes readiness probe pattern — validate external dependencies before
  // accepting traffic. If protocol is incompatible, the server should never have been
  // "ready." Fail-fast at boot prevents serving requests that will inevitably fail
  // at the billing boundary. See Bridgebuilder Finding #8 PRAISE (PR #68).
  if (billingUrl) {
    try {
      const { validateProtocolAtBoot } = await import("./hounfour/protocol-handshake.js")
      await validateProtocolAtBoot({
        arrakisBaseUrl: process.env.ARRAKIS_BASE_URL,
        billingUrl,
        env: process.env.NODE_ENV ?? "development",
      })
    } catch (err) {
      // In production, validateProtocolAtBoot throws — propagate to halt boot
      if (process.env.NODE_ENV === "production") throw err
      console.error(`[finn] protocol handshake failed (non-fatal):`, (err as Error).message)
    }
  }

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

    // Stop billing guard recovery timer
    if (billingGuard) billingGuard.stopRecoveryTimer()

    // Shutdown sidecar (Phase 3)
    if (sidecarManager) {
      try { await sidecarManager.stop() } catch (err) { console.error("[finn] sidecar shutdown error:", err) }
    }

    // Shutdown worker pool (abort running, terminate workers)
    if (pool) {
      try { await pool.shutdown() } catch (err) { console.error("[finn] pool shutdown error:", err) }
    }

    // Disconnect Redis (before final sync — Redis not needed for R2/WAL)
    if (redis) {
      try { await redis.disconnect() } catch (err) { console.error("[finn] redis disconnect error:", err) }
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
