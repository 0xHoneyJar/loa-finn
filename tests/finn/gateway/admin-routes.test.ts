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

async function seedCreditsRequest(app: Hono, wallet_address: string, credits: number) {
  return app.request("/admin/seed-credits", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ wallet_address, credits }),
  })
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

describe("Admin API — seed-credits (legacy auth)", () => {
  it("rejects without FINN_AUTH_TOKEN env", async () => {
    delete process.env.FINN_AUTH_TOKEN
    const { app } = createTestApp()

    const res = await app.request("/admin/seed-credits", {
      method: "POST",
      headers: {
        Authorization: "Bearer some-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wallet_address: "0x0000000000000000000000000000000000000123", credits: 100 }),
    })

    expect(res.status).toBe(503)
  })

  it("accepts valid FINN_AUTH_TOKEN", async () => {
    process.env.FINN_AUTH_TOKEN = "test-secret-token"
    const { app, deps } = createTestApp()

    const res = await seedCreditsRequest(app, "0x0000000000000000000000000000000000000ABC", 50)

    expect(res.status).toBe(200)
    const body = await res.json() as { wallet_address: string; credits: number; seeded: boolean }
    expect(body.wallet_address).toBe("0x0000000000000000000000000000000000000abc")
    expect(body.credits).toBe(50)
    expect(body.seeded).toBe(true)
    expect(deps.setCreditBalance).toHaveBeenCalledWith("0x0000000000000000000000000000000000000abc", 50)
    delete process.env.FINN_AUTH_TOKEN
  })

  it("accepts zero and exact maximum credit seeds", async () => {
    process.env.FINN_AUTH_TOKEN = "test-secret-token"
    const { app, deps } = createTestApp()
    const wallet = "0x0000000000000000000000000000000000000abc"

    for (const credits of [0, 1_000_000]) {
      const res = await seedCreditsRequest(app, wallet, credits)
      expect(res.status).toBe(200)
      const body = await res.json() as { credits: number; seeded: boolean }
      expect(body.credits).toBe(credits)
      expect(body.seeded).toBe(true)
    }

    expect(deps.setCreditBalance).toHaveBeenCalledWith(wallet, 0)
    expect(deps.setCreditBalance).toHaveBeenCalledWith(wallet, 1_000_000)
    delete process.env.FINN_AUTH_TOKEN
  })

  it("rejects malformed wallet addresses", async () => {
    process.env.FINN_AUTH_TOKEN = "test-secret-token"
    const { app, deps } = createTestApp()

    for (const wallet_address of ["0xABC", "0000000000000000000000000000000000000abc", "0x0000000000000000000000000000000000000abz"]) {
      const res = await seedCreditsRequest(app, wallet_address, 50)
      expect(res.status).toBe(400)
      const body = await res.json() as { code: string }
      expect(body.code).toBe("INVALID_WALLET_ADDRESS")
    }

    expect(deps.setCreditBalance).not.toHaveBeenCalled()
    delete process.env.FINN_AUTH_TOKEN
  })

  it("rejects fractional and over-limit credits", async () => {
    process.env.FINN_AUTH_TOKEN = "test-secret-token"
    const { app, deps } = createTestApp()

    for (const credits of [1.5, 1_000_001]) {
      const res = await seedCreditsRequest(app, "0x0000000000000000000000000000000000000abc", credits)
      expect(res.status).toBe(400)
      const body = await res.json() as { code: string }
      expect(body.code).toBe("INVALID_CREDITS")
    }

    expect(deps.setCreditBalance).not.toHaveBeenCalled()
    delete process.env.FINN_AUTH_TOKEN
  })
})
