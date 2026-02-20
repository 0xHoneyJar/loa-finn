// tests/x402/rpc-pool.test.ts — RPC Pool Tests (Sprint 2 T2.5)

import { describe, it, expect } from "vitest"
import { RpcPool } from "../../src/x402/rpc-pool.js"
import { base } from "viem/chains"

// We test the pool's circuit breaker and fallback logic using the execute() method
// with mock functions that simulate provider behavior (not actual RPC calls).

describe("RpcPool", () => {
  it("creates pool with public fallback when no keys provided", () => {
    const pool = new RpcPool({})
    const health = pool.getHealth()
    expect(health).toHaveLength(1)
    expect(health[0].name).toBe("public")
    expect(health[0].state).toBe("closed")
  })

  it("creates pool with alchemy primary + public fallback", () => {
    const pool = new RpcPool({ alchemyApiKey: "test-key" })
    const health = pool.getHealth()
    expect(health).toHaveLength(2)
    expect(health[0].name).toBe("alchemy")
    expect(health[1].name).toBe("public")
  })

  it("creates pool with custom RPC URLs", () => {
    const pool = new RpcPool({
      rpcUrls: ["https://rpc1.example.com", "https://rpc2.example.com"],
    })
    const health = pool.getHealth()
    expect(health).toHaveLength(3) // 2 custom + 1 public
    expect(health[0].name).toBe("custom-0")
    expect(health[1].name).toBe("custom-1")
    expect(health[2].name).toBe("public")
  })

  it("execute returns result from first available provider", async () => {
    const pool = new RpcPool({})
    // Mock: the function gets a PublicClient but we just return a fixed value
    const result = await pool.execute(async () => 42)
    expect(result).toBe(42)
  })

  it("execute falls through to next provider on failure", async () => {
    const pool = new RpcPool({
      rpcUrls: ["https://will-not-be-called.example.com"],
    })

    let callCount = 0
    const result = await pool.execute(async (client) => {
      callCount++
      if (callCount === 1) throw new Error("first provider failed")
      return "fallback-result"
    })

    expect(result).toBe("fallback-result")
    expect(callCount).toBe(2) // custom-0 failed, public succeeded
  })

  it("throws rpc_unreachable when all providers fail", async () => {
    const pool = new RpcPool({})

    try {
      await pool.execute(async () => {
        throw new Error("provider down")
      })
      expect.fail("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain("All RPC providers failed")
      expect((err as Error & { code: string }).code).toBe("rpc_unreachable")
    }
  })

  it("circuit breaker opens after threshold failures", async () => {
    const pool = new RpcPool({
      rpcUrls: ["https://flaky.example.com"],
      circuitBreaker: {
        failureThreshold: 3,
        failureWindowMs: 30_000,
        probeDelayMs: 15_000,
      },
    })

    // Fail the custom provider 3 times to trip its circuit breaker
    for (let i = 0; i < 3; i++) {
      let callCount = 0
      await pool.execute(async () => {
        callCount++
        if (callCount === 1) throw new Error("flaky failure")
        return "public-ok"
      })
    }

    // After 3 failures, custom-0 circuit should be open
    const health = pool.getHealth()
    const custom = health.find((h) => h.name === "custom-0")
    expect(custom?.state).toBe("open")
  })

  it("circuit breaker resets on success", async () => {
    const pool = new RpcPool({
      circuitBreaker: {
        failureThreshold: 5,
        failureWindowMs: 30_000,
        probeDelayMs: 100, // fast probe for test
      },
    })

    // Fail a few times (less than threshold)
    let failures = 0
    for (let i = 0; i < 3; i++) {
      try {
        await pool.execute(async () => {
          failures++
          throw new Error("fail")
        })
      } catch {
        // expected
      }
    }

    // Then succeed — should still work since we didn't hit threshold
    const result = await pool.execute(async () => "recovered")
    expect(result).toBe("recovered")

    const health = pool.getHealth()
    expect(health[0].state).toBe("closed")
  })
})
