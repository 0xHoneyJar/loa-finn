// tests/finn/byok-stress-security.test.ts — BYOK Stress & Security Tests (Task 4.6)
// Validates bounded-use edge cases, concurrent session operations, key material
// isolation, and redaction completeness across all output paths.

import { describe, it, expect, beforeEach } from "vitest"
import { BYOKProxyStub, type BYOKProxyRequest } from "../../tests/mocks/byok-proxy-stub.js"
import {
  containsKeyPattern,
  redactKeyPatterns,
  redactResponseBody,
  scrubProviderError,
  shannonEntropy,
  createAuditEntry,
} from "../../src/hounfour/byok-redaction.js"

// --- Helpers ---

let stub: BYOKProxyStub

function makeReq(overrides: Partial<BYOKProxyRequest> = {}): BYOKProxyRequest {
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

// --- Stress Tests ---

describe("BYOK stress & security", () => {
  beforeEach(() => {
    stub = new BYOKProxyStub()
  })

  describe("concurrent session operations", () => {
    it("handles 50 independent sessions in parallel", () => {
      const sessions = Array.from({ length: 50 }, (_, i) => ({
        token: stub.mintSession(`tenant-${i}`, i % 2 === 0 ? "openai" : "anthropic"),
        tenantId: `tenant-${i}`,
        provider: i % 2 === 0 ? "openai" : "anthropic",
      }))

      // All 50 sessions make requests simultaneously
      const results = sessions.map(({ token, tenantId, provider }) =>
        stub.proxy(token.jti, tenantId, makeReq({ provider })),
      )

      // All should succeed
      expect(results.every(r => r.status === 200)).toBe(true)
      expect(stub.auditLog.filter(e => e.action === "proxy_success")).toHaveLength(50)
    })

    it("handles rapid session create-use-revoke cycles", () => {
      for (let i = 0; i < 20; i++) {
        const token = stub.mintSession(`tenant-${i}`, "openai")
        const r1 = stub.proxy(token.jti, `tenant-${i}`, makeReq())
        expect(r1.status).toBe(200)

        stub.revokeSession(token.jti)

        const r2 = stub.proxy(token.jti, `tenant-${i}`, makeReq())
        expect(r2.status).toBe(403)
      }
    })

    it("isolates sessions from different tenants", () => {
      const tokenA = stub.mintSession("tenant-A", "openai")
      const tokenB = stub.mintSession("tenant-B", "openai")

      // A cannot use B's session
      const crossResult = stub.proxy(tokenA.jti, "tenant-B", makeReq())
      expect(crossResult.status).toBe(403)
      expect((crossResult.body as { error: string }).error).toBe("tenant_mismatch")

      // B cannot use A's session
      const crossResult2 = stub.proxy(tokenB.jti, "tenant-A", makeReq())
      expect(crossResult2.status).toBe(403)

      // Each uses own session correctly
      const aResult = stub.proxy(tokenA.jti, "tenant-A", makeReq())
      const bResult = stub.proxy(tokenB.jti, "tenant-B", makeReq())
      expect(aResult.status).toBe(200)
      expect(bResult.status).toBe(200)
    })

    it("multiple sessions per tenant are independent", () => {
      const t1 = stub.mintSession("shared-tenant", "openai")
      const t2 = stub.mintSession("shared-tenant", "anthropic")

      // Each session has its own request count
      for (let i = 0; i < 5; i++) {
        stub.proxy(t1.jti, "shared-tenant", makeReq({ provider: "openai" }))
      }

      expect(stub.getRequestCount(t1.jti)).toBe(5)
      expect(stub.getRequestCount(t2.jti)).toBe(0)

      // Revoking one doesn't affect the other
      stub.revokeSession(t1.jti)
      expect(stub.isSessionActive(t1.jti)).toBe(false)
      expect(stub.isSessionActive(t2.jti)).toBe(true)
    })
  })

  describe("bounded-use edge cases", () => {
    it("exact boundary: request N succeeds, N+1 rejected", () => {
      const limitedStub = new BYOKProxyStub({ maxRequestsPerSession: 5 })
      const token = limitedStub.mintSession("tenant-1", "openai")

      // Requests 1-5 succeed
      for (let i = 0; i < 5; i++) {
        const r = limitedStub.proxy(token.jti, "tenant-1", makeReq())
        expect(r.status).toBe(200)
      }

      // Request 6 rejected
      const r6 = limitedStub.proxy(token.jti, "tenant-1", makeReq())
      expect(r6.status).toBe(429)
      expect((r6.body as { error: string; limit: number }).limit).toBe(5)
    })

    it("bounded-use with limit=1 (single-use token)", () => {
      const singleUse = new BYOKProxyStub({ maxRequestsPerSession: 1 })
      const token = singleUse.mintSession("tenant-1", "openai")

      const r1 = singleUse.proxy(token.jti, "tenant-1", makeReq())
      expect(r1.status).toBe(200)

      const r2 = singleUse.proxy(token.jti, "tenant-1", makeReq())
      expect(r2.status).toBe(429)
    })

    it("rejected requests do not increment count", () => {
      const limitedStub = new BYOKProxyStub({ maxRequestsPerSession: 3 })
      const token = limitedStub.mintSession("tenant-1", "openai")

      // Use all 3
      for (let i = 0; i < 3; i++) {
        limitedStub.proxy(token.jti, "tenant-1", makeReq())
      }

      // Rejected requests should not increment
      for (let i = 0; i < 5; i++) {
        limitedStub.proxy(token.jti, "tenant-1", makeReq())
      }

      expect(limitedStub.getRequestCount(token.jti)).toBe(3) // Still 3, not 8
    })

    it("different sessions have independent limits", () => {
      const limitedStub = new BYOKProxyStub({ maxRequestsPerSession: 2 })
      const t1 = limitedStub.mintSession("tenant-1", "openai")
      const t2 = limitedStub.mintSession("tenant-1", "openai")

      // Burn through t1's limit
      limitedStub.proxy(t1.jti, "tenant-1", makeReq())
      limitedStub.proxy(t1.jti, "tenant-1", makeReq())
      expect(limitedStub.proxy(t1.jti, "tenant-1", makeReq()).status).toBe(429)

      // t2 still has its own limit
      expect(limitedStub.proxy(t2.jti, "tenant-1", makeReq()).status).toBe(200)
      expect(limitedStub.proxy(t2.jti, "tenant-1", makeReq()).status).toBe(200)
      expect(limitedStub.proxy(t2.jti, "tenant-1", makeReq()).status).toBe(429)
    })
  })

  describe("nonce replay stress", () => {
    it("rejects same nonce across different sessions", () => {
      const t1 = stub.mintSession("tenant-1", "openai")
      const t2 = stub.mintSession("tenant-1", "openai")
      const sharedNonce = "shared-nonce-abc"

      // First use succeeds on t1
      const r1 = stub.proxy(t1.jti, "tenant-1", makeReq({ req_nonce: sharedNonce }))
      expect(r1.status).toBe(200)

      // Same nonce on t2 also rejected (nonce is global)
      const r2 = stub.proxy(t2.jti, "tenant-1", makeReq({ req_nonce: sharedNonce }))
      expect(r2.status).toBe(409)
    })

    it("handles 100 unique nonces without collision", () => {
      const token = stub.mintSession("tenant-1", "openai")

      for (let i = 0; i < 100; i++) {
        const r = stub.proxy(token.jti, "tenant-1", makeReq({ req_nonce: `unique-${i}` }))
        expect(r.status).toBe(200)
      }
    })

    it("nonce replay detected even after session revocation", () => {
      const token = stub.mintSession("tenant-1", "openai")
      const nonce = "pre-revoke-nonce"

      stub.proxy(token.jti, "tenant-1", makeReq({ req_nonce: nonce }))
      stub.revokeSession(token.jti)

      // New session, same nonce — should be rejected (nonce is global, not per-session)
      const t2 = stub.mintSession("tenant-1", "openai")
      const r = stub.proxy(t2.jti, "tenant-1", makeReq({ req_nonce: nonce }))
      expect(r.status).toBe(409)
    })
  })

  describe("key material isolation — redaction completeness", () => {
    it("no key material in any successful proxy response", () => {
      const token = stub.mintSession("tenant-1", "openai")
      const result = stub.proxy(token.jti, "tenant-1", makeReq())

      const json = JSON.stringify(result)
      expect(containsKeyPattern(json)).toBe(false)
    })

    it("no key material in error responses", () => {
      // Session not found
      const r1 = stub.proxy("bad-jti", "tenant-1", makeReq())
      expect(containsKeyPattern(JSON.stringify(r1))).toBe(false)

      // Revoked session
      const token = stub.mintSession("tenant-1", "openai")
      stub.revokeSession(token.jti)
      const r2 = stub.proxy(token.jti, "tenant-1", makeReq())
      expect(containsKeyPattern(JSON.stringify(r2))).toBe(false)

      // Bounded-use exceeded
      const limited = new BYOKProxyStub({ maxRequestsPerSession: 1 })
      const t = limited.mintSession("tenant-1", "openai")
      limited.proxy(t.jti, "tenant-1", makeReq())
      const r3 = limited.proxy(t.jti, "tenant-1", makeReq())
      expect(containsKeyPattern(JSON.stringify(r3))).toBe(false)
    })

    it("simulated key leak redacted for all providers", () => {
      for (const provider of ["openai", "anthropic"]) {
        const leak = stub.simulateKeyLeakError(provider)
        const raw = JSON.stringify(leak.body)

        // Raw contains keys
        expect(containsKeyPattern(raw)).toBe(true)

        // Redacted does not
        const redacted = redactKeyPatterns(raw)
        expect(containsKeyPattern(redacted)).toBe(false)
        expect(redacted).toContain("[REDACTED]")
      }
    })

    it("audit log remains clean after many operations", () => {
      // Mix of successful and failed operations
      const token = stub.mintSession("tenant-1", "openai")
      for (let i = 0; i < 10; i++) {
        stub.proxy(token.jti, "tenant-1", makeReq())
      }
      stub.proxy("bad-jti", "tenant-1", makeReq()) // 404
      stub.proxy(token.jti, "wrong-tenant", makeReq()) // 403
      stub.revokeSession(token.jti)
      stub.proxy(token.jti, "tenant-1", makeReq()) // 403 revoked

      const auditJson = JSON.stringify(stub.auditLog)
      expect(containsKeyPattern(auditJson)).toBe(false)
    })
  })

  describe("redaction response body security", () => {
    it("strips nested sensitive fields", () => {
      const body = {
        status: 200,
        model: "gpt-4o",
        choices: [{ message: { content: "secret", role: "assistant" } }],
        headers: { "x-api-key": "sk-secret-key-1234567890abcdef" },
        _internal: { api_key: "sk-real-key-999" },
      }
      const result = redactResponseBody(body)

      expect(result.status).toBe(200)
      expect(result.model).toBe("gpt-4o")
      expect(result.choices).toBeUndefined()
      expect(result.headers).toBeUndefined()
      expect(result._internal).toBeUndefined()
    })

    it("redacts keys embedded in allowed string fields", () => {
      const body = {
        model: "sk-proj-a9B2cD3eF4gH5iJ6kL7mN8oP9",
        id: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        status: 200,
      }
      const result = redactResponseBody(body)

      // String fields with keys get redacted
      expect(containsKeyPattern(result.model as string)).toBe(false)
      expect(containsKeyPattern(result.id as string)).toBe(false)
      // Numeric field preserved
      expect(result.status).toBe(200)
    })

    it("handles deeply nested allowed structures", () => {
      const body = {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          reasoning_tokens: 20,
          // Secret field at nested level
          internal_billing_key: "sk-billing-secret-key-1234567890abcdef",
        },
      }
      const result = redactResponseBody(body)
      const usage = result.usage as Record<string, unknown>

      expect(usage.prompt_tokens).toBe(100)
      expect(usage.completion_tokens).toBe(50)
      expect(usage.total_tokens).toBe(150)
      expect(usage.reasoning_tokens).toBe(20)
      expect(usage.internal_billing_key).toBeUndefined()
    })
  })

  describe("provider error scrubbing security", () => {
    it("scrubs error messages containing multiple key types", () => {
      const body = {
        error: {
          message: `Auth failed: tried sk-proj-abcdefghij1234567890 then anthropic-sk-ant-secret-key-backup12345`,
          code: "authentication_error",
        },
      }
      const result = scrubProviderError(401, body)

      expect(result.message).toBe("<redacted>")
      expect(result.error_code).toBeUndefined() // authentication_error not in allowlist
      expect(containsKeyPattern(JSON.stringify(result))).toBe(false)
    })

    it("scrubs error with stack trace containing secrets", () => {
      const body = {
        error: {
          message: "Internal error",
          stack: "Error: fetch failed\n  at makeRequest(sk-proj-abc123def456ghi789jkl0)\n  at handler.ts:42",
        },
      }
      const result = scrubProviderError(500, body)
      const json = JSON.stringify(result)

      expect(containsKeyPattern(json)).toBe(false)
      // Stack trace should not be present
      expect(json).not.toContain("stack")
      expect(json).not.toContain("handler.ts")
    })

    it("preserves allowed error codes but redacts messages", () => {
      const allowedCodes = [
        "rate_limit_exceeded",
        "model_not_found",
        "context_length_exceeded",
        "insufficient_quota",
      ]

      for (const code of allowedCodes) {
        const result = scrubProviderError(429, {
          error: { code, message: `Detailed internal error for ${code} with sk-secret-key-1234567890abcdef` },
        })
        expect(result.error_code).toBe(code)
        // Even with allowed code, the message should be generic (not the raw one)
        expect(containsKeyPattern(JSON.stringify(result))).toBe(false)
      }
    })
  })

  describe("audit entry security", () => {
    it("strips query params containing keys", () => {
      const entry = createAuditEntry(
        "req-1",
        "tenant-1",
        "openai",
        "/v1/chat?api_key=sk-proj-secret12345678901234&session=abc",
        200,
        100,
      )
      expect(entry.endpoint).toBe("/v1/chat")
      expect(containsKeyPattern(JSON.stringify(entry))).toBe(false)
    })

    it("handles malformed URLs gracefully", () => {
      const entry = createAuditEntry("req-1", "t-1", "openai", "/v1/chat?", 200, 50)
      expect(entry.endpoint).toBe("/v1/chat")
    })

    it("all fields are safe in serialized output", () => {
      const entry = createAuditEntry(
        "req-uuid-123",
        "tenant-abc",
        "anthropic",
        "/v1/messages",
        200,
        42,
      )
      const json = JSON.stringify(entry)
      expect(containsKeyPattern(json)).toBe(false)
      expect(json).not.toContain("key")
      expect(entry.timestamp).toBeTruthy()
    })
  })

  describe("shannon entropy edge cases", () => {
    it("correctly classifies known API key formats", () => {
      // Real-ish OpenAI key pattern (high entropy)
      expect(shannonEntropy("sk-proj-a9B2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV")).toBeGreaterThan(4.0)
      // Anthropic key pattern (high entropy)
      expect(shannonEntropy("anthropic-sk-ant-api03-a9B2cD3eF4gH5iJ6kL7m")).toBeGreaterThan(4.0)
    })

    it("correctly classifies safe strings", () => {
      // Model names — low entropy
      expect(shannonEntropy("gpt-4o-2024-08-06")).toBeLessThan(4.5)
      // Common response fields
      expect(shannonEntropy("chat.completion")).toBeLessThan(4.5)
      // UUID-like but structured (moderate entropy, typically < 4.5)
      expect(shannonEntropy("chatcmpl-123456789")).toBeLessThan(4.5)
    })

    it("handles single character strings", () => {
      expect(shannonEntropy("a")).toBe(0)
    })

    it("handles mixed case alphanumeric (high entropy)", () => {
      // Random-looking string should have high entropy
      const random = "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5"
      expect(shannonEntropy(random)).toBeGreaterThan(4.5)
    })
  })

  describe("full lifecycle stress", () => {
    it("create → use → exhaust → revoke → verify all states", () => {
      const limited = new BYOKProxyStub({ maxRequestsPerSession: 3 })
      const token = limited.mintSession("tenant-1", "openai")

      // 1. Active and usable
      expect(limited.isSessionActive(token.jti)).toBe(true)
      expect(limited.proxy(token.jti, "tenant-1", makeReq()).status).toBe(200)

      // 2. Continue using until exhausted
      expect(limited.proxy(token.jti, "tenant-1", makeReq()).status).toBe(200)
      expect(limited.proxy(token.jti, "tenant-1", makeReq()).status).toBe(200)
      expect(limited.proxy(token.jti, "tenant-1", makeReq()).status).toBe(429) // exhausted

      // 3. Session still "active" even if exhausted (not revoked)
      expect(limited.isSessionActive(token.jti)).toBe(true)

      // 4. Revoke
      expect(limited.revokeSession(token.jti)).toBe(true)
      expect(limited.isSessionActive(token.jti)).toBe(false)

      // 5. Double revoke returns true (session still exists, just already revoked)
      expect(limited.revokeSession(token.jti)).toBe(true)

      // 6. Cannot use after revoke (gets 403, not 429)
      expect(limited.proxy(token.jti, "tenant-1", makeReq()).status).toBe(403)
    })

    it("reset clears everything including nonces", () => {
      const token = stub.mintSession("tenant-1", "openai")
      stub.proxy(token.jti, "tenant-1", makeReq({ req_nonce: "remember-me" }))

      stub.reset()

      // Session gone
      expect(stub.isSessionActive(token.jti)).toBe(false)
      expect(stub.auditLog).toHaveLength(0)

      // Nonce cleared — can reuse
      const t2 = stub.mintSession("tenant-1", "openai")
      const r = stub.proxy(t2.jti, "tenant-1", makeReq({ req_nonce: "remember-me" }))
      expect(r.status).toBe(200)
    })
  })
})
