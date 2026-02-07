// src/cron/circuit-breaker.ts — Circuit breaker state machine with failure taxonomy (SDD §4.12)

import { EventEmitter } from "node:events"
import type { CircuitBreakerState } from "./types.js"

// ── Types ───────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half_open"

export type FailureClass =
  | "transient"     // Temporary failures (5xx) — counts toward threshold
  | "permanent"     // Permanent failures (422) — counts toward threshold
  | "expected"      // Expected failures (404) — SKIPPED, does not count
  | "external"      // External failures — counts toward threshold
  | "rate_limited"  // GitHub rate limits (429/403+Retry-After) — counts, special backoff

export interface CircuitBreakerConfig {
  failureThreshold?: number     // Default: 5
  rollingWindowMs?: number      // Default: 3600000 (1 hour)
  openDurationMs?: number       // Default: 1800000 (30 minutes)
  halfOpenProbeCount?: number   // Default: 2
  resetOnSuccess?: boolean      // Default: true
}

export type { CircuitBreakerState }

// ── GitHub Failure Classification ───────────────────────────

/** Classify GitHub API errors into failure classes. (SDD §4.12, Flatline IMP-003) */
export function classifyGitHubFailure(statusCode: number, headers?: Record<string, string>): FailureClass {
  if (statusCode === 429) return "rate_limited"
  if (statusCode === 403) {
    const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"]
    if (retryAfter) return "rate_limited"
  }
  if (statusCode >= 500) return "transient"
  if (statusCode === 422) return "permanent"
  if (statusCode === 404) return "expected"
  return "external"
}

// ── CircuitBreaker ──────────────────────────────────────────

export class CircuitBreaker extends EventEmitter {
  private config: Required<CircuitBreakerConfig>
  private _state: CircuitBreakerState
  private readonly now: () => number
  /** Timestamped failure ring buffer for rolling window enforcement. */
  private failureTimestamps: number[] = []

  constructor(config?: CircuitBreakerConfig, now?: () => number) {
    super()
    this.now = now ?? Date.now
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      rollingWindowMs: config?.rollingWindowMs ?? 3_600_000,
      openDurationMs: config?.openDurationMs ?? 1_800_000,
      halfOpenProbeCount: config?.halfOpenProbeCount ?? 2,
      resetOnSuccess: config?.resetOnSuccess ?? true,
    }
    this._state = {
      state: "closed",
      failures: 0,
      successes: 0,
    }
  }

  get state(): CircuitBreakerState { return { ...this._state } }

  /** Check if execution is allowed. Transitions open->half_open if timeout elapsed. */
  canExecute(): boolean {
    if (this._state.state === "closed") return true
    if (this._state.state === "open") {
      const elapsed = this.now() - (this._state.openedAt ?? 0)
      if (elapsed >= this.config.openDurationMs) {
        this.transitionTo("half_open")
        return true
      }
      return false
    }
    // half_open: allow limited probes
    return true
  }

  /** Record a successful execution. */
  recordSuccess(): void {
    if (this._state.state === "half_open") {
      this._state.successes += 1
      if (this._state.successes >= this.config.halfOpenProbeCount) {
        this.transitionTo("closed")
      }
    } else if (this._state.state === "closed" && this.config.resetOnSuccess) {
      this._state.failures = 0
    }
  }

  /** Record a failed execution with failure classification. */
  recordFailure(failureClass: FailureClass): void {
    // Expected failures don't count
    if (failureClass === "expected") return

    if (this._state.state === "half_open") {
      // Any failure in half_open -> back to open
      this.transitionTo("open")
      return
    }

    const currentTime = this.now()
    this._state.lastFailureAt = currentTime

    // Add to rolling window and evict stale entries
    this.failureTimestamps.push(currentTime)
    const windowStart = currentTime - this.config.rollingWindowMs
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts > windowStart)

    // Sync the scalar counter with the rolling window count
    this._state.failures = this.failureTimestamps.length

    if (this._state.state === "closed" && this._state.failures >= this.config.failureThreshold) {
      this.transitionTo("open")
    }
  }

  /** Manual reset to closed state. */
  reset(): void {
    this.transitionTo("closed")
  }

  /** Restore state from persisted data. */
  restoreState(saved: CircuitBreakerState): void {
    this._state = { ...saved }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this._state.state
    this._state.state = newState

    if (newState === "open") {
      this._state.openedAt = this.now()
      this._state.successes = 0
      this.emit("circuit:opened", { from: oldState })
    } else if (newState === "closed") {
      this._state.failures = 0
      this._state.successes = 0
      this._state.openedAt = undefined
      this._state.halfOpenAt = undefined
      this.failureTimestamps = []
      this.emit("circuit:closed", { from: oldState })
    } else if (newState === "half_open") {
      this._state.halfOpenAt = this.now()
      this._state.successes = 0
    }
  }
}
