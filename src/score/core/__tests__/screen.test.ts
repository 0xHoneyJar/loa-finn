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

  it("subsidy capture (subsidy share ≥ 50%) → MED, not HIGH (factual flag, never a public accusation)", () => {
    const r = byId(screenAnomaly(mixedGraph(), T))
    expect(r.get("subF")!.adversaryTag).toBe("subsidy_capture")
    expect(r.get("subF")!.band).toBe("MED") // review fix #2: a legit grant recipient must NOT be HIGH
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

describe("screenAnomaly — GPT-5 code-review regressions", () => {
  // fix #1: a naive_farm that ALSO has circular revenue must stay HIGH (not downgraded to relay MED)
  it("naive_farm + circular revenue → HIGH (severity wins over branch order)", () => {
    const T2: Thresholds = { bandLow: 2, bandHigh: 10, jaccardHigh: 0.5, precisionBar: 0.8 }
    const shared = ["ext1", "ext2", "agB", "agC"] // agB/agC become agents below → buys from them are circular
    const g = buildGraph({
      deployers: { A: "DEP", B: "DEP" },
      edges: [
        ...edgesFor("A", shared), // 4 buyers (in [2,10]); 2 are agents → 50% circular
        ...edgesFor("B", shared), // identical → jaccard 1 with A
        ...edgesFor("agB", ["x1"]), // makes agB an agent
        ...edgesFor("agC", ["x2"]), // makes agC an agent
      ],
    })
    const a = byId(screenAnomaly(g, T2)).get("A")!
    expect(a.adversaryTag).toBe("naive_farm")
    expect(a.band).toBe("HIGH") // would have been relay_double_count/MED under the old branch order
  })

  // fix #2: no agent is HIGH on a single non-naive signal (subsidy or circular alone)
  it("no agent is HIGH without the full naive_farm combo", () => {
    for (const res of screenAnomaly(mixedGraph(), T)) {
      if (res.band === "HIGH") expect(res.adversaryTag).toBe("naive_farm")
    }
  })

  // fix #3: bigint threshold math — a share JUST under 50% must not flip to a flag via Number() rounding
  it("subsidy share just under 50% (huge values) is NOT flagged", () => {
    const subsidy = 4503599627370496n // 2^52
    const gross = 4503599627370497n // denom = 9007199254740993n > 2^53 → Number() would round to exactly 0.5
    const g = buildGraph({
      edges: [
        { buyer: "ext", agent: "Z", amountMicro: gross },
        { buyer: "pool", agent: "Z", amountMicro: subsidy, isSubsidy: true },
      ],
    })
    const z = byId(screenAnomaly(g, T)).get("Z")!
    expect(z.adversaryTag).not.toBe("subsidy_capture") // bigint: 2*subsidy < denom → correctly under 50%
  })

  // fix #4: a subsidy-only agent (no buyers) is screened, not spuriously in-band, MED not HIGH
  it("subsidy-only agent is screened, not spuriously in-band, never HIGH", () => {
    const g = buildGraph({
      edges: [{ buyer: "pool", agent: "W", amountMicro: 5_000_000n, isSubsidy: true }],
    })
    const w = byId(screenAnomaly(g, T)).get("W")
    expect(w).toBeDefined()
    expect(w!.distinctBuyers).toBe(0)
    expect(w!.bandDeviation).toBeGreaterThan(0) // NOT the spurious 0 that means "in band"
    expect(w!.adversaryTag).toBe("subsidy_capture")
    expect(w!.band).toBe("MED")
  })

  // NFR-1 robustness: identical logical graph with shuffled edge order → identical output
  it("output is invariant to edge insertion order", () => {
    const e = [
      { buyer: "x", agent: "p", amountMicro: 3_000_000n },
      { buyer: "y", agent: "q", amountMicro: 2_000_000n },
      { buyer: "z", agent: "p", amountMicro: 1_000_000n },
    ]
    const g1 = buildGraph({ edges: e })
    const g2 = buildGraph({ edges: [e[2], e[0], e[1]] })
    expect(screenAnomaly(g1, T)).toEqual(screenAnomaly(g2, T))
  })
})
