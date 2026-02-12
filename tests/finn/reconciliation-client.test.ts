// tests/finn/reconciliation-client.test.ts — Reconciliation Client tests (Task 2.9)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import {
  ReconciliationClient,
  type ReconState,
} from "../../src/hounfour/reconciliation-client.js"
import { ArrakisMockServer, createTestMockServer } from "../mocks/arrakis-mock-server.js"

// --- Setup ---

let mockServer: ArrakisMockServer
let baseUrl: string

function makeTestJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "s2s-1" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    iss: "loa-finn", aud: "arrakis", sub: "s2s",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  })).toString("base64url")
  const sig = Buffer.from("mock").toString("base64url")
  return `${header}.${payload}.${sig}`
}

function makeClient(overrides: Record<string, unknown> = {}): ReconciliationClient {
  return new ReconciliationClient({
    arrakisBaseUrl: baseUrl,
    getS2sToken: async () => makeTestJwt(),
    pollIntervalMs: 100,
    driftThresholdMicro: 1000n,
    failOpenHeadroomPercent: 10,
    failOpenMaxDurationMs: 5000,
    failOpenAbsCapMicro: 10_000_000n,
    failOpenMaxRps: 10,
    requestTimeoutMs: 3000,
    ...overrides,
  })
}

beforeAll(async () => {
  mockServer = createTestMockServer()
  const port = await mockServer.start()
  baseUrl = `http://localhost:${port}`
})

afterAll(async () => {
  await mockServer.stop()
})

beforeEach(() => {
  mockServer.clearFailureModes()
  mockServer.clearRequestLog()
  // Reset default budgets
  mockServer.setTenantBudget("tenant-abc", {
    committed_micro: "500000",
    reserved_micro: "100000",
    limit_micro: "10000000",
    window_start: new Date().toISOString(),
    window_end: new Date(Date.now() + 86400000).toISOString(),
  })
})

// --- Tests ---

describe("initial state", () => {
  it("starts in SYNCED state", () => {
    const client = makeClient()
    expect(client.getState().status).toBe("SYNCED")
  })

  it("initial counters are zero", () => {
    const client = makeClient()
    const state = client.getState()
    expect(state.localSpendMicro).toBe(0n)
    expect(state.arrakisCommittedMicro).toBe(0n)
    expect(state.consecutiveFailures).toBe(0)
  })
})

describe("successful poll", () => {
  it("stays SYNCED when no drift", async () => {
    const client = makeClient()
    // Set local spend to match arrakis committed (500000)
    client.recordLocalSpend(500000n)

    const result = await client.poll("tenant-abc")

    expect(result.arrakisReachable).toBe(true)
    expect(result.newState).toBe("SYNCED")
    expect(result.driftExceedsThreshold).toBe(false)
  })

  it("updates arrakisCommittedMicro from response", async () => {
    const client = makeClient()
    await client.poll("tenant-abc")

    expect(client.getState().arrakisCommittedMicro).toBe(500000n)
  })

  it("returns to SYNCED from FAIL_OPEN on successful poll", async () => {
    const client = makeClient()

    // Force into FAIL_OPEN by simulating failure
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")
    expect(client.getState().status).toBe("FAIL_OPEN")

    // Clear failure and reconcile
    mockServer.clearFailureModes()
    // Set local spend to match arrakis
    client.recordLocalSpend(500000n)
    await client.poll("tenant-abc")

    expect(client.getState().status).toBe("SYNCED")
  })

  it("resets consecutive failures on success", async () => {
    const client = makeClient()

    // Fail once
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")
    expect(client.getState().consecutiveFailures).toBe(1)

    // Succeed
    mockServer.clearFailureModes()
    client.recordLocalSpend(500000n)
    await client.poll("tenant-abc")
    expect(client.getState().consecutiveFailures).toBe(0)
  })
})

