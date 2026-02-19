// src/x402/settlement.ts — Settlement Orchestration (Sprint 8 Task 8.2)
//
// Primary: openx402.ai facilitator executes transferWithAuthorization.
// Fallback: direct on-chain submission via viem.
// Circuit breaker: CLOSED → OPEN (3 failures/60s) → HALF_OPEN (30s) → CLOSED.

import type { EIP3009Authorization, SettlementResult } from "./types.js"
import { X402Error } from "./types.js"
import { getTracer } from "../tracing/otlp.js"

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export class CircuitBreaker {
  private state: CircuitState = "CLOSED"
  private failureCount = 0
  private lastFailureTime = 0
  private readonly failureThreshold: number
  private readonly failureWindowMs: number
  private readonly halfOpenDelayMs: number
  private readonly onStateChange?: (from: CircuitState, to: CircuitState, failureCount: number) => void

  constructor(opts?: {
    threshold?: number
    windowMs?: number
    halfOpenMs?: number
    onStateChange?: (from: CircuitState, to: CircuitState, failureCount: number) => void
  }) {
    this.failureThreshold = opts?.threshold ?? 3
    this.failureWindowMs = opts?.windowMs ?? 60_000
    this.halfOpenDelayMs = opts?.halfOpenMs ?? 30_000
    this.onStateChange = opts?.onStateChange
  }

  get currentState(): CircuitState {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - this.lastFailureTime
      if (elapsed >= this.halfOpenDelayMs) {
        this.emitStateChange(this.state, "HALF_OPEN")
        this.state = "HALF_OPEN"
      }
    }
    return this.state
  }

  get isOpen(): boolean {
    return this.currentState === "OPEN"
  }

  recordSuccess(): void {
    const prev = this.state
    this.failureCount = 0
    this.state = "CLOSED"
    if (prev !== "CLOSED") {
      this.emitStateChange(prev, "CLOSED")
    }
  }

  recordFailure(): void {
    const now = Date.now()

    // Reset if outside failure window
    if (now - this.lastFailureTime > this.failureWindowMs) {
      this.failureCount = 0
    }

    this.failureCount++
    this.lastFailureTime = now

    if (this.failureCount >= this.failureThreshold && this.state !== "OPEN") {
      const prev = this.state
      this.state = "OPEN"
      this.emitStateChange(prev, "OPEN")
    }
  }

  private emitStateChange(from: CircuitState, to: CircuitState): void {
    console.log(JSON.stringify({
      metric: "settlement.circuit.state_change",
      from,
      to,
      failure_count: this.failureCount,
      timestamp: Date.now(),
    }))
    this.onStateChange?.(from, to, this.failureCount)
  }
}

// ---------------------------------------------------------------------------
// Settlement Service
// ---------------------------------------------------------------------------

export interface SettlementDeps {
  /** Submit to openx402.ai facilitator */
  submitToFacilitator?: (auth: EIP3009Authorization) => Promise<SettlementResult>
  /** Submit directly on-chain */
  submitDirect?: (auth: EIP3009Authorization) => Promise<SettlementResult>
  /** Verify transaction receipt on-chain */
  verifyReceipt?: (txHash: string, treasuryAddress: string, expectedAmount: string) => Promise<boolean>
  treasuryAddress: string
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
}

export class SettlementService {
  private readonly facilitatorCB = new CircuitBreaker()
  private readonly submitToFacilitator: ((auth: EIP3009Authorization) => Promise<SettlementResult>) | undefined
  private readonly submitDirect: ((auth: EIP3009Authorization) => Promise<SettlementResult>) | undefined
  private readonly verifyReceipt: ((txHash: string, treasury: string, amount: string) => Promise<boolean>) | undefined
  private readonly treasuryAddress: string
  private readonly walAppend: SettlementDeps["walAppend"]

  constructor(deps: SettlementDeps) {
    this.submitToFacilitator = deps.submitToFacilitator
    this.submitDirect = deps.submitDirect
    this.verifyReceipt = deps.verifyReceipt
    this.treasuryAddress = deps.treasuryAddress
    this.walAppend = deps.walAppend
  }

  get circuitState(): CircuitState {
    return this.facilitatorCB.currentState
  }

  /**
   * Execute settlement: facilitator primary, direct fallback.
   */
  async settle(auth: EIP3009Authorization, quoteId: string): Promise<SettlementResult> {
    const tracer = getTracer("x402")
    const span = tracer?.startSpan("x402.settle")

    try {
      span?.setAttribute("circuit_state", this.facilitatorCB.currentState)

      let result: SettlementResult | null = null

      // Try facilitator first (if available and circuit not open)
      if (this.submitToFacilitator && !this.facilitatorCB.isOpen) {
        try {
          result = await this.submitToFacilitator(auth)
          this.facilitatorCB.recordSuccess()
          span?.setAttribute("method", "facilitator")
        } catch {
          this.facilitatorCB.recordFailure()
          result = null
        }
      }

      // Fallback to direct submission
      if (!result && this.submitDirect) {
        try {
          result = await this.submitDirect(auth)
          span?.setAttribute("method", "direct")
        } catch {
          throw new X402Error(
            "Settlement failed: both facilitator and direct submission failed",
            "SETTLEMENT_FAILED",
            402,
          )
        }
      }

      if (!result) {
        throw new X402Error(
          "Settlement failed: no settlement method available",
          "SETTLEMENT_UNAVAILABLE",
          402,
        )
      }

      span?.setAttribute("tx_hash", result.tx_hash)

      // Verify receipt on-chain
      if (this.verifyReceipt) {
        const verified = await this.verifyReceipt(
          result.tx_hash,
          this.treasuryAddress,
          auth.value,
        )
        if (!verified) {
          throw new X402Error(
            "Settlement verification failed: funds not confirmed at treasury",
            "SETTLEMENT_VERIFICATION_FAILED",
            402,
          )
        }
      }

      // WAL record
      this.writeAudit("x402_settlement", {
        quote_id: quoteId,
        tx_hash: result.tx_hash,
        block_number: result.block_number,
        method: result.method,
        amount: result.amount,
      })

      return result
    } finally {
      span?.end()
    }
  }

  private writeAudit(operation: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("x402", operation, "x402", { ...payload, timestamp: Date.now() })
    } catch {
      // Best-effort
    }
  }
}
