// tests/gateway/key-routes.test.ts — API Key Lifecycle Route Tests (Sprint 4 T4.6)

import { describe, it, expect, beforeEach } from "vitest"
import { Hono } from "hono"
import * as jose from "jose"
import { createKeyRoutes } from "../../src/gateway/routes/keys.js"

// ---------------------------------------------------------------------------
// Mock ApiKeyManager
// ---------------------------------------------------------------------------

class MockApiKeyManager {
  private keys = new Map<string, { tenantId: string; label: string; balance: number; revoked: boolean }>()
  private nextId = 1

  async create(tenantId: string, label = ""): Promise<{ keyId: string; plaintextKey: string }> {
    const keyId = `key_${String(this.nextId++).padStart(4, "0")}`
    const plaintextKey = `dk_${keyId}.test_secret`
    this.keys.set(keyId, { tenantId, label, balance: 0, revoked: false })
    return { keyId, plaintextKey }
  }

  async revoke(keyId: string, tenantId: string): Promise<boolean> {
    const key = this.keys.get(keyId)
    if (!key || key.tenantId !== tenantId) return false
    key.revoked = true
    return true
  }

  async getBalance(keyId: string): Promise<number | null> {
    const key = this.keys.get(keyId)
    if (!key) return null
    return key.balance
  }
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

const JWT_SECRET = "a]K9#mP2$vL7!nQ5^wX3&jR8*hT6+bY4"
const secretKey = new TextEncoder().encode(JWT_SECRET)
const WALLET = "0x742D35CC6634C0532925a3B844Bc9E7595F2bD18"

async function makeToken(wallet: string = WALLET): Promise<string> {
  return new jose.SignJWT({ sub: wallet })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("loa-finn")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secretKey)
}

describe("T4.6: API Key Lifecycle Endpoints", () => {
  let app: Hono
  let apiKeyManager: MockApiKeyManager

  beforeEach(() => {
    apiKeyManager = new MockApiKeyManager()
    const routes = createKeyRoutes({
      apiKeyManager: apiKeyManager as never,
      jwtSecret: JWT_SECRET,
    })
    app = new Hono()
    app.route("/api/v1/keys", routes)
  })

  // -------------------------------------------------------------------------
  // Auth enforcement
  // -------------------------------------------------------------------------

  it("rejects requests without auth", async () => {
    const res = await app.request("/api/v1/keys", { method: "POST" })
    expect(res.status).toBe(401)
  })

  it("rejects requests with expired JWT", async () => {
    const token = await new jose.SignJWT({ sub: WALLET })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("loa-finn")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(secretKey)

    const res = await app.request("/api/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/keys — Create key
  // -------------------------------------------------------------------------

  it("creates key and returns plaintext", async () => {
    const token = await makeToken()
    const res = await app.request("/api/v1/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "My test key" }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.key_id).toBeDefined()
    expect(body.plaintext_key).toMatch(/^dk_/)
    expect(body.message).toContain("Store this key securely")
  })

  it("creates key without label", async () => {
    const token = await makeToken()
    const res = await app.request("/api/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.key_id).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // DELETE /api/v1/keys/:key_id — Revoke key
  // -------------------------------------------------------------------------

  it("revokes key owned by wallet", async () => {
    const token = await makeToken()

    // Create a key first
    const createRes = await app.request("/api/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    const { key_id } = await createRes.json()

    // Revoke it
    const res = await app.request(`/api/v1/keys/${key_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.revoked).toBe(true)
  })

  it("returns 404 for non-existent key revocation", async () => {
    const token = await makeToken()
    const res = await app.request("/api/v1/keys/nonexistent", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(404)
  })

  it("returns 404 when revoking key owned by different wallet", async () => {
    const token1 = await makeToken(WALLET)
    const token2 = await makeToken("0xDifferentWallet")

    // Create key with wallet1
    const createRes = await app.request("/api/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${token1}` },
    })
    const { key_id } = await createRes.json()

    // Try to revoke with wallet2
    const res = await app.request(`/api/v1/keys/${key_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token2}` },
    })

    expect(res.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/keys/:key_id/balance — Check balance
  // -------------------------------------------------------------------------

  it("returns balance for existing key", async () => {
    const token = await makeToken()

    // Create a key first
    const createRes = await app.request("/api/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    const { key_id } = await createRes.json()

    // Check balance
    const res = await app.request(`/api/v1/keys/${key_id}/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.key_id).toBe(key_id)
    expect(body.balance_micro).toBe(0)
  })

  it("returns 404 for non-existent key balance", async () => {
    const token = await makeToken()
    const res = await app.request("/api/v1/keys/nonexistent/balance", {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(404)
  })

  // -------------------------------------------------------------------------
  // Full lifecycle: create → use → check balance → revoke
  // -------------------------------------------------------------------------

  it("full lifecycle: create → balance → revoke", async () => {
    const token = await makeToken()

    // 1. Create
    const createRes = await app.request("/api/v1/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "Lifecycle test" }),
    })
    expect(createRes.status).toBe(201)
    const { key_id, plaintext_key } = await createRes.json()
    expect(plaintext_key).toMatch(/^dk_/)

    // 2. Check balance
    const balRes = await app.request(`/api/v1/keys/${key_id}/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(balRes.status).toBe(200)
    const { balance_micro } = await balRes.json()
    expect(balance_micro).toBe(0)

    // 3. Revoke
    const revokeRes = await app.request(`/api/v1/keys/${key_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(revokeRes.status).toBe(200)
    expect((await revokeRes.json()).revoked).toBe(true)
  })
})
