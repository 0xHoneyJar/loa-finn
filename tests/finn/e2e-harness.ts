// tests/finn/e2e-harness.ts — E2E Test Environment Harness (Sprint 5 Task 5.5)
// Creates a full Oracle sub-app with mocked dependencies for integration testing.

import { createHash } from "node:crypto"
import { Hono } from "hono"
import { vi } from "vitest"
import { createOracleHandler, oracleCorsMiddleware } from "../../src/gateway/routes/oracle.js"
import { oracleAuthMiddleware } from "../../src/gateway/oracle-auth.js"
import { oracleRateLimitMiddleware, OracleRateLimiter } from "../../src/gateway/oracle-rate-limit.js"
import { oracleConcurrencyMiddleware, ConcurrencyLimiter } from "../../src/gateway/oracle-concurrency.js"
import type { HounfourRouter } from "../../src/hounfour/router.js"
import type { CompletionResult } from "../../src/hounfour/types.js"
import type { FinnConfig } from "../../src/config.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// --- Mock Factories ---

export interface E2EContext {
  app: Hono
  config: FinnConfig
  mockRouter: HounfourRouter
  mockRedis: MockRedisClient
  rateLimiter: OracleRateLimiter
  teardown: () => void
}

export interface MockRedisClient extends RedisCommandClient {
  _store: Map<string, unknown>
  _seedApiKey: (key: string, owner: string) => void
}

/** Create a mock Redis client with in-memory store */
function createMockRedis(): MockRedisClient {
  const store = new Map<string, unknown>()
  const redis: MockRedisClient = {
    _store: store,
    _seedApiKey(key: string, owner: string) {
      const hash = createHash("sha256").update(key).digest("hex")
      store.set(`oracle:apikeys:${hash}`, {
        status: "active",
        owner,
        created_at: new Date().toISOString(),
        last_used_at: null,
      })
    },
    get: vi.fn(async (key: string) => {
      const val = store.get(key)
      return typeof val === "string" ? val : null
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return "OK"
    }),
    hgetall: vi.fn(async (key: string) => {
      const val = store.get(key)
      return (val && typeof val === "object") ? val as Record<string, string> : null
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      const existing = (store.get(key) as Record<string, string>) ?? {}
      existing[field] = value
      store.set(key, existing)
      return 1
    }),
    eval: vi.fn(async () => [1, 4, null]),
    incrby: vi.fn(async () => 1),
    ping: vi.fn(async () => "PONG"),
    quit: vi.fn(async () => undefined),
  } as unknown as MockRedisClient
  return redis
}

/** Create a mock HounfourRouter that returns configurable results */
function createMockRouter(): HounfourRouter {
  return {
    invokeForTenant: vi.fn().mockResolvedValue(createDefaultResult()),
  } as unknown as HounfourRouter
}

/** Default Oracle completion result */
export function createDefaultResult(overrides?: Partial<CompletionResult>): CompletionResult {
  return {
    content: "The Oracle provides an answer grounded in knowledge sources.",
    thinking: null,
    tool_calls: null,
    usage: { prompt_tokens: 500, completion_tokens: 200, reasoning_tokens: 0 },
    metadata: {
      model: "claude-opus-4-6",
      latency_ms: 1200,
      trace_id: "trace-e2e-001",
      cost_micro: "250000",
      knowledge: {
        sources_used: ["glossary", "ecosystem-architecture", "code-reality-finn"],
        tokens_used: 8000,
        budget: 30000,
        mode: "full",
        tags_matched: ["core", "technical"],
        classification: ["technical"],
      },
    },
    ...overrides,
  }
}

/** Create E2E Oracle config */
function createE2EConfig(): FinnConfig {
  return {
    oracle: {
      enabled: true,
      sourcesConfigPath: "grimoires/oracle/sources.json",
      minContextWindow: 30000,
      dailyCap: 200,
      costCeilingCents: 2000,
      maxConcurrent: 3,
      publicDailyLimit: 5,
      authenticatedDailyLimit: 50,
      estimatedCostCents: 50,
      trustXff: true,
      corsOrigins: ["https://oracle.arrakis.community", "http://localhost:3000"],
      dixieRef: "e2e-test",
    },
  } as unknown as FinnConfig
}

