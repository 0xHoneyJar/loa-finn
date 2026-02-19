// tests/finn/sprint-12-observability.test.ts — Sprint 12: Observability & Testing
//
// Tests for: OTel setup (12.1), trace propagation no-op (12.2),
// circuit breaker state change logging (12.3), gate-check dry-run (12.5).
// E2E-lite test is in its own file (x402-e2e-lite.test.ts, Task 12.4).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Task 12.1: OpenTelemetry SDK Setup + Base Configuration
// ---------------------------------------------------------------------------

describe("OpenTelemetry Setup (Task 12.1)", async () => {
  const { initTracing, isTracingEnabled, getTracer, setCorrelationId, shutdownTracing } =
    await import("../../src/tracing/otlp.js")

  afterEach(async () => {
    await shutdownTracing()
    // Reset OTEL_ENABLED
    delete process.env.OTEL_ENABLED
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  })

  it("tracing disabled when OTEL_ENABLED not set", async () => {
    delete process.env.OTEL_ENABLED
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const provider = await initTracing()
    expect(provider).toBeNull()
    expect(isTracingEnabled()).toBe(false)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("OTEL_ENABLED not set"),
    )

    consoleSpy.mockRestore()
  })

  it("getTracer returns null when tracing disabled", () => {
    const tracer = getTracer("test")
    expect(tracer).toBeNull()
  })

  it("setCorrelationId does not throw when tracing disabled", () => {
    expect(() => setCorrelationId("corr_123")).not.toThrow()
  })

  it("shutdownTracing is idempotent", async () => {
    await shutdownTracing()
    await shutdownTracing() // Should not throw
  })
})

// ---------------------------------------------------------------------------
// Task 12.2: Trace Context Propagation — Zero Overhead When Disabled
// ---------------------------------------------------------------------------

