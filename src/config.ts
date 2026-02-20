// src/config.ts — Configuration loader from environment variables (SDD §4.4)

import type { ThinkingLevel } from "@mariozechner/pi-ai"
import { availableParallelism } from "node:os"

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

  /** Cheval adapter mode: subprocess (Phase 0-2 default) or sidecar (Phase 3) */
  chevalMode: "subprocess" | "sidecar"

  /** x402 payment configuration (Sprint 2) */
  x402: {
    enabled: boolean
    challengeSecret: string
    challengeSecretPrevious: string
    walletAddress: string
    alchemyApiKey: string
    rpcUrls: string[]
    minConfirmations: number
  }

  /** PostgreSQL database (Sprint 1 — finn schema) */
  postgres: {
    enabled: boolean
    connectionString: string
    maxConnections: number
  }

  /** Redis state backend (Phase 3 — circuit breaker, budget, rate limiter, idempotency) */
  redis: {
    url: string
    enabled: boolean
    connectTimeoutMs: number
    commandTimeoutMs: number
  }

  /** Model pool configuration (Phase 5 §3.2) */
  pools: {
    configPath: string
  }

  /** S2S JWT signing for loa-finn→arrakis communication (Phase 5 §3.4) */
  s2s: {
    privateKeyPem: string
    kid: string
    issuer: string
    audience: string
  }

  /** Oracle knowledge enrichment (Cycle 025 §3) */
  oracle: {
    enabled: boolean
    sourcesConfigPath: string
    minContextWindow: number
    // Phase 1 additions (SDD §3.5)
    dailyCap: number
    costCeilingCents: number
    maxConcurrent: number
    publicDailyLimit: number
    authenticatedDailyLimit: number
    estimatedCostCents: number
    trustXff: boolean
    corsOrigins: string[]
    dixieRef: string
  }

  /** JWT validation for arrakis-originated requests (Phase 5 §3.1) */
  jwt: {
    enabled: boolean
    issuer: string
    issuers?: string[]                    // Issuer allowlist (overrides issuer if set)
    audience: string
    jwksUrl: string
    clockSkewSeconds: number
    maxTokenLifetimeSeconds: number
    maxStalenessMs?: number               // JWKS DEGRADED threshold (default: 24h)
    compromiseMode?: boolean              // Tighten staleness to 1h
    compromiseMaxStalenessMs?: number     // Compromise-mode staleness (default: 1h)
  }
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

