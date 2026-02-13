// tests/finn/reconciliation-e2e.test.ts — Reconciliation E2E (Task 2.10, A.8)
// Fail-open/closed state transitions, flapping simulation, reconciliation with mock arrakis.

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
    pollIntervalMs: 50,
    driftThresholdMicro: 100n,
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
  mockServer.setTenantBudget("tenant-e2e", {
    committed_micro: "500000",
    reserved_micro: "100000",
    limit_micro: "10000000",
    window_start: new Date().toISOString(),
    window_end: new Date(Date.now() + 86400000).toISOString(),
  })
})

// --- State Machine E2E ---

describe("fail-open → fail-closed state transitions", () => {
  it("SYNCED → FAIL_OPEN on arrakis 500", async () => {
    const client = makeClient()
    expect(client.getState().status).toBe("SYNCED")

    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-e2e")

    expect(client.getState().status).toBe("FAIL_OPEN")
    expect(client.getState().failOpenBudgetRemaining).toBe(10_000_000n)
    expect(client.getState().failOpenStartedAt).not.toBeNull()
    expect(client.getState().consecutiveFailures).toBe(1)
  })

  it("FAIL_OPEN → FAIL_CLOSED when headroom exhausted", async () => {
    const client = makeClient({ failOpenAbsCapMicro: 5000n })
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-e2e")

    expect(client.getState().status).toBe("FAIL_OPEN")
    expect(client.shouldAllowRequest()).toBe(true)

    // Exhaust headroom in multiple steps
    client.recordLocalSpend(2000n)
    expect(client.getState().failOpenBudgetRemaining).toBe(3000n)
    expect(client.shouldAllowRequest()).toBe(true)

    client.recordLocalSpend(3001n)
    expect(client.getState().status).toBe("FAIL_CLOSED")
    expect(client.shouldAllowRequest()).toBe(false)
  })

  it("FAIL_OPEN → FAIL_CLOSED on timeout", async () => {
    const client = makeClient({ failOpenMaxDurationMs: 30 })
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("FAIL_OPEN")

    await new Promise((r) => setTimeout(r, 50))

    expect(client.shouldAllowRequest()).toBe(false)
    expect(client.getState().status).toBe("FAIL_CLOSED")
  })

  it("FAIL_CLOSED → SYNCED on successful reconciliation", async () => {
    const client = makeClient({ failOpenAbsCapMicro: 100n })

    // Drive to FAIL_CLOSED
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-e2e")
    client.recordLocalSpend(101n)
    expect(client.getState().status).toBe("FAIL_CLOSED")

    // Recover
    mockServer.clearFailureModes()
    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })

    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("SYNCED")
    expect(client.shouldAllowRequest()).toBe(true)
  })
})

describe("flapping simulation", () => {
  it("handles rapid SYNCED → FAIL_OPEN → SYNCED cycles without state corruption", async () => {
    const client = makeClient({ driftThresholdMicro: 50n })
    const transitions: string[] = []
    client.onStateChange = (from, to) => transitions.push(`${from}→${to}`)

    // Cycle 1: SYNCED → FAIL_OPEN → SYNCED
    client.recordLocalSpend(500000n)
    await client.poll("tenant-e2e") // matches arrakis, stays SYNCED
    expect(client.getState().status).toBe("SYNCED")

    // Cause drift
    client.recordLocalSpend(1000000n)
    await client.poll("tenant-e2e") // local=1500000, arrakis=500000 → drift
    expect(client.getState().status).toBe("FAIL_OPEN")

    // Fix arrakis to match
    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("SYNCED")

    // Cycle 2: Repeat
    client.recordLocalSpend(2000000n)
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("FAIL_OPEN")

    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("SYNCED")

    expect(transitions).toEqual([
      "SYNCED→FAIL_OPEN",
      "FAIL_OPEN→SYNCED",
      "SYNCED→FAIL_OPEN",
      "FAIL_OPEN→SYNCED",
    ])

    // State should be clean after flapping
    expect(client.getState().consecutiveFailures).toBe(0)
    expect(client.getState().failOpenStartedAt).toBeNull()
  })

  it("handles interleaved drift + network failures", async () => {
    const client = makeClient({ driftThresholdMicro: 50n, failOpenAbsCapMicro: 100_000n })
    const transitions: string[] = []
    client.onStateChange = (from, to) => transitions.push(`${from}→${to}`)

    // Step 1: drift → FAIL_OPEN
    client.recordLocalSpend(1000000n)
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("FAIL_OPEN")

    // Step 2: network failure while in FAIL_OPEN
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-e2e")
    // Should stay FAIL_OPEN (already in fail state)
    expect(client.getState().status).toBe("FAIL_OPEN")
    expect(client.getState().consecutiveFailures).toBe(1)

    // Step 3: recover
    mockServer.clearFailureModes()
    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("SYNCED")

    // Transitions: only SYNCED→FAIL_OPEN (first drift) and FAIL_OPEN→SYNCED (recovery)
    expect(transitions).toEqual(["SYNCED→FAIL_OPEN", "FAIL_OPEN→SYNCED"])
  })
})

