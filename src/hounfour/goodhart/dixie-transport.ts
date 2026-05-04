// src/hounfour/goodhart/dixie-transport.ts — Dixie Transport Layer (SDD §6.3, cycle-035 T-2.3)
//
// Three concrete transports behind DixieTransport interface:
//   Stub (null), HTTP (fetch + circuit breaker), Direct (library import).
//
// DixieHttpTransport: Node.js fetch (undici keep-alive), 300ms timeout,
// circuit breaker (3 failures → open → 5min cooldown → half-open probe).

import { normalizeResponse, type ReputationResponse } from "./reputation-response.js"

// --- Interface ---

export interface DixieTransport {
  getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null>
  shutdown?(): Promise<void>
}

// --- Stub Transport (zero behavioral change) ---

export class DixieStubTransport implements DixieTransport {
  async getReputation(): Promise<null> {
    return null
  }
}

// --- Circuit Breaker (transport-level) ---

type CBState = "closed" | "open" | "half-open"

class TransportCircuitBreaker {
  private state: CBState = "closed"
  private failureCount = 0
  private lastFailureAt = 0
  private readonly threshold: number
  private readonly cooldownMs: number

  constructor(threshold = 3, cooldownMs = 300_000) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  get currentState(): CBState {
    if (this.state === "open" && Date.now() - this.lastFailureAt >= this.cooldownMs) {
      this.state = "half-open"
    }
    return this.state
  }

  canExecute(): boolean {
    const s = this.currentState
    return s === "closed" || s === "half-open"
  }

  recordSuccess(): void {
    this.failureCount = 0
    this.state = "closed"
  }

  recordFailure(): void {
    this.failureCount++
    this.lastFailureAt = Date.now()
    if (this.failureCount >= this.threshold) {
      this.state = "open"
    }
  }

  getStats() {
    return { state: this.currentState, failureCount: this.failureCount }
  }
}

// --- HTTP Transport ---

export interface DixieHttpConfig {
  baseUrl: string
  timeoutMs?: number
  maxConnections?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
}

export class DixieHttpTransport implements DixieTransport {
  private readonly baseOrigin: string
  private readonly timeoutMs: number
  private readonly circuitBreaker: TransportCircuitBreaker
  constructor(config: DixieHttpConfig) {
    const parsed = new URL(config.baseUrl)
    this.baseOrigin = parsed.origin
    this.timeoutMs = config.timeoutMs ?? 300

    this.circuitBreaker = new TransportCircuitBreaker(
      config.circuitBreakerThreshold ?? 3,
      config.circuitBreakerCooldownMs ?? 300_000,
    )
  }

  async getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null> {
    // Circuit breaker check
    if (!this.circuitBreaker.canExecute()) {
      return null
    }

    try {
      // Compose timeout signal with caller's signal
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const signal = options?.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

      const response = await fetch(`${this.baseOrigin}/reputation/${encodeURIComponent(nftId)}`, {
        signal,
        headers: { "Accept": "application/json" },
        // Node.js fetch uses undici internally with keep-alive by default
      })

      if (!response.ok) {
        this.circuitBreaker.recordFailure()
        return null
      }

      const raw = await response.json()
      const result = normalizeResponse(raw)
      this.circuitBreaker.recordSuccess()
      return result
    } catch {
      this.circuitBreaker.recordFailure()
      return null
    }
  }

  async shutdown(): Promise<void> {
    // No-op; reserved for future connection pool cleanup
  }

  get circuitBreakerState() {
    return this.circuitBreaker.getStats()
  }
}

// --- Direct Import Transport ---

export interface DixieReputationStore {
  get(nftId: string): Promise<unknown>
}

export class DixieDirectTransport implements DixieTransport {
  private readonly store: DixieReputationStore

  constructor(store: DixieReputationStore) {
    this.store = store
  }

  async getReputation(nftId: string, options?: { signal?: AbortSignal }): Promise<ReputationResponse | null> {
    if (options?.signal?.aborted) return null
    try {
      const raw = await this.store.get(nftId)
      return normalizeResponse(raw)
    } catch {
      return null
    }
  }
}
