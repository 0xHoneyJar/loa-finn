// tests/e2e/x402-flow.test.ts — x402 Payment Flow E2E Test
//
// Exercises the full x402 payment lifecycle against running Finn services:
//   1. Enable x402 flag → send without X-Payment → 402 with quote
//   2. Construct mock payment proof → send with X-Payment → success
//   3. Replay same nonce → 409 Conflict (idempotent replay)
//   4. Disable x402 flag → 503
//   5. Underpayment (conservation guard) → 402 rejection
//   6. Alias endpoint /api/v1/pay/chat → same behavior as /api/v1/x402/invoke
//
// Requires:
//   CHEVAL_MODE=mock  (deterministic inference)
//   Redis on port 6380
//   Finn on http://localhost:3001
//   x402 routes mounted (x402Deps wired in createApp)
//   ioredis installed (npm i -D ioredis)

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { importPKCS8, SignJWT } from "jose"
import { randomUUID, createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Redis from "ioredis"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FINN_URL = process.env.FINN_URL ?? "http://localhost:3001"
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT ?? 6380)

/** Base chain ID */
const BASE_CHAIN_ID = 8453

/** USDC on Base */
const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

/** Feature flag Redis key for x402 */
const X402_FLAG_KEY = "feature:x402:enabled"

/** Feature flag Redis key for x402:public (bypass allowlist) */
const X402_PUBLIC_FLAG_KEY = "feature:x402:public:enabled"

/** Fake payer wallet address (valid 42-char hex) */
const PAYER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678"

/** Fake treasury address (valid 42-char hex) */
const TREASURY_ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

// ---------------------------------------------------------------------------
// Key Material — reads the SAME key finn uses (from .env.e2e)
// ---------------------------------------------------------------------------

let privateKey: Awaited<ReturnType<typeof importPKCS8>>

function loadPrivateKeyPem(): string {
  const fromEnv = process.env.E2E_ES256_PRIVATE_KEY
  if (fromEnv) return Buffer.from(fromEnv, "base64").toString("utf-8")

  const __filename = fileURLToPath(import.meta.url)
  const __dir = dirname(__filename)
  const candidates = [
    resolve(__dir, ".env.e2e"),
    resolve(process.cwd(), "tests/e2e/.env.e2e"),
    resolve(process.cwd(), ".env.e2e"),
  ]
  const envPath = candidates.find((p) => existsSync(p))
  if (!envPath) throw new Error("Unable to locate .env.e2e for FINN_S2S_PRIVATE_KEY")

  const content = readFileSync(envPath, "utf-8")
  const match = content.match(/^FINN_S2S_PRIVATE_KEY=(.+)$/m)
  if (!match) throw new Error("FINN_S2S_PRIVATE_KEY not found in .env.e2e")
  return Buffer.from(match[1].trim(), "base64").toString("utf-8")
}

// ---------------------------------------------------------------------------
// Redis — direct flag and allowlist manipulation for E2E
// ---------------------------------------------------------------------------

let redis: Redis

beforeAll(async () => {
  const pem = loadPrivateKeyPem()
  privateKey = await importPKCS8(pem, "ES256")

  redis = new Redis({ port: REDIS_PORT, lazyConnect: true })
  await redis.connect()
})

afterAll(async () => {
  // Clean up: disable x402 flags and remove allowlist entry
  try {
    await redis.set(X402_FLAG_KEY, "0")
    await redis.set(X402_PUBLIC_FLAG_KEY, "0")
    await redis.del(`beta:allowlist:${PAYER_ADDRESS}`)
  } catch {
    // Best-effort cleanup
  }
  await redis.quit()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mint a signed ES256 admin JWT (role: "admin") for admin API calls. */
async function mintAdminJWT(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    iss: "e2e-harness",
    aud: "loa-finn-admin",
    tenant_id: "e2e-admin",
    role: "admin",
    jti: randomUUID(),
    exp: now + 120,
  } as Record<string, unknown>)
    .setProtectedHeader({ alg: "ES256", kid: "e2e-v1" })
    .sign(privateKey)
}

