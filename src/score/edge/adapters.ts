// src/score/edge/adapters.ts — GraphSource adapters (cycle-041 Sprint 1, T1.5)
//
// FR-6 portability proof. Both adapters are typed stubs in Sprint 1 — the point is that
// the SECOND platform (`VirtualsRevNetAdapter`) compiles against the same `GraphSource`
// port without any change to `score/core`. Real Base/ACP ingestion lands in Sprint 2
// (the `AgdpAcpAdapter` body); the Virtuals adapter stays a stub until a real second
// surface exists (PRD timing decision: enter aGDP now, keep the core substrate-agnostic).

import type { EpochRef, GraphSource, TxGraph } from "./port.js"
import { NotImplementedError } from "./port.js"

/**
 * aGDP / ACP (Base) adapter. The real read-only transaction-graph ingestion is Sprint 2
 * (SDD §8 Sprint 2). In Sprint 1 it is a typed stub so `score/core` can be built and
 * tested against fixtures without an on-chain dependency.
 */
export class AgdpAcpAdapter implements GraphSource {
  readonly platform = "agdp-acp"

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchEpochGraph(epoch: EpochRef): Promise<TxGraph> {
    throw new NotImplementedError("AgdpAcpAdapter.fetchEpochGraph (Sprint 2: real Base/ACP ingestion)")
  }
}

/**
 * Virtuals Revenue Network adapter — the FR-6 portability proof. It implements the SAME
 * `GraphSource` port, demonstrating that a second platform plugs in at the edge without
 * touching the substrate-agnostic core. Intentionally unimplemented (no second surface yet).
 */
export class VirtualsRevNetAdapter implements GraphSource {
  readonly platform = "virtuals-revnet"

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchEpochGraph(epoch: EpochRef): Promise<TxGraph> {
    throw new NotImplementedError("VirtualsRevNetAdapter.fetchEpochGraph (successor surface; PRD §6.2)")
  }
}
