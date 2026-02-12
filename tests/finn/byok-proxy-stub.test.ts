// tests/finn/byok-proxy-stub.test.ts — BYOK Proxy Stub Tests (Task 4.5, C.5)
// Validates two-JWT, bounded-use, nonce replay, session lifecycle, redaction leaks.

import { describe, it, expect, beforeEach } from "vitest"
import { BYOKProxyStub, type BYOKProxyRequest } from "../../tests/mocks/byok-proxy-stub.js"
import { containsKeyPattern, redactKeyPatterns } from "../../src/hounfour/byok-redaction.js"

// --- Helpers ---

let stub: BYOKProxyStub

function makeProxyRequest(overrides: Partial<BYOKProxyRequest> = {}): BYOKProxyRequest {
  return {
    session_token: "placeholder",
    provider: "openai",
    req_nonce: `nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 100,
    },
    ...overrides,
  }
}

// --- Tests ---

describe("BYOKProxyStub", () => {
  beforeEach(() => {
    stub = new BYOKProxyStub()
  })

  describe("session minting", () => {
    it("mints a session token with correct fields", () => {
      const token = stub.mintSession("tenant-1", "openai")
      expect(token.jti).toBeTruthy()
      expect(token.tenant_id).toBe("tenant-1")
      expect(token.provider).toBe("openai")
      expect(token.aud).toBe("arrakis-proxy")
      expect(token.exp).toBeGreaterThan(token.iat)
      expect(token.scopes).toContain("inference")
    })

    it("mints unique JTIs for each session", () => {
      const t1 = stub.mintSession("tenant-1", "openai")
      const t2 = stub.mintSession("tenant-1", "openai")
      expect(t1.jti).not.toBe(t2.jti)
    })

    it("records session creation in audit log", () => {
      stub.mintSession("tenant-1", "openai")
      expect(stub.auditLog).toHaveLength(1)
      expect(stub.auditLog[0].action).toBe("session_created")
      expect(stub.auditLog[0].tenant_id).toBe("tenant-1")
    })
  })

  describe("proxy — happy path", () => {
    it("returns canned response for valid request", () => {
      const token = stub.mintSession("tenant-1", "openai")
      const req = makeProxyRequest({ provider: "openai" })

      const result = stub.proxy(token.jti, "tenant-1", req)

      expect(result.status).toBe(200)
      const body = result.body as { content: string; model: string }
      expect(body.content).toContain("OpenAI")
      expect(body.model).toBe("gpt-4o")
    })

    it("returns Anthropic canned response", () => {
      const token = stub.mintSession("tenant-1", "anthropic")
      const req = makeProxyRequest({ provider: "anthropic" })

      const result = stub.proxy(token.jti, "tenant-1", req)

      expect(result.status).toBe(200)
      const body = result.body as { content: string }
      expect(body.content).toContain("Anthropic")
    })

    it("increments request count", () => {
      const token = stub.mintSession("tenant-1", "openai")

      for (let i = 0; i < 5; i++) {
        const req = makeProxyRequest({ provider: "openai" })
        stub.proxy(token.jti, "tenant-1", req)
      }

      expect(stub.getRequestCount(token.jti)).toBe(5)
    })
  })

  describe("bounded-use enforcement", () => {
    it("rejects request after bounded-use limit", () => {
      const limitedStub = new BYOKProxyStub({ maxRequestsPerSession: 3 })
      const token = limitedStub.mintSession("tenant-1", "openai")

      // First 3 succeed
      for (let i = 0; i < 3; i++) {
        const result = limitedStub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
        expect(result.status).toBe(200)
      }

      // 4th is rejected
      const result = limitedStub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
      expect(result.status).toBe(429)
      expect((result.body as { error: string }).error).toBe("bounded_use_exceeded")
    })

    it("101st request on default limit is rejected", () => {
      const token = stub.mintSession("tenant-1", "openai")

      // Burn through 100 requests
      for (let i = 0; i < 100; i++) {
        const result = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
        expect(result.status).toBe(200)
      }

      // 101st rejected
      const result = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
      expect(result.status).toBe(429)
    })
  })

  describe("nonce replay protection", () => {
    it("rejects duplicate nonce", () => {
      const token = stub.mintSession("tenant-1", "openai")
      const nonce = "fixed-nonce-123"

      // First request succeeds
      const r1 = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai", req_nonce: nonce }))
      expect(r1.status).toBe(200)

      // Replay with same nonce rejected
      const r2 = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai", req_nonce: nonce }))
      expect(r2.status).toBe(409)
      expect((r2.body as { error: string }).error).toBe("nonce_replay")
    })

    it("allows different nonces on same session", () => {
      const token = stub.mintSession("tenant-1", "openai")

      const r1 = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai", req_nonce: "nonce-a" }))
      const r2 = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai", req_nonce: "nonce-b" }))

      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
    })
  })

  describe("session validation", () => {
    it("rejects unknown session JTI", () => {
      const result = stub.proxy("nonexistent-jti", "tenant-1", makeProxyRequest())
      expect(result.status).toBe(404)
      expect((result.body as { error: string }).error).toBe("session_not_found")
    })

    it("rejects revoked session", () => {
      const token = stub.mintSession("tenant-1", "openai")
      stub.revokeSession(token.jti)

      const result = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
      expect(result.status).toBe(403)
      expect((result.body as { error: string }).error).toBe("session_revoked")
    })

    it("rejects tenant mismatch", () => {
      const token = stub.mintSession("tenant-1", "openai")

      const result = stub.proxy(token.jti, "tenant-OTHER", makeProxyRequest({ provider: "openai" }))
      expect(result.status).toBe(403)
      expect((result.body as { error: string }).error).toBe("tenant_mismatch")
    })

    it("rejects provider mismatch", () => {
      const token = stub.mintSession("tenant-1", "openai")

      const result = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "anthropic" }))
      expect(result.status).toBe(400)
      expect((result.body as { error: string }).error).toBe("provider_mismatch")
    })

    it("isSessionActive returns true for active session", () => {
      const token = stub.mintSession("tenant-1", "openai")
      expect(stub.isSessionActive(token.jti)).toBe(true)
    })

    it("isSessionActive returns false after revocation", () => {
      const token = stub.mintSession("tenant-1", "openai")
      stub.revokeSession(token.jti)
      expect(stub.isSessionActive(token.jti)).toBe(false)
    })
  })

  describe("session revocation → subsequent rejection", () => {
    it("revoke token → subsequent requests rejected", () => {
      const token = stub.mintSession("tenant-1", "openai")

      // First request succeeds
      const r1 = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
      expect(r1.status).toBe(200)

      // Revoke
      const revoked = stub.revokeSession(token.jti)
      expect(revoked).toBe(true)

      // Subsequent request rejected
      const r2 = stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))
      expect(r2.status).toBe(403)
    })
  })

  describe("redaction enforcement", () => {
    it("simulated key leak error contains fake API keys", () => {
      const error = stub.simulateKeyLeakError("openai")
      const json = JSON.stringify(error.body)

      // The error intentionally contains a key pattern
      expect(containsKeyPattern(json)).toBe(true)
    })

    it("redacting key leak error removes all API key patterns", () => {
      const error = stub.simulateKeyLeakError("openai")
      const json = JSON.stringify(error.body)

      // After redaction, no key patterns should remain
      const redacted = redactKeyPatterns(json)
      expect(containsKeyPattern(redacted)).toBe(false)
      expect(redacted).toContain("[REDACTED]")
    })

    it("redacting Anthropic key leak removes pattern", () => {
      const error = stub.simulateKeyLeakError("anthropic")
      const json = JSON.stringify(error.body)

      const redacted = redactKeyPatterns(json)
      expect(containsKeyPattern(redacted)).toBe(false)
    })

    it("audit log contains no key material", () => {
      const token = stub.mintSession("tenant-1", "openai")
      stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))

      const auditJson = JSON.stringify(stub.auditLog)
      expect(containsKeyPattern(auditJson)).toBe(false)
    })
  })

  describe("cleanup", () => {
    it("reset clears all state", () => {
      const token = stub.mintSession("tenant-1", "openai")
      stub.proxy(token.jti, "tenant-1", makeProxyRequest({ provider: "openai" }))

      stub.reset()

      expect(stub.isSessionActive(token.jti)).toBe(false)
      expect(stub.auditLog).toHaveLength(0)
    })
  })
})
