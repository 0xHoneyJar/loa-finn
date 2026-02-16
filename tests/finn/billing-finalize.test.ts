// tests/finn/billing-finalize.test.ts — BillingFinalizeClient Tests (Phase 5 T6)

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { BillingFinalizeClient, getDLQEntries, getDLQSize } from "../../src/hounfour/billing-finalize-client.js"
import type { FinalizeRequest, BillingFinalizeConfig } from "../../src/hounfour/billing-finalize-client.js"
import type { S2SJwtSigner } from "../../src/hounfour/s2s-jwt.js"
import http from "node:http"

// --- Test Helpers ---

function createMockSigner(): S2SJwtSigner {
  return {
    signJWT: async () => "mock-jwt-token",
    signJWS: async () => "mock-jws",
    signPayload: async () => "mock-payload",
    getPublicJWK: () => ({ kty: "EC" }),
    getJWKS: () => ({ keys: [{ kty: "EC" }] }),
    isReady: true,
    init: async () => {},
  } as unknown as S2SJwtSigner
}

function createTestRequest(overrides?: Partial<FinalizeRequest>): FinalizeRequest {
  return {
    reservation_id: "res-test-001",
    tenant_id: "tenant-abc",
    actual_cost_micro: "1500000",
    trace_id: "trace-001",
    ...overrides,
  }
}

let mockServer: http.Server | null = null
let serverPort: number = 0

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler)
    mockServer.listen(0, () => {
      const addr = mockServer!.address()
      serverPort = typeof addr === "object" && addr ? addr.port : 0
      resolve(serverPort)
    })
  })
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve())
      mockServer = null
    } else {
      resolve()
    }
  })
}

function createClient(port: number, overrides?: Partial<BillingFinalizeConfig>): BillingFinalizeClient {
  return new BillingFinalizeClient({
    billingUrl: `http://127.0.0.1:${port}/api/internal/billing/finalize`,
    s2sSigner: createMockSigner(),
    timeoutMs: 2000,
    ...overrides,
  })
}

// --- Tests ---

