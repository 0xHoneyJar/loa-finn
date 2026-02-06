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
    csrfEnabled: boolean
    rateLimiting: {
      windowMs: number
      maxRequestsPerWindow: number
    }
  }

  // Scheduler
  syncIntervalMs: number
  gitSyncIntervalMs: number
  healthIntervalMs: number

  // Feature flags
  allowBash: boolean
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
      csrfEnabled: process.env.FINN_CSRF_ENABLED !== "false",
      rateLimiting: {
        windowMs: parseInt(process.env.FINN_RATE_LIMIT_WINDOW_MS ?? "60000", 10),
        maxRequestsPerWindow: parseInt(process.env.FINN_RATE_LIMIT_MAX ?? "60", 10),
      },
    },

    syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS ?? "30000", 10),
    gitSyncIntervalMs: parseInt(process.env.GIT_SYNC_INTERVAL_MS ?? "3600000", 10),
    healthIntervalMs: parseInt(process.env.HEALTH_INTERVAL_MS ?? "300000", 10),

    allowBash: process.env.FINN_ALLOW_BASH === "true",
  }
}
