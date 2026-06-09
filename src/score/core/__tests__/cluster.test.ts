// src/score/core/__tests__/cluster.test.ts — FR-2 union-find counterparty/deployer clustering.

import { describe, it, expect } from "vitest"
import { clusterCounterparties } from "../cluster.js"
import { buildGraph, edgesFor } from "./fixtures.js"

describe("clusterCounterparties (union-find)", () => {
  it("agents sharing a deployer land in the same cluster", () => {
    const graph = buildGraph({
      edges: [...edgesFor("a", ["x"]), ...edgesFor("b", ["y"]), ...edgesFor("c", ["z"])],
      deployers: { a: "DEPLOYER_1", b: "DEPLOYER_1", c: "DEPLOYER_2" },
    })
    const cl = new Map(clusterCounterparties(graph).map((r) => [r.agentId, r.clusterId]))
    expect(cl.get("a")).toBe(cl.get("b")) // shared deployer
    expect(cl.get("a")).not.toBe(cl.get("c")) // different deployer
  })

  it("agents with overlapping buyer sets (≥ threshold) land in the same cluster", () => {
    const shared = ["s1", "s2", "s3", "s4"]
    const graph = buildGraph({
      edges: [
        ...edgesFor("ring1", shared),
        ...edgesFor("ring2", shared), // identical → jaccard 1
        ...edgesFor("lone", ["u1", "u2", "u3", "u4"]), // disjoint
      ],
    })
    const cl = new Map(clusterCounterparties(graph, 0.5).map((r) => [r.agentId, r.clusterId]))
    expect(cl.get("ring1")).toBe(cl.get("ring2"))
    expect(cl.get("lone")).not.toBe(cl.get("ring1"))
  })

  it("cluster id is deterministic (lexicographically smallest member) and stable", () => {
    const graph = buildGraph({
      edges: [...edgesFor("zeta", ["x"]), ...edgesFor("alpha", ["y"])],
      deployers: { zeta: "D", alpha: "D" },
    })
    const r1 = clusterCounterparties(graph)
    const r2 = clusterCounterparties(graph)
    expect(r1).toEqual(r2)
    expect(r1.every((r) => r.clusterId === "alpha")).toBe(true) // smallest id is the root
  })
})
