// tests/finn/hounfour-sprint3.test.ts — Sprint 3 comprehensive tests (T-16.2, T-16.3, T-16.4, T-16.5, T-16.7)
// Tests: FullHealthProber, ProviderRateLimiter, ledger rotation, cost-report, fallback integration

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FullHealthProber, StubHealthProber } from "../../src/hounfour/health.js"
import type { CircuitState, WALLike } from "../../src/hounfour/health.js"
import { HounfourTokenBucket, ProviderRateLimiter } from "../../src/hounfour/rate-limiter.js"
import { generateCostReport, formatCostReportMarkdown } from "../../src/hounfour/cost-report.js"
import type { CostReport } from "../../src/hounfour/cost-report.js"
import { ChevalError } from "../../src/hounfour/errors.js"

const PREFIX = "finn-sprint3-test-"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), PREFIX))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// --- Mock WAL ---

class MockWAL implements WALLike {
  entries: Array<{ type: string; operation: string; path: string; data: unknown }> = []

  append(type: string, operation: string, path: string, data: unknown): string {
    this.entries.push({ type, operation, path, data })
    return `wal-${this.entries.length}`
  }
}

// --- Controllable clock ---

function makeClock(start: number = 1000000) {
  let now = start
  return {
    get: () => now,
    fn: () => now,
    advance: (ms: number) => { now += ms },
    set: (t: number) => { now = t },
  }
}

