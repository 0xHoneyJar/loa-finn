// src/gateway/redis-health.ts — Redis Health + Circuit Breaker (Bridge medium-3, Sprint 2 T2.3)
//
// Graceful degradation when Redis is unavailable:
//   - x402 nonces:    fail-closed (503) — cannot verify payment without nonce store
//   - SIWE nonces:    fail-closed (401) — cannot verify auth without nonce store
//   - Rate limiting:  degrade to in-memory — continue serving, less precision
//   - API key cache:  fall through to DB — slower but functional
//
// Circuit breaker pattern: CLOSED → OPEN → HALF_OPEN → CLOSED
//   - Opens after `failureThreshold` consecutive failures
//   - Stays open for `resetTimeoutMs` then moves to HALF_OPEN
//   - Single probe request in HALF_OPEN: success → CLOSED, failure → OPEN

// ---------------------------------------------------------------------------
// Circuit Breaker States
// ---------------------------------------------------------------------------

export const CircuitState = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
} as const

export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState]

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RedisHealthConfig {
  /** Number of consecutive failures before circuit opens (default: 3) */
  failureThreshold?: number
  /** Milliseconds to wait before probing after circuit opens (default: 30_000) */
  resetTimeoutMs?: number
  /** Callback when circuit state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void
}

// ---------------------------------------------------------------------------
// Redis Health Monitor (Circuit Breaker)
// ---------------------------------------------------------------------------

export class RedisHealthMonitor {
  private state: CircuitState = CircuitState.CLOSED
  private consecutiveFailures = 0
  private lastFailureTime = 0
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void

  constructor(config: RedisHealthConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 3
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000
    this.onStateChange = config.onStateChange
  }

  /** Get current circuit state */
  getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      // Check if reset timeout has elapsed → transition to HALF_OPEN
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transition(CircuitState.HALF_OPEN)
      }
    }
    return this.state
  }

  /** Report a successful Redis operation */
  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      // Probe succeeded → close circuit
      this.transition(CircuitState.CLOSED)
    }
    this.consecutiveFailures = 0
  }

  /** Report a failed Redis operation */
  recordFailure(): void {
    this.consecutiveFailures++
    this.lastFailureTime = Date.now()

    if (this.state === CircuitState.HALF_OPEN) {
      // Probe failed → reopen circuit
      this.transition(CircuitState.OPEN)
    } else if (
      this.state === CircuitState.CLOSED &&
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.transition(CircuitState.OPEN)
    }
  }

  /** Whether Redis operations should be attempted */
  isAvailable(): boolean {
    const current = this.getState()
    return current === CircuitState.CLOSED || current === CircuitState.HALF_OPEN
  }

  /** Reset circuit breaker to CLOSED (testing / manual recovery) */
  reset(): void {
    this.consecutiveFailures = 0
    this.lastFailureTime = 0
    if (this.state !== CircuitState.CLOSED) {
      this.transition(CircuitState.CLOSED)
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state
    this.state = to
    if (from !== to) {
      this.onStateChange?.(from, to)
    }
  }
}

// ---------------------------------------------------------------------------
// Degradation Modes
// ---------------------------------------------------------------------------

export const DegradationMode = {
  /** Reject request — cannot operate safely without Redis */
  FAIL_CLOSED: "FAIL_CLOSED",
  /** Use in-memory fallback — reduced accuracy but operational */
  IN_MEMORY_FALLBACK: "IN_MEMORY_FALLBACK",
  /** Fall through to database — slower but correct */
  DB_FALLBACK: "DB_FALLBACK",
} as const

export type DegradationMode = (typeof DegradationMode)[keyof typeof DegradationMode]

/** Subsystem degradation behavior when Redis is unavailable */
export const SUBSYSTEM_DEGRADATION: Record<string, { mode: DegradationMode; httpStatus?: number }> = {
  /** x402 payment nonces — cannot verify without nonce store */
  x402_nonce: { mode: DegradationMode.FAIL_CLOSED, httpStatus: 503 },
  /** SIWE auth nonces — cannot authenticate without nonce store */
  siwe_nonce: { mode: DegradationMode.FAIL_CLOSED, httpStatus: 401 },
  /** Rate limiting — degrade to in-memory token bucket */
  rate_limit: { mode: DegradationMode.IN_MEMORY_FALLBACK },
  /** API key validation cache — fall through to Postgres */
  api_key_cache: { mode: DegradationMode.DB_FALLBACK },
}

// ---------------------------------------------------------------------------
// Redis-Guarded Operation Helper
// ---------------------------------------------------------------------------

export interface RedisGuardedResult<T> {
  ok: boolean
  value?: T
  degraded: boolean
  mode?: DegradationMode
}

/**
 * Execute a Redis operation with circuit breaker protection.
 * On failure, returns the degradation mode for the subsystem.
 */
export async function withRedisGuard<T>(
  monitor: RedisHealthMonitor,
  subsystem: keyof typeof SUBSYSTEM_DEGRADATION,
  fn: () => Promise<T>,
): Promise<RedisGuardedResult<T>> {
  if (!monitor.isAvailable()) {
    const degradation = SUBSYSTEM_DEGRADATION[subsystem]
    return {
      ok: false,
      degraded: true,
      mode: degradation?.mode ?? DegradationMode.FAIL_CLOSED,
    }
  }

  try {
    const value = await fn()
    monitor.recordSuccess()
    return { ok: true, value, degraded: false }
  } catch {
    monitor.recordFailure()
    const degradation = SUBSYSTEM_DEGRADATION[subsystem]
    return {
      ok: false,
      degraded: true,
      mode: degradation?.mode ?? DegradationMode.FAIL_CLOSED,
    }
  }
}