/** Parse an integer from an environment variable, failing fast on NaN (SD-012). */
function parseIntEnv(envKey: string, fallback: string): number {
  const raw = process.env[envKey] ?? fallback
  const value = parseInt(raw, 10)
  if (isNaN(value)) {
    throw new Error(`${envKey} must be a valid integer (got "${raw}")`)
  }
  return value
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

    port: parseIntEnv("PORT", "3000"),
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
        windowMs: parseIntEnv("FINN_RATE_LIMIT_WINDOW_MS", "60000"),
        maxRequestsPerWindow: parseIntEnv("FINN_RATE_LIMIT_MAX", "60"),
      },
    },

    syncIntervalMs: parseIntEnv("SYNC_INTERVAL_MS", "30000"),
    gitSyncIntervalMs: parseIntEnv("GIT_SYNC_INTERVAL_MS", "3600000"),
    healthIntervalMs: parseIntEnv("HEALTH_INTERVAL_MS", "300000"),

    sandbox: {
      allowBash: process.env.FINN_ALLOW_BASH === "true",
      jailRoot: process.env.FINN_SANDBOX_JAIL_ROOT ?? dataDir,
      execTimeout: parseIntEnv("FINN_SANDBOX_TIMEOUT", "30000"),
      maxOutput: parseIntEnv("FINN_SANDBOX_MAX_OUTPUT", "65536"),
    },

    workerPool: {
      interactiveWorkers: Math.max(1, Math.min(
        parseIntEnv("FINN_WORKER_POOL_SIZE", "2"),
        Math.max(1, availableParallelism() - 1),
      )),
      shutdownDeadlineMs: parseIntEnv("FINN_WORKER_SHUTDOWN_MS", "10000"),
      maxQueueDepth: parseIntEnv("FINN_WORKER_QUEUE_DEPTH", "10"),
    },

    sandboxMode: parseSandboxMode(process.env.SANDBOX_MODE),
    sandboxSyncFallback: parseSyncFallback(process.env.SANDBOX_SYNC_FALLBACK, process.env.NODE_ENV),

    chevalMode: (process.env.CHEVAL_MODE ?? "subprocess") as "subprocess" | "sidecar",

    x402: {
      enabled: process.env.X402_ENABLED === "true",
      challengeSecret: process.env.X402_CHALLENGE_SECRET ?? "",
      challengeSecretPrevious: process.env.X402_CHALLENGE_SECRET_PREVIOUS ?? "",
      walletAddress: process.env.X402_WALLET_ADDRESS ?? "",
      alchemyApiKey: process.env.ALCHEMY_API_KEY ?? "",
      rpcUrls: (process.env.X402_RPC_URLS ?? "").split(",").filter(Boolean),
      minConfirmations: parseIntEnv("X402_MIN_CONFIRMATIONS", "10"),
    },

    postgres: {
      enabled: process.env.FINN_POSTGRES_ENABLED === "true",
      connectionString: process.env.DATABASE_URL ?? "",
      maxConnections: parseIntEnv("FINN_PG_MAX_CONNECTIONS", "10"),
    },

    redis: {
      url: process.env.REDIS_URL ?? "",
      enabled: !!process.env.REDIS_URL,
      connectTimeoutMs: parseIntEnv("REDIS_CONNECT_TIMEOUT_MS", "5000"),
      commandTimeoutMs: parseIntEnv("REDIS_COMMAND_TIMEOUT_MS", "3000"),
    },

    pools: {
      configPath: process.env.FINN_POOLS_CONFIG ?? "",
    },

    s2s: {
      privateKeyPem: process.env.FINN_S2S_PRIVATE_KEY ?? "",
      kid: process.env.FINN_S2S_KID ?? "loa-finn-v1",
      issuer: process.env.FINN_S2S_ISSUER ?? "loa-finn",
      audience: process.env.FINN_S2S_AUDIENCE ?? "arrakis",
    },

    oracle: {
      enabled: process.env.FINN_ORACLE_ENABLED === "true",
      sourcesConfigPath: process.env.FINN_ORACLE_SOURCES_CONFIG ?? "grimoires/oracle/sources.json",
      minContextWindow: parseIntEnv("FINN_ORACLE_MIN_CONTEXT", "30000"),
      // Phase 1 additions (SDD §3.5)
      dailyCap: parseIntEnv("FINN_ORACLE_DAILY_CAP", "200"),
      costCeilingCents: parseIntEnv("FINN_ORACLE_COST_CEILING_CENTS", "2000"),
      maxConcurrent: parseIntEnv("FINN_ORACLE_MAX_CONCURRENT", "3"),
      publicDailyLimit: parseIntEnv("FINN_ORACLE_PUBLIC_DAILY_LIMIT", "5"),
      authenticatedDailyLimit: parseIntEnv("FINN_ORACLE_AUTH_DAILY_LIMIT", "50"),
      estimatedCostCents: parseIntEnv("FINN_ORACLE_ESTIMATED_COST_CENTS", "50"),
      trustXff: process.env.FINN_ORACLE_TRUST_XFF !== "false",
      corsOrigins: (process.env.FINN_ORACLE_CORS_ORIGINS ?? "https://oracle.arrakis.community").split(","),
      dixieRef: process.env.DIXIE_REF ?? "unknown",
    },

    jwt: {
      enabled: process.env.FINN_JWT_ENABLED === "true",
      issuer: process.env.FINN_JWT_ISSUER ?? "arrakis",
      audience: process.env.FINN_JWT_AUDIENCE ?? "loa-finn",
      jwksUrl: process.env.FINN_JWKS_URL ?? "",
      clockSkewSeconds: parseIntEnv("FINN_JWT_CLOCK_SKEW", "30"),
      maxTokenLifetimeSeconds: parseIntEnv("FINN_JWT_MAX_LIFETIME", "3600"),
    },
  }
}
