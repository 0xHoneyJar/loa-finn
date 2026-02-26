// src/hounfour/goodhart/reputation-adapter.ts — Reputation Adapter (SDD §4.2.1, T-2.3)
//
// Implements ReputationQueryFn contract: dixie → EMA update → decayed score → calibration blend.
// Returns clamped [0,1] score or null when dixie unreachable.

import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../nft-routing-config.js"
import type { ReputationQuery, ReputationQueryOptions } from "../types.js"
import type { TemporalDecayEngine, EMAKey } from "./temporal-decay.js"
import type { CalibrationEngine } from "./calibration.js"
import type { DixieTransport } from "./dixie-transport.js"

// --- Types ---

export interface ReputationAdapterConfig {
  decay: TemporalDecayEngine
  calibration: CalibrationEngine
  transport: DixieTransport
}

// --- Adapter ---

export class ReputationAdapter {
  private readonly config: ReputationAdapterConfig

  constructor(config: ReputationAdapterConfig) {
    this.config = config
  }

  /**
   * Query reputation for a pool, implementing the full FR1.4 precedence:
   * 1. Get decayed EMA score (if exists)
   * 2. Blend with calibration entries (if any)
   * 3. Clamp to [0,1]
   *
   * Returns null when no signal is available (cold start, dixie unreachable).
   */
  async query(queryParams: ReputationQuery, options?: ReputationQueryOptions): Promise<number | null> {
    const { nftId, poolId, routingKey } = queryParams
    const emaKey: EMAKey = { nftId, poolId, routingKey }

    // Get decayed score from EMA
    const decayResult = await this.config.decay.getDecayedScore(emaKey)

    if (!decayResult) {
      // No EMA state — check if dixie has a score to bootstrap
      const dixieResponse = await this.config.transport.getReputation(nftId, options)
      if (!dixieResponse) return null

      // Bootstrap EMA from dixie's aggregate score (cold start)
      // Don't feed into EMA here — that's the quality signal's job (T-2.5)
      // Just return the dixie score with calibration blending
      const calibrationEntries = this.config.calibration.getCalibration(nftId, poolId, routingKey)
      if (calibrationEntries.length > 0) {
        const blended = this.config.calibration.blendWithDecay(
          dixieResponse.score,
          dixieResponse.sampleCount,
          calibrationEntries,
        )
        return Math.max(0, Math.min(1, blended))
      }

      return Math.max(0, Math.min(1, dixieResponse.score))
    }

    // Have decayed EMA — blend with calibration
    let finalScore = decayResult.score

    const calibrationEntries = this.config.calibration.getCalibration(nftId, poolId, routingKey)
    if (calibrationEntries.length > 0) {
      const rawState = await this.config.decay.getRawState(emaKey)
      const sampleCount = rawState?.sampleCount ?? 0
      finalScore = this.config.calibration.blendWithDecay(finalScore, sampleCount, calibrationEntries)
    }

    return Math.max(0, Math.min(1, finalScore))
  }

  /**
   * Create a ReputationQueryFn-compatible function for use with resolvePoolWithReputation.
   */
  toQueryFn(): (query: ReputationQuery, options?: ReputationQueryOptions) => Promise<number | null> {
    return (query, options) => this.query(query, options)
  }
}
