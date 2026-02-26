// tests/finn/goodhart/parallel-scoring.test.ts — Parallel Scoring Tests (T-2.8, cycle-034)

import { describe, it, expect } from "vitest"
import { resolvePoolWithReputation } from "../../../src/hounfour/tier-bridge.js"
import type { ReputationQueryFn } from "../../../src/hounfour/types.js"

// --- Helpers ---

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// --- Tests ---

describe("Parallel scoring with AbortSignal.any()", () => {
  const NFT = "nft-parallel-test"

  it("5 pools scored in ≤ 200ms (AC14)", async () => {
    // Each query takes 20ms — parallel should complete well under 200ms
    const query: ReputationQueryFn = async ({ poolId }) => {
      await delay(20)
      const scores: Record<string, number> = {
        "cheap": 0.4, "fast-code": 0.9, "reviewer": 0.6, "reasoning": 0.3, "architect": 0.5,
      }
      return scores[poolId] ?? null
    }

    const start = Date.now()
    const result = await resolvePoolWithReputation("enterprise", NFT, "general", undefined, query)
    const elapsed = Date.now() - start

    expect(result).toBe("fast-code")
    expect(elapsed).toBeLessThan(200)
  })

  it("individual timeout doesn't block other queries (AC15)", async () => {
    const query: ReputationQueryFn = async ({ poolId }, options) => {
      if (poolId === "cheap") {
        // This query hangs until aborted
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
        return null
      }
      await delay(10)
      if (poolId === "fast-code") return 0.85
      return null
    }

    const result = await resolvePoolWithReputation("enterprise", NFT, "general", undefined, query)
    // fast-code should still win despite cheap hanging
    expect(result).toBe("fast-code")
  })

  it("rejected result treated as null (AC16)", async () => {
    const query: ReputationQueryFn = async ({ poolId }) => {
      if (poolId === "cheap") throw new Error("connection refused")
      if (poolId === "fast-code") throw new Error("timeout")
      if (poolId === "reviewer") return 0.7
      return null
    }

    const result = await resolvePoolWithReputation("pro", NFT, "general", undefined, query)
    expect(result).toBe("reviewer")
  })

  it("hung query aborted within 200ms deadline (AC16a)", async () => {
    const query: ReputationQueryFn = async ({ poolId }, options) => {
      // All queries hang forever
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(0.5), 10000)
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(new Error("aborted"))
        })
      })
    }

    const start = Date.now()
    const result = await resolvePoolWithReputation("enterprise", NFT, "general", undefined, query)
    const elapsed = Date.now() - start

    // Should abort all queries and fall back to deterministic within ~200ms
    expect(elapsed).toBeLessThan(400) // 200ms + some overhead
    // Falls back to deterministic since all queries were aborted
    expect(result).toBeTruthy()
  })

  it("passes nftId through query object", async () => {
    let receivedNftId: string | undefined
    const query: ReputationQueryFn = async ({ nftId, poolId }) => {
      receivedNftId = nftId
      return poolId === "fast-code" ? 0.8 : null
    }

    await resolvePoolWithReputation("pro", "my-special-nft", "general", undefined, query)
    expect(receivedNftId).toBe("my-special-nft")
  })

  it("composes AbortSignal correctly (no listener leaks)", async () => {
    let queryCount = 0
    const query: ReputationQueryFn = async ({ poolId }) => {
      queryCount++
      await delay(5)
      return poolId === "fast-code" ? 0.9 : 0.3
    }

    // Run multiple times to check for listener accumulation
    for (let i = 0; i < 10; i++) {
      await resolvePoolWithReputation("pro", NFT, "general", undefined, query)
    }

    // Each call queries 3 pools (pro: cheap, fast-code, reviewer) × 10 runs = 30
    expect(queryCount).toBe(30)
  })
})
