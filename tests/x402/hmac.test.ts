// tests/x402/hmac.test.ts — HMAC Challenge Tests (Sprint 2 T2.1, T2.2)

import { describe, it, expect } from "vitest"
import {
  signChallenge,
  verifyChallenge,
  createChallenge,
  computeRequestBinding,
  type X402Challenge,
} from "../../src/x402/hmac.js"

const TEST_SECRET = "test-hmac-secret-32-bytes-long!!"
const TEST_SECRET_2 = "different-secret-for-rotation-!!"

function makeFields(): Omit<X402Challenge, "hmac"> {
  return {
    amount: "100000",
    recipient: "0x1234567890abcdef1234567890abcdef12345678",
    chain_id: 8453,
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    nonce: "550e8400-e29b-41d4-a716-446655440000",
    expiry: 1700000000,
    request_path: "/api/v1/agent/chat",
    request_method: "POST",
    request_binding: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  }
}

describe("computeRequestBinding", () => {
  it("produces deterministic output for same inputs", () => {
    const params = { token_id: "0xABC", model: "claude-opus-4-6", max_tokens: 4096 }
    const a = computeRequestBinding(params)
    const b = computeRequestBinding(params)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("lowercases all fields", () => {
    const a = computeRequestBinding({ token_id: "0xABC", model: "Claude-Opus-4-6", max_tokens: 4096 })
    const b = computeRequestBinding({ token_id: "0xabc", model: "claude-opus-4-6", max_tokens: 4096 })
    expect(a).toBe(b)
  })

  it("different inputs produce different bindings", () => {
    const a = computeRequestBinding({ token_id: "0x1", model: "claude-opus-4-6", max_tokens: 4096 })
    const b = computeRequestBinding({ token_id: "0x2", model: "claude-opus-4-6", max_tokens: 4096 })
    expect(a).not.toBe(b)
  })

  it("handles empty token_id", () => {
    const result = computeRequestBinding({ token_id: "", model: "claude-opus-4-6", max_tokens: 4096 })
    expect(result).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("signChallenge", () => {
  it("returns challenge with hmac field", () => {
    const fields = makeFields()
    const signed = signChallenge(fields, TEST_SECRET)
    expect(signed.hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.amount).toBe(fields.amount)
    expect(signed.nonce).toBe(fields.nonce)
  })

  it("deterministic: same inputs produce same HMAC", () => {
    const fields = makeFields()
    const a = signChallenge(fields, TEST_SECRET)
    const b = signChallenge(fields, TEST_SECRET)
    expect(a.hmac).toBe(b.hmac)
  })

  it("different secrets produce different HMACs", () => {
    const fields = makeFields()
    const a = signChallenge(fields, TEST_SECRET)
    const b = signChallenge(fields, TEST_SECRET_2)
    expect(a.hmac).not.toBe(b.hmac)
  })

  it("different fields produce different HMACs", () => {
    const fieldsA = makeFields()
    const fieldsB = { ...makeFields(), amount: "200000" }
    const a = signChallenge(fieldsA, TEST_SECRET)
    const b = signChallenge(fieldsB, TEST_SECRET)
    expect(a.hmac).not.toBe(b.hmac)
  })
})

describe("verifyChallenge", () => {
  it("valid HMAC passes verification", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    expect(verifyChallenge(signed, TEST_SECRET)).toBe(true)
  })

  it("tampered HMAC fails verification", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const tampered = { ...signed, hmac: signed.hmac.replace(/^./, "0") }
    // Only fails if the replacement actually changed the char
    if (tampered.hmac !== signed.hmac) {
      expect(verifyChallenge(tampered, TEST_SECRET)).toBe(false)
    }
    // More reliable: completely different HMAC
    const badHmac = { ...signed, hmac: "a".repeat(64) }
    expect(verifyChallenge(badHmac, TEST_SECRET)).toBe(false)
  })

  it("wrong secret fails verification", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    expect(verifyChallenge(signed, TEST_SECRET_2)).toBe(false)
  })

  it("non-hex HMAC fails gracefully (returns false, never throws)", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const bad = { ...signed, hmac: "not-a-hex-string-at-all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" }
    expect(verifyChallenge(bad, TEST_SECRET)).toBe(false)
  })

  it("short HMAC fails gracefully", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const bad = { ...signed, hmac: "abcd" }
    expect(verifyChallenge(bad, TEST_SECRET)).toBe(false)
  })

  it("uppercase hex HMAC fails (must be lowercase)", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const bad = { ...signed, hmac: signed.hmac.toUpperCase() }
    expect(verifyChallenge(bad, TEST_SECRET)).toBe(false)
  })

  it("empty string HMAC fails gracefully", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const bad = { ...signed, hmac: "" }
    expect(verifyChallenge(bad, TEST_SECRET)).toBe(false)
  })

  it("tampered amount invalidates HMAC", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const tampered = { ...signed, amount: "999999" }
    expect(verifyChallenge(tampered, TEST_SECRET)).toBe(false)
  })

  it("tampered recipient invalidates HMAC", () => {
    const signed = signChallenge(makeFields(), TEST_SECRET)
    const tampered = { ...signed, recipient: "0xdeadbeef" }
    expect(verifyChallenge(tampered, TEST_SECRET)).toBe(false)
  })
})

describe("createChallenge", () => {
  it("creates challenge with fresh nonce and expiry", () => {
    const challenge = createChallenge(
      {
        amount: "100000",
        recipient: "0x1234",
        chain_id: 8453,
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        request_path: "/api/v1/agent/chat",
        request_method: "POST",
        request_binding: "a".repeat(64),
      },
      TEST_SECRET,
    )

    expect(challenge.nonce).toMatch(/^[0-9a-f-]{36}$/) // uuid format
    expect(challenge.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(challenge.hmac).toMatch(/^[0-9a-f]{64}$/)
    // Verify the HMAC is valid
    expect(verifyChallenge(challenge, TEST_SECRET)).toBe(true)
  })

  it("two challenges have different nonces", () => {
    const params = {
      amount: "100000",
      recipient: "0x1234",
      chain_id: 8453,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      request_path: "/api/v1/agent/chat",
      request_method: "POST",
      request_binding: "a".repeat(64),
    }
    const a = createChallenge(params, TEST_SECRET)
    const b = createChallenge(params, TEST_SECRET)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.hmac).not.toBe(b.hmac) // different nonce → different HMAC
  })

  it("custom TTL sets correct expiry", () => {
    const now = Math.floor(Date.now() / 1000)
    const challenge = createChallenge(
      {
        amount: "100000",
        recipient: "0x1234",
        chain_id: 8453,
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        request_path: "/test",
        request_method: "GET",
        request_binding: "a".repeat(64),
        ttlSeconds: 60,
      },
      TEST_SECRET,
    )
    // Expiry should be ~60s from now (allow 2s drift)
    expect(challenge.expiry).toBeGreaterThanOrEqual(now + 58)
    expect(challenge.expiry).toBeLessThanOrEqual(now + 62)
  })
})
