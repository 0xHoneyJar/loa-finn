// tests/gateway/siwe-auth.test.ts — SIWE Auth Tests (Sprint 4 T4.5)

import { describe, it, expect, beforeEach } from "vitest"
import { Hono } from "hono"
import * as jose from "jose"
import { SiweMessage } from "siwe"
import { createSiweAuthRoutes, requireSiweSession } from "../../src/gateway/siwe-auth.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

class MockRedis {
  private store = new Map<string, { value: string; expiresAt: number }>()

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, _mode?: string, ttl?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? 300) * 1000,
    })
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
  }

  /** Inject a nonce directly for testing */
  injectNonce(nonce: string): void {
    this.store.set(`finn:siwe:nonce:${nonce}`, {
      value: "1",
      expiresAt: Date.now() + 300_000,
    })
  }

  clear(): void {
    this.store.clear()
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "a]K9#mP2$vL7!nQ5^wX3&jR8*hT6+bY4" // 32+ chars
const TEST_DOMAIN = "finn.honeyjar.xyz"
const TEST_URI = "https://finn.honeyjar.xyz"
const TEST_CHAIN_ID = 8453

// ---------------------------------------------------------------------------
// Nonce Endpoint Tests
// ---------------------------------------------------------------------------

describe("T4.5: GET /nonce", () => {
  let app: Hono
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
    const routes = createSiweAuthRoutes({
      redis: redis as never,
      jwtSecret: TEST_JWT_SECRET,
      domain: TEST_DOMAIN,
      uri: TEST_URI,
      chainId: TEST_CHAIN_ID,
    })
    app = new Hono()
    app.route("/auth", routes)
  })

  it("returns a nonce", async () => {
    const res = await app.request("/auth/nonce")
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.nonce).toBeDefined()
    expect(typeof body.nonce).toBe("string")
    expect(body.nonce.length).toBe(32) // 16 bytes hex
  })

  it("returns unique nonces on successive calls", async () => {
    const res1 = await app.request("/auth/nonce")
    const res2 = await app.request("/auth/nonce")
    const body1 = await res1.json()
    const body2 = await res2.json()
    expect(body1.nonce).not.toBe(body2.nonce)
  })
})

// ---------------------------------------------------------------------------
// Verify Endpoint Tests
// ---------------------------------------------------------------------------

describe("T4.5: POST /verify", () => {
  let app: Hono
  let redis: MockRedis

  beforeEach(() => {
    redis = new MockRedis()
    const routes = createSiweAuthRoutes({
      redis: redis as never,
      jwtSecret: TEST_JWT_SECRET,
      domain: TEST_DOMAIN,
      uri: TEST_URI,
      chainId: TEST_CHAIN_ID,
    })
    app = new Hono()
    app.route("/auth", routes)
  })

  it("rejects missing body", async () => {
    const res = await app.request("/auth/verify", { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("rejects missing message", async () => {
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "0x123" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects missing signature", async () => {
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects invalid SIWE message format", async () => {
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "not a valid SIWE message", signature: "0x123" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects wrong domain", async () => {
    redis.injectNonce("testnonce123")

    const message = buildSiweMessage({
      domain: "evil.com",
      nonce: "testnonce123",
    })

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: "0x" + "ab".repeat(65) }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects wrong URI", async () => {
    redis.injectNonce("testnonce456")

    const message = buildSiweMessage({
      uri: "https://evil.com",
      nonce: "testnonce456",
    })

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: "0x" + "ab".repeat(65) }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects wrong chain ID", async () => {
    redis.injectNonce("testnonce789")

    const message = buildSiweMessage({
      chainId: 1, // Ethereum mainnet, not Base
      nonce: "testnonce789",
    })

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: "0x" + "ab".repeat(65) }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects reused nonce (nonce not in Redis)", async () => {
    // Don't inject nonce — simulates already consumed
    const message = buildSiweMessage({ nonce: "alreadyused" })

    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: "0x" + "ab".repeat(65) }),
    })
    expect(res.status).toBe(401)
  })

  it("returns generic error messages (no info leakage)", async () => {
    // Wrong domain — should get generic error, not "wrong domain"
    redis.injectNonce("infoleaknonce")
    const message = buildSiweMessage({ domain: "evil.com", nonce: "infoleaknonce" })
    const res = await app.request("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature: "0x" + "ab".repeat(65) }),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    // Must NOT say "wrong domain" or "domain mismatch" — generic message only
    expect(body.error).toBe("Invalid or expired SIWE credentials")
  })
})

