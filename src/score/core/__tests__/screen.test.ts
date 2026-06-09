// src/score/core/__tests__/screen.test.ts — FR-2/FR-2a anomaly screen + hard invariants.

import { describe, it, expect } from "vitest"
import { screenAnomaly, type Thresholds, type ScreenResult } from "../screen.js"
import { buildGraph, buyers, edgesFor } from "./fixtures.js"

const T: Thresholds = { bandLow: 100, bandHigh: 200, jaccardHigh: 0.5, precisionBar: 0.8 }

// A graph exercising every adversary class at once.
function mixedGraph() {
  const farmBuyers = buyers("farm", 150) // shared 150 (in-band)
  const legitShared = buyers("legit", 8) // 8 shared
  return buildGraph({
    deployers: { farmA: "FARMDEP", farmB: "FARMDEP" },
    edges: [
      // naive farm: two clones, identical 150-buyer set, shared deployer
      ...edgesFor("farmA", farmBuyers),
      ...edgesFor("farmB", farmBuyers),
      // legit shared audience: high overlap but only 10 buyers (OUTSIDE the band)
      ...edgesFor("legitC", [...legitShared, "legitC9", "legitC10"]),
      ...edgesFor("legitD", [...legitShared, "legitD9", "legitD10"]),
      // adaptive farm: 150 buyers (in-band) but all unique → no overlap
      ...edgesFor("adaptE", buyers("adapt", 150)),
      // clean real earner: 300 unique buyers (outside band), no overlap
      ...edgesFor("cleanG", buyers("clean", 300)),
      // subsidy capture: 1 real buyer + a dominant prize-pool subsidy edge
      { buyer: "subext", agent: "subF", amountMicro: 1_000_000n },
      { buyer: "pool", agent: "subF", amountMicro: 10_000_000n, isSubsidy: true },
    ],
  })
}

function byId(results: ScreenResult[]): Map<string, ScreenResult> {
  return new Map(results.map((r) => [r.agentId, r]))
}

describe("screenAnomaly (FR-2 band assignment)", () => {
  it("naive farm (in-band + high overlap + clustered) → HIGH", () => {
    const r = byId(screenAnomaly(mixedGraph(), T))
    expect(r.get("farmA")!.adversaryTag).toBe("naive_farm")
    expect(r.get("farmA")!.band).toBe("HIGH")
    expect(r.get("farmA")!.clusterId).toBe(r.get("farmB")!.clusterId)
  })

  it("subsidy capture (subsidy share ≥ 50%) → HIGH", () => {
    const r = byId(screenAnomaly(mixedGraph(), T))
    expect(r.get("subF")!.adversaryTag).toBe("subsidy_capture")
    expect(r.get("subF")!.band).toBe("HIGH")
  })

  it("clean real earner (outside band, no overlap) → LOW / none", () => {
    const r = byId(screenAnomaly(mixedGraph(), T))
    expect(r.get("cleanG")!.band).toBe("LOW")
    expect(r.get("cleanG")!.adversaryTag).toBe("none")
  })
})

describe("screenAnomaly hard invariants (FR-2a)", () => {
  it("adaptive_farm is NEVER tagged HIGH", () => {
    const results = screenAnomaly(mixedGraph(), T)
    const adaptE = byId(results).get("adaptE")!
    expect(adaptE.adversaryTag).toBe("adaptive_farm")
    expect(adaptE.band).not.toBe("HIGH")
    // and the invariant holds for EVERY agent, not just this fixture
    for (const r of results) {
      if (r.adversaryTag === "adaptive_farm") expect(r.band).not.toBe("HIGH")
    }
  })

  it("legit_shared_audience ⇒ INSUFFICIENT_EVIDENCE (false-positive guard)", () => {
    const results = screenAnomaly(mixedGraph(), T)
    const legitC = byId(results).get("legitC")!
    expect(legitC.adversaryTag).toBe("legit_shared_audience")
    expect(legitC.band).toBe("INSUFFICIENT_EVIDENCE")
    for (const r of results) {
      if (r.adversaryTag === "legit_shared_audience") expect(r.band).toBe("INSUFFICIENT_EVIDENCE")
    }
  })

  it("every band is a valid verdict and every agent is screened", () => {
    const results = screenAnomaly(mixedGraph(), T)
    const valid = new Set(["HIGH", "MED", "LOW", "INSUFFICIENT_EVIDENCE"])
    for (const r of results) expect(valid.has(r.band)).toBe(true)
    expect(results.map((r) => r.agentId).sort()).toEqual(
      ["adaptE", "cleanG", "farmA", "farmB", "legitC", "legitD", "subF"].sort(),
    )
  })
})

describe("screenAnomaly determinism (NFR-1)", () => {
  it("same input → identical ScreenResult[] across two runs", () => {
    const g = mixedGraph()
    expect(screenAnomaly(g, T)).toEqual(screenAnomaly(g, T))
  })

  it("output is ordered by recomputed rank", () => {
    const results = screenAnomaly(mixedGraph(), T)
    const ranks = results.map((r) => r.recomputedRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})
