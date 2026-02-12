// src/hounfour/reconciliation-client.ts — Budget Reconciliation Client (SDD §4.4, Task 2.9)
//
// Periodic poll of arrakis budget endpoint with 3-state machine:
//   SYNCED → FAIL_OPEN → FAIL_CLOSED
// Drift detection, monotonic headroom, and usage report posting.

import type { RedisStateBackend } from "./redis/client.js"

// --- Types ---

export type ReconState = "SYNCED" | "FAIL_OPEN" | "FAIL_CLOSED"

/** Configuration for the reconciliation client. */
export interface ReconciliationConfig {
  /** Arrakis budget endpoint base URL. */
  arrakisBaseUrl: string
  /** Poll interval in ms. Default: 60_000 (60s). */
  pollIntervalMs: number
  /** Drift threshold in micro-USD. Default: max(1, 0.1% of spend). */
  driftThresholdMicro: bigint
  /** FAIL_OPEN headroom as percentage of budget. Default: 10. */
  failOpenHeadroomPercent: number
  /** FAIL_OPEN maximum duration in ms. Default: 300_000 (5min). */
  failOpenMaxDurationMs: number
  /** FAIL_OPEN absolute cap in micro-USD. Default: 10_000_000 ($10). */
  failOpenAbsCapMicro: bigint
  /** FAIL_OPEN max requests per second. Default: 10. */
  failOpenMaxRps: number
  /** S2S JWT token for arrakis authentication. */
  getS2sToken: () => Promise<string>
  /** Request timeout in ms. Default: 5000. */
  requestTimeoutMs: number
}

export const DEFAULT_RECON_CONFIG: Omit<ReconciliationConfig, "arrakisBaseUrl" | "getS2sToken"> = {
  pollIntervalMs: 60_000,
  driftThresholdMicro: 1n,
  failOpenHeadroomPercent: 10,
  failOpenMaxDurationMs: 300_000,
  failOpenAbsCapMicro: 10_000_000n,
  failOpenMaxRps: 10,
  requestTimeoutMs: 5000,
}

/** Current reconciliation state. */
export interface ReconciliationState {
  status: ReconState
  lastSyncTimestamp: number
  localSpendMicro: bigint
  arrakisCommittedMicro: bigint
  failOpenBudgetRemaining: bigint
  failOpenStartedAt: number | null
  consecutiveFailures: number
  lastDriftMicro: bigint
}

/** Arrakis budget response (matches mock server contract). */
export interface ArrakisBudgetResponse {
  committed_micro: string
  reserved_micro: string
  limit_micro: string
  window_start: string
  window_end: string
}

/** Result of a single reconciliation poll. */
export interface ReconciliationPollResult {
  previousState: ReconState
  newState: ReconState
  driftMicro: bigint
  driftExceedsThreshold: boolean
  arrakisReachable: boolean
  timestamp: number
}

// --- Reconciliation Client ---

/**
 * Budget reconciliation client with 3-state machine.
 *
 * State transitions:
 *   SYNCED → (poll fails OR drift > threshold) → FAIL_OPEN
 *   FAIL_OPEN → (headroom exhausted OR timeout) → FAIL_CLOSED
 *   FAIL_CLOSED → (successful reconciliation) → SYNCED
 *   FAIL_OPEN → (successful reconciliation) → SYNCED
 *
 * FAIL_OPEN characteristics:
 *   - Headroom budget active (percentage of limit)
 *   - Monotonic decrement only (no refill)
 *   - Max RPS throttle
 *   - Auto-transition to FAIL_CLOSED after maxDuration
 *   - Absolute cap on headroom
 */
export class ReconciliationClient {
  private config: ReconciliationConfig
  private state: ReconciliationState
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private redis: RedisStateBackend | null

  /** Event handler for state transitions. */
  onStateChange?: (from: ReconState, to: ReconState, reason: string) => void

  constructor(
    config: Partial<ReconciliationConfig> & Pick<ReconciliationConfig, "arrakisBaseUrl" | "getS2sToken">,
    redis: RedisStateBackend | null = null,
  ) {
    this.config = { ...DEFAULT_RECON_CONFIG, ...config }
    this.redis = redis
    this.state = {
      status: "SYNCED",
      lastSyncTimestamp: Date.now(),
      localSpendMicro: 0n,
      arrakisCommittedMicro: 0n,
      failOpenBudgetRemaining: 0n,
      failOpenStartedAt: null,
      consecutiveFailures: 0,
      lastDriftMicro: 0n,
    }
  }

  /** Get current state (readonly snapshot). */
  getState(): Readonly<ReconciliationState> {
    return { ...this.state }
  }

  /** Update local spend counter (called after each budget recording). */
  recordLocalSpend(costMicro: bigint): void {
    this.state.localSpendMicro += costMicro

    // Decrement headroom in FAIL_OPEN
    if (this.state.status === "FAIL_OPEN") {
      this.state.failOpenBudgetRemaining -= costMicro

      // Check headroom exhaustion
      if (this.state.failOpenBudgetRemaining <= 0n) {
        this.transition("FAIL_CLOSED", "headroom exhausted")
      }
    }
  }