/** Create a mock OracleRateLimiter with controllable behavior */
function createMockRateLimiter(): OracleRateLimiter {
  let requestCount = 0
  let costCents = 0
  const publicLimit = 5

  return {
    check: vi.fn(async (identity: string) => {
      requestCount++
      if (requestCount > publicLimit) {
        return { allowed: false, reason: "IDENTITY_LIMIT_EXCEEDED", limit: publicLimit, remaining: 0 }
      }
      return { allowed: true, reason: null, limit: publicLimit, remaining: publicLimit - requestCount }
    }),
    reserveCost: vi.fn(async (estimated: number) => ({
      allowed: true,
      reservationId: `res-e2e-${Date.now()}`,
      release: vi.fn(async (actual: number) => { costCents += actual }),
    })),
    isHealthy: vi.fn(async () => true),
    getDailyUsage: vi.fn(async () => ({ globalCount: requestCount, costCents })),
    _resetForTest() { requestCount = 0; costCents = 0 },
  } as unknown as OracleRateLimiter & { _resetForTest: () => void }
}

// --- Harness Setup ---

/**
 * Set up a full E2E Oracle test environment.
 * Returns the Hono app with all middleware wired, plus mocked dependencies.
 */
export function setupE2E(overrides?: {
  config?: Partial<FinnConfig>
  corsOrigins?: string[]
}): E2EContext {
  const config = createE2EConfig()
  if (overrides?.corsOrigins) {
    config.oracle.corsOrigins = overrides.corsOrigins
  }

  const mockRouter = createMockRouter()
  const mockRedis = createMockRedis()
  const rateLimiter = createMockRateLimiter()
  const concurrencyLimiter = new ConcurrencyLimiter(config.oracle.maxConcurrent)

  // Build isolated Oracle sub-app (mirrors server.ts registration)
  const oracleApp = new Hono()
  oracleApp.use("*", oracleCorsMiddleware(config.oracle.corsOrigins))
  oracleApp.use("*", oracleAuthMiddleware(mockRedis as unknown as RedisCommandClient, { trustXff: config.oracle.trustXff }))
  oracleApp.use("*", oracleRateLimitMiddleware(rateLimiter))
  oracleApp.use("*", oracleConcurrencyMiddleware(concurrencyLimiter))
  oracleApp.post("/", createOracleHandler(mockRouter, rateLimiter, config))

  // Mount under same path as production
  const app = new Hono()
  app.route("/api/v1/oracle", oracleApp)

  // Health endpoint stub
  app.get("/health", (c) => c.json({
    status: "healthy",
    checks: {
      oracle: {
        status: "ok",
        rate_limiter_healthy: true,
        daily_usage: { globalCount: 0, costCents: 0 },
      },
    },
  }))

  return {
    app,
    config,
    mockRouter,
    mockRedis,
    rateLimiter,
    teardown: () => {
      mockRedis._store.clear()
      vi.restoreAllMocks()
    },
  }
}

/** Helper: create a request with X-Forwarded-For header for IP simulation */
export function requestWithIp(url: string, ip: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  headers.set("X-Forwarded-For", `${ip}, 10.0.0.1`)
  return new Request(url, { ...init, headers })
}

/** Helper: create a request with API key authorization */
export function requestWithApiKey(url: string, apiKey: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-Forwarded-For": "1.2.3.4, 10.0.0.1",
    },
    body: JSON.stringify(body),
  })
}

/** Helper: create a CORS preflight OPTIONS request */
export function preflightRequest(url: string, origin: string): Request {
  return new Request(url, {
    method: "OPTIONS",
    headers: {
      "Origin": origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Authorization",
    },
  })
}
