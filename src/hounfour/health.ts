// src/hounfour/health.ts — Health Prober with Circuit Breaker (SDD §4.7, T-16.2)
// Per-provider:model health tracking, circuit breaker state machine, error taxonomy.

import type { HealthProber } from "./cheval-invoker.js"
import type { ResolvedModel, HealthProbeConfig } from "./types.js"
import type { ChevalError } from "./errors.js"

// --- Circuit Breaker Types ---

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface ProviderHealthEntry {
  provider: string
  model: string
  state: CircuitState
  consecutiveFailures: number
  consecutiveSuccesses: number
  lastError?: string
  lastProbeMs: number
  recoveryAt?: number           // Timestamp for OPEN→HALF_OPEN transition
  totalSuccesses: number
  totalFailures: number
}

export interface HealthProberConfig {
  unhealthy_threshold: number   // Consecutive failures before OPEN (default: 3)
  recovery_threshold: number    // Successes in HALF_OPEN before CLOSED (default: 1)
  recovery_interval_ms: number  // OPEN→HALF_OPEN delay (default: 30000)
  recovery_jitter_percent: number // ±jitter on recovery interval (default: 20)
}

const DEFAULT_HEALTH_CONFIG: HealthProberConfig = {
  unhealthy_threshold: 3,
  recovery_threshold: 1,
  recovery_interval_ms: 30_000,
  recovery_jitter_percent: 20,
}

// --- Error Taxonomy ---
// Per SDD §4.7 SKP-004:
// 429 → NOT health failure (rate limit)
// 401/403 → NOT health failure (auth)
// 400/404 → NOT health failure (client error)
// 5xx, timeout, connection refused → IS health failure

const NON_HEALTH_STATUS_CODES = new Set([429, 401, 403, 400, 404])
const NON_HEALTH_ERROR_CODES = new Set(["rate_limited", "auth_error"])

function isHealthFailure(error: Error): boolean {
  const chevalErr = error as Partial<ChevalError>
  // Check status code
  if (chevalErr.statusCode !== undefined && NON_HEALTH_STATUS_CODES.has(chevalErr.statusCode)) {
    return false
  }
  // Check error code
  if (chevalErr.code !== undefined && NON_HEALTH_ERROR_CODES.has(chevalErr.code as string)) {
    return false
  }
  return true
}

// --- State Transition Logger ---

export interface WALLike {
  append(type: string, operation: string, path: string, data: unknown): string
}

// --- Full HealthProber ---

export class FullHealthProber implements HealthProber {
  private healthState = new Map<string, ProviderHealthEntry>()
  private config: HealthProberConfig
  private wal?: WALLike
  private clock: () => number