// ---------------------------------------------------------------------------
// JWT Middleware Tests
// ---------------------------------------------------------------------------

describe("T4.5: requireSiweSession middleware", () => {
  let app: Hono
  const secretKey = new TextEncoder().encode(TEST_JWT_SECRET)

  beforeEach(() => {
    app = new Hono()
    app.use("/protected/*", requireSiweSession(TEST_JWT_SECRET))
    app.get("/protected/test", (c) => {
      const wallet = c.get("siwe_wallet")
      return c.json({ wallet })
    })
  })

  it("rejects missing Authorization header", async () => {
    const res = await app.request("/protected/test")
    expect(res.status).toBe(401)
  })

  it("rejects non-Bearer auth", async () => {
    const res = await app.request("/protected/test", {
      headers: { Authorization: "Basic abc123" },
    })
    expect(res.status).toBe(401)
  })

  it("rejects dk_ API key (wrong auth path)", async () => {
    const res = await app.request("/protected/test", {
      headers: { Authorization: "Bearer dk_key123.secret" },
    })
    expect(res.status).toBe(401)
  })

  it("rejects expired JWT", async () => {
    const token = await new jose.SignJWT({ sub: "0xabc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secretKey)

    const res = await app.request("/protected/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it("rejects JWT with wrong audience", async () => {
    const token = await new jose.SignJWT({ sub: "0xabc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("wrong-audience")
      .setExpirationTime("15m")
      .sign(secretKey)

    const res = await app.request("/protected/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it("rejects tampered JWT", async () => {
    const token = await new jose.SignJWT({ sub: "0xabc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setExpirationTime("15m")
      .sign(secretKey)

    // Tamper with the token
    const tampered = token.slice(0, -5) + "XXXXX"

    const res = await app.request("/protected/test", {
      headers: { Authorization: `Bearer ${tampered}` },
    })
    expect(res.status).toBe(401)
  })

  it("rejects JWT missing sub claim", async () => {
    const token = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setExpirationTime("15m")
      .sign(secretKey)

    const res = await app.request("/protected/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it("accepts valid JWT and sets siwe_wallet", async () => {
    const walletAddress = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18"
    const token = await new jose.SignJWT({ sub: walletAddress })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(secretKey)

    const res = await app.request("/protected/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.wallet).toBe(walletAddress)
  })

  it("rejects JWT signed with wrong secret", async () => {
    const wrongKey = new TextEncoder().encode("wrong-secret-key-that-is-long-enough-32!")
    const token = await new jose.SignJWT({ sub: "0xabc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setExpirationTime("15m")
      .sign(wrongKey)

    const res = await app.request("/protected/test", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Config Validation Tests
// ---------------------------------------------------------------------------

describe("T4.5: SIWE config validation", () => {
  it("rejects short JWT secret", () => {
    expect(() => createSiweAuthRoutes({
      redis: new MockRedis() as never,
      jwtSecret: "short",
      domain: TEST_DOMAIN,
      uri: TEST_URI,
      chainId: TEST_CHAIN_ID,
    })).toThrow("JWT secret must be at least 32 characters")
  })

  it("rejects missing domain", () => {
    expect(() => createSiweAuthRoutes({
      redis: new MockRedis() as never,
      jwtSecret: TEST_JWT_SECRET,
      domain: "",
      uri: TEST_URI,
      chainId: TEST_CHAIN_ID,
    })).toThrow("domain is required")
  })

  it("rejects invalid chain ID", () => {
    expect(() => createSiweAuthRoutes({
      redis: new MockRedis() as never,
      jwtSecret: TEST_JWT_SECRET,
      domain: TEST_DOMAIN,
      uri: TEST_URI,
      chainId: 0,
    })).toThrow("chain ID must be a positive integer")
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSiweMessage(overrides: {
  domain?: string
  address?: string
  uri?: string
  chainId?: number
  nonce?: string
} = {}): string {
  const msg = new SiweMessage({
    domain: overrides.domain ?? TEST_DOMAIN,
    address: overrides.address ?? "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18",
    statement: "Sign in to manage API keys",
    uri: overrides.uri ?? TEST_URI,
    version: "1",
    chainId: overrides.chainId ?? TEST_CHAIN_ID,
    nonce: overrides.nonce ?? "testnonce",
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 300_000).toISOString(),
  })
  return msg.prepareMessage()
}
