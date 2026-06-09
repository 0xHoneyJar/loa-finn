// src/score/core/__tests__/leaderboard.test.ts — FR-1 net-revenue decomposition + ranking.

import { describe, it, expect } from "vitest"
import { recomputeLeaderboard } from "../leaderboard.js"
import { buildGraph } from "./fixtures.js"

describe("recomputeLeaderboard (FR-1)", () => {
  it("decomposes gross / subsidy / circular and computes net = gross − circular", () => {
    // agentA: 3 external buyers (1M each) + 1 circular edge from agentB (2M) + 1 subsidy edge (5M)
    const graph = buildGraph({
      edges: [
        { buyer: "ext1", agent: "agentA", amountMicro: 1_000_000n },
        { buyer: "ext2", agent: "agentA", amountMicro: 1_000_000n },
        { buyer: "ext3", agent: "agentA", amountMicro: 1_000_000n },
        { buyer: "agentB", agent: "agentA", amountMicro: 2_000_000n }, // circular: buyer is an agent
        { buyer: "sub", agent: "agentA", amountMicro: 5_000_000n, isSubsidy: true },
        { buyer: "ext9", agent: "agentB", amountMicro: 1_000_000n },
      ],
    })

    const rows = recomputeLeaderboard(graph)
    const a = rows.find((r) => r.agentId === "agentA")!
    expect(a.grossMicro).toBe(5_000_000n) // 3×1M + 2M (non-subsidy)
    expect(a.subsidyMicro).toBe(5_000_000n)
    expect(a.circularMicro).toBe(2_000_000n) // the agentB→agentA edge
    expect(a.netMicro).toBe(3_000_000n) // gross − circular
    expect(a.distinctBuyers).toBe(4) // ext1,ext2,ext3,agentB
  })

  it("ranks by net revenue descending and is deterministic across runs", () => {
    const graph = buildGraph({
      edges: [
        { buyer: "x", agent: "low", amountMicro: 1_000_000n },
        { buyer: "y", agent: "high", amountMicro: 9_000_000n },
        { buyer: "z", agent: "mid", amountMicro: 5_000_000n },
      ],
    })
    const r1 = recomputeLeaderboard(graph)
    const r2 = recomputeLeaderboard(graph)
    expect(r1.map((r) => r.agentId)).toEqual(["high", "mid", "low"])
    expect(r1.map((r) => r.recomputedRank)).toEqual([1, 2, 3])
    expect(r1).toEqual(r2) // NFR-1 determinism
  })

  it("a fully-circular agent (all revenue from other agents) ranks below a real earner", () => {
    const graph = buildGraph({
      edges: [
        { buyer: "realBuyer", agent: "real", amountMicro: 1_000_000n },
        { buyer: "real", agent: "wash", amountMicro: 8_000_000n }, // wash: buyer is agent 'real'
      ],
    })
    const rows = recomputeLeaderboard(graph)
    const wash = rows.find((r) => r.agentId === "wash")!
    expect(wash.netMicro).toBe(0n) // all revenue is circular
    expect(rows[0].agentId).toBe("real") // the real earner outranks the wash agent
  })
})