describe("SYNCED → FAIL_OPEN transitions", () => {
  it("transitions on arrakis unreachable", async () => {
    const client = makeClient()
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })

    const result = await client.poll("tenant-abc")

    expect(result.previousState).toBe("SYNCED")
    expect(result.newState).toBe("FAIL_OPEN")
    expect(result.arrakisReachable).toBe(false)
  })

  it("transitions on drift exceeding threshold", async () => {
    const client = makeClient({ driftThresholdMicro: 100n })
    // Local says 1000000, arrakis says 500000 → drift = 500000
    client.recordLocalSpend(1000000n)

    const result = await client.poll("tenant-abc")

    expect(result.driftExceedsThreshold).toBe(true)
    expect(result.newState).toBe("FAIL_OPEN")
  })

  it("sets headroom on transition to FAIL_OPEN", async () => {
    const client = makeClient({ failOpenHeadroomPercent: 10 })
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })

    await client.poll("tenant-abc")
    const state = client.getState()

    // Headroom = min(10% of limit, absCap) = min(1000000, 10000000) = 1000000
    // But since arrakis is unreachable, it falls back to absCap
    expect(state.failOpenBudgetRemaining).toBe(10_000_000n)
    expect(state.failOpenStartedAt).not.toBeNull()
  })

  it("fires onStateChange callback", async () => {
    const client = makeClient()
    const transitions: Array<{ from: ReconState; to: ReconState; reason: string }> = []
    client.onStateChange = (from, to, reason) => transitions.push({ from, to, reason })

    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")

    expect(transitions).toHaveLength(1)
    expect(transitions[0].from).toBe("SYNCED")
    expect(transitions[0].to).toBe("FAIL_OPEN")
  })
})

describe("FAIL_OPEN behavior", () => {
  it("allows requests while headroom > 0", () => {
    const client = makeClient()
    // Manually force FAIL_OPEN state by triggering poll failure
    // We'll use the poll method
    return (async () => {
      mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
      await client.poll("tenant-abc")
      expect(client.getState().status).toBe("FAIL_OPEN")

      expect(client.shouldAllowRequest()).toBe(true)
    })()
  })

  it("monotonic headroom decrement via recordLocalSpend", async () => {
    const client = makeClient()
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")

    const initialHeadroom = client.getState().failOpenBudgetRemaining

    client.recordLocalSpend(1000n)
    expect(client.getState().failOpenBudgetRemaining).toBe(initialHeadroom - 1000n)

    client.recordLocalSpend(2000n)
    expect(client.getState().failOpenBudgetRemaining).toBe(initialHeadroom - 3000n)
  })

  it("transitions to FAIL_CLOSED when headroom exhausted", async () => {
    const client = makeClient({ failOpenAbsCapMicro: 5000n })
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")

    expect(client.getState().status).toBe("FAIL_OPEN")

    // Exhaust headroom
    client.recordLocalSpend(5001n)

    expect(client.getState().status).toBe("FAIL_CLOSED")
  })

  it("transitions to FAIL_CLOSED on timeout", async () => {
    const client = makeClient({ failOpenMaxDurationMs: 50 })
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")

    expect(client.getState().status).toBe("FAIL_OPEN")

    // Wait for timeout
    await new Promise(r => setTimeout(r, 60))

    // shouldAllowRequest checks timeout
    expect(client.shouldAllowRequest()).toBe(false)
    expect(client.getState().status).toBe("FAIL_CLOSED")
  })
})