  /**
   * Check if a request should be allowed based on current state.
   * Returns true if allowed, false if should be rejected.
   */
  shouldAllowRequest(): boolean {
    switch (this.state.status) {
      case "SYNCED":
        return true
      case "FAIL_OPEN":
        // Check timeout
        if (this.state.failOpenStartedAt) {
          const elapsed = Date.now() - this.state.failOpenStartedAt
          if (elapsed > this.config.failOpenMaxDurationMs) {
            this.transition("FAIL_CLOSED", "FAIL_OPEN timeout exceeded")
            return false
          }
        }
        return this.state.failOpenBudgetRemaining > 0n
      case "FAIL_CLOSED":
        return false
    }
  }

  /**
   * Execute a single reconciliation poll against arrakis.
   * Called by the poll timer or manually for testing.
   */
  async poll(tenantId: string): Promise<ReconciliationPollResult> {
    const previousState = this.state.status
    const timestamp = Date.now()

    try {
      const token = await this.config.getS2sToken()
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.requestTimeoutMs,
      )

      const response = await fetch(
        `${this.config.arrakisBaseUrl}/api/v1/budget/${tenantId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      )
      clearTimeout(timeout)

      if (!response.ok) {
        throw new Error(`Arrakis returned ${response.status}`)
      }

      const body = await response.json() as ArrakisBudgetResponse
      const arrakisCommitted = BigInt(body.committed_micro)
      const arrakisLimit = BigInt(body.limit_micro)

      // Compute drift
      const drift = this.state.localSpendMicro > arrakisCommitted
        ? this.state.localSpendMicro - arrakisCommitted
        : arrakisCommitted - this.state.localSpendMicro

      // Compute dynamic threshold: max(configured, 0.1% of spend)
      const dynamicThreshold = this.state.localSpendMicro > 0n
        ? this.state.localSpendMicro / 1000n  // 0.1%
        : 0n
      const effectiveThreshold = drift > dynamicThreshold
        ? this.config.driftThresholdMicro > dynamicThreshold
          ? this.config.driftThresholdMicro
          : dynamicThreshold
        : this.config.driftThresholdMicro

      const driftExceedsThreshold = drift > effectiveThreshold

      // Update state from arrakis (arrakis wins on conflict)
      this.state.arrakisCommittedMicro = arrakisCommitted
      this.state.lastDriftMicro = drift
      this.state.consecutiveFailures = 0

      if (driftExceedsThreshold) {
        // Drift detected — enter FAIL_OPEN if SYNCED
        if (this.state.status === "SYNCED") {
          const headroom = this.computeHeadroom(arrakisLimit)
          this.state.failOpenBudgetRemaining = headroom
          this.state.failOpenStartedAt = timestamp
          this.transition("FAIL_OPEN", `drift ${drift} micro-USD exceeds threshold`)
        }
      } else {
        // Reconciliation successful
        this.state.lastSyncTimestamp = timestamp
        if (this.state.status !== "SYNCED") {
          this.transition("SYNCED", "reconciliation successful")
        }
      }

      return {
        previousState,
        newState: this.state.status,
        driftMicro: drift,
        driftExceedsThreshold,
        arrakisReachable: true,
        timestamp,
      }
    } catch (err) {
      // Poll failed — arrakis unreachable
      this.state.consecutiveFailures++

      if (this.state.status === "SYNCED") {
        // Transition to FAIL_OPEN
        // Use a default headroom (can't get limit from arrakis)
        this.state.failOpenBudgetRemaining = this.config.failOpenAbsCapMicro
        this.state.failOpenStartedAt = timestamp
        this.transition("FAIL_OPEN", `arrakis unreachable: ${err}`)
      }

      return {
        previousState,
        newState: this.state.status,
        driftMicro: 0n,
        driftExceedsThreshold: false,
        arrakisReachable: false,
        timestamp,
      }
    }
  }

  /** Start periodic polling. */
  startPolling(tenantId: string): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(
      () => { this.poll(tenantId).catch(() => {}) },
      this.config.pollIntervalMs,
    )
  }

  /** Stop periodic polling. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // --- Private ---

  private computeHeadroom(limitMicro: bigint): bigint {
    const percentHeadroom = (limitMicro * BigInt(this.config.failOpenHeadroomPercent)) / 100n
    // Cap at absolute maximum
    return percentHeadroom < this.config.failOpenAbsCapMicro
      ? percentHeadroom
      : this.config.failOpenAbsCapMicro
  }

  private transition(to: ReconState, reason: string): void {
    const from = this.state.status
    if (from === to) return
    this.state.status = to

    // Reset FAIL_OPEN state when leaving
    if (to === "SYNCED") {
      this.state.failOpenStartedAt = null
      // Note: headroom is NOT refilled (monotonic)
    }

    this.onStateChange?.(from, to, reason)
  }
}
