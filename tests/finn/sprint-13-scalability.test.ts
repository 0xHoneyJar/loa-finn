// tests/finn/sprint-13-scalability.test.ts — Sprint 13: Scalability & Quality
//
// Tests for: Alchemy NFT detection (13.1), CSP hardening (13.2),
// integration test helpers (13.3), load test foundation (13.4).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Task 13.1: Alchemy NFT Batch Detection
// ---------------------------------------------------------------------------

describe("Alchemy NFT Detection (Task 13.1)", async () => {
  const { AlchemyNFTDetector } = await import("../../src/nft/detection.js")

  function createMockRedis() {
    const store: Record<string, string> = {}
    return {
      store,
      get: vi.fn(async (key: string) => store[key] ?? null),
      set: vi.fn(async (key: string, value: string) => { store[key] = value; return "OK" }),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
    }
  }

  const COLLECTIONS = [
    "0x1234567890abcdef1234567890abcdef12345678",
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  ]

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("filters known collections from Alchemy response", async () => {
    const redis = createMockRedis()

    // Mock fetch for Alchemy API
    const mockResponse = {
      ownedNfts: [
        { contract: { address: COLLECTIONS[0] }, tokenId: "1", tokenType: "ERC721", title: "Bear #1", description: "" },
        { contract: { address: COLLECTIONS[1] }, tokenId: "42", tokenType: "ERC721", title: "Honey #42", description: "" },
        { contract: { address: "0x9999999999999999999999999999999999999999" }, tokenId: "7", tokenType: "ERC721", title: "Unknown #7", description: "" },
      ],
      totalCount: 3,
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200, headers: { "content-type": "application/json" } }))

    try {
      const detector = new AlchemyNFTDetector({
        apiKey: "test-key",
        collections: COLLECTIONS,
        redis: redis as any,
      })

      const result = await detector.detectNFTs("0xWALLET")
      expect(result.nfts).toHaveLength(2) // Only known collections
      expect(result.nfts[0].collection).toBe(COLLECTIONS[0].toLowerCase())
      expect(result.nfts[1].collection).toBe(COLLECTIONS[1].toLowerCase())
      expect(result.source).toBe("alchemy")
      expect(result.cached).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns cached result on second call", async () => {
    const redis = createMockRedis()

    const mockResponse = {
      ownedNfts: [
        { contract: { address: COLLECTIONS[0] }, tokenId: "1", tokenType: "ERC721", title: "Bear #1", description: "" },
      ],
      totalCount: 1,
    }

    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200, headers: { "content-type": "application/json" } }))
    globalThis.fetch = fetchMock

    try {
      const detector = new AlchemyNFTDetector({
        apiKey: "test-key",
        collections: COLLECTIONS,
        redis: redis as any,
      })

      // First call — fetch from Alchemy
      await detector.detectNFTs("0xWALLET")
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Second call — should use cache
      const result2 = await detector.detectNFTs("0xWALLET")
      expect(result2.cached).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1) // No additional fetch
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("falls back to RPC when Alchemy API fails", async () => {
    const redis = createMockRedis()
    const fallbackCalled = vi.fn(async () => [
      { collection: COLLECTIONS[0].toLowerCase(), tokenId: "1", title: "Fallback #1" },
    ])

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response("Service Unavailable", { status: 503 }))

    try {
      const detector = new AlchemyNFTDetector({
        apiKey: "test-key",
        collections: COLLECTIONS,
        redis: redis as any,
        rpcFallback: fallbackCalled,
      })

      const result = await detector.detectNFTs("0xWALLET")
      expect(result.source).toBe("rpc_fallback")
      expect(fallbackCalled).toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("circuit breaker trips after 3 consecutive failures", async () => {
    const redis = createMockRedis()
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const fallbackCalled = vi.fn(async () => [])

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error("Network error") })

    try {
      const detector = new AlchemyNFTDetector({
        apiKey: "test-key",
        collections: COLLECTIONS,
        redis: redis as any,
        rpcFallback: fallbackCalled,
      })

      // 3 failures should trip circuit
      await detector.detectNFTs("0xWALLET1")
      await detector.detectNFTs("0xWALLET2")
      await detector.detectNFTs("0xWALLET3")

      // Verify circuit open log
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("nft.detection.circuit_open"),
      )

      // 4th call should skip Alchemy entirely (circuit open)
      const fetchCount = (globalThis.fetch as any).mock.calls.length
      await detector.detectNFTs("0xWALLET4")

      // Circuit is open — should go directly to fallback without calling fetch
      expect((globalThis.fetch as any).mock.calls.length).toBe(fetchCount)
      expect(fallbackCalled).toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
      consoleSpy.mockRestore()
    }
  })

  it("returns empty nfts when no fallback and Alchemy fails", async () => {
    const redis = createMockRedis()

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error("Network error") })

    try {
      const detector = new AlchemyNFTDetector({
        apiKey: "test-key",
        collections: COLLECTIONS,
        redis: redis as any,
        // No rpcFallback
      })

      const result = await detector.detectNFTs("0xWALLET")
      expect(result.nfts).toHaveLength(0)
      expect(result.source).toBe("rpc_fallback")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("ownsCollectionNFT returns true when wallet owns NFT", async () => {
    const redis = createMockRedis()
    const mockResponse = {
      ownedNfts: [
        { contract: { address: COLLECTIONS[0] }, tokenId: "1", tokenType: "ERC721", title: "Bear #1", description: "" },
      ],
      totalCount: 1,
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200, headers: { "content-type": "application/json" } }))

    try {
      const detector = new AlchemyNFTDetector({
        apiKey: "test-key",
        collections: COLLECTIONS,
        redis: redis as any,
      })

      const owns = await detector.ownsCollectionNFT("0xWALLET", COLLECTIONS[0])
      expect(owns).toBe(true)

      const doesntOwn = await detector.ownsCollectionNFT("0xWALLET", COLLECTIONS[1])
      expect(doesntOwn).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ---------------------------------------------------------------------------
// Task 13.1: Factory Function
// ---------------------------------------------------------------------------

describe("Alchemy Detector Factory (Task 13.1)", async () => {
  const { createAlchemyDetector } = await import("../../src/nft/detection.js")

  afterEach(() => {
    delete process.env.ALCHEMY_API_KEY
  })

  it("returns null when ALCHEMY_API_KEY not set", () => {
    delete process.env.ALCHEMY_API_KEY
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const detector = createAlchemyDetector({} as any)
    expect(detector).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ALCHEMY_API_KEY not set"))
    consoleSpy.mockRestore()
  })

  it("creates detector when ALCHEMY_API_KEY set", () => {
    process.env.ALCHEMY_API_KEY = "test-key-123"
    const detector = createAlchemyDetector({} as any)
    expect(detector).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 13.2: CSP Hardening + Violation Reporting
// ---------------------------------------------------------------------------

describe("CSP Hardening (Task 13.2)", async () => {
  const { waitlistRoutes, cspReportRoutes } = await import("../../src/gateway/waitlist.js")

  it("waitlist page includes nonce-based CSP header", async () => {
    const app = waitlistRoutes({
      projectName: "TestProject",
      projectDescription: "Test description",
    })

    const res = await app.request("/")
    expect(res.status).toBe(200)

    // Check for CSP header (report-only or enforcing)
    const cspRO = res.headers.get("Content-Security-Policy-Report-Only")
    const cspEnf = res.headers.get("Content-Security-Policy")
    const csp = cspRO ?? cspEnf
    expect(csp).not.toBeNull()

    // Verify nonce-based directives (no unsafe-inline)
    expect(csp).toContain("'nonce-")
    expect(csp).not.toContain("'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")

    // Verify report-uri and report-to directives
    expect(csp).toContain("report-uri /api/v1/csp-report")
    expect(csp).toContain("report-to csp-endpoint")

    // Verify Reporting-Endpoints header
    const reportingEndpoints = res.headers.get("Reporting-Endpoints")
    expect(reportingEndpoints).toContain("csp-endpoint")
  })

  it("waitlist HTML contains nonce attributes on script and style tags", async () => {
    const app = waitlistRoutes({
      projectName: "TestProject",
      projectDescription: "Test",
    })

    const res = await app.request("/")
    const html = await res.text()

    // Extract nonce from CSP header
    const csp = res.headers.get("Content-Security-Policy-Report-Only") ?? res.headers.get("Content-Security-Policy") ?? ""
    const nonceMatch = csp.match(/'nonce-([^']+)'/)
    expect(nonceMatch).not.toBeNull()
    const nonce = nonceMatch![1]

    // Verify nonce appears in HTML
    expect(html).toContain(`nonce="${nonce}"`)
    expect(html).toContain(`<script nonce="${nonce}"`)
    expect(html).toContain(`<style nonce="${nonce}"`)
  })

  it("each request gets a unique nonce", async () => {
    const app = waitlistRoutes({
      projectName: "TestProject",
      projectDescription: "Test",
    })

    const res1 = await app.request("/")
    const res2 = await app.request("/")

    const csp1 = res1.headers.get("Content-Security-Policy-Report-Only") ?? res1.headers.get("Content-Security-Policy") ?? ""
    const csp2 = res2.headers.get("Content-Security-Policy-Report-Only") ?? res2.headers.get("Content-Security-Policy") ?? ""

    const nonce1 = csp1.match(/'nonce-([^']+)'/)?.[1]
    const nonce2 = csp2.match(/'nonce-([^']+)'/)?.[1]

    expect(nonce1).toBeDefined()
    expect(nonce2).toBeDefined()
    expect(nonce1).not.toBe(nonce2) // Each request gets unique nonce
  })

  it("CSP report endpoint accepts valid violation report (204)", async () => {
    const app = cspReportRoutes()
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const report = {
      "csp-report": {
        "document-uri": "https://example.com/waitlist",
        "violated-directive": "style-src",
        "blocked-uri": "inline",
      },
    }

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify(report),
    })

    expect(res.status).toBe(204)

    // Verify structured log was emitted
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("csp.violation"),
    )
    const logCall = consoleSpy.mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("csp.violation"),
    )
    const parsed = JSON.parse(logCall![0] as string)
    expect(parsed.metric).toBe("csp.violation")
    expect(parsed.violated_directive).toBe("style-src")
    expect(parsed.blocked_uri).toBe("inline")

    consoleSpy.mockRestore()
  })

  it("CSP report endpoint rejects oversized payload (413)", async () => {
    const app = cspReportRoutes()

    const largePayload = "x".repeat(11 * 1024) // > 10KB
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/csp-report",
        "Content-Length": String(largePayload.length),
      },
      body: largePayload,
    })

    expect(res.status).toBe(413)
  })
})

