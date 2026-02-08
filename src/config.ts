// src/config.ts — Configuration loader from environment variables (SDD §4.4)

import type { ThinkingLevel } from "@mariozechner/pi-ai"

export interface FinnConfig {
  // Agent
  model: string
  thinkingLevel: ThinkingLevel
  beauvoirPath: string

  // Gateway
  port: number
  host: string

  // Persistence
  dataDir: string
  sessionDir: string
  r2: {
    endpoint: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
  }
  git: {
    remote: string
    branch: string
    archiveBranch: string
    token: string
  }

  // Auth
  auth: {
    bearerToken: string
    corsOrigins: string[]
    rateLimiting: {
      windowMs: number
      maxRequestsPerWindow: number
    }
  }

  // Scheduler
  syncIntervalMs: number
  gitSyncIntervalMs: number
  healthIntervalMs: number

  // Sandbox
  sandbox: {
    allowBash: boolean
    jailRoot: string
    execTimeout: number
    maxOutput: number
  }

  // Worker Pool (Cycle 005)
  workerPool: {
    /** Number of interactive-lane workers */
    interactiveWorkers: number
    /** Shutdown hard deadline in ms */
    shutdownDeadlineMs: number
    /** Max queued jobs per lane */
    maxQueueDepth: number
  }

  /** Sandbox execution mode: worker (default), child_process (async fallback), disabled (fail closed) */
  sandboxMode: "worker" | "child_process" | "disabled"
  /** Dev-only: sync fallback for debugging (never in production) */
  sandboxSyncFallback: boolean
}

const VALID_SANDBOX_MODES = ["worker", "child_process", "disabled"] as const
type SandboxMode = (typeof VALID_SANDBOX_MODES)[number]

function parseSandboxMode(value: string | undefined): SandboxMode {
  const v = (value ?? "worker").trim().toLowerCase()
  if (VALID_SANDBOX_MODES.includes(v as SandboxMode)) return v as SandboxMode
  throw new Error(`SANDBOX_MODE must be one of ${VALID_SANDBOX_MODES.join(", ")} (got "${value}")`)
}

function parseSyncFallback(value: string | undefined, nodeEnv: string | undefined): boolean {
  const enabled = value === "true"
  if (enabled) {
    const env = (nodeEnv ?? "").trim().toLowerCase()
    if (env === "production" || env === "prod") {
      throw new Error("SANDBOX_SYNC_FALLBACK must not be enabled in production")
    }
  }
  return enabled
}

export function loadConfig(): FinnConfig {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY is required")
  }

  const dataDir = process.env.DATA_DIR ?? "./data"

  return {
    model: process.env.MODEL ?? "claude-opus-4-6",
    thinkingLevel: (process.env.THINKING_LEVEL ?? "medium") as ThinkingLevel,
    beauvoirPath: process.env.BEAUVOIR_PATH ?? "grimoires/loa/BEAUVOIR.md",

    port: parseInt(process.env.PORT ?? "3000", 10),
    host: process.env.HOST ?? "0.0.0.0",

    dataDir,
    sessionDir: `${dataDir}/sessions`,

    r2: {
      endpoint: process.env.R2_ENDPOINT ?? "",
      bucket: process.env.R2_BUCKET ?? "loa-finn-data",
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },

    git: {
      remote: process.env.GIT_REMOTE ?? "origin",
      branch: process.env.GIT_BRANCH ?? "main",
      archiveBranch: process.env.GIT_ARCHIVE_BRANCH ?? "finn/archive",
      token: process.env.GIT_TOKEN ?? "",
    },

    auth: {
      bearerToken: process.env.FINN_AUTH_TOKEN ?? "",
      corsOrigins: (process.env.FINN_CORS_ORIGINS ?? "localhost:*").split(","),
      rateLimiting: {
        windowMs: parseInt(process.env.FINN_RATE_LIMIT_WINDOW_MS ?? "60000", 10),
        maxRequestsPerWindow: parseInt(process.env.FINN_RATE_LIMIT_MAX ?? "60", 10),
      },
    },

    syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS ?? "30000", 10),
    gitSyncIntervalMs: parseInt(process.env.GIT_SYNC_INTERVAL_MS ?? "3600000", 10),
    healthIntervalMs: parseInt(process.env.HEALTH_INTERVAL_MS ?? "300000", 10),

    sandbox: {
      allowBash: process.env.FINN_ALLOW_BASH === "true",
      jailRoot: process.env.FINN_SANDBOX_JAIL_ROOT ?? dataDir,
      execTimeout: parseInt(process.env.FINN_SANDBOX_TIMEOUT ?? "30000", 10),
      maxOutput: parseInt(process.env.FINN_SANDBOX_MAX_OUTPUT ?? "65536", 10),
    },

    workerPool: {
      interactiveWorkers: parseInt(process.env.FINN_WORKER_POOL_SIZE ?? "2", 10),
      shutdownDeadlineMs: parseInt(process.env.FINN_WORKER_SHUTDOWN_MS ?? "10000", 10),
      maxQueueDepth: parseInt(process.env.FINN_WORKER_QUEUE_DEPTH ?? "10", 10),
    },

    sandboxMode: parseSandboxMode(process.env.SANDBOX_MODE),
    sandboxSyncFallback: parseSyncFallback(process.env.SANDBOX_SYNC_FALLBACK, process.env.NODE_ENV),
  }
}
