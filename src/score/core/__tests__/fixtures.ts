// src/score/core/__tests__/fixtures.ts — TxGraph builder for the pure-core tests.
// Not a test file (no `.test` suffix) → not collected by vitest.

import type { EpochRef, TxEdge, TxGraph } from "../../edge/port.js"

export interface EdgeSpec {
  buyer: string
  agent: string
  amountMicro?: bigint
  isSubsidy?: boolean
}

export function buildGraph(spec: {
  epoch?: EpochRef
  edges: EdgeSpec[]
  deployers?: Record<string, string>
}): TxGraph {
  const edges: TxEdge[] = spec.edges.map((e, i) => ({
    buyer: e.buyer,
    agent: e.agent,
    amountMicro: e.amountMicro ?? 1_000_000n,
    txHash: `0x${i.toString(16)}`,
    block: BigInt(i),
    isSubsidy: e.isSubsidy ?? false,
  }))

  const buyersOf = new Map<string, Set<string>>()
  const deployerOf = new Map<string, string>(Object.entries(spec.deployers ?? {}))
  for (const e of edges) {
    if (e.isSubsidy) continue
    let set = buyersOf.get(e.agent)
    if (!set) {
      set = new Set<string>()
      buyersOf.set(e.agent, set)
    }
    set.add(e.buyer)
  }
  // ensure agents that only have a deployer entry still appear as nodes
  for (const a of deployerOf.keys()) if (!buyersOf.has(a)) buyersOf.set(a, new Set())

  return {
    epoch: spec.epoch ?? { platform: "test", epoch: "e1" },
    blockFrom: 0n,
    blockTo: BigInt(edges.length),
    edges,
    deployerOf,
    buyersOf,
  }
}

/** N distinct buyer wallets with a shared prefix. */
export function buyers(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-b${i}`)
}

/** Edges from a buyer list to one agent. */
export function edgesFor(agent: string, buyerList: string[], amountMicro = 1_000_000n): EdgeSpec[] {
  return buyerList.map((buyer) => ({ buyer, agent, amountMicro }))
}
