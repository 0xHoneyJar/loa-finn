// src/hounfour/goodhart/exploration.ts — Epsilon-Greedy Exploration Engine (SDD §4.1.2, cycle-034)
//
// Bernoulli coin flip with candidate set filtering:
//   circuit breaker state, pool capabilities, cost ceiling, blocklist.
// Authoritative tier: epsilon = 0 (never explores).

import type { RedisCommandClient } from "../redis/client.js"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../nft-routing-config.js"

// --- Types ---

export interface ExplorationConfig {
  /** Epsilon per tier (e.g., { "enterprise": 0.0, "standard": 0.05 }) */
  epsilonByTier: Record<string, number>
  /** Default epsilon when tier not in epsilonByTier */
  defaultEpsilon: number
  /** Pools that must never be explored */
  blocklist: ReadonlySet<PoolId>
  /** Max cost multiplier relative to default pool (default: 2.0) */
  costCeiling: number
  /** Redis for observability counters (best-effort) */
  redis: RedisCommandClient
}

export interface ExplorationDecision {
  explore: boolean
  candidateSetSize: number
  selectedPool?: PoolId
  randomValue: number
  reason?: string
}

// --- Engine ---

export class ExplorationEngine {
  private readonly config: ExplorationConfig

  constructor(config: ExplorationConfig) {
    this.config = config
  }

  /**
   * Decide whether to explore and, if so, select a random candidate pool.
   *
   * Candidate filtering (SDD §4.1.2):
   * 1. Circuit breaker must be "closed" or "half-open" (exclude "open")
   * 2. Pool must support the requested routingKey (if capabilities map has entry)
   * 3. Pool cost must be <= costCeiling * defaultPoolCost
   * 4. Pool must not be in blocklist
   */
  decide(
    tier: string,
    accessiblePools: readonly PoolId[],
    circuitBreakerStates: Map<PoolId, "closed" | "half-open" | "open">,
    poolCosts: Map<PoolId, number>,
    defaultPoolCost: number,
    routingKey: NFTRoutingKey,
    poolCapabilities: Map<PoolId, Set<NFTRoutingKey>>,
  ): ExplorationDecision {
    const epsilon = this.config.epsilonByTier[tier] ?? this.config.defaultEpsilon
    const randomValue = Math.random()

    // Bernoulli coin flip
    if (randomValue >= epsilon) {
      return { explore: false, candidateSetSize: 0, randomValue }
    }

    // Build candidate set with filtering
    const candidates: PoolId[] = []
    const maxCost = this.config.costCeiling * defaultPoolCost

    for (const poolId of accessiblePools) {
      // 1. Circuit breaker check
      const cbState = circuitBreakerStates.get(poolId) ?? "closed"
      if (cbState === "open") continue

      // 2. Capability check
      const capabilities = poolCapabilities.get(poolId)
      if (capabilities && !capabilities.has(routingKey)) continue

      // 3. Cost ceiling check
      const cost = poolCosts.get(poolId)
      if (cost !== undefined && cost > maxCost) continue

      // 4. Blocklist check
      if (this.config.blocklist.has(poolId)) continue

      candidates.push(poolId)
    }

    if (candidates.length === 0) {
      return {
        explore: true,
        candidateSetSize: 0,
        randomValue,
        reason: "exploration_skipped",
      }
    }

    // Uniform random selection from candidates
    const selectedIdx = Math.floor(Math.random() * candidates.length)
    const selectedPool = candidates[selectedIdx]

    return {
      explore: true,
      candidateSetSize: candidates.length,
      selectedPool,
      randomValue,
    }
  }

  /** Record exploration event for observability. Best-effort, swallows errors. */
  async recordExploration(tier: string): Promise<void> {
    try {
      const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
      const key = `finn:explore:count:${tier}:${date}`
      await this.config.redis.incrby(key, 1)
      await this.config.redis.expire(key, 172800) // 48h TTL
    } catch {
      // Best-effort observability — don't fail the request
    }
  }
}
