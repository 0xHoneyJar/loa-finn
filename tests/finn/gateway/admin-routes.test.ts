// tests/finn/gateway/admin-routes.test.ts — Admin API tests (cycle-035 T-2.7)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { createAdminRoutes } from "../../../src/gateway/routes/admin.js"
import type { AdminRouteDeps } from "../../../src/gateway/routes/admin.js"

// --- Test JWKS setup ---

let privateKey: CryptoKey
let publicJwk: Record<string, unknown>
let jwksResolver: AdminRouteDeps["jwksKeyResolver"]

async function setupKeys() {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair("ES256")
  privateKey = priv as CryptoKey
  const exported = await exportJWK(pub)
  exported.kid = "test-key-1"
  exported.alg = "ES256"
  exported.use = "sig"
  publicJwk = exported as Record<string, unknown>

  // Simple key resolver that matches by kid
  jwksResolver = async (header: { kid?: string }) => {
    if (header.kid === "test-key-1") return pub
    throw new Error(`Unknown kid: ${header.kid}`)
  }
}

async function signToken(payload: Record<string, unknown>, kid = "test-key-1"): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey)
}

// --- Mock RuntimeConfig ---

function createMockRuntimeConfig() {
  let mode = "shadow"
  return {
    getMode: vi.fn(async () => mode),
    setMode: vi.fn(async (newMode: string) => { mode = newMode }),
    hasRedis: true,
    lastLatencyMs: 1,
  }
}

// --- Test app factory ---

function createTestApp(overrides?: Partial<AdminRouteDeps>) {
  const app = new Hono()
  const auditLog: Array<{ action: string; payload: Record<string, unknown> }> = []
  const deps: AdminRouteDeps = {
    setCreditBalance: vi.fn(async () => {}),
    runtimeConfig: createMockRuntimeConfig() as any,
    auditAppend: vi.fn(async (action, payload) => {
      auditLog.push({ action, payload })
      return "hash-123"
    }),
    jwksKeyResolver: jwksResolver,
    ...overrides,
  }
  app.route("/admin", createAdminRoutes(deps))
  return { app, deps, auditLog }
}

// --- Tests ---

beforeEach(async () => {
  await setupKeys()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Admin API — JWT auth", () => {
  it("returns 401 for missing token", async () => {
    const { app } = createTestApp()
    const res = await app.request("/admin/mode")
    expect(res.status).toBe(401)
  })

  it("returns 401 for invalid JWT", async () => {
    const { app } = createTestApp()
    const res = await app.request("/admin/mode", {
      headers: { Authorization: "Bearer invalid.jwt.token" },
    })
    expect(res.status).toBe(401)
  })

  it("returns 401 for wrong kid", async () => {
    const { app } = createTestApp()
    const token = await new SignJWT({ sub: "admin", role: "operator" })
      .setProtectedHeader({ alg: "ES256", kid: "wrong-key" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey)

    const res = await app.request("/admin/mode", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it("returns 403 for wrong role", async () => {
    const { app } = createTestApp()
    const token = await signToken({ sub: "user1", role: "viewer" })

    const res = await app.request("/admin/mode", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
  })

  it("returns 200 for valid operator JWT", async () => {
    const { app } = createTestApp()
    const token = await signToken({ sub: "admin1", role: "operator" })

    const res = await app.request("/admin/mode", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { mode: string }
    expect(body.mode).toBe("shadow")
  })

  it("returns 200 for valid admin JWT", async () => {
    const { app } = createTestApp()
    const token = await signToken({ sub: "admin1", role: "admin" })

    const res = await app.request("/admin/mode", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it("returns 503 when JWKS not configured", async () => {
    const { app } = createTestApp({ jwksKeyResolver: undefined })
    const token = await signToken({ sub: "admin1", role: "operator" })

    const res = await app.request("/admin/mode", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503)
  })
})

describe("Admin API — mode change (audit-first)", () => {
  it("changes mode with audit-first semantics", async () => {
    const { app, auditLog } = createTestApp()
    const token = await signToken({ sub: "admin1", role: "operator" })

    const res = await app.request("/admin/mode", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "enabled" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { mode: string; previousMode: string }
    expect(body.mode).toBe("enabled")
    expect(body.previousMode).toBe("shadow")

    // Audit was written BEFORE mode change
    expect(auditLog.length).toBe(1)
    expect(auditLog[0].action).toBe("routing_mode_change")
    expect(auditLog[0].payload.intent).toBe("mode_change")
    expect(auditLog[0].payload.from).toBe("shadow")
    expect(auditLog[0].payload.to).toBe("enabled")
  })

  it("returns 400 for invalid mode", async () => {
    const { app } = createTestApp()
    const token = await signToken({ sub: "admin1", role: "operator" })

    const res = await app.request("/admin/mode", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "invalid" }),
    })

    expect(res.status).toBe(400)
  })

  it("returns 503 when audit fails (fail-closed)", async () => {
    const { app } = createTestApp({
      auditAppend: vi.fn(async () => { throw new Error("DynamoDB unavailable") }),
    })
    const token = await signToken({ sub: "admin1", role: "operator" })

    const res = await app.request("/admin/mode", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "enabled" }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("AUDIT_FAILED")
  })

  it("returns 503 when Redis write fails after audit intent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { app, deps } = createTestApp()
    ;(deps.runtimeConfig!.setMode as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Redis connection refused"),
    )
    const token = await signToken({ sub: "admin1", role: "operator" })

    const res = await app.request("/admin/mode", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "enabled" }),
    })

    expect(res.status).toBe(503)
    const body = await res.json() as { code: string }
    expect(body.code).toBe("MODE_CHANGE_FAILED")
    errorSpy.mockRestore()
  })

  it("rate limits per subject (5/hour)", async () => {
    const { app } = createTestApp()
    const token = await signToken({ sub: "rate-test-user", role: "operator" })

    // 5 successful requests
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/admin/mode", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: i % 2 === 0 ? "enabled" : "shadow" }),
      })
      expect(res.status).toBe(200)
    }

    // 6th request should be rate limited
    const res = await app.request("/admin/mode", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "enabled" }),
    })
    expect(res.status).toBe(429)
  })
})

