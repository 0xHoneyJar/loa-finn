// src/billing/circuit-breaker.ts — Billing Circuit Breaker (SDD §6.4, Sprint 1 Task 1.4)
//
// 3-state circuit breaker for the arrakis finalize endpoint.
// CLOSED → OPEN (failures threshold) → HALF_OPEN (cooldown) → CLOSED or OPEN

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface CircuitBreakerConfig {
  /** Number of failures in the window to trigger OPEN. Default: 5 */
  failureThreshold: number
  /** Time window for counting failures (ms). Default: 60000 (60s) */
  failureWindowMs: number
  /** Cooldown before transitioning from OPEN to HALF_OPEN (ms). Default: 30000 (30s) */
  cooldownMs: number
  /** Max concurrent FINALIZE_PENDING entries before denying new requests. Default: 50 */
  maxPendingReconciliation: number
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  maxPendingReconciliation: 50,
}

export interface CircuitBreakerMetrics {
  recordStateChange: (from: CircuitState, to: CircuitState) => void
  recordProbeResult: (success: boolean) => void
  recordRejection: (reason: string) => void
}

const noopMetrics: CircuitBreakerMetrics = {
  recordStateChange() {},
  recordProbeResult() {},
  recordRejection() {},
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export class BillingCircuitBreaker {
  private _state: CircuitState = "CLOSED"
  private failures: number[] = [] // timestamps of failures within window
  private lastOpenedAt: number = 0
  private probeInFlight = false
  private readonly config: CircuitBreakerConfig
  private readonly metrics: CircuitBreakerMetrics

  constructor(config?: Partial<CircuitBreakerConfig>, metrics?: CircuitBreakerMetrics) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.metrics = metrics ?? noopMetrics
  }

  get state(): CircuitState {
    // Check if OPEN should transition to HALF_OPEN based on cooldown
    if (this._state === "OPEN") {
      const elapsed = Date.now() - this.lastOpenedAt
      if (elapsed >= this.config.cooldownMs) {
        this.transitionTo("HALF_OPEN")
      }
    }
    return this._state
  }

  /**
   * Check if a request should be allowed through.
   * Returns true if allowed, false if circuit is open.
   */
  allowRequest(): boolean {
    const currentState = this.state // triggers OPEN → HALF_OPEN check

    switch (currentState) {
      case "CLOSED":
        return true

      case "OPEN":
        this.metrics.recordRejection("circuit_open")
        return false

      case "HALF_OPEN":
        // Allow one probe request, reject the rest
        if (!this.probeInFlight) {
          this.probeInFlight = true
          return true
        }
        this.metrics.recordRejection("half_open_probe_in_flight")
        return false

      default:
        return false
    }
  }

  /**
   * Record a successful finalize call.
   */
  recordSuccess(): void {
    if (this._state === "HALF_OPEN") {
      this.probeInFlight = false
      this.metrics.recordProbeResult(true)
      this.transitionTo("CLOSED")
      this.failures = []
    }
    // In CLOSED state, success is a no-op (expected)
  }

  /**
   * Record a failed finalize call.
   */
  recordFailure(): void {
    const now = Date.now()

    if (this._state === "HALF_OPEN") {
      this.probeInFlight = false
      this.metrics.recordProbeResult(false)
      this.transitionTo("OPEN")
      this.lastOpenedAt = now
      return
    }

    if (this._state === "CLOSED") {
      // Add failure, prune old failures outside window
      this.failures.push(now)
      this.pruneOldFailures(now)

      if (this.failures.length >= this.config.failureThreshold) {
        this.transitionTo("OPEN")
        this.lastOpenedAt = now
        this.failures = []
      }
    }
  }

  /**
   * Check if pending reconciliation count exceeds threshold.
   */
  isPendingReconciliationExceeded(currentCount: number): boolean {
    return currentCount >= this.config.maxPendingReconciliation
  }

  /**
   * Get health status for /health endpoint.
   */
  getHealth(): { state: CircuitState; failures_in_window: number } {
    return {
      state: this.state,
      failures_in_window: this.failures.length,
    }
  }

  /**
   * Force reset to CLOSED state (admin action).
   */
  reset(): void {
    this.transitionTo("CLOSED")
    this.failures = []
    this.probeInFlight = false
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private transitionTo(newState: CircuitState): void {
    if (this._state === newState) return
    const from = this._state
    this._state = newState
    this.metrics.recordStateChange(from, newState)
  }

  private pruneOldFailures(now: number): void {
    const cutoff = now - this.config.failureWindowMs
    this.failures = this.failures.filter(t => t > cutoff)
  }
}