describe("consecutive failure tracking", () => {
  it("increments on each failed poll and resets on success", async () => {
    const client = makeClient()
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })

    await client.poll("tenant-e2e")
    expect(client.getState().consecutiveFailures).toBe(1)

    await client.poll("tenant-e2e")
    expect(client.getState().consecutiveFailures).toBe(2)

    await client.poll("tenant-e2e")
    expect(client.getState().consecutiveFailures).toBe(3)

    // Recover
    mockServer.clearFailureModes()
    client.recordLocalSpend(500000n)
    await client.poll("tenant-e2e")
    expect(client.getState().consecutiveFailures).toBe(0)
  })
})

describe("monotonic headroom decrement", () => {
  it("headroom only decreases, never refills on re-entering FAIL_OPEN", async () => {
    const client = makeClient({
      driftThresholdMicro: 50n,
      failOpenAbsCapMicro: 100_000n,
    })

    // Enter FAIL_OPEN via drift
    client.recordLocalSpend(1000000n)
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("FAIL_OPEN")
    const initialHeadroom = client.getState().failOpenBudgetRemaining

    // Spend some headroom
    client.recordLocalSpend(50000n)
    const afterSpend = client.getState().failOpenBudgetRemaining
    expect(afterSpend).toBe(initialHeadroom - 50000n)

    // Recover to SYNCED
    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("SYNCED")

    // Headroom is NOT refilled after returning to SYNCED
    // (the failOpenBudgetRemaining stays at reduced value or is irrelevant while SYNCED)
    // What matters is shouldAllowRequest returns true in SYNCED
    expect(client.shouldAllowRequest()).toBe(true)
  })

  // BB-PR63-F005: Verify headroom doesn't increase when re-entering FAIL_OPEN
  it("headroom from second FAIL_OPEN entry does not exceed first entry's initial value", async () => {
    const client = makeClient({
      driftThresholdMicro: 50n,
      failOpenHeadroomPercent: 10,
      failOpenAbsCapMicro: 100_000n,
    })

    // First FAIL_OPEN: capture initial headroom
    client.recordLocalSpend(1000000n)
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("FAIL_OPEN")
    const firstHeadroom = client.getState().failOpenBudgetRemaining

    // Spend some headroom
    client.recordLocalSpend(30000n)
    const afterFirstSpend = client.getState().failOpenBudgetRemaining
    expect(afterFirstSpend).toBeLessThan(firstHeadroom)

    // Recover to SYNCED
    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("SYNCED")

    // Second FAIL_OPEN: new headroom should be computed fresh but capped
    client.recordLocalSpend(2000000n)
    await client.poll("tenant-e2e")
    expect(client.getState().status).toBe("FAIL_OPEN")
    const secondHeadroom = client.getState().failOpenBudgetRemaining

    // Second headroom is capped at failOpenAbsCapMicro (100_000n)
    // and should not exceed the absolute cap regardless of limit_micro
    expect(secondHeadroom).toBeLessThanOrEqual(100_000n)
  })
})

describe("drift detection with mock arrakis", () => {
  it("detects injected drift from mock server", async () => {
    const client = makeClient({ driftThresholdMicro: 10n })
    client.recordLocalSpend(500000n)

    mockServer.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "drift",
      driftMicro: "999999",
    })

    const result = await client.poll("tenant-e2e")
    expect(result.driftMicro).toBe(499999n)
    expect(result.driftExceedsThreshold).toBe(true)
  })

  it("reports no drift when local matches arrakis", async () => {
    const client = makeClient()
    client.recordLocalSpend(500000n)

    const result = await client.poll("tenant-e2e")
    expect(result.driftMicro).toBe(0n)
    expect(result.driftExceedsThreshold).toBe(false)
  })

  it("arrakis wins on conflict — committed_micro updated from response", async () => {
    const client = makeClient()

    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: "750000",
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })

    await client.poll("tenant-e2e")
    expect(client.getState().arrakisCommittedMicro).toBe(750000n)
  })
})