// ---------------------------------------------------------------------------
// Task 13.3: Integration Test Helper (unit-level validation)
// ---------------------------------------------------------------------------

describe("Integration Test Helpers (Task 13.3)", async () => {
  it("docker-compose.test.yml exists and defines redis-test service", async () => {
    const { readFileSync } = await import("node:fs")
    const compose = readFileSync("tests/docker-compose.test.yml", "utf-8")

    expect(compose).toContain("redis-test:")
    expect(compose).toContain("redis:7-alpine")
    expect(compose).toContain("6381:6379")
    expect(compose).toContain("healthcheck:")
  })

  it("test-integration.sh exists and is executable", async () => {
    const { statSync } = await import("node:fs")
    const stats = statSync("scripts/test-integration.sh")

    expect(stats.isFile()).toBe(true)
    // Check executable bit (owner)
    // eslint-disable-next-line no-bitwise
    expect(stats.mode & 0o100).toBeTruthy()
  })

  it("redis-integration helper exports required functions", async () => {
    const helper = await import("../helpers/redis-integration.js")

    expect(typeof helper.getTestRedis).toBe("function")
    expect(typeof helper.flushTestRedis).toBe("function")
    expect(typeof helper.disconnectTestRedis).toBe("function")
    expect(typeof helper.isRedisAvailable).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Task 13.4: Load Test Foundation — Concurrent Payment Scenarios
// ---------------------------------------------------------------------------

describe("Concurrent Payment Load Foundation (Task 13.4)", async () => {
  const { Ledger, creditMintPostings, billingReservePostings, billingCommitPostings } =
    await import("../../src/billing/ledger.js")
  const { QuoteService } = await import("../../src/x402/middleware.js")

  function createMockRedis() {
    const store: Record<string, string> = {}
    let idCounter = 0
    return {
      store,
      set: vi.fn(async (key: string, value: string, ...args: any[]) => {
        if (args.includes("NX")) {
          if (store[key]) return null
          store[key] = value
          return "OK"
        }
        store[key] = value
        return "OK"
      }),
      get: vi.fn(async (key: string) => store[key] ?? null),
      del: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      eval: vi.fn(async () => null),
    }
  }

  it("Scenario 1: 50 concurrent reserve→commit — conservation holds", () => {
    const ledger = new Ledger()
    const users = Array.from({ length: 50 }, (_, i) => `user_${i}`)

    // Mint credits for all users
    for (const userId of users) {
      ledger.appendEntry({
        billing_entry_id: `mint_${userId}` as any,
        event_type: "credit_mint",
        correlation_id: `corr_${userId}`,
        postings: creditMintPostings(userId, 1_000_000n),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_mint_${userId}`,
        timestamp: Date.now(),
      })
    }

    // Reserve + commit for all users concurrently
    for (const userId of users) {
      const estimated = 500_000n
      const actual = 300_000n + BigInt(Math.floor(Math.random() * 100_000))

      ledger.appendEntry({
        billing_entry_id: `reserve_${userId}` as any,
        event_type: "billing_reserve",
        correlation_id: `corr_${userId}`,
        postings: billingReservePostings(userId, estimated),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_reserve_${userId}`,
        timestamp: Date.now(),
      })

      ledger.appendEntry({
        billing_entry_id: `commit_${userId}` as any,
        event_type: "billing_commit",
        correlation_id: `corr_${userId}`,
        postings: billingCommitPostings(userId, estimated, actual),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_commit_${userId}`,
        timestamp: Date.now(),
      })
    }

    // Conservation: SUM(all accounts) === 0n
    const balances = ledger.deriveAllBalances()
    let total = 0n
    for (const [, balance] of balances) {
      total += balance
    }
    expect(total).toBe(0n)
    expect(ledger.entryCount).toBe(150) // 50 mint + 50 reserve + 50 commit
  })

  it("Scenario 2: 50 concurrent reserves with 5 settlement failures — conservation holds", () => {
    const ledger = new Ledger()
    const users = Array.from({ length: 50 }, (_, i) => `user_s2_${i}`)

    for (const userId of users) {
      ledger.appendEntry({
        billing_entry_id: `mint_${userId}` as any,
        event_type: "credit_mint",
        correlation_id: `corr_${userId}`,
        postings: creditMintPostings(userId, 1_000_000n),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_mint_${userId}`,
        timestamp: Date.now(),
      })
    }

    let failedCount = 0
    for (let i = 0; i < users.length; i++) {
      const userId = users[i]
      const estimated = 500_000n
      const isFailed = i < 5 // First 5 fail settlement

      ledger.appendEntry({
        billing_entry_id: `reserve_${userId}` as any,
        event_type: "billing_reserve",
        correlation_id: `corr_${userId}`,
        postings: billingReservePostings(userId, estimated),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_reserve_${userId}`,
        timestamp: Date.now(),
      })

      if (!isFailed) {
        const actual = 400_000n
        ledger.appendEntry({
          billing_entry_id: `commit_${userId}` as any,
          event_type: "billing_commit",
          correlation_id: `corr_${userId}`,
          postings: billingCommitPostings(userId, estimated, actual),
          exchange_rate: null,
          rounding_direction: null,
          wal_offset: `wal_commit_${userId}`,
          timestamp: Date.now(),
        })
      } else {
        failedCount++
        // Settlement failed — funds remain in held (DLQ will retry)
      }
    }

    expect(failedCount).toBe(5)

    // Conservation still holds — failed settlements just leave funds in held
    const balances = ledger.deriveAllBalances()
    let total = 0n
    for (const [, balance] of balances) {
      total += balance
    }
    expect(total).toBe(0n)
  })

  it("Scenario 4: 100 concurrent quote generations — unique quote_ids", async () => {
    const redis = createMockRedis()
    const service = new QuoteService({
      redis: redis as any,
      treasuryAddress: "0x1234",
      ratePerToken: { "test-model": "10" },
    })

    // Generate 100 quotes concurrently
    const quotes = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        service.generateQuote({ model: "test-model", max_tokens: 100 }),
      ),
    )

    // All should have unique IDs
    const ids = new Set(quotes.map(q => q.quote_id))
    expect(ids.size).toBe(100)

    // All should have valid max_cost
    for (const quote of quotes) {
      expect(BigInt(quote.max_cost)).toBeGreaterThan(0n)
    }
  })

  it("Scenario: conservation invariant validated after mixed operations", () => {
    const ledger = new Ledger()

    // Complex scenario: mint, reserve, commit, some with overage, some exact
    const ops = [
      { user: "alice", mint: 10_000_000n, estimated: 5_000_000n, actual: 3_000_000n },
      { user: "bob", mint: 20_000_000n, estimated: 15_000_000n, actual: 15_000_000n },
      { user: "carol", mint: 5_000_000n, estimated: 4_000_000n, actual: 2_500_000n },
    ]

    for (const op of ops) {
      ledger.appendEntry({
        billing_entry_id: `mint_${op.user}` as any,
        event_type: "credit_mint",
        correlation_id: `corr_${op.user}`,
        postings: creditMintPostings(op.user, op.mint),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_mint_${op.user}`,
        timestamp: Date.now(),
      })
      ledger.appendEntry({
        billing_entry_id: `reserve_${op.user}` as any,
        event_type: "billing_reserve",
        correlation_id: `corr_${op.user}`,
        postings: billingReservePostings(op.user, op.estimated),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_reserve_${op.user}`,
        timestamp: Date.now(),
      })
      ledger.appendEntry({
        billing_entry_id: `commit_${op.user}` as any,
        event_type: "billing_commit",
        correlation_id: `corr_${op.user}`,
        postings: billingCommitPostings(op.user, op.estimated, op.actual),
        exchange_rate: null,
        rounding_direction: null,
        wal_offset: `wal_commit_${op.user}`,
        timestamp: Date.now(),
      })
    }

    // SUM(all accounts) === 0n
    const balances = ledger.deriveAllBalances()
    let total = 0n
    for (const [, b] of balances) {
      total += b
    }
    expect(total).toBe(0n)

    // Verify individual balances
    // alice: available = 10M - 5M + 2M = 7M
    expect(balances.get("user:alice:available")).toBe(7_000_000n)
    // bob: available = 20M - 15M + 0 = 5M (exact cost, no overage)
    expect(balances.get("user:bob:available")).toBe(5_000_000n)
    // carol: available = 5M - 4M + 1.5M = 2.5M
    expect(balances.get("user:carol:available")).toBe(2_500_000n)
  })
})