async function main() {
  console.log("\n=== Sprint 3 Comprehensive Tests ===\n")

  // ===========================
  // FullHealthProber Tests
  // ===========================
  console.log("--- FullHealthProber (T-16.2) ---")

  await test("health: new provider is healthy by default (optimistic)", () => {
    const prober = new FullHealthProber()
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
  })

  await test("health: single failure does not trip circuit (threshold=3)", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 3 })
    prober.recordFailure("openai", "gpt-4o", new Error("500 Internal Server Error"))
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
  })

  await test("health: 3 failures trips CLOSED→OPEN", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 3 })
    for (let i = 0; i < 3; i++) {
      prober.recordFailure("openai", "gpt-4o", new Error("5xx"))
    }
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), false)
    const stats = prober.getStats()
    assert.equal(stats["openai:gpt-4o"].state, "OPEN")
  })

  await test("health: OPEN transitions to HALF_OPEN after recovery interval", () => {
    const clock = makeClock()
    const prober = new FullHealthProber(
      { unhealthy_threshold: 2, recovery_interval_ms: 10_000, recovery_jitter_percent: 0 },
      { clock: clock.fn },
    )
    prober.recordFailure("openai", "gpt-4o", new Error("5xx"))
    prober.recordFailure("openai", "gpt-4o", new Error("5xx"))
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), false)

    // Advance past recovery interval
    clock.advance(11_000)
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
    assert.equal(prober.getStats()["openai:gpt-4o"].state, "HALF_OPEN")
  })

  await test("health: success in HALF_OPEN transitions to CLOSED", () => {
    const clock = makeClock()
    const prober = new FullHealthProber(
      { unhealthy_threshold: 2, recovery_threshold: 1, recovery_interval_ms: 5000, recovery_jitter_percent: 0 },
      { clock: clock.fn },
    )
    // Trip to OPEN
    prober.recordFailure("p", "m", new Error("fail"))
    prober.recordFailure("p", "m", new Error("fail"))
    // Wait for recovery
    clock.advance(6000)
    prober.isHealthy({ provider: "p", modelId: "m" }) // triggers HALF_OPEN
    // Success in HALF_OPEN
    prober.recordSuccess("p", "m")
    assert.equal(prober.getStats()["p:m"].state, "CLOSED")
    assert.equal(prober.isHealthy({ provider: "p", modelId: "m" }), true)
  })

  await test("health: failure in HALF_OPEN goes back to OPEN", () => {
    const clock = makeClock()
    const prober = new FullHealthProber(
      { unhealthy_threshold: 2, recovery_interval_ms: 5000, recovery_jitter_percent: 0 },
      { clock: clock.fn },
    )
    // Trip to OPEN
    prober.recordFailure("p", "m", new Error("fail"))
    prober.recordFailure("p", "m", new Error("fail"))
    // Wait for recovery
    clock.advance(6000)
    prober.isHealthy({ provider: "p", modelId: "m" }) // triggers HALF_OPEN
    // Fail again in HALF_OPEN
    prober.recordFailure("p", "m", new Error("still failing"))
    assert.equal(prober.getStats()["p:m"].state, "OPEN")
  })

  await test("health: 429 is NOT a health failure", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 1 })
    const err = new ChevalError({ code: "rate_limited", message: "429", statusCode: 429 })
    prober.recordFailure("openai", "gpt-4o", err)
    // Should still be healthy — 429 filtered by taxonomy
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
    assert.equal(prober.getStats()["openai:gpt-4o"]?.state ?? "CLOSED", "CLOSED")
  })

  await test("health: 401 is NOT a health failure", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 1 })
    const err = new ChevalError({ code: "auth_error", message: "401", statusCode: 401 })
    prober.recordFailure("openai", "gpt-4o", err)
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
  })

  await test("health: 400 is NOT a health failure", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 1 })
    const err = new ChevalError({ code: "provider_error", message: "400", statusCode: 400 })
    prober.recordFailure("openai", "gpt-4o", err)
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
  })

  await test("health: 500 IS a health failure", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 1 })
    const err = new ChevalError({ code: "provider_error", message: "500", statusCode: 500 })
    prober.recordFailure("openai", "gpt-4o", err)
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), false)
  })

  await test("health: timeout IS a health failure", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 1 })
    const err = new ChevalError({ code: "cheval_timeout", message: "timeout" })
    prober.recordFailure("openai", "gpt-4o", err)
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), false)
  })

  await test("health: WAL logs circuit breaker transitions", () => {
    const wal = new MockWAL()
    const prober = new FullHealthProber({ unhealthy_threshold: 2 }, { wal })
    prober.recordFailure("p", "m", new Error("fail"))
    prober.recordFailure("p", "m", new Error("fail"))
    // Should have logged CLOSED→OPEN
    const transition = wal.entries.find(e => e.path.includes("circuit-breaker"))
    assert.ok(transition, "No WAL entry for circuit breaker transition")
    const data = transition!.data as { from: string; to: string }
    assert.equal(data.from, "CLOSED")
    assert.equal(data.to, "OPEN")
  })

  await test("health: per-provider isolation", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 2 })
    prober.recordFailure("openai", "gpt-4o", new Error("fail"))
    prober.recordFailure("openai", "gpt-4o", new Error("fail"))
    // OpenAI down, Qwen still up
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), false)
    assert.equal(prober.isHealthy({ provider: "qwen", modelId: "qwen3-coder" }), true)
  })

  await test("health: success resets consecutive failure count", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 3 })
    prober.recordFailure("p", "m", new Error("fail"))
    prober.recordFailure("p", "m", new Error("fail"))
    prober.recordSuccess("p", "m") // Resets failures
    prober.recordFailure("p", "m", new Error("fail"))
    // Only 1 failure after reset — should be healthy
    assert.equal(prober.isHealthy({ provider: "p", modelId: "m" }), true)
  })

  await test("health: snapshot returns all entries", () => {
    const prober = new FullHealthProber()
    prober.recordSuccess("a", "1")
    prober.recordSuccess("b", "2")
    const snap = prober.snapshot()
    assert.equal(snap.length, 2)
  })

  // ===========================
  // HounfourTokenBucket Tests
  // ===========================
  console.log("\n--- HounfourTokenBucket (T-16.3) ---")

  await test("bucket: starts at full capacity", () => {
    const bucket = new HounfourTokenBucket(10, 10)
    assert.equal(bucket.remaining(), 10)
  })

  await test("bucket: tryConsume reduces tokens", () => {
    const bucket = new HounfourTokenBucket(10, 10)
    assert.equal(bucket.tryConsume(3), true)
    assert.equal(bucket.remaining(), 7)
  })

  await test("bucket: tryConsume returns false when insufficient", () => {
    const bucket = new HounfourTokenBucket(5, 5)
    assert.equal(bucket.tryConsume(3), true)
    assert.equal(bucket.tryConsume(3), false)
    assert.equal(bucket.remaining(), 2)
  })

  await test("bucket: refills over time", () => {
    const clock = makeClock()
    const bucket = new HounfourTokenBucket(10, 60, clock.fn) // 60/min = 1/sec
    bucket.tryConsume(10) // Drain
    assert.equal(bucket.remaining(), 0)
    clock.advance(5000) // 5 seconds = 5 tokens
    assert.equal(bucket.remaining(), 5)
  })

  await test("bucket: refill capped at capacity", () => {
    const clock = makeClock()
    const bucket = new HounfourTokenBucket(10, 60, clock.fn)
    bucket.tryConsume(2)
    clock.advance(60_000) // 1 minute = full refill
    assert.equal(bucket.remaining(), 10) // Capped at capacity
  })

  await test("bucket: addTokens refunds correctly", () => {
    const bucket = new HounfourTokenBucket(10, 10)
    bucket.tryConsume(5)
    assert.equal(bucket.remaining(), 5)
    bucket.addTokens(3)
    assert.equal(bucket.remaining(), 8)
  })

  await test("bucket: addTokens capped at capacity", () => {
    const bucket = new HounfourTokenBucket(10, 10)
    bucket.addTokens(5) // Already at 10
    assert.equal(bucket.remaining(), 10) // Can't exceed capacity
  })

  await test("bucket: addTokens ignores non-positive amounts", () => {
    const bucket = new HounfourTokenBucket(10, 10)
    bucket.addTokens(0)
    bucket.addTokens(-5)
    assert.equal(bucket.remaining(), 10)
  })

  await test("bucket: timeUntilAvailable returns 0 when tokens available", () => {
    const bucket = new HounfourTokenBucket(10, 60)
    assert.equal(bucket.timeUntilAvailable(5), 0)
  })

  await test("bucket: timeUntilAvailable calculates wait time", () => {
    const clock = makeClock()
    const bucket = new HounfourTokenBucket(10, 60, clock.fn) // 1 token/sec
    bucket.tryConsume(10) // Drain
    const wait = bucket.timeUntilAvailable(5) // Need 5 tokens
    assert.ok(wait > 4000 && wait <= 5000, `Expected ~5000ms, got ${wait}`)
  })

  await test("bucket: throws on invalid capacity", () => {
    assert.throws(() => new HounfourTokenBucket(0, 10), /Invalid token bucket config/)
    assert.throws(() => new HounfourTokenBucket(-1, 10), /Invalid token bucket config/)
  })

  await test("bucket: throws on invalid refillPerMinute", () => {
    assert.throws(() => new HounfourTokenBucket(10, 0), /Invalid token bucket config/)
    assert.throws(() => new HounfourTokenBucket(10, -5), /Invalid token bucket config/)
  })

  // ===========================
  // ProviderRateLimiter Tests
  // ===========================
  console.log("\n--- ProviderRateLimiter (T-16.3) ---")

  await test("rateLimiter: acquire succeeds with available tokens", async () => {
    const limiter = new ProviderRateLimiter({ openai: { rpm: 60, tpm: 100_000, queue_timeout_ms: 1000 } })
    const result = await limiter.acquire("openai", 1000)
    assert.equal(result, true)
  })

  await test("rateLimiter: getStatus shows remaining tokens", async () => {
    const limiter = new ProviderRateLimiter({ openai: { rpm: 10, tpm: 50_000, queue_timeout_ms: 1000 } })
    await limiter.acquire("openai", 1000)
    const status = limiter.getStatus("openai")
    assert.ok(status, "Status should exist after acquire")
    assert.equal(status!.rpm_remaining, 9) // 10 - 1
    assert.equal(status!.tpm_remaining, 49_000) // 50000 - 1000
  })

  await test("rateLimiter: unknown provider uses defaults", async () => {
    const limiter = new ProviderRateLimiter({})
    const result = await limiter.acquire("unknown-provider", 100)
    assert.equal(result, true)
    const status = limiter.getStatus("unknown-provider")
    assert.ok(status)
  })

  await test("rateLimiter: getStatus returns undefined for unacquired provider", () => {
    const limiter = new ProviderRateLimiter({})
    assert.equal(limiter.getStatus("never-used"), undefined)
  })

  await test("rateLimiter: release is a no-op", () => {
    const limiter = new ProviderRateLimiter({})
    // Should not throw
    limiter.release("openai")
  })

  // ===========================
  // Cost Report Tests (T-16.7)
  // ===========================
  console.log("\n--- Cost Report (T-16.7) ---")

  await test("costReport: aggregates entries by agent", async () => {
    const tmpDir = makeTempDir()
    try {
      const ledgerPath = join(tmpDir, "cost-ledger.jsonl")
      const entries = [
        { agent: "translator", provider: "openai", model: "gpt-4o-mini", prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 0, total_cost_usd: 0.005, phase_id: "phase-0", sprint_id: "sprint-14", timestamp: new Date().toISOString(), trace_id: "t1", tenant_id: "local", project_id: "test", latency_ms: 1200, tool_calls: 0, request_type: "completion" },
        { agent: "translator", provider: "openai", model: "gpt-4o-mini", prompt_tokens: 800, completion_tokens: 400, reasoning_tokens: 0, total_cost_usd: 0.004, phase_id: "phase-0", sprint_id: "sprint-14", timestamp: new Date().toISOString(), trace_id: "t2", tenant_id: "local", project_id: "test", latency_ms: 900, tool_calls: 0, request_type: "completion" },
        { agent: "reviewer", provider: "qwen", model: "qwen3-coder", prompt_tokens: 2000, completion_tokens: 1000, reasoning_tokens: 0, total_cost_usd: 0.003, phase_id: "phase-0", sprint_id: "sprint-14", timestamp: new Date().toISOString(), trace_id: "t3", tenant_id: "local", project_id: "test", latency_ms: 2000, tool_calls: 0, request_type: "completion" },
      ]
      writeFileSync(ledgerPath, entries.map(e => JSON.stringify(e)).join("\n"))

      const report = await generateCostReport({ ledgerFiles: [ledgerPath] })
      assert.equal(report.total_requests, 3)
      assert.ok(Math.abs(report.total_cost_usd - 0.012) < 0.0001)
      assert.equal(report.by_agent.length, 2) // translator + reviewer
      assert.equal(report.by_agent[0].agent, "translator") // Highest cost first
      assert.equal(report.by_agent[0].request_count, 2)
      assert.equal(report.by_agent[1].agent, "reviewer")
    } finally {
      cleanup(tmpDir)
    }
  })

  await test("costReport: aggregates entries by phase", async () => {
    const tmpDir = makeTempDir()
    try {
      const ledgerPath = join(tmpDir, "cost-ledger.jsonl")
      const entries = [
        { agent: "a", provider: "p", model: "m", prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, total_cost_usd: 0.001, phase_id: "phase-0", sprint_id: "sprint-14", timestamp: "", trace_id: "", tenant_id: "", project_id: "", latency_ms: 0, tool_calls: 0, request_type: "" },
        { agent: "a", provider: "p", model: "m", prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, total_cost_usd: 0.002, phase_id: "phase-1", sprint_id: "sprint-15", timestamp: "", trace_id: "", tenant_id: "", project_id: "", latency_ms: 0, tool_calls: 0, request_type: "" },
      ]
      writeFileSync(ledgerPath, entries.map(e => JSON.stringify(e)).join("\n"))

      const report = await generateCostReport({ ledgerFiles: [ledgerPath] })
      assert.equal(report.by_phase.length, 2)
      // Sorted by phase_id
      assert.equal(report.by_phase[0].phase_id, "phase-0")
      assert.equal(report.by_phase[1].phase_id, "phase-1")
    } finally {
      cleanup(tmpDir)
    }
  })

  await test("costReport: handles empty ledger", async () => {
    const tmpDir = makeTempDir()
    try {
      const ledgerPath = join(tmpDir, "empty.jsonl")
      writeFileSync(ledgerPath, "")
      const report = await generateCostReport({ ledgerFiles: [ledgerPath] })
      assert.equal(report.total_requests, 0)
      assert.equal(report.total_cost_usd, 0)
      assert.equal(report.avg_cost_per_request, 0)
      assert.equal(report.by_agent.length, 0)
    } finally {
      cleanup(tmpDir)
    }
  })

  await test("costReport: skips malformed lines", async () => {
    const tmpDir = makeTempDir()
    try {
      const ledgerPath = join(tmpDir, "bad.jsonl")
      writeFileSync(ledgerPath, `not valid json\n{"agent":"a","provider":"p","model":"m","prompt_tokens":100,"completion_tokens":50,"reasoning_tokens":0,"total_cost_usd":0.01,"phase_id":"p0","sprint_id":"s0"}\ntruncated{`)
      const report = await generateCostReport({ ledgerFiles: [ledgerPath] })
      assert.equal(report.total_requests, 1) // Only the valid line
    } finally {
      cleanup(tmpDir)
    }
  })

  await test("costReport: handles missing files gracefully", async () => {
    const report = await generateCostReport({ ledgerFiles: ["/tmp/nonexistent-ledger-12345.jsonl"] })
    assert.equal(report.total_requests, 0)
  })

  await test("costReport: reads multiple ledger files", async () => {
    const tmpDir = makeTempDir()
    try {
      const file1 = join(tmpDir, "ledger-1.jsonl")
      const file2 = join(tmpDir, "ledger-2.jsonl")
      const entry1 = JSON.stringify({ agent: "a", provider: "p", model: "m", prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, total_cost_usd: 0.01, phase_id: "p0", sprint_id: "s0" })
      const entry2 = JSON.stringify({ agent: "b", provider: "p", model: "m", prompt_tokens: 200, completion_tokens: 100, reasoning_tokens: 0, total_cost_usd: 0.02, phase_id: "p0", sprint_id: "s0" })
      writeFileSync(file1, entry1)
      writeFileSync(file2, entry2)

      const report = await generateCostReport({ ledgerFiles: [file1, file2] })
      assert.equal(report.total_requests, 2)
      assert.ok(Math.abs(report.total_cost_usd - 0.03) < 0.0001)
    } finally {
      cleanup(tmpDir)
    }
  })

  await test("costReport: formatMarkdown produces valid table", async () => {
    const report: CostReport = {
      generated_at: "2026-02-08T00:00:00Z",
      total_requests: 5,
      total_cost_usd: 0.05,
      avg_cost_per_request: 0.01,
      by_agent: [{ agent: "translator", provider: "openai", model: "gpt-4o-mini", request_count: 5, total_prompt_tokens: 5000, total_completion_tokens: 2500, total_reasoning_tokens: 0, total_cost_usd: 0.05 }],
      by_phase: [{ phase_id: "phase-0", sprint_id: "sprint-14", request_count: 5, total_cost_usd: 0.05 }],
    }
    const md = formatCostReportMarkdown(report)
    assert.ok(md.includes("# Cost Report"))
    assert.ok(md.includes("| Total Requests | 5 |"))
    assert.ok(md.includes("| Total Cost | $0.0500 |"))
    assert.ok(md.includes("| translator |"))
    assert.ok(md.includes("| phase-0 |"))
  })

  // ===========================
  // StubHealthProber backward compat
  // ===========================
  console.log("\n--- StubHealthProber (backward compat) ---")

  await test("stub: always returns healthy", () => {
    const stub = new StubHealthProber()
    stub.recordFailure("p", "m", new Error("fail"))
    stub.recordFailure("p", "m", new Error("fail"))
    stub.recordFailure("p", "m", new Error("fail"))
    assert.equal(stub.isHealthy({ provider: "p", modelId: "m" }), true)
  })

  await test("stub: tracks stats", () => {
    const stub = new StubHealthProber()
    stub.recordSuccess("p", "m")
    stub.recordSuccess("p", "m")
    stub.recordFailure("p", "m")
    const stats = stub.getStats()
    assert.equal(stats["p:m"].successes, 2)
    assert.equal(stats["p:m"].failures, 1)
  })

  // ===========================
  // Integration: FullHealthProber recovery cycle
  // ===========================
  console.log("\n--- Integration: Health Recovery Cycle ---")

  await test("integration: provider down → fallback → recovery → restore", () => {
    const clock = makeClock()
    const wal = new MockWAL()
    const prober = new FullHealthProber(
      { unhealthy_threshold: 2, recovery_threshold: 1, recovery_interval_ms: 10_000, recovery_jitter_percent: 0 },
      { wal, clock: clock.fn },
    )

    // 1. Provider is healthy
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)

    // 2. Provider goes down (2 failures)
    prober.recordFailure("openai", "gpt-4o", new Error("5xx"))
    prober.recordFailure("openai", "gpt-4o", new Error("5xx"))
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), false)
    assert.equal(prober.getStats()["openai:gpt-4o"].state, "OPEN")

    // 3. Fallback would be used here (router logic) — time passes
    clock.advance(11_000)

    // 4. Recovery: OPEN → HALF_OPEN (recovery interval elapsed)
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
    assert.equal(prober.getStats()["openai:gpt-4o"].state, "HALF_OPEN")

    // 5. Restore: success in HALF_OPEN → CLOSED
    prober.recordSuccess("openai", "gpt-4o")
    assert.equal(prober.getStats()["openai:gpt-4o"].state, "CLOSED")
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)

    // WAL should have logged transitions
    const transitions = wal.entries.filter(e => e.path.includes("circuit-breaker"))
    assert.ok(transitions.length >= 3, `Expected >=3 transitions, got ${transitions.length}`)
  })

  await test("integration: mixed error types — only health failures count", () => {
    const prober = new FullHealthProber({ unhealthy_threshold: 2 })

    // Non-health errors (429, 401, 400)
    prober.recordFailure("p", "m", new ChevalError({ code: "rate_limited", message: "429", statusCode: 429 }))
    prober.recordFailure("p", "m", new ChevalError({ code: "auth_error", message: "401", statusCode: 401 }))
    prober.recordFailure("p", "m", new ChevalError({ code: "provider_error", message: "400", statusCode: 400 }))
    assert.equal(prober.isHealthy({ provider: "p", modelId: "m" }), true)

    // Health failures (500)
    prober.recordFailure("p", "m", new ChevalError({ code: "provider_error", message: "500", statusCode: 500 }))
    assert.equal(prober.isHealthy({ provider: "p", modelId: "m" }), true) // Only 1 health failure

    prober.recordFailure("p", "m", new ChevalError({ code: "provider_error", message: "503", statusCode: 503 }))
    assert.equal(prober.isHealthy({ provider: "p", modelId: "m" }), false) // 2 health failures → OPEN
  })

  console.log("\n--- Results ---")
  console.log("All Sprint 3 tests completed.\n")
}

main()