describe("FAIL_CLOSED behavior", () => {
  it("denies all requests", async () => {
    const client = makeClient({ failOpenAbsCapMicro: 1n })
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")

    // Exhaust headroom immediately
    client.recordLocalSpend(2n)
    expect(client.getState().status).toBe("FAIL_CLOSED")

    expect(client.shouldAllowRequest()).toBe(false)
  })

  it("recovers to SYNCED on successful reconciliation", async () => {
    const client = makeClient({ failOpenAbsCapMicro: 1n })

    // Force into FAIL_CLOSED
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")
    client.recordLocalSpend(2n)
    expect(client.getState().status).toBe("FAIL_CLOSED")

    // Successful poll recovers
    mockServer.clearFailureModes()
    // Match local spend to arrakis committed
    mockServer.setTenantBudget("tenant-abc", {
      committed_micro: "2",
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-abc")

    expect(client.getState().status).toBe("SYNCED")
    expect(client.shouldAllowRequest()).toBe(true)
  })
})

describe("drift detection", () => {
  it("detects drift between local and arrakis", async () => {
    const client = makeClient({ driftThresholdMicro: 100n })
    // Local: 1000000, arrakis: 500000 → drift = 500000
    client.recordLocalSpend(1000000n)

    const result = await client.poll("tenant-abc")

    expect(result.driftMicro).toBe(500000n)
    expect(result.driftExceedsThreshold).toBe(true)
  })

  it("no drift when values match", async () => {
    const client = makeClient()
    client.recordLocalSpend(500000n) // Match arrakis committed

    const result = await client.poll("tenant-abc")

    expect(result.driftMicro).toBe(0n)
    expect(result.driftExceedsThreshold).toBe(false)
  })

  it("handles injected drift from mock", async () => {
    const client = makeClient({ driftThresholdMicro: 10n })
    client.recordLocalSpend(500000n)

    // Inject drift via mock
    mockServer.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "drift",
      driftMicro: "999999",
    })

    const result = await client.poll("tenant-abc")

    // Local: 500000, arrakis: 999999 → drift = 499999
    expect(result.driftMicro).toBe(499999n)
    expect(result.driftExceedsThreshold).toBe(true)
  })
})

describe("polling lifecycle", () => {
  it("startPolling/stopPolling controls timer", async () => {
    const client = makeClient({ pollIntervalMs: 50 })
    client.recordLocalSpend(500000n)

    client.startPolling("tenant-abc")

    // Wait for a couple polls
    await new Promise(r => setTimeout(r, 150))
    client.stopPolling()

    // Should have made some requests
    const requests = mockServer.requestLog.filter(r =>
      r.path.includes("/api/v1/budget/")
    )
    expect(requests.length).toBeGreaterThanOrEqual(1)
  })

  it("double startPolling is idempotent", () => {
    const client = makeClient()
    client.startPolling("tenant-abc")
    client.startPolling("tenant-abc") // Should not create second timer
    client.stopPolling()
  })
})

describe("state machine flapping resilience", () => {
  it("SYNCED → FAIL_OPEN → SYNCED cycle works correctly", async () => {
    const client = makeClient({ driftThresholdMicro: 100n })
    const transitions: string[] = []
    client.onStateChange = (from, to) => transitions.push(`${from}→${to}`)

    // Start SYNCED, matching local spend
    client.recordLocalSpend(500000n)
    await client.poll("tenant-abc")
    expect(client.getState().status).toBe("SYNCED")

    // Cause drift → FAIL_OPEN
    client.recordLocalSpend(1000000n) // Now local = 1500000, arrakis = 500000
    await client.poll("tenant-abc")
    expect(client.getState().status).toBe("FAIL_OPEN")

    // Fix arrakis to match → SYNCED
    mockServer.setTenantBudget("tenant-abc", {
      committed_micro: "1500000",
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-abc")
    expect(client.getState().status).toBe("SYNCED")

    expect(transitions).toEqual(["SYNCED→FAIL_OPEN", "FAIL_OPEN→SYNCED"])
  })

  it("SYNCED → FAIL_OPEN → FAIL_CLOSED → SYNCED full cycle", async () => {
    const client = makeClient({
      failOpenAbsCapMicro: 1000n,
      driftThresholdMicro: 100n,
    })
    const transitions: string[] = []
    client.onStateChange = (from, to) => transitions.push(`${from}→${to}`)

    // Cause FAIL_OPEN via unreachable
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-abc")
    expect(client.getState().status).toBe("FAIL_OPEN")

    // Exhaust headroom → FAIL_CLOSED
    client.recordLocalSpend(1001n)
    expect(client.getState().status).toBe("FAIL_CLOSED")

    // Recover → SYNCED
    mockServer.clearFailureModes()
    mockServer.setTenantBudget("tenant-abc", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-abc")
    expect(client.getState().status).toBe("SYNCED")

    expect(transitions).toEqual([
      "SYNCED→FAIL_OPEN",
      "FAIL_OPEN→FAIL_CLOSED",
      "FAIL_CLOSED→SYNCED",
    ])
  })
})
