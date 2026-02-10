// tests/finn/req-hash.test.ts — req_hash Verification tests (T-A.3)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { Hono } from "hono"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import { serve } from "@hono/node-server"
import { createHash } from "node:crypto"
import {
  jwtAuthMiddleware,
  reqHashMiddleware,
  resetJWKSCache,
  sha256Hex,
} from "../../src/hounfour/jwt-auth.js"
import type { FinnConfig } from "../../src/config.js"

let jwksServer: ReturnType<typeof serve>
let jwksPort: number
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>

async function startJWKSServer(): Promise<void> {
  keyPair = await generateKeyPair("ES256")
  const app = new Hono()
  app.get("/.well-known/jwks.json", async (c) => {
    const jwk = await exportJWK(keyPair.publicKey)
    jwk.kid = "key-1"
    jwk.alg = "ES256"
    jwk.use = "sig"
    return c.json({ keys: [jwk] })
  })
  return new Promise((resolve) => {
    jwksServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      jwksPort = info.port
      resolve()
    })
  })
}

function mockConfig(): FinnConfig {
  return {
    auth: {
      bearerToken: "test-bearer-token",
      corsOrigins: ["*"],
      rateLimiting: { windowMs: 60000, maxRequestsPerWindow: 100 },
    },
    jwt: {
      enabled: true,
      issuer: "arrakis",
      audience: "loa-finn",
      jwksUrl: `http://localhost:${jwksPort}/.well-known/jwks.json`,
      clockSkewSeconds: 30,
      maxTokenLifetimeSeconds: 3600,
    },
  } as FinnConfig
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf-8") : data)
    .digest("hex")
}

async function signJWT(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-1" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keyPair.privateKey)
}

function validClaims(bodyHash: string): Record<string, unknown> {
  return {
    iss: "arrakis",
    aud: "loa-finn",
    sub: "user:discord:123",
    tenant_id: "community:thj",
    tier: "pro",
    req_hash: `sha256:${bodyHash}`,
  }
}

describe("req_hash Verification (T-A.3)", () => {
  beforeAll(async () => {
    await startJWKSServer()
  })

  afterAll(() => {
    if (jwksServer) jwksServer.close()
  })

  beforeEach(() => {
    resetJWKSCache()
  })

  function createApp(): Hono {
    const config = mockConfig()
    const app = new Hono()

    // JWT auth first, then req_hash verification
    app.use("/api/v1/*", jwtAuthMiddleware(config))
    app.use("/api/v1/*", reqHashMiddleware())

    app.post("/api/v1/chat", async (c) => {
      return c.json({ ok: true })
    })

    app.put("/api/v1/settings", async (c) => {
      return c.json({ ok: true })
    })

    app.patch("/api/v1/session", async (c) => {
      return c.json({ ok: true })
    })

    app.get("/api/v1/status", (c) => {
      return c.json({ ok: true })
    })

    return app
  }

  it("sha256Hex produces correct hash", () => {
    const data = new TextEncoder().encode("hello world")
    const expected = createHash("sha256").update(data).digest("hex")
    expect(sha256Hex(data)).toBe(expected)
  })

  it("sha256Hex of empty bytes matches EMPTY_SHA256", () => {
    const empty = new Uint8Array(0)
    expect(sha256Hex(empty)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  it("valid req_hash on POST → 200", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "hello" })
    const bodyHash = sha256(body)
    const token = await signJWT(validClaims(bodyHash))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(200)
  })

  it("valid req_hash on PUT → 200", async () => {
    const app = createApp()
    const body = JSON.stringify({ theme: "dark" })
    const bodyHash = sha256(body)
    const token = await signJWT(validClaims(bodyHash))

    const res = await app.request("/api/v1/settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(200)
  })

  it("valid req_hash on PATCH → 200", async () => {
    const app = createApp()
    const body = JSON.stringify({ active: true })
    const bodyHash = sha256(body)
    const token = await signJWT(validClaims(bodyHash))

    const res = await app.request("/api/v1/session", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(200)
  })

  it("mismatched req_hash → 400", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "hello" })
    // Sign with a valid-format but wrong hash (64 hex chars, all zeros)
    const wrongHash = "0".repeat(64)
    const token = await signJWT(validClaims(wrongHash))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("req_hash_mismatch")
    expect(json.code).toBe("REQ_HASH_MISMATCH")
  })

  it("malformed req_hash format → 400 format_invalid", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "hello" })
    // "deadbeef" is only 8 hex chars, not 64 — invalid format
    const token = await signJWT(validClaims("deadbeef"))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("req_hash_format_invalid")
    expect(json.code).toBe("REQ_HASH_FORMAT")
  })

  it("req_hash without sha256: prefix → 400 format_invalid", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "test" })
    // Valid 64-char hex but missing sha256: prefix
    const token = await signJWT({
      ...validClaims("unused"),
      req_hash: "a".repeat(64),
    })

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("req_hash_format_invalid")
  })

  it("empty body verifies against sha256 of empty string", async () => {
    const app = createApp()
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    const token = await signJWT(validClaims(emptyHash))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "",
    })
    expect(res.status).toBe(200)
  })

  it("GET requests skip req_hash entirely", async () => {
    const app = createApp()
    // req_hash in JWT but GET method — should be skipped
    const token = await signJWT(validClaims("irrelevant"))

    const res = await app.request("/api/v1/status", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it("non-JSON content type skips req_hash", async () => {
    const app = createApp()
    const token = await signJWT(validClaims("irrelevant"))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: "hello",
    })
    // Middleware skips — route handler responds 200
    expect(res.status).toBe(200)
  })

  it("Content-Encoding: gzip → 415", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "compressed" })
    const bodyHash = sha256(body)
    const token = await signJWT(validClaims(bodyHash))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body,
    })
    expect(res.status).toBe(415)
    const json = await res.json()
    expect(json.error).toBe("req_hash_requires_identity_encoding")
  })

  it("Content-Encoding: identity → allowed", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "plain" })
    const bodyHash = sha256(body)
    const token = await signJWT(validClaims(bodyHash))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Encoding": "identity",
      },
      body,
    })
    expect(res.status).toBe(200)
  })

  it("Content-Length > 1MB → 413", async () => {
    const app = createApp()
    const token = await signJWT(validClaims("irrelevant"))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024), // 2MB
      },
      body: "{}",
    })
    expect(res.status).toBe(413)
    const json = await res.json()
    expect(json.code).toBe("BODY_TOO_LARGE")
  })

  it("unicode body hashes correctly", async () => {
    const app = createApp()
    const body = JSON.stringify({ text: "こんにちは世界 🌍" })
    const bodyHash = sha256(body)
    const token = await signJWT(validClaims(bodyHash))

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    })
    expect(res.status).toBe(200)
  })

  it("JSON with different whitespace produces different hash", async () => {
    const app = createApp()
    // Hash of compact JSON
    const compact = '{"text":"hello"}'
    const compactHash = sha256(compact)
    const token = await signJWT(validClaims(compactHash))

    // Send with extra whitespace — different bytes, different hash
    const prettyBody = '{ "text": "hello" }'

    const res = await app.request("/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: prettyBody,
    })
    // Hashes don't match → 400
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("req_hash_mismatch")
  })
})
