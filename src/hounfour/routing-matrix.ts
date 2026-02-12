// src/hounfour/routing-matrix.ts — Native vs Remote Decision Matrix (SDD §4.5, Task 3.4)
//
// Config-driven routing that selects native or remote adapter per model pool.
// Fallback: if native healthCheck fails, route to remote adapter transparently.

import type { ModelPortBase, ModelPortStreaming, HealthStatus } from "./types.js"
import { isStreamingPort } from "./types.js"

// --- Types ---

/** Routing mode for a model pool */
export type RouteMode = "native" | "remote" | "prefer_native"

/** Per-pool routing configuration */
export interface PoolRouteConfig {
  /** Pool identifier (e.g., "qwen3-coder-7b") */
  pool: string
  /** Routing preference */
  mode: RouteMode
  /** Native adapter instance (if available) */
  native?: ModelPortBase | ModelPortStreaming
  /** Remote adapter instance (fallback or primary) */
  remote: ModelPortBase | ModelPortStreaming
}

/** Full routing matrix configuration */
export interface RoutingMatrixConfig {
  /** Per-pool routing entries */
  pools: PoolRouteConfig[]
  /** Health check timeout for native adapters (ms). Default: 5000 */
  healthCheckTimeoutMs?: number
}

/** Routing decision result */
export interface RouteDecision {
  pool: string
  adapter: ModelPortBase | ModelPortStreaming
  source: "native" | "remote"
  fallback: boolean
}

// --- RoutingMatrix ---

/**
 * Config-driven router selecting native or remote adapter per pool.
 *
 * Decision matrix:
 *   - mode=native: always use native adapter (fail if unavailable)
 *   - mode=remote: always use remote adapter
 *   - mode=prefer_native: try native first, fallback to remote on health failure
 */
export class RoutingMatrix {
  private poolMap: Map<string, PoolRouteConfig>
  private healthCheckTimeoutMs: number
  private healthCache: Map<string, { healthy: boolean; timestamp: number }>

  constructor(config: RoutingMatrixConfig) {
    this.poolMap = new Map(config.pools.map((p) => [p.pool, p]))
    this.healthCheckTimeoutMs = config.healthCheckTimeoutMs ?? 5000
    this.healthCache = new Map()
  }

  /**
   * Route a request to the appropriate adapter for a pool.
   *
   * @param pool - Pool identifier
   * @returns Route decision with adapter and metadata
   */
  async route(pool: string): Promise<RouteDecision> {
    const config = this.poolMap.get(pool)
    if (!config) {
      throw new Error(`RoutingMatrix: unknown pool "${pool}"`)
    }

    switch (config.mode) {
      case "remote":
        return { pool, adapter: config.remote, source: "remote", fallback: false }

      case "native":
        if (!config.native) {
          throw new Error(`RoutingMatrix: pool "${pool}" configured as native but no native adapter`)
        }
        return { pool, adapter: config.native, source: "native", fallback: false }

      case "prefer_native": {
        if (!config.native) {
          return { pool, adapter: config.remote, source: "remote", fallback: true }
        }

        const healthy = await this.checkNativeHealth(pool, config.native)
        if (healthy) {
          return { pool, adapter: config.native, source: "native", fallback: false }
        }
        return { pool, adapter: config.remote, source: "remote", fallback: true }
      }

      default:
        throw new Error(`RoutingMatrix: unknown mode "${config.mode}" for pool "${pool}"`)
    }
  }

  /**
   * Check native adapter health with caching (5s TTL).
   * Prevents hammering the health endpoint on every request.
   */
  private async checkNativeHealth(pool: string, adapter: ModelPortBase): Promise<boolean> {
    const cached = this.healthCache.get(pool)
    const now = Date.now()

    // Use cache if fresh (< 5s)
    if (cached && now - cached.timestamp < 5000) {
      return cached.healthy
    }

    try {
      const healthPromise = adapter.healthCheck()
      const timeoutPromise = new Promise<HealthStatus>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), this.healthCheckTimeoutMs),
      )

      const result = await Promise.race([healthPromise, timeoutPromise])
      this.healthCache.set(pool, { healthy: result.healthy, timestamp: now })
      return result.healthy
    } catch {
      this.healthCache.set(pool, { healthy: false, timestamp: now })
      return false
    }
  }

  /** Get all configured pool IDs */
  pools(): string[] {
    return Array.from(this.poolMap.keys())
  }

  /** Get route config for a pool */
  getConfig(pool: string): PoolRouteConfig | undefined {
    return this.poolMap.get(pool)
  }

  /** Invalidate health cache for a pool (force re-check) */
  invalidateHealth(pool: string): void {
    this.healthCache.delete(pool)
  }
}
