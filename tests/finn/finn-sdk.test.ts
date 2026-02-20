// tests/finn/finn-sdk.test.ts — Finn SDK Client Tests (Sprint 7 T7.2, T7.3)

import { describe, it, expect, vi } from "vitest"
import { FinnClient, FinnApiError, parseX402Challenge, formatReceiptHeaders } from "../../packages/finn-sdk/src/index.js"

// ---------------------------------------------------------------------------
// Mock Fetch Helper
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0
  const calls: Array<{ url: string; init: RequestInit }> = []

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const response = responses[callIndex++]
    if (!response) throw new Error("No more mock responses")

    calls.push({ url: url.toString(), init: init ?? {} })

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      headers: new Headers(response.headers ?? {}),
    } as Response
  })

  return { fetchFn, calls }
}

// ---------------------------------------------------------------------------
// T7.2: FinnClient Core Methods
// ---------------------------------------------------------------------------

describe("FinnClient (T7.2)", () => {
  describe("chat()", () => {
    it("sends POST to /api/v1/agent/chat with JSON body", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { response: "Hello!", personality: { archetype: "freetekno", display_name: "Tekno" } } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", apiKey: "dk_test123", fetch: fetchFn })

      const result = await client.chat({ token_id: "1", message: "Hi" })
      expect(result.response).toBe("Hello!")
      expect(calls[0].url).toBe("https://finn.test/api/v1/agent/chat")
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ token_id: "1", message: "Hi" })
    })

    it("includes Authorization header when API key set", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { response: "ok", personality: { archetype: "milady", display_name: "Lady" } } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", apiKey: "dk_mykey", fetch: fetchFn })

      await client.chat({ token_id: "1", message: "test" })
      const headers = calls[0].init.headers as Record<string, string>
      expect(headers["Authorization"]).toBe("Bearer dk_mykey")
    })

    it("throws FinnApiError on non-2xx response", async () => {
      const { fetchFn } = mockFetch([
        { status: 404, body: { error: "Token not found", code: "NOT_FOUND" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

      await expect(client.chat({ token_id: "999", message: "hi" })).rejects.toThrow(FinnApiError)
      try {
        await client.chat({ token_id: "999", message: "hi" })
      } catch (e) {
        // Second call for assertion
      }
    })
  })

  describe("createKey()", () => {
    it("sends POST to /api/v1/keys with session auth", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 201, body: { key_id: "k_abc", plaintext_key: "dk_secret", message: "Store securely" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", sessionToken: "jwt_token", fetch: fetchFn })

      const result = await client.createKey({ label: "test key" })
      expect(result.key_id).toBe("k_abc")
      expect(result.plaintext_key).toBe("dk_secret")

      const headers = calls[0].init.headers as Record<string, string>
      expect(headers["Authorization"]).toBe("Bearer jwt_token")
    })

    it("works without request body", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 201, body: { key_id: "k_abc", plaintext_key: "dk_secret", message: "ok" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", sessionToken: "jwt", fetch: fetchFn })

      await client.createKey()
      expect(calls[0].init.body).toBeUndefined()
    })
  })

  describe("revokeKey()", () => {
    it("sends DELETE to /api/v1/keys/:id", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { key_id: "k_abc", revoked: true } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", sessionToken: "jwt", fetch: fetchFn })

      const result = await client.revokeKey("k_abc")
      expect(result.revoked).toBe(true)
      expect(calls[0].url).toBe("https://finn.test/api/v1/keys/k_abc")
      expect(calls[0].init.method).toBe("DELETE")
    })

    it("URL-encodes key ID", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { key_id: "k/special", revoked: true } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", sessionToken: "jwt", fetch: fetchFn })

      await client.revokeKey("k/special")
      expect(calls[0].url).toContain("k%2Fspecial")
    })
  })

  describe("getBalance()", () => {
    it("returns balance in micro-USDC", async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { key_id: "k_abc", balance_micro: 500000 } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", sessionToken: "jwt", fetch: fetchFn })

      const result = await client.getBalance("k_abc")
      expect(result.balance_micro).toBe(500000)
    })
  })

  describe("getNonce()", () => {
    it("fetches nonce from /api/v1/auth/nonce", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { nonce: "abc123" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

      const result = await client.getNonce()
      expect(result.nonce).toBe("abc123")
      expect(calls[0].init.method).toBe("GET")
    })
  })

  describe("verify()", () => {
    it("sends SIWE message and stores session token", async () => {
      const { fetchFn } = mockFetch([
        { status: 200, body: { token: "jwt_session", expires_in: 900, wallet_address: "0xABC" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

      const result = await client.verify({ message: "siwe_msg", signature: "0xsig" })
      expect(result.token).toBe("jwt_session")
      expect(result.wallet_address).toBe("0xABC")
    })
  })

  describe("setSessionToken()", () => {
    it("updates session token for subsequent requests", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 201, body: { key_id: "k1", plaintext_key: "dk_x", message: "ok" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

      client.setSessionToken("new_token")
      await client.createKey()

      const headers = calls[0].init.headers as Record<string, string>
      expect(headers["Authorization"]).toBe("Bearer new_token")
    })
  })

  describe("baseUrl normalization", () => {
    it("strips trailing slash", async () => {
      const { fetchFn, calls } = mockFetch([
        { status: 200, body: { nonce: "x" } },
      ])
      const client = new FinnClient({ baseUrl: "https://finn.test/", fetch: fetchFn })

      await client.getNonce()
      expect(calls[0].url).toBe("https://finn.test/api/v1/auth/nonce")
    })
  })
})

// ---------------------------------------------------------------------------
// T7.2: FinnApiError
// ---------------------------------------------------------------------------

describe("FinnApiError", () => {
  it("carries code and status", () => {
    const err = new FinnApiError("Not found", "NOT_FOUND", 404)
    expect(err.message).toBe("Not found")
    expect(err.code).toBe("NOT_FOUND")
    expect(err.status).toBe(404)
    expect(err.name).toBe("FinnApiError")
    expect(err instanceof Error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// T7.3: payAndChat() — x402 Payment Flow
// ---------------------------------------------------------------------------

describe("payAndChat() (T7.3)", () => {
  const CHALLENGE = {
    error: "Payment required",
    code: "PAYMENT_REQUIRED",
    challenge: {
      nonce: "nonce_123",
      amount: "100000",
      recipient: "0xTREASURY",
      chain_id: 8453,
      expires_at: "2026-12-31T23:59:59Z",
      hmac: "hmac_abc",
    },
  }

  it("returns response directly when first request succeeds", async () => {
    const { fetchFn } = mockFetch([
      { status: 200, body: { response: "Hello!", personality: { archetype: "freetekno", display_name: "T" } } },
    ])
    const client = new FinnClient({ baseUrl: "https://finn.test", apiKey: "dk_key", fetch: fetchFn })
    const callback = vi.fn()

    const result = await client.payAndChat({ token_id: "1", message: "hi" }, callback)
    expect(result).not.toBeNull()
    expect(result!.response).toBe("Hello!")
    expect(callback).not.toHaveBeenCalled()
  })

  it("invokes payment callback on 402 and retries with receipt", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 402, body: CHALLENGE },
      { status: 200, body: { response: "Paid!", personality: { archetype: "milady", display_name: "L" } } },
    ])
    const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

    const callback = vi.fn().mockResolvedValue({ tx_hash: "0xTX", nonce: "nonce_123" })

    const result = await client.payAndChat({ token_id: "1", message: "hi" }, callback)
    expect(result).not.toBeNull()
    expect(result!.response).toBe("Paid!")
    expect(callback).toHaveBeenCalledWith(CHALLENGE.challenge)

    // Verify retry includes receipt headers
    const retryHeaders = calls[1].init.headers as Record<string, string>
    expect(retryHeaders["X-Payment-Receipt"]).toBe("0xTX")
    expect(retryHeaders["X-Payment-Nonce"]).toBe("nonce_123")
  })

  it("returns null when payment callback returns null (user abort)", async () => {
    const { fetchFn } = mockFetch([
      { status: 402, body: CHALLENGE },
    ])
    const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

    const callback = vi.fn().mockResolvedValue(null)

    const result = await client.payAndChat({ token_id: "1", message: "hi" }, callback)
    expect(result).toBeNull()
  })

  it("throws on non-402 error", async () => {
    const { fetchFn } = mockFetch([
      { status: 500, body: { error: "Internal error", code: "INTERNAL" } },
    ])
    const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

    const callback = vi.fn()
    await expect(client.payAndChat({ token_id: "1", message: "hi" }, callback)).rejects.toThrow(FinnApiError)
    expect(callback).not.toHaveBeenCalled()
  })

  it("throws on 402 without challenge body", async () => {
    const { fetchFn } = mockFetch([
      { status: 402, body: { error: "Payment required" } },
    ])
    const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

    const callback = vi.fn()
    await expect(client.payAndChat({ token_id: "1", message: "hi" }, callback)).rejects.toThrow("no challenge")
  })

  it("throws if retry after payment fails", async () => {
    const { fetchFn } = mockFetch([
      { status: 402, body: CHALLENGE },
      { status: 400, body: { error: "Invalid receipt", code: "INVALID_RECEIPT" } },
    ])
    const client = new FinnClient({ baseUrl: "https://finn.test", fetch: fetchFn })

    const callback = vi.fn().mockResolvedValue({ tx_hash: "0xBAD", nonce: "nonce_123" })
    await expect(client.payAndChat({ token_id: "1", message: "hi" }, callback)).rejects.toThrow(FinnApiError)
  })
})

// ---------------------------------------------------------------------------
// T7.3: Utility Functions
// ---------------------------------------------------------------------------

describe("parseX402Challenge()", () => {
  it("parses valid challenge body", () => {
    const body = {
      challenge: {
        nonce: "abc",
        amount: "100000",
        recipient: "0xTREASURY",
        chain_id: 8453,
        expires_at: "2026-12-31T23:59:59Z",
        hmac: "hmac_123",
      },
    }
    const result = parseX402Challenge(body)
    expect(result).not.toBeNull()
    expect(result!.nonce).toBe("abc")
    expect(result!.chain_id).toBe(8453)
  })

  it("returns null for non-object input", () => {
    expect(parseX402Challenge(null)).toBeNull()
    expect(parseX402Challenge(undefined)).toBeNull()
    expect(parseX402Challenge("string")).toBeNull()
  })

  it("returns null for missing challenge field", () => {
    expect(parseX402Challenge({ error: "test" })).toBeNull()
  })

  it("returns null for incomplete challenge", () => {
    expect(parseX402Challenge({ challenge: { nonce: "abc" } })).toBeNull()
  })
})

describe("formatReceiptHeaders()", () => {
  it("returns headers with receipt and nonce", () => {
    const headers = formatReceiptHeaders({ tx_hash: "0xABC", nonce: "n_123" })
    expect(headers["X-Payment-Receipt"]).toBe("0xABC")
    expect(headers["X-Payment-Nonce"]).toBe("n_123")
  })
})
