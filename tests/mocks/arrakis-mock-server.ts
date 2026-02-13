// tests/mocks/arrakis-mock-server.ts — Arrakis Budget & BYOK Mock Server (Task 2.8)
//
// Lightweight mock of arrakis budget reconciliation and BYOK endpoints.
// Enables loa-finn integration testing without real arrakis dependency.
// Contract tests in tests/contract/ validate against loa-hounfour schemas.

import { Hono } from "hono"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"

// --- Types ---

/** Budget state for a tenant in the mock. */
export interface MockTenantBudget {
  committed_micro: string      // String micro-USD (matches loa-hounfour wire format)
  reserved_micro: string
  limit_micro: string
  window_start: string         // ISO 8601
  window_end: string           // ISO 8601
}

/** BYOK session state in the mock. */
export interface MockByokSession {
  session_id: string
  tenant_id: string
  provider: string
  model: string
  expires_at: string
  status: "active" | "expired" | "revoked"
}

/** Scripted failure mode configuration. */
export interface FailureMode {
  /** Endpoint path pattern to apply failure to (regex or exact match). */
  pathPattern: string
  /** Type of failure to simulate. */
  type: "timeout" | "error_500" | "stale_data" | "drift" | "rate_limit"
  /** Timeout delay in ms (for "timeout" type). */
  delayMs?: number
  /** Number of requests before the failure triggers (0 = always). */
  triggerAfter?: number
  /** Custom drift amount in micro-USD (for "drift" type). */
  driftMicro?: string
}

/** Configuration for the mock server. */
export interface ArrakisMockConfig {
  /** Port to listen on. Default: 0 (random). */
  port?: number
  /** S2S JWT issuer allowlist. Default: ["loa-finn"]. */
  issuerAllowlist?: string[]
  /** S2S JWT expected audience. Default: "arrakis". */
  expectedAudience?: string
  /** Whether to validate JWT signatures. Default: false (accept any Bearer token). */
  validateSignatures?: boolean
  /** Initial tenant budgets. */
  tenantBudgets?: Record<string, MockTenantBudget>
  /** Scripted failure modes. */
  failureModes?: FailureMode[]
}

// --- Mock Server ---

export class ArrakisMockServer {
  private app: Hono
  private server: Server | null = null
  private port: number
  private config: Required<ArrakisMockConfig>
  private tenantBudgets: Map<string, MockTenantBudget>
  private byokSessions: Map<string, MockByokSession>
  private failureModes: FailureMode[]
  private requestCounts: Map<string, number> = new Map()

  /** Track all requests received (for test assertions). */
  public requestLog: Array<{
    method: string
    path: string
    timestamp: string
    headers: Record<string, string>
  }> = []

  constructor(config: ArrakisMockConfig = {}) {
    this.config = {
      port: config.port ?? 0,
      issuerAllowlist: config.issuerAllowlist ?? ["loa-finn"],
      expectedAudience: config.expectedAudience ?? "arrakis",
      validateSignatures: config.validateSignatures ?? false,
      tenantBudgets: config.tenantBudgets ?? {},
      failureModes: config.failureModes ?? [],
    }
    this.port = this.config.port
    this.tenantBudgets = new Map(Object.entries(this.config.tenantBudgets))
    this.byokSessions = new Map()
    this.failureModes = [...this.config.failureModes]
    this.app = this.buildApp()
  }

