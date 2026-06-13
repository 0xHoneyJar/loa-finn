// src/score/edge/port.ts — the FR-6 substrate-agnostic seam (cycle-041 Sprint 1, T1.1)
//
// The ONLY platform-coupled surface is `GraphSource.fetchEpochGraph`. Everything in
// `score/core` consumes the abstract `TxGraph` and is therefore substrate-agnostic —
// this is the "1→3 push-to-the-edge" decision from the PRD (SDD §5.1, FR-6).
//
// Types are authored verbatim to the SDD contract (sdd-finn-economy-os.md:L665-689).

/** A platform-scoped epoch reference, e.g. `{ platform: 'agdp-acp', epoch: 'epoch-5' }`. */
export interface EpochRef {
  platform: string
  epoch: string
}

/** One service-payment (or subsidy) edge from a buyer wallet to an agent. */
export interface TxEdge {
  buyer: string // buyer wallet
  agent: string // agent id
  amountMicro: bigint // service-payment amount, micro-USD (integer-exact)
  txHash: string
  block: bigint
  isSubsidy: boolean // prize-pool subsidy edge — decomposed out of net revenue (FR-1)
}

/**
 * The abstract transaction graph for one epoch. Built by a `GraphSource` adapter;
 * consumed only by the pure analysis core. No I/O, no platform coupling.
 */
export interface TxGraph {
  epoch: EpochRef
  blockFrom: bigint
  blockTo: bigint
  edges: TxEdge[]
  deployerOf: Map<string, string> // agent → deployer wallet
  buyersOf: Map<string, Set<string>> // agent → distinct buyer set
}

/** The single platform-coupled port. aGDP/ACP implements it; Virtuals RevNet is a stub (FR-6). */
export interface GraphSource {
  fetchEpochGraph(epoch: EpochRef): Promise<TxGraph>
}

/** Thrown by not-yet-implemented adapters (e.g. the Virtuals RevNet portability stub). */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented (Phase 1 scope; deferred per PRD §6.2)`)
    this.name = "NotImplementedError"
  }
}
