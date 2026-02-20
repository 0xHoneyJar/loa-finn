// src/x402/rpc-pool.ts — RPC Pool with Circuit Breaker (Sprint 2 T2.5)
//
// Multi-provider RPC pool for Base chain reads.
// Alchemy (primary) + public Base RPC (fallback).
// Per-provider circuit breaker: closed/open/half-open.

import { createPublicClient, http, type PublicClient, type Chain } from "viem"
import { base } from "viem/chains"

// ---------------------------------------------------------------------------
// Circuit Breaker (per-provider)
// ---------------------------------------------------------------------------

type CircuitState = "closed" | "open" | "half_open"

interface CircuitBreakerConfig {
  /** Failures before opening (default: 5) */
  failureThreshold: number
  /** Window in ms for failure counting (default: 30_000) */
  failureWindowMs: number
  /** Time in ms before probe attempt (default: 15_000) */
  probeDelayMs: number
}

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 30_000,
  probeDelayMs: 15_000,
}

class ProviderCircuitBreaker {
  private state: CircuitState = "closed"
  private failures: number[] = [] // timestamps of failures
  private lastOpenedAt = 0
  private readonly config: CircuitBreakerConfig

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CB_CONFIG, ...config }
  }

  get currentState(): CircuitState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastOpenedAt
      if (elapsed >= this.config.probeDelayMs) {
        this.state = "half_open"
      }
    }
    return this.state
  }

  get isAvailable(): boolean {
    return this.currentState !== "open"
  }

  recordSuccess(): void {
    this.failures = []
    this.state = "closed"
  }

  recordFailure(): void {
    const now = Date.now()
    const cutoff = now - this.config.failureWindowMs
    this.failures = this.failures.filter((t) => t > cutoff)
    this.failures.push(now)

    if (this.failures.length >= this.config.failureThreshold) {
      this.state = "open"
      this.lastOpenedAt = now
    }
  }
}

// ---------------------------------------------------------------------------
// RPC Provider
// ---------------------------------------------------------------------------

interface RpcProvider {
  name: string
  client: PublicClient
  circuitBreaker: ProviderCircuitBreaker
  priority: number // lower = preferred
}

// ---------------------------------------------------------------------------
// RPC Pool
// ---------------------------------------------------------------------------

export interface RpcPoolConfig {
  /** Alchemy API key (primary provider) */
  alchemyApiKey?: string
  /** Custom RPC URLs in priority order */
  rpcUrls?: string[]
  /** Chain to use (default: Base) */
  chain?: Chain
  /** Circuit breaker config per provider */
  circuitBreaker?: Partial<CircuitBreakerConfig>
}

export class RpcPool {
  private providers: RpcProvider[] = []

  constructor(config: RpcPoolConfig) {
    const chain = config.chain ?? base
    const cbConfig = config.circuitBreaker

    // Primary: Alchemy (if key provided)
    if (config.alchemyApiKey) {
      this.providers.push({
        name: "alchemy",
        client: createPublicClient({
          chain,
          transport: http(`https://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`),
        }),
        circuitBreaker: new ProviderCircuitBreaker(cbConfig),
        priority: 0,
      })
    }

    // Custom RPC URLs
    if (config.rpcUrls) {
      for (let i = 0; i < config.rpcUrls.length; i++) {
        this.providers.push({
          name: `custom-${i}`,
          client: createPublicClient({
            chain,
            transport: http(config.rpcUrls[i]),
          }),
          circuitBreaker: new ProviderCircuitBreaker(cbConfig),
          priority: (config.alchemyApiKey ? 1 : 0) + i,
        })
      }
    }

    // Fallback: public Base RPC (always last)
    this.providers.push({
      name: "public",
      client: createPublicClient({
        chain,
        transport: http(),
      }),
      circuitBreaker: new ProviderCircuitBreaker(cbConfig),
      priority: 999,
    })
  }

  /**
   * Execute an RPC call against available providers.
   * Tries providers in priority order, skipping those with open circuits.
   * Records success/failure on the circuit breaker.
   *
   * @throws Error with code `rpc_unreachable` if all providers fail.
   */
  async execute<T>(fn: (client: PublicClient) => Promise<T>): Promise<T> {
    const sorted = [...this.providers].sort((a, b) => a.priority - b.priority)
    const errors: Array<{ name: string; error: Error }> = []

    for (const provider of sorted) {
      if (!provider.circuitBreaker.isAvailable) {
        errors.push({ name: provider.name, error: new Error("circuit open") })
        continue
      }

      try {
        const result = await fn(provider.client)
        provider.circuitBreaker.recordSuccess()
        return result
      } catch (err) {
        provider.circuitBreaker.recordFailure()
        errors.push({
          name: provider.name,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    }

    // All providers failed
    const details = errors.map((e) => `${e.name}: ${e.error.message}`).join("; ")
    const error = new Error(`All RPC providers failed: ${details}`)
    ;(error as Error & { code: string }).code = "rpc_unreachable"
    throw error
  }

  /**
   * Get health status of all providers.
   */
  getHealth(): Array<{ name: string; state: CircuitState; priority: number }> {
    return this.providers.map((p) => ({
      name: p.name,
      state: p.circuitBreaker.currentState,
      priority: p.priority,
    }))
  }
}