  /** Start the server. Returns the actual port. */
  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = serve({
        fetch: this.app.fetch,
        port: this.port,
      }, (info) => {
        this.port = info.port
        resolve(info.port)
      })
    })
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** Get the base URL for this mock server. */
  get baseUrl(): string {
    return `http://localhost:${this.port}`
  }

  // --- State manipulation for tests ---

  /** Set a tenant's budget state. */
  setTenantBudget(tenantId: string, budget: MockTenantBudget): void {
    this.tenantBudgets.set(tenantId, budget)
  }

  /** Get a tenant's budget state (for test assertions). */
  getTenantBudget(tenantId: string): MockTenantBudget | undefined {
    return this.tenantBudgets.get(tenantId)
  }

  /** Add a scripted failure mode. */
  addFailureMode(mode: FailureMode): void {
    this.failureModes.push(mode)
  }

  /** Clear all failure modes. */
  clearFailureModes(): void {
    this.failureModes = []
    this.requestCounts.clear()
  }

  /** Clear the request log. */
  clearRequestLog(): void {
    this.requestLog = []
  }

  /** Add a BYOK session. */
  addByokSession(session: MockByokSession): void {
    this.byokSessions.set(session.session_id, session)
  }

  // --- Private ---

  private buildApp(): Hono {
    const app = new Hono()

    // Request logging middleware
    app.use("*", async (c, next) => {
      this.requestLog.push({
        method: c.req.method,
        path: c.req.path,
        timestamp: new Date().toISOString(),
        headers: Object.fromEntries(
          [...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])
        ),
      })
      await next()
    })

    // S2S JWT auth middleware
    app.use("/api/*", async (c, next) => {
      const authHeader = c.req.header("authorization")
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ error: "missing_token", message: "Authorization header required" }, 401)
      }

      const token = authHeader.slice(7)
      if (!token) {
        return c.json({ error: "invalid_token", message: "Empty token" }, 401)
      }

      // Basic JWT structure check (3 dot-separated parts)
      const parts = token.split(".")
      if (parts.length !== 3) {
        return c.json({ error: "invalid_token", message: "Malformed JWT" }, 401)
      }

      // Decode header + payload (no signature verification in mock by default)
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())

        // Validate audience
        if (payload.aud !== this.config.expectedAudience) {
          return c.json({
            error: "invalid_audience",
            message: `Expected aud "${this.config.expectedAudience}", got "${payload.aud}"`,
          }, 403)
        }

        // Validate issuer
        if (!this.config.issuerAllowlist.includes(payload.iss)) {
          return c.json({
            error: "invalid_issuer",
            message: `Issuer "${payload.iss}" not in allowlist`,
          }, 403)
        }

        // BB-PR63-F007: Validate JWT expiry (reject expired tokens)
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
          return c.json({
            error: "token_expired",
            message: `Token expired at ${new Date(payload.exp * 1000).toISOString()}`,
          }, 401)
        }

        // Store claims for handlers
        c.set("jwtClaims" as any, payload)
      } catch {
        return c.json({ error: "invalid_token", message: "Cannot decode JWT" }, 401)
      }

      await next()
    })

    // Failure mode middleware
    app.use("/api/*", async (c, next) => {
      const path = c.req.path
      for (const mode of this.failureModes) {
        if (!this.matchesPath(path, mode.pathPattern)) continue

        const countKey = `${mode.type}:${mode.pathPattern}`
        const count = (this.requestCounts.get(countKey) ?? 0) + 1
        this.requestCounts.set(countKey, count)

        if (mode.triggerAfter && count <= mode.triggerAfter) continue

        switch (mode.type) {
          case "timeout":
            await new Promise(r => setTimeout(r, mode.delayMs ?? 30000))
            return c.json({ error: "timeout" }, 504)

          case "error_500":
            return c.json({ error: "internal_error", message: "Simulated server error" }, 500)

          case "rate_limit":
            return c.json({ error: "rate_limited", message: "Too many requests" }, 429)

          case "stale_data":
          case "drift":
            // These modify the response, not block — handled in the endpoint
            break
        }
      }

      await next()
    })

    // --- Budget endpoint ---
    app.get("/api/v1/budget/:tenant_id", (c) => {
      const tenantId = c.req.param("tenant_id")
      const budget = this.tenantBudgets.get(tenantId)

      if (!budget) {
        return c.json({ error: "tenant_not_found", message: `No budget for tenant "${tenantId}"` }, 404)
      }

      // Apply drift failure mode
      let response = { ...budget }
      for (const mode of this.failureModes) {
        if (mode.type === "drift" && this.matchesPath(c.req.path, mode.pathPattern)) {
          response.committed_micro = mode.driftMicro ?? String(
            parseInt(response.committed_micro) + 50000
          )
        }
        if (mode.type === "stale_data" && this.matchesPath(c.req.path, mode.pathPattern)) {
          // Return data with old window_end
          const staleDate = new Date(Date.now() - 86400000) // 1 day ago
          response.window_end = staleDate.toISOString()
        }
      }

      return c.json(response)
    })

    // --- BYOK session endpoint ---
    app.post("/api/v1/byok/session", async (c) => {
      const body = await c.req.json()
      const sessionId = `byok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const session: MockByokSession = {
        session_id: sessionId,
        tenant_id: body.tenant_id,
        provider: body.provider,
        model: body.model,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        status: "active",
      }
      this.byokSessions.set(sessionId, session)

      return c.json({
        session_id: sessionId,
        expires_at: session.expires_at,
        proxy_url: `${this.baseUrl}/api/v1/byok/proxy`,
      }, 201)
    })

    // --- BYOK proxy endpoint ---
    app.post("/api/v1/byok/proxy", async (c) => {
      const body = await c.req.json()
      const sessionId = body.session_id

      if (!sessionId) {
        return c.json({ error: "missing_session_id" }, 400)
      }

      const session = this.byokSessions.get(sessionId)
      if (!session) {
        return c.json({ error: "session_not_found" }, 404)
      }

      if (session.status !== "active") {
        return c.json({ error: "session_expired" }, 410)
      }

      // Mock proxy response
      return c.json({
        session_id: sessionId,
        status: "proxied",
        provider: session.provider,
        model: session.model,
      })
    })

    // --- Health endpoint (no auth) ---
    app.get("/health", (c) => {
      return c.json({ status: "ok", service: "arrakis-mock" })
    })

    return app
  }

  private matchesPath(path: string, pattern: string): boolean {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
      return regex.test(path)
    }
    return path.includes(pattern)
  }
}

// --- Convenience factory ---

/** Create a mock server with default tenant budgets for testing. */
export function createTestMockServer(overrides: ArrakisMockConfig = {}): ArrakisMockServer {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + 86400000) // +24h

  return new ArrakisMockServer({
    tenantBudgets: {
      "tenant-abc": {
        committed_micro: "500000",      // $0.50
        reserved_micro: "100000",       // $0.10
        limit_micro: "10000000",        // $10.00
        window_start: now.toISOString(),
        window_end: windowEnd.toISOString(),
      },
      "tenant-xyz": {
        committed_micro: "9500000",     // $9.50 (near limit)
        reserved_micro: "0",
        limit_micro: "10000000",        // $10.00
        window_start: now.toISOString(),
        window_end: windowEnd.toISOString(),
      },
    },
    ...overrides,
  })
}