  constructor(
    config?: Partial<HealthProberConfig>,
    opts?: { wal?: WALLike; clock?: () => number },
  ) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config }
    this.wal = opts?.wal
    this.clock = opts?.clock ?? Date.now
  }

  private key(provider: string, modelId: string): string {
    return `${provider}:${modelId}`
  }

  private getOrCreate(provider: string, model: string): ProviderHealthEntry {
    const k = this.key(provider, model)
    let entry = this.healthState.get(k)
    if (!entry) {
      entry = {
        provider,
        model,
        state: "CLOSED",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastProbeMs: this.clock(),
        totalSuccesses: 0,
        totalFailures: 0,
      }
      this.healthState.set(k, entry)
    }
    return entry
  }

  recordSuccess(provider: string, modelId: string): void {
    const entry = this.getOrCreate(provider, modelId)
    entry.totalSuccesses++
    entry.consecutiveFailures = 0
    entry.lastProbeMs = this.clock()

    // If a success arrives while OPEN, treat it as a HALF_OPEN trial
    if (entry.state === "OPEN") {
      this.transition(entry, "HALF_OPEN")
    }

    // Count success after any state change to avoid wiping it
    entry.consecutiveSuccesses++

    if (entry.state === "HALF_OPEN") {
      if (entry.consecutiveSuccesses >= this.config.recovery_threshold) {
        this.transition(entry, "CLOSED")
      }
    }
  }

  recordFailure(provider: string, modelId: string, error?: Error): void {
    // Apply error taxonomy — only health failures affect circuit breaker
    if (error && !isHealthFailure(error)) {
      return
    }

    const entry = this.getOrCreate(provider, modelId)
    entry.totalFailures++
    entry.consecutiveFailures++
    entry.consecutiveSuccesses = 0
    entry.lastError = error?.message
    entry.lastProbeMs = this.clock()

    if (entry.state === "CLOSED") {
      if (entry.consecutiveFailures >= this.config.unhealthy_threshold) {
        this.transition(entry, "OPEN")
        entry.recoveryAt = this.calculateRecoveryAt()
      }
    } else if (entry.state === "HALF_OPEN") {
      // Any failure in HALF_OPEN → back to OPEN
      this.transition(entry, "OPEN")
      entry.recoveryAt = this.calculateRecoveryAt()
    }
  }

  isHealthy(resolved: ResolvedModel): boolean {
    const k = this.key(resolved.provider, resolved.modelId)
    const entry = this.healthState.get(k)
    if (!entry) return true // Unknown = healthy (optimistic)

    if (entry.state === "CLOSED") return true
    if (entry.state === "HALF_OPEN") return true // Allow trial request

    // OPEN: ensure recoveryAt is set, then check if elapsed
    if (entry.state === "OPEN") {
      if (!entry.recoveryAt) {
        entry.recoveryAt = this.calculateRecoveryAt()
        return false
      }
      if (this.clock() >= entry.recoveryAt) {
        this.transition(entry, "HALF_OPEN")
        return true
      }
    }

    return false
  }

  /** Snapshot for dashboard / health aggregator */
  getStats(): Record<string, {
    state: CircuitState
    successes: number
    failures: number
    consecutiveFailures: number
    lastError?: string
    lastFailure?: string
    recoveryAt?: string
  }> {
    const stats: Record<string, {
      state: CircuitState
      successes: number
      failures: number
      consecutiveFailures: number
      lastError?: string
      lastFailure?: string
      recoveryAt?: string
    }> = {}
    for (const [key, entry] of this.healthState) {
      stats[key] = {
        state: entry.state,
        successes: entry.totalSuccesses,
        failures: entry.totalFailures,
        consecutiveFailures: entry.consecutiveFailures,
        lastError: entry.lastError,
        recoveryAt: entry.recoveryAt ? new Date(entry.recoveryAt).toISOString() : undefined,
      }
    }
    return stats
  }

  /** Full snapshot with per-provider:model entries */
  snapshot(): ProviderHealthEntry[] {
    return Array.from(this.healthState.values())
  }

  // --- Private helpers ---

  private transition(entry: ProviderHealthEntry, newState: CircuitState): void {
    const oldState = entry.state
    entry.state = newState

    if (newState === "CLOSED") {
      entry.consecutiveFailures = 0
      entry.recoveryAt = undefined
    }

    if (newState === "HALF_OPEN") {
      entry.consecutiveSuccesses = 0
    }

    // Log transition to WAL
    this.wal?.append(
      "config",
      "update",
      `circuit-breaker/${entry.provider}:${entry.model}`,
      {
        provider: entry.provider,
        model: entry.model,
        from: oldState,
        to: newState,
        consecutiveFailures: entry.consecutiveFailures,
        lastError: entry.lastError,
      },
    )
  }

  private calculateRecoveryAt(): number {
    const base = this.config.recovery_interval_ms
    const jitterRange = base * (this.config.recovery_jitter_percent / 100)
    const jitter = (Math.random() * 2 - 1) * jitterRange
    return this.clock() + base + jitter
  }
}

// --- StubHealthProber (backward compatibility) ---

/**
 * Stub HealthProber — always returns healthy.
 * Records success/failure counts for observability but does not trip circuits.
 * Preserved for backward compatibility — new code should use FullHealthProber.
 */
export class StubHealthProber implements HealthProber {
  private records = new Map<string, { successes: number; failures: number; lastFailure?: Date }>()

  private key(provider: string, modelId: string): string {
    return `${provider}:${modelId}`
  }

  recordSuccess(provider: string, modelId: string): void {
    const k = this.key(provider, modelId)
    const record = this.records.get(k) ?? { successes: 0, failures: 0 }
    record.successes++
    this.records.set(k, record)
  }

  recordFailure(provider: string, modelId: string, _error?: Error): void {
    const k = this.key(provider, modelId)
    const record = this.records.get(k) ?? { successes: 0, failures: 0 }
    record.failures++
    record.lastFailure = new Date()
    this.records.set(k, record)
  }

  isHealthy(_resolved: ResolvedModel): boolean {
    return true
  }

  getStats(): Record<string, { successes: number; failures: number; lastFailure?: string }> {
    const stats: Record<string, { successes: number; failures: number; lastFailure?: string }> = {}
    for (const [key, record] of this.records) {
      stats[key] = {
        successes: record.successes,
        failures: record.failures,
        lastFailure: record.lastFailure?.toISOString(),
      }
    }
    return stats
  }
}