describe("BillingFinalizeClient", () => {
  beforeEach(() => {
    // Clear DLQ between tests
    const entries = getDLQEntries() as Map<string, unknown>
    entries.clear()
  })

  afterEach(async () => {
    await stopMockServer()
  })

  // 1. Success (200)
  it("returns ok:true on 200 success", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "finalized" }))
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest())
    expect(result).toEqual({ ok: true, status: "finalized" })
  })

  // 2. Idempotent success (409)
  it("returns ok:true with idempotent status on 409", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(409, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "already finalized" }))
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest())
    expect(result).toEqual({ ok: true, status: "idempotent" })
  })

  // 3. Schema invalid — negative cost
  it("DLQs on negative cost", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest({ actual_cost_micro: "-500" }))
    expect(result.ok).toBe(false)
    expect(result.status).toBe("dlq")
    expect(getDLQSize()).toBe(1)
  })

  // 4. Schema invalid — non-numeric cost
  it("DLQs on non-numeric cost", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest({ actual_cost_micro: "abc" }))
    expect(result.ok).toBe(false)
    expect(result.status).toBe("dlq")
  })

  // 5. 401 Unauthorized → DLQ terminal
  it("DLQs on 401", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(401)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    expect(result.status).toBe("dlq")
    const entry = getDLQEntries().get("res-test-001")
    expect(entry?.reason).toBe("http_401")
  })

  // 6. 404 Not Found → DLQ terminal
  it("DLQs on 404", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    const entry = getDLQEntries().get("res-test-001")
    expect(entry?.reason).toBe("http_404")
  })

  // 7. 422 Unprocessable → DLQ terminal
  it("DLQs on 422", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(422)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    const entry = getDLQEntries().get("res-test-001")
    expect(entry?.reason).toBe("http_422")
  })

  // 8. 500 Server Error → DLQ retry
  it("DLQs on 500 for retry", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(500)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    const entry = getDLQEntries().get("res-test-001")
    expect(entry?.reason).toBe("http_500")
    expect(entry?.attempt_count).toBe(1)
  })

  // 9. Timeout → DLQ
  it("DLQs on timeout", async () => {
    const port = await startMockServer((_req, _res) => {
      // Never respond — triggers timeout
    })
    const client = createClient(port, { timeoutMs: 100 })
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    const entry = getDLQEntries().get("res-test-001")
    expect(entry?.reason).toBe("timeout")
  })

  // 10. Network error → DLQ
  it("DLQs on network error (no server)", async () => {
    const client = new BillingFinalizeClient({
      billingUrl: "http://127.0.0.1:1/finalize",
      s2sSigner: createMockSigner(),
      timeoutMs: 2000,
    })
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    const entry = getDLQEntries().get("res-test-001")
    expect(entry?.reason).toContain("network_error")
  })

  // 11. Missing reservation_id → DLQ
  it("DLQs on missing reservation_id", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest({ reservation_id: "" }))
    expect(result.ok).toBe(false)
    expect(result.status).toBe("dlq")
  })

  // 12. Large BigInt round-trip (>2^53)
  it("handles BigInt >2^53 correctly", async () => {
    let receivedBody = ""
    const port = await startMockServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => { body += chunk.toString() })
      req.on("end", () => {
        receivedBody = body
        res.writeHead(200)
        res.end()
      })
    })
    const client = createClient(port)
    const largeCost = "9007199254740993" // 2^53 + 1
    const result = await client.finalize(createTestRequest({ actual_cost_micro: largeCost }))
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(receivedBody)
    expect(parsed.actual_cost_micro).toBe(largeCost) // String preserved, no precision loss
  })

  // 13. DLQ replay success
  it("replays DLQ entry successfully", async () => {
    let callCount = 0
    const port = await startMockServer((_req, res) => {
      callCount++
      if (callCount === 1) {
        res.writeHead(500)
        res.end()
      } else {
        res.writeHead(200)
        res.end()
      }
    })
    const client = createClient(port)

    // First call fails → DLQ
    await client.finalize(createTestRequest())
    expect(getDLQSize()).toBe(1)

    // Force next_attempt_at to now
    const entry = getDLQEntries().get("res-test-001")!
    entry.next_attempt_at = new Date(0).toISOString()

    // Replay succeeds → removed from DLQ
    const result = await client.replayDeadLetters()
    expect(result.succeeded).toBe(1)
    expect(getDLQSize()).toBe(0)
  })

  // 14. DLQ replay 409 removes entry (idempotent)
  it("DLQ replay treats 409 as success and removes entry", async () => {
    let callCount = 0
    const port = await startMockServer((_req, res) => {
      callCount++
      if (callCount === 1) {
        res.writeHead(500)
        res.end()
      } else {
        res.writeHead(409) // Already finalized
        res.end()
      }
    })
    const client = createClient(port)

    await client.finalize(createTestRequest())
    expect(getDLQSize()).toBe(1)

    const entry = getDLQEntries().get("res-test-001")!
    entry.next_attempt_at = new Date(0).toISOString()

    const result = await client.replayDeadLetters()
    expect(result.succeeded).toBe(1)
    expect(getDLQSize()).toBe(0)
  })

  // 15. DLQ replay failure reschedules
  it("DLQ replay failure increments attempt and reschedules", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(500)
      res.end()
    })
    const client = createClient(port)

    await client.finalize(createTestRequest())
    const entry = getDLQEntries().get("res-test-001")!
    entry.next_attempt_at = new Date(0).toISOString()
    const oldAttempt = entry.attempt_count

    await client.replayDeadLetters()
    const updated = getDLQEntries().get("res-test-001")!
    expect(updated.attempt_count).toBe(oldAttempt + 1)
    expect(new Date(updated.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
  })

  // 16. Terminal drop — max retries exhausted
  it("drops DLQ entry after max retries", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(500)
      res.end()
    })
    const client = createClient(port, { maxRetries: 2 })

    await client.finalize(createTestRequest())
    const entry = getDLQEntries().get("res-test-001")!
    entry.attempt_count = 2 // At max
    entry.next_attempt_at = new Date(0).toISOString()

    await client.replayDeadLetters()
    expect(getDLQSize()).toBe(0) // Dropped
  })

  // 17. finalize internal throw returns {ok: false}
  it("catches internal errors and returns ok:false", async () => {
    const brokenSigner = {
      ...createMockSigner(),
      signJWT: async () => { throw new Error("signing failed") },
    } as unknown as S2SJwtSigner

    const client = new BillingFinalizeClient({
      billingUrl: "http://127.0.0.1:1/finalize",
      s2sSigner: brokenSigner,
      timeoutMs: 1000,
    })
    const result = await client.finalize(createTestRequest())
    expect(result.ok).toBe(false)
    expect(result.status).toBe("dlq")
  })

  // 18. S2S JWT claims check
  it("includes correct claims in S2S JWT", async () => {
    let signedClaims: Record<string, unknown> = {}
    const spySigner = {
      ...createMockSigner(),
      signJWT: async (claims: Record<string, unknown>) => {
        signedClaims = claims
        return "mock-jwt"
      },
    } as unknown as S2SJwtSigner

    const port = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    const client = new BillingFinalizeClient({
      billingUrl: `http://127.0.0.1:${port}/finalize`,
      s2sSigner: spySigner,
      timeoutMs: 2000,
    })
    await client.finalize(createTestRequest())

    expect(signedClaims.sub).toBe("tenant-abc")
    expect(signedClaims.purpose).toBe("billing_finalize")
    expect(signedClaims.reservation_id).toBe("res-test-001")
    expect(signedClaims.trace_id).toBe("trace-001")
  })

  // 19. cost_micro validation — zero is valid
  it("accepts zero cost", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest({ actual_cost_micro: "0" }))
    expect(result.ok).toBe(true)
  })

  // 20. cost_micro validation — decimal rejected
  it("rejects decimal cost", async () => {
    const port = await startMockServer((_req, res) => {
      res.writeHead(200)
      res.end()
    })
    const client = createClient(port)
    const result = await client.finalize(createTestRequest({ actual_cost_micro: "1.5" }))
    expect(result.ok).toBe(false)
  })
})