// --- seed-credits (injected token auth, #204) ---

const ADMIN_TOKEN = "test-secret-token"
const VALID_WALLET = "0x742d35Cc6634C0532925a3b844Bc9e7595f2BD18"
const VALID_WALLET_LOWER = VALID_WALLET.toLowerCase()

function seedRequest(app: Hono, body: unknown, token: string | null = ADMIN_TOKEN) {
  return app.request("/admin/seed-credits", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

describe("Admin API — seed-credits (injected token auth)", () => {
  it("rejects when no auth token configured (503)", async () => {
    const { app } = createTestApp({ authToken: undefined })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 100 }, "some-token")
    expect(res.status).toBe(503)
  })

  it("rejects wrong bearer token (401)", async () => {
    const { app } = createTestApp({ authToken: ADMIN_TOKEN })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 100 }, "wrong-token")
    expect(res.status).toBe(401)
  })

  it("accepts valid injected token and normalizes wallet to lowercase", async () => {
    const { app, deps } = createTestApp({ authToken: ADMIN_TOKEN })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 50 })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.wallet_address).toBe(VALID_WALLET_LOWER)
    expect(deps.setCreditBalance).toHaveBeenCalledWith(VALID_WALLET_LOWER, 50)
  })

  it("does NOT read process.env.FINN_AUTH_TOKEN (#204)", async () => {
    process.env.FINN_AUTH_TOKEN = "env-token-should-be-ignored"
    try {
      const { app } = createTestApp({ authToken: undefined })
      const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 1 }, "env-token-should-be-ignored")
      expect(res.status).toBe(503) // disabled — env var alone must not enable the route
    } finally {
      delete process.env.FINN_AUTH_TOKEN
    }
  })
})

describe("Admin API — seed-credits wallet validation (#201)", () => {
  it.each([
    ["short hex", "0x123"],
    ["no 0x prefix", "742d35cc6634c0532925a3b844bc9e7595f2bd18"],
    ["non-hex chars", "0xZZZd35cc6634c0532925a3b844bc9e7595f2bd18"],
    ["41 hex chars", "0x742d35cc6634c0532925a3b844bc9e7595f2bd181"],
    ["ENS-style name", "vitalik.eth"],
    ["embedded whitespace", "0x742d35cc6634c0532925a3b844 c9e7595f2bd18"],
  ])("rejects invalid wallet: %s", async (_label, wallet) => {
    const { app, deps } = createTestApp({ authToken: ADMIN_TOKEN })

    const res = await seedRequest(app, { wallet_address: wallet, credits: 10 })
    expect(res.status).toBe(400)
    expect(deps.setCreditBalance).not.toHaveBeenCalled()
  })

  it("accepts checksummed and lowercase addresses equivalently", async () => {
    const { app, deps } = createTestApp({ authToken: ADMIN_TOKEN })

    const res1 = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 10 })
    const res2 = await seedRequest(app, { wallet_address: VALID_WALLET_LOWER, credits: 10 })
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    // Both normalize to the same balance key
    expect(deps.setCreditBalance).toHaveBeenNthCalledWith(1, VALID_WALLET_LOWER, 10)
    expect(deps.setCreditBalance).toHaveBeenNthCalledWith(2, VALID_WALLET_LOWER, 10)
  })
})

