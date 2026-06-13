// src/score/core/__tests__/features.test.ts — FR-2 features: Jaccard + band-deviation.

import { describe, it, expect } from "vitest"
import { jaccard, jaccardOverlap, buyerCountDeviation } from "../features.js"
import { buildGraph, buyers, edgesFor } from "./fixtures.js"

describe("jaccard (hand-computed)", () => {
  it("|A∩B| / |A∪B|", () => {
    const A = new Set(["x", "y", "z"])
    const B = new Set(["y", "z", "w"])
    // ∩ = {y,z} = 2 ; ∪ = {x,y,z,w} = 4 → 0.5
    expect(jaccard(A, B)).toBe(0.5)
  })

  it("identical sets → 1, disjoint → 0, empty/empty → 0 (not NaN)", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0)
    expect(jaccard(new Set(), new Set())).toBe(0)
  })
})

describe("jaccardOverlap (feature 1)", () => {
  it("reports each agent's max overlap with the most-overlapping other agent", () => {
    // agentP buyers {x,y,z}; agentQ buyers {y,z,w}; agentR buyers {m,n} (disjoint)
    const graph = buildGraph({
      edges: [
        ...edgesFor("agentP", ["x", "y", "z"]),
        ...edgesFor("agentQ", ["y", "z", "w"]),
        ...edgesFor("agentR", ["m", "n"]),
      ],
    })
    const res = new Map(jaccardOverlap(graph).map((r) => [r.agentId, r]))
    expect(res.get("agentP")!.maxJaccard).toBe(0.5) // with agentQ
    expect(res.get("agentQ")!.maxJaccard).toBe(0.5) // with agentP
    expect(res.get("agentR")!.maxJaccard).toBe(0) // disjoint from everyone
    expect(res.get("agentP")!.pairs[0]).toEqual({ otherAgentId: "agentQ", jaccard: 0.5 })
  })
})

describe("buyerCountDeviation (feature 2)", () => {
  it("0 inside the band, distance to nearest edge outside", () => {
    const graph = buildGraph({
      edges: [
        ...edgesFor("inBand", buyers("ib", 150)), // inside [100,200]
        ...edgesFor("tooFew", buyers("tf", 50)), // 50 below → dev 50
        ...edgesFor("tooMany", buyers("tm", 250)), // 50 above → dev 50
      ],
    })
    const dev = buyerCountDeviation(graph, { bandLow: 100, bandHigh: 200 })
    expect(dev.get("inBand")).toBe(0)
    expect(dev.get("tooFew")).toBe(50)
    expect(dev.get("tooMany")).toBe(50)
  })
})