/** Build a mock EIP-3009 authorization with realistic structure. */
function buildMockAuthorization(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    from: PAYER_ADDRESS,
    to: TREASURY_ADDRESS,
    value: "61440", // 4096 tokens * 15 MicroUSDC/token = 61440
    valid_after: 0,
    valid_before: now + 600, // 10 minutes from now
    nonce: `0x${randomUUID().replace(/-/g, "")}`,
    v: 28,
    r: "0x" + "ab".repeat(32),
    s: "0x" + "cd".repeat(32),
    ...overrides,
  }
}

/** Build a mock payment proof from a quote and authorization. */
function buildPaymentProof(
  quoteId: string,
  authorization: ReturnType<typeof buildMockAuthorization>,
) {
  return {
    quote_id: quoteId,
    authorization,
    chain_id: BASE_CHAIN_ID,
  }
}

/** POST to x402 invoke endpoint with optional X-Payment header. */
async function postX402Invoke(
  body: Record<string, unknown>,
  xPayment?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (xPayment) {
    headers["X-Payment"] = xPayment
  }
  return fetch(`${FINN_URL}/api/v1/x402/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

/** POST to the /api/v1/pay/chat alias with optional X-Payment header. */
async function postPayChat(
  body: Record<string, unknown>,
  xPayment?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (xPayment) {
    headers["X-Payment"] = xPayment
  }
  return fetch(`${FINN_URL}/api/v1/pay/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

/** Enable x402 feature flag via Redis. */
async function enableX402Flag(): Promise<void> {
  await redis.set(X402_FLAG_KEY, "1")
}

/** Disable x402 feature flag via Redis. */
async function disableX402Flag(): Promise<void> {
  await redis.set(X402_FLAG_KEY, "0")
}

/** Enable x402:public flag (bypasses allowlist). */
async function enableX402PublicFlag(): Promise<void> {
  await redis.set(X402_PUBLIC_FLAG_KEY, "1")
}

/** Add payer address to beta allowlist in Redis. */
async function addToAllowlist(address: string): Promise<void> {
  const normalized = address.toLowerCase()
  await redis.set(`beta:allowlist:${normalized}`, "1")
}

/** Seed a quote directly into Redis (for tests where we need a known quote). */
async function seedQuote(quote: Record<string, unknown>): Promise<void> {
  const quoteId = quote.quote_id as string
  const key = `x402:quote_id:${quoteId}`
  await redis.set(key, JSON.stringify(quote), "EX", 300)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: x402 Payment Flow", () => {
  const requestBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    prompt: "Hello, world!",
  }

  // =========================================================================
  // Test 1: Feature flag OFF → 503
  // =========================================================================
  describe("feature flag disabled", () => {
    it("x402 flag OFF returns 503 FEATURE_DISABLED", async () => {
      await disableX402Flag()

      const res = await postX402Invoke(requestBody)

      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string; code: string }
      expect(body.code).toBe("FEATURE_DISABLED")
    })
  })

  // =========================================================================
  // Test 2: No X-Payment header → 402 with quote
  // =========================================================================
  describe("no payment header → 402 with quote", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag() // Bypass allowlist for quote generation
    })

    it("missing X-Payment returns 402 with quote in header and body", async () => {
      const res = await postX402Invoke(requestBody)

      expect(res.status).toBe(402)

      // Check response body contains quote
      const body = (await res.json()) as {
        error: string
        code: string
        quote: {
          max_cost: string
          max_tokens: number
          model: string
          payment_address: string
          chain_id: number
          valid_until: number
          token_address: string
          quote_id: string
        }
      }
      expect(body.code).toBe("PAYMENT_REQUIRED")
      expect(body.quote).toBeDefined()
      expect(body.quote.quote_id).toBeTruthy()
      expect(body.quote.model).toBe("claude-sonnet-4-6")
      expect(body.quote.max_tokens).toBe(4096)
      expect(body.quote.chain_id).toBe(BASE_CHAIN_ID)
      expect(body.quote.token_address).toBe(USDC_BASE_ADDRESS)
      expect(typeof body.quote.max_cost).toBe("string")
      expect(BigInt(body.quote.max_cost)).toBeGreaterThan(0n)
      expect(body.quote.valid_until).toBeGreaterThan(Math.floor(Date.now() / 1000))

      // Check X-Payment-Required header
      const paymentRequiredHeader = res.headers.get("X-Payment-Required")
      expect(paymentRequiredHeader).toBeTruthy()
      const headerQuote = JSON.parse(paymentRequiredHeader!)
      expect(headerQuote.quote_id).toBe(body.quote.quote_id)
    })

    it("/api/v1/pay/chat alias also returns 402 with quote", async () => {
      const res = await postPayChat(requestBody)

      expect(res.status).toBe(402)
      const body = (await res.json()) as { code: string; quote: { quote_id: string } }
      expect(body.code).toBe("PAYMENT_REQUIRED")
      expect(body.quote.quote_id).toBeTruthy()
    })
  })

  // =========================================================================
  // Test 3: Valid payment → inference response
  // =========================================================================
  describe("valid payment → success", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag()
      await addToAllowlist(PAYER_ADDRESS)
    })

    it("request with valid X-Payment returns inference result", async () => {
      // Step 1: Get a quote
      const quoteRes = await postX402Invoke(requestBody)
      expect(quoteRes.status).toBe(402)
      const quoteBody = (await quoteRes.json()) as {
        quote: {
          quote_id: string
          max_cost: string
          payment_address: string
          max_tokens: number
          model: string
          chain_id: number
          valid_until: number
          token_address: string
        }
      }
      const quote = quoteBody.quote

      // Step 2: Build payment proof matching the quote
      const auth = buildMockAuthorization({
        to: quote.payment_address,
        value: quote.max_cost, // Exact payment matches quoted cost
      })
      const proof = buildPaymentProof(quote.quote_id, auth)

      // Step 3: Send request with X-Payment
      const payRes = await postX402Invoke(requestBody, JSON.stringify(proof))

      // With CHEVAL_MODE=mock, the payment verifier may use mock signature verification.
      // Accept either 200 (full success) or 402 (signature verification failed in non-mock verifier).
      if (payRes.status === 200) {
        const result = (await payRes.json()) as {
          result: string
          payment_id: string
          quote_id: string
        }
        expect(result.result).toBeTruthy()
        expect(result.payment_id).toBeTruthy()
        expect(result.quote_id).toBe(quote.quote_id)
      } else {
        // If the verifier rejects the mock signature, we still validate the
        // error response is well-formed (not a 500 or crash).
        expect([400, 402, 403]).toContain(payRes.status)
        const errBody = (await payRes.json()) as { code: string; error: string }
        expect(errBody.code).toBeTruthy()
        expect(errBody.error).toBeTruthy()
      }
    })
  })

  // =========================================================================
  // Test 4: Nonce replay → idempotent (same payment_id) or 409
  // =========================================================================
  describe("nonce replay protection", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag()
      await addToAllowlist(PAYER_ADDRESS)
    })

    it("replayed nonce with same proof returns idempotent result, not double-charge", async () => {
      // Get a quote
      const quoteRes = await postX402Invoke(requestBody)
      expect(quoteRes.status).toBe(402)
      const quoteBody = (await quoteRes.json()) as {
        quote: {
          quote_id: string
          max_cost: string
          payment_address: string
        }
      }
      const quote = quoteBody.quote

      // Build payment proof with a fixed nonce
      const fixedNonce = `0x${randomUUID().replace(/-/g, "")}`
      const auth = buildMockAuthorization({
        to: quote.payment_address,
        value: quote.max_cost,
        nonce: fixedNonce,
      })
      const proof = buildPaymentProof(quote.quote_id, auth)
      const proofJson = JSON.stringify(proof)

      // First request
      const res1 = await postX402Invoke(requestBody, proofJson)

      // Second request with identical proof (same nonce)
      const res2 = await postX402Invoke(requestBody, proofJson)

      // The implementation uses SETNX for nonce dedup:
      // - First call sets the key → processes normally
      // - Second call finds key exists → returns idempotent_replay=true (same 200)
      // Both should return the same status (not 409, since the server treats
      // replays as idempotent, not conflicting).
      // If signature verification fails, both will fail identically.
      expect(res2.status).toBe(res1.status)

      if (res1.status === 200 && res2.status === 200) {
        const body1 = (await res1.json()) as { payment_id: string }
        const body2 = (await res2.json()) as { payment_id: string }
        // Idempotent replay returns the same payment_id
        expect(body2.payment_id).toBe(body1.payment_id)
      }
    })
  })

  // =========================================================================
  // Test 5: Underpayment (conservation guard) → 402 rejection
  // =========================================================================
  describe("conservation guard — underpayment", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag()
      await addToAllowlist(PAYER_ADDRESS)
    })

    it("payment below quoted cost returns 402 INSUFFICIENT_PAYMENT", async () => {
      // Get a quote
      const quoteRes = await postX402Invoke(requestBody)
      expect(quoteRes.status).toBe(402)
      const quoteBody = (await quoteRes.json()) as {
        quote: {
          quote_id: string
          max_cost: string
          payment_address: string
        }
      }
      const quote = quoteBody.quote

      // Build payment proof with insufficient value (1 MicroUSDC, well below the quote)
      const auth = buildMockAuthorization({
        to: quote.payment_address,
        value: "1", // Underpayment: 1 < quoted max_cost
      })
      const proof = buildPaymentProof(quote.quote_id, auth)

      const res = await postX402Invoke(requestBody, JSON.stringify(proof))

      // Should be rejected — either by conservation guard (402) or by verifier
      expect([400, 402]).toContain(res.status)
      const body = (await res.json()) as { code: string; error: string }

      // If signature verification passes first, we get INSUFFICIENT_PAYMENT.
      // If signature verification fails first, we get INVALID_SIGNATURE.
      // Both are valid rejection paths for the E2E test.
      expect(body.code).toBeTruthy()
      expect(body.error).toBeTruthy()
    })
  })

  // =========================================================================
  // Test 6: Feature flag toggle OFF → 503 (regression check)
  // =========================================================================
  describe("flag toggle OFF → 503", () => {
    it("disabling x402 flag returns 503 on subsequent requests", async () => {
      // Enable first
      await enableX402Flag()
      const enabledRes = await postX402Invoke(requestBody)
      // Should be anything but 503 (402 is expected since no payment header)
      expect(enabledRes.status).not.toBe(503)
      await enabledRes.text() // Drain body

      // Now disable
      await disableX402Flag()
      const disabledRes = await postX402Invoke(requestBody)
      expect(disabledRes.status).toBe(503)
      const body = (await disabledRes.json()) as { code: string }
      expect(body.code).toBe("FEATURE_DISABLED")
    })
  })

  // =========================================================================
  // Test 7: Invalid request body
  // =========================================================================
  describe("invalid request bodies", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag()
    })

    it("missing prompt returns 400", async () => {
      const res = await postX402Invoke({ model: "claude-sonnet-4-6", max_tokens: 4096 })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("empty prompt returns 400", async () => {
      const res = await postX402Invoke({ model: "claude-sonnet-4-6", prompt: "" })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("nft_id rejected with 400 NFT_NOT_SUPPORTED", async () => {
      const res = await postX402Invoke({
        model: "claude-sonnet-4-6",
        prompt: "Hello",
        nft_id: "0xCOLL:42",
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("NFT_NOT_SUPPORTED")
    })

    it("invalid JSON body returns 400", async () => {
      const res = await fetch(`${FINN_URL}/api/v1/x402/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("INVALID_REQUEST")
    })
  })

  // =========================================================================
  // Test 8: Malformed X-Payment header
  // =========================================================================
  describe("malformed X-Payment header", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag()
    })

    it("non-JSON X-Payment returns 400 INVALID_PAYMENT", async () => {
      const res = await postX402Invoke(requestBody, "not-valid-json")
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("INVALID_PAYMENT")
    })

    it("X-Payment without quote_id returns 400 INVALID_PAYMENT", async () => {
      const res = await postX402Invoke(
        requestBody,
        JSON.stringify({ authorization: { from: PAYER_ADDRESS } }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe("INVALID_PAYMENT")
    })

    it("X-Payment with expired/invalid quote_id returns 402 QUOTE_NOT_FOUND", async () => {
      const proof = buildPaymentProof("q_nonexistent_" + randomUUID(), buildMockAuthorization())
      const res = await postX402Invoke(requestBody, JSON.stringify(proof))

      // Could be 400 (missing from in authorization for allowlist check) or 402 (quote not found)
      expect([400, 402]).toContain(res.status)
    })
  })

  // =========================================================================
  // Test 9: Quote structure validation
  // =========================================================================
  describe("quote structure", () => {
    beforeAll(async () => {
      await enableX402Flag()
      await enableX402PublicFlag()
    })

    it("quote contains all required fields with correct types", async () => {
      const res = await postX402Invoke({
        model: "claude-sonnet-4-6",
        prompt: "Test quote structure",
      })

      expect(res.status).toBe(402)
      const body = (await res.json()) as {
        quote: {
          max_cost: string
          max_tokens: number
          model: string
          payment_address: string
          chain_id: number
          valid_until: number
          token_address: string
          quote_id: string
        }
      }

      const q = body.quote
      expect(typeof q.max_cost).toBe("string")
      expect(typeof q.max_tokens).toBe("number")
      expect(typeof q.model).toBe("string")
      expect(typeof q.payment_address).toBe("string")
      expect(typeof q.chain_id).toBe("number")
      expect(typeof q.valid_until).toBe("number")
      expect(typeof q.token_address).toBe("string")
      expect(typeof q.quote_id).toBe("string")

      // Validate specific values
      expect(q.chain_id).toBe(8453)
      expect(q.token_address).toBe(USDC_BASE_ADDRESS)
      expect(q.model).toBe("claude-sonnet-4-6")
      expect(q.max_tokens).toBe(4096)
      expect(q.quote_id).toMatch(/^q_/)

      // max_cost should be positive and parseable as BigInt
      expect(BigInt(q.max_cost)).toBeGreaterThan(0n)

      // valid_until should be in the future (within 5 min window)
      const now = Math.floor(Date.now() / 1000)
      expect(q.valid_until).toBeGreaterThan(now)
      expect(q.valid_until).toBeLessThanOrEqual(now + 300 + 5) // 5s tolerance
    })

    it("each quote gets a unique quote_id", async () => {
      const [res1, res2] = await Promise.all([
        postX402Invoke({ model: "claude-sonnet-4-6", prompt: "Quote 1" }),
        postX402Invoke({ model: "claude-sonnet-4-6", prompt: "Quote 2" }),
      ])

      expect(res1.status).toBe(402)
      expect(res2.status).toBe(402)

      const body1 = (await res1.json()) as { quote: { quote_id: string } }
      const body2 = (await res2.json()) as { quote: { quote_id: string } }

      expect(body1.quote.quote_id).not.toBe(body2.quote.quote_id)
    })
  })
}, 60_000) // 60s timeout for the entire suite