describe("Admin API — seed-credits input boundaries (#200, #215)", () => {
  it.each([
    ["negative", -1],
    ["fractional", 10.5],
    ["huge (unsafe integer)", Number.MAX_SAFE_INTEGER + 2],
    ["scientific overflow", 1e308],
    ["string number", "100"],
    ["null", null],
    ["missing", undefined],
    ["boolean", true],
  ])("rejects credits: %s", async (_label, credits) => {
    const { app, deps } = createTestApp({ authToken: ADMIN_TOKEN })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits })
    expect(res.status).toBe(400)
    expect(deps.setCreditBalance).not.toHaveBeenCalled()
  })

  it("rejects credits above the documented cap (CREDITS_OUT_OF_BOUNDS)", async () => {
    const { app, deps } = createTestApp({ authToken: ADMIN_TOKEN })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 1_000_001 })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.code).toBe("CREDITS_OUT_OF_BOUNDS")
    expect(deps.setCreditBalance).not.toHaveBeenCalled()
  })

  it("accepts zero and the exact cap", async () => {
    const { app } = createTestApp({ authToken: ADMIN_TOKEN })

    expect((await seedRequest(app, { wallet_address: VALID_WALLET, credits: 0 })).status).toBe(200)
    expect((await seedRequest(app, { wallet_address: VALID_WALLET, credits: 1_000_000 })).status).toBe(200)
  })

  it("honors a custom maxSeedCredits", async () => {
    const { app } = createTestApp({ authToken: ADMIN_TOKEN, maxSeedCredits: 100 })

    expect((await seedRequest(app, { wallet_address: VALID_WALLET, credits: 100 })).status).toBe(200)
    expect((await seedRequest(app, { wallet_address: VALID_WALLET, credits: 101 })).status).toBe(400)
  })
})

describe("Admin API — seed-credits audit records (#225, #234)", () => {
  it("writes an audit record before mutating the balance", async () => {
    const { app, deps, auditLog } = createTestApp({ authToken: ADMIN_TOKEN })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 42 })
    expect(res.status).toBe(200)

    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].action).toBe("seed_credits")
    expect(auditLog[0].payload.wallet_address).toBe(VALID_WALLET_LOWER)
    expect(auditLog[0].payload.credits).toBe(42)
    expect(deps.setCreditBalance).toHaveBeenCalledOnce()
  })

  it("fails closed (503) when audit write fails — balance untouched", async () => {
    const { app, deps } = createTestApp({
      authToken: ADMIN_TOKEN,
      auditAppend: vi.fn(async () => { throw new Error("audit down") }),
    })

    const res = await seedRequest(app, { wallet_address: VALID_WALLET, credits: 42 })
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.code).toBe("AUDIT_FAILED")
    expect(deps.setCreditBalance).not.toHaveBeenCalled()
  })

  it("does not audit rejected inputs", async () => {
    const { app, auditLog } = createTestApp({ authToken: ADMIN_TOKEN })

    await seedRequest(app, { wallet_address: "0x123", credits: 42 })
    await seedRequest(app, { wallet_address: VALID_WALLET, credits: -5 })
    expect(auditLog).toHaveLength(0)
  })
})