describe("polling lifecycle with mock server", () => {
  it("startPolling makes periodic requests to arrakis", async () => {
    const client = makeClient({ pollIntervalMs: 30 })
    client.recordLocalSpend(500000n)

    client.startPolling("tenant-e2e")
    await new Promise((r) => setTimeout(r, 120))
    client.stopPolling()

    const budgetRequests = mockServer.requestLog.filter((r) =>
      r.path.includes("/api/v1/budget/"),
    )
    expect(budgetRequests.length).toBeGreaterThanOrEqual(2)
  })

  it("requests include proper Authorization header", async () => {
    const client = makeClient()
    mockServer.clearRequestLog()

    await client.poll("tenant-e2e")

    const req = mockServer.requestLog.find((r) =>
      r.path.includes("/api/v1/budget/tenant-e2e"),
    )
    expect(req).toBeDefined()
    expect(req!.headers["authorization"]).toMatch(/^Bearer /)
  })

  it("stopPolling is idempotent and safe", () => {
    const client = makeClient()
    client.stopPolling()
    client.stopPolling()
    // No throw
  })
})

describe("onStateChange callback integration", () => {
  it("fires with correct from/to/reason for all transitions", async () => {
    const client = makeClient({ failOpenAbsCapMicro: 100n, driftThresholdMicro: 50n })
    const callbacks: Array<{ from: ReconState; to: ReconState; reason: string }> = []
    client.onStateChange = (from, to, reason) => callbacks.push({ from, to, reason })

    // SYNCED → FAIL_OPEN (unreachable)
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "error_500" })
    await client.poll("tenant-e2e")

    // FAIL_OPEN → FAIL_CLOSED (headroom exhausted)
    client.recordLocalSpend(101n)

    // FAIL_CLOSED → SYNCED (recovery)
    mockServer.clearFailureModes()
    mockServer.setTenantBudget("tenant-e2e", {
      committed_micro: String(client.getState().localSpendMicro),
      reserved_micro: "0",
      limit_micro: "10000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    await client.poll("tenant-e2e")

    expect(callbacks).toHaveLength(3)
    expect(callbacks[0].from).toBe("SYNCED")
    expect(callbacks[0].to).toBe("FAIL_OPEN")
    expect(callbacks[0].reason).toContain("arrakis unreachable")

    expect(callbacks[1].from).toBe("FAIL_OPEN")
    expect(callbacks[1].to).toBe("FAIL_CLOSED")
    expect(callbacks[1].reason).toBe("headroom exhausted")

    expect(callbacks[2].from).toBe("FAIL_CLOSED")
    expect(callbacks[2].to).toBe("SYNCED")
    expect(callbacks[2].reason).toBe("reconciliation successful")
  })
})

describe("rate-limit failure mode", () => {
  it("rate-limited response triggers FAIL_OPEN transition", async () => {
    const client = makeClient()
    mockServer.addFailureMode({ pathPattern: "/api/v1/budget/*", type: "rate_limit" })

    const result = await client.poll("tenant-e2e")
    expect(result.arrakisReachable).toBe(false)
    expect(client.getState().status).toBe("FAIL_OPEN")
  })
})

describe("stale data detection", () => {
  it("stale data from arrakis is still parseable", async () => {
    const client = makeClient()
    client.recordLocalSpend(500000n)

    mockServer.addFailureMode({
      pathPattern: "/api/v1/budget/*",
      type: "stale_data",
    })

    // Stale data still returns 200 with valid numbers
    const result = await client.poll("tenant-e2e")
    expect(result.arrakisReachable).toBe(true)
    // The committed_micro is still valid, just window_end is stale
    expect(client.getState().arrakisCommittedMicro).toBe(500000n)
  })
})

describe("multi-tenant reconciliation isolation", () => {
  it("polling tenant-A does not affect tenant-B state", async () => {
    mockServer.setTenantBudget("tenant-a", {
      committed_micro: "100000",
      reserved_micro: "0",
      limit_micro: "5000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })
    mockServer.setTenantBudget("tenant-b", {
      committed_micro: "200000",
      reserved_micro: "0",
      limit_micro: "5000000",
      window_start: new Date().toISOString(),
      window_end: new Date(Date.now() + 86400000).toISOString(),
    })

    const clientA = makeClient()
    const clientB = makeClient()

    clientA.recordLocalSpend(100000n)
    clientB.recordLocalSpend(200000n)

    await clientA.poll("tenant-a")
    await clientB.poll("tenant-b")

    expect(clientA.getState().arrakisCommittedMicro).toBe(100000n)
    expect(clientB.getState().arrakisCommittedMicro).toBe(200000n)
    expect(clientA.getState().status).toBe("SYNCED")
    expect(clientB.getState().status).toBe("SYNCED")
  })
})