describe("Trace Propagation Zero Overhead (Task 12.2)", async () => {
  const { QuoteService } = await import("../../src/x402/middleware.js")
  const { PaymentVerifier } = await import("../../src/x402/verify.js")
  const { SettlementService } = await import("../../src/x402/settlement.js")
  const { Ledger, creditMintPostings } = await import("../../src/billing/ledger.js")

  function createMockRedis() {
    const store: Record<string, string> = {}
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

  it("QuoteService works without tracing (no span overhead)", async () => {
    delete process.env.OTEL_ENABLED
    const redis = createMockRedis()
    const service = new QuoteService({
      redis: redis as any,
      treasuryAddress: "0x1234",
      ratePerToken: { "test-model": "10" },
    })

    const quote = await service.generateQuote({ model: "test-model", max_tokens: 100 })
    expect(quote.quote_id).toBeDefined()
    expect(BigInt(quote.max_cost)).toBeGreaterThan(0n)
  })

  it("PaymentVerifier works without tracing", async () => {
    delete process.env.OTEL_ENABLED
    const redis = createMockRedis()
    const verifier = new PaymentVerifier({
      redis: redis as any,
      treasuryAddress: "0x1234",
      verifyEOASignature: async () => true,
    })

    const now = Math.floor(Date.now() / 1000)
    const result = await verifier.verify(
      {
        quote_id: "q_test",
        authorization: {
          from: "0xabcd", to: "0x1234", value: "1000",
          valid_after: now - 60, valid_before: now + 300,
          nonce: "0x" + "a".repeat(64), v: 27,
          r: "0x" + "b".repeat(64), s: "0x" + "c".repeat(64),
        },
        chain_id: 8453,
      },
      {
        max_cost: "1000", max_tokens: 100, model: "test",
        payment_address: "0x1234", chain_id: 8453,
        valid_until: now + 300, token_address: "0xUSDC", quote_id: "q_test",
      },
    )
    expect(result.valid).toBe(true)
  })

  it("SettlementService works without tracing", async () => {
    delete process.env.OTEL_ENABLED
    const service = new SettlementService({
      submitToFacilitator: async () => ({
        tx_hash: "0x123", block_number: 1,
        confirmation_count: 1, method: "facilitator" as const, amount: "1000",
      }),
      treasuryAddress: "0x1234",
    })

    const result = await service.settle(
      { from: "0xabcd", to: "0x1234", value: "1000", valid_after: 0, valid_before: 9999999999, nonce: "0x1", v: 27, r: "0x2", s: "0x3" },
      "q_test",
    )
    expect(result.method).toBe("facilitator")
  })

  it("Ledger appendEntry works without tracing", () => {
    delete process.env.OTEL_ENABLED
    const ledger = new Ledger()
    ledger.appendEntry({
      billing_entry_id: "01AAAAAAAAAAAAAAAAAAAAAAAAA" as any,
      event_type: "credit_mint",
      correlation_id: "corr_test",
      postings: creditMintPostings("user1", 1000n),
      exchange_rate: null,
      rounding_direction: null,
      wal_offset: "01AAAAAAAAAAAAAAAAAAAAAAAAA",
      timestamp: Date.now(),
    })
    expect(ledger.entryCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Task 12.3: Circuit Breaker State Metrics + Logging
// ---------------------------------------------------------------------------

describe("Circuit Breaker State Change Logging (Task 12.3)", async () => {
  const { CircuitBreaker } = await import("../../src/x402/settlement.js")

  it("emits structured log on CLOSED → OPEN transition", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const stateChanges: Array<{ from: string; to: string }> = []

    const cb = new CircuitBreaker({
      threshold: 3,
      windowMs: 60_000,
      onStateChange: (from, to) => { stateChanges.push({ from, to }) },
    })

    // Record 3 failures to trip circuit
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    // Should have emitted state change
    expect(stateChanges).toHaveLength(1)
    expect(stateChanges[0]).toEqual({ from: "CLOSED", to: "OPEN" })

    // Verify structured log was emitted
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("settlement.circuit.state_change"),
    )

    const logArg = consoleSpy.mock.calls.find(
      c => typeof c[0] === "string" && c[0].includes("state_change"),
    )
    expect(logArg).toBeDefined()
    const parsed = JSON.parse(logArg![0] as string)
    expect(parsed.metric).toBe("settlement.circuit.state_change")
    expect(parsed.from).toBe("CLOSED")
    expect(parsed.to).toBe("OPEN")
    expect(parsed.failure_count).toBe(3)
    expect(parsed.timestamp).toBeGreaterThan(0)

    consoleSpy.mockRestore()
  })

  it("emits structured log on OPEN → CLOSED (recovery)", () => {
    const stateChanges: Array<{ from: string; to: string }> = []
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const cb = new CircuitBreaker({
      threshold: 2,
      windowMs: 60_000,
      onStateChange: (from, to) => { stateChanges.push({ from, to }) },
    })

    // Trip circuit
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.currentState).toBe("OPEN")

    // Record success → should recover
    cb.recordSuccess()
    expect(cb.currentState).toBe("CLOSED")

    // Should have: CLOSED→OPEN, then OPEN→CLOSED
    expect(stateChanges).toHaveLength(2)
    expect(stateChanges[1]).toEqual({ from: "OPEN", to: "CLOSED" })

    consoleSpy.mockRestore()
  })

  it("does not emit duplicate OPEN transitions", () => {
    const stateChanges: Array<{ from: string; to: string }> = []
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const cb = new CircuitBreaker({
      threshold: 2,
      windowMs: 60_000,
      onStateChange: (from, to) => { stateChanges.push({ from, to }) },
    })

    // Trip circuit
    cb.recordFailure()
    cb.recordFailure() // → OPEN

    // Additional failures should NOT re-emit OPEN
    cb.recordFailure()
    cb.recordFailure()

    expect(stateChanges).toHaveLength(1) // Only one CLOSED→OPEN
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Task 12.5: Gate Check Script — Dry Run Validation
// ---------------------------------------------------------------------------

describe("Gate Check Script (Task 12.5)", async () => {
  const { execSync } = await import("node:child_process")

  it("gate-check.sh 0 --dry-run validates script logic", () => {
    const result = execSync(
      "./scripts/gate-check.sh 0 --dry-run",
      { cwd: "/home/merlin/Documents/thj/code/loa-finn", encoding: "utf-8" },
    )
    expect(result).toContain("Gate 0")
    expect(result).toContain("PASS")
    expect(result).not.toContain("FAIL")
  })

  it("gate-check.sh 0 --dry-run --json outputs valid JSON", () => {
    const result = execSync(
      "./scripts/gate-check.sh 0 --dry-run --json",
      { cwd: "/home/merlin/Documents/thj/code/loa-finn", encoding: "utf-8" },
    )
    const parsed = JSON.parse(result.trim())
    expect(parsed.gate).toBe(0)
    expect(parsed.gate_name).toBe("Smoke")
    expect(parsed.overall).toBe("PASS")
    expect(parsed.checks).toBeInstanceOf(Array)
    expect(parsed.checks.length).toBeGreaterThanOrEqual(4)
  })

  it("gate-check.sh without args shows usage", () => {
    try {
      execSync("./scripts/gate-check.sh", {
        cwd: "/home/merlin/Documents/thj/code/loa-finn",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      expect.unreachable("Should have exited with code 2")
    } catch (err: any) {
      expect(err.status).toBe(2)
      expect(err.stdout || err.stderr).toContain("Usage")
    }
  })

  it("all gates pass in dry-run mode", () => {
    for (const gate of [0, 1, 2, 3, 4]) {
      const result = execSync(
        `./scripts/gate-check.sh ${gate} --dry-run --json`,
        { cwd: "/home/merlin/Documents/thj/code/loa-finn", encoding: "utf-8" },
      )
      const parsed = JSON.parse(result.trim())
      expect(parsed.overall).toBe("PASS")
      expect(parsed.gate).toBe(gate)
    }
  })
})