describe("Admin API — injectable rate limiter (#199, #214, #223)", () => {
  it("in-memory limiter is per-instance (NOT shared) — documents the dev-only fallback", async () => {
    // Two separate route instances with default (in-memory) limiters simulate
    // two replicas WITHOUT a shared store: each replica has its own budget.
    const { app: replicaA } = createTestApp()
    const { app: replicaB } = createTestApp()
    const token = await signToken({ sub: "multi-instance-user", role: "operator" })
    const post = (app: Hono) => app.request("/admin/mode", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "shadow" }),
    })

    for (let i = 0; i < 5; i++) expect((await post(replicaA)).status).toBe(200)
    expect((await post(replicaA)).status).toBe(429)
    // Replica B is unaware of A's usage — this is exactly the production gap
    // that the shared Redis-backed limiter closes.
    expect((await post(replicaB)).status).toBe(200)
  })

  it("a shared limiter enforces the limit across instances", async () => {
    // Simulated shared store (what RedisAdminRateLimiter provides via Redis)
    const counts = new Map<string, number>()
    const shared = {
      check: async (subject: string) => {
        const n = (counts.get(subject) ?? 0) + 1
        counts.set(subject, n)
        return n <= 5
      },
    }
    const { app: replicaA } = createTestApp({ rateLimiter: shared })
    const { app: replicaB } = createTestApp({ rateLimiter: shared })
    const token = await signToken({ sub: "shared-store-user", role: "operator" })
    const post = (app: Hono) => app.request("/admin/mode", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "shadow" }),
    })

    // 3 on A + 2 on B exhaust the shared budget
    for (let i = 0; i < 3; i++) expect((await post(replicaA)).status).toBe(200)
    for (let i = 0; i < 2; i++) expect((await post(replicaB)).status).toBe(200)
    expect((await post(replicaA)).status).toBe(429)
    expect((await post(replicaB)).status).toBe(429)
  })

  it("RedisAdminRateLimiter shares counts via Redis and fails closed on errors", async () => {
    const { RedisAdminRateLimiter } = await import("../../../src/gateway/routes/admin.js")
    // Fake Redis that executes the INCR+EXPIRE Lua script atomically —
    // the single eval round-trip is the atomicity fix (a partial
    // INCR-then-EXPIRE failure could leave an immortal key).
    const store = new Map<string, number>()
    const ttls = new Map<string, number>()
    const fakeRedis = {
      eval: vi.fn(async (script: string, _numkeys: number, key: string, ttl: number) => {
        expect(script).toContain("INCR")
        expect(script).toContain("EXPIRE")
        const n = (store.get(key) ?? 0) + 1
        store.set(key, n)
        if (n === 1) ttls.set(key, Number(ttl))
        return n
      }),
    }
    // Two limiter instances (two replicas) sharing one Redis
    const limiterA = new RedisAdminRateLimiter(fakeRedis as never)
    const limiterB = new RedisAdminRateLimiter(fakeRedis as never)

    for (let i = 0; i < 3; i++) expect(await limiterA.check("subj")).toBe(true)
    for (let i = 0; i < 2; i++) expect(await limiterB.check("subj")).toBe(true)
    expect(await limiterA.check("subj")).toBe(false)
    expect(await limiterB.check("subj")).toBe(false)
    // Every counter key carries a TTL from its first increment — no
    // immortal-key window.
    expect(ttls.get("finn:admin:mode-rl:subj")).toBe(3600)

    // Fail-closed on Redis errors
    const brokenRedis = { eval: vi.fn(async () => { throw new Error("redis down") }) }
    const failing = new RedisAdminRateLimiter(brokenRedis as never)
    expect(await failing.check("subj")).toBe(false)
  })

  it("RedisAdminRateLimiter accepts a late-binding resolver and fails closed while disconnected", async () => {
    const { RedisAdminRateLimiter } = await import("../../../src/gateway/routes/admin.js")
    const store = new Map<string, number>()
    const fakeRedis = {
      eval: vi.fn(async (_s: string, _n: number, key: string) => {
        const n = (store.get(key) ?? 0) + 1
        store.set(key, n)
        return n
      }),
    }
    let connected = false
    const limiter = new RedisAdminRateLimiter((() => (connected ? fakeRedis : null)) as never)

    // Redis configured but not yet connected → fail closed, never in-memory
    expect(await limiter.check("subj")).toBe(false)
    expect(fakeRedis.eval).not.toHaveBeenCalled()

    // Connection established after boot → limiter picks it up on next use
    connected = true
    expect(await limiter.check("subj")).toBe(true)
    expect(fakeRedis.eval).toHaveBeenCalledTimes(1)
  })
})

describe("Admin API — missing audit dependency fails closed", () => {
  it("POST /mode returns 503 AUDIT_FAILED when auditAppend is not configured", async () => {
    const { app, deps } = createTestApp({ auditAppend: undefined })
    const token = await signToken({ role: "operator", sub: "op-1" })
    const res = await app.request("/admin/mode", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "enabled" }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("AUDIT_FAILED")
    expect((deps.runtimeConfig as any).setMode).not.toHaveBeenCalled()
  })

  it("POST /seed-credits returns 503 AUDIT_FAILED when auditAppend is not configured — balance untouched", async () => {
    const { app, deps } = createTestApp({ auditAppend: undefined, authToken: "tok-1" })
    const res = await app.request("/admin/seed-credits", {
      method: "POST",
      headers: { Authorization: "Bearer tok-1", "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: `0x${"a".repeat(40)}`, credits: 10 }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("AUDIT_FAILED")
    expect(deps.setCreditBalance).not.toHaveBeenCalled()
  })
})
