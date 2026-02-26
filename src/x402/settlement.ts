// src/x402/settlement.ts — Settlement Orchestration (Sprint 8 Task 8.2)
//
// Primary: openx402.ai facilitator executes transferWithAuthorization.
// Fallback: direct on-chain submission via viem.
// Circuit breaker: CLOSED → OPEN (3 failures/60s) → HALF_OPEN (30s) → CLOSED.

import type { EIP3009Authorization, SettlementResult } from "./types.js"
import { X402Error } from "./types.js"
import { getTracer } from "../tracing/otlp.js"
import type { SettlementStore } from "./settlement-store.js"
import { buildIdempotencyKey } from "./settlement-store.js"
import { resolveChainConfig } from "./types.js"
import type { ChainConfig } from "./types.js"
import type { ResilientAuditLogger } from "../hounfour/audit/audit-fallback.js"

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
      let facilitatorError: Error | null = null
      if (this.submitToFacilitator && !this.facilitatorCB.isOpen) {
        try {
          result = await this.submitToFacilitator(auth)
          this.facilitatorCB.recordSuccess()
          span?.setAttribute("method", "facilitator")
        } catch (err) {
          facilitatorError = err instanceof Error ? err : new Error(String(err))
          this.facilitatorCB.recordFailure()
          console.warn(JSON.stringify({
            metric: "settlement.facilitator.error",
            error: facilitatorError.message,
            circuit_state: this.facilitatorCB.currentState,
            timestamp: Date.now(),
          }))
          result = null
        }
      }

      // Fallback to direct submission
      if (!result && this.submitDirect) {
        try {
          result = await this.submitDirect(auth)
          span?.setAttribute("method", "direct")
        } catch (err) {
          const directError = err instanceof Error ? err : new Error(String(err))
          throw new X402Error(
            `Settlement failed: facilitator=${facilitatorError?.message ?? "skipped"}, direct=${directError.message}`,
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

// ---------------------------------------------------------------------------
// MerchantRelayer — DynamoDB-backed settlement state machine (SDD §4.4.1, T-3.2)
// ---------------------------------------------------------------------------

/** Clock skew allowance for validAfter/validBefore window check (30 seconds). */
const CLOCK_SKEW_SECONDS = 30

/** Default confirmation timeout for on-chain tx (60 seconds, T-4.1). */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000

/** Default max concurrent settlements (semaphore). */
const DEFAULT_MAX_CONCURRENT_SETTLEMENTS = 5

export interface MerchantRelayerDeps {
  store: SettlementStore
  settlementService: SettlementService
  /** Wait for on-chain confirmation. Returns SettlementResult or throws. */
  waitForConfirmation?: (txHash: string, timeoutMs: number) => Promise<SettlementResult>
  confirmationTimeoutMs?: number
  maxConcurrentSettlements?: number
  /** Optional audit logger for tamper-evident settlement log (T-4.7). */
  auditLogger?: ResilientAuditLogger
  /** Chain config override. Defaults to resolveChainConfig() (T-4.1). */
  chainConfig?: ChainConfig
}

export interface MerchantRelayerResult {
  idempotencyKey: string
  txHash: string
  status: "confirmed"
  /** True if this was a cached idempotent replay. */
  idempotent: boolean
}

export class MerchantRelayer {
  private readonly store: SettlementStore
  private readonly service: SettlementService
  private readonly waitForConfirmation: MerchantRelayerDeps["waitForConfirmation"]
  private readonly confirmationTimeoutMs: number
  private readonly maxConcurrent: number
  private activeConcurrent = 0
  private readonly auditLogger?: ResilientAuditLogger
  private readonly chainConfig: ChainConfig

  constructor(deps: MerchantRelayerDeps) {
    this.store = deps.store
    this.service = deps.settlementService
    this.waitForConfirmation = deps.waitForConfirmation
    this.confirmationTimeoutMs = deps.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS
    this.maxConcurrent = deps.maxConcurrentSettlements ?? DEFAULT_MAX_CONCURRENT_SETTLEMENTS
    this.auditLogger = deps.auditLogger
    this.chainConfig = deps.chainConfig ?? resolveChainConfig()
  }

  /**
   * Execute settlement with DynamoDB-backed state machine.
   *
   * State transitions:
   *   (new) → pending → submitted(txHash) → confirmed | reverted | gas_failed
   *
   * Idempotent: same nonce returns cached confirmed result.
   * Bounded concurrency: max N in-flight settlements.
   */
  async settle(auth: EIP3009Authorization, quoteId: string, chainId?: number): Promise<MerchantRelayerResult> {
    const tracer = getTracer("x402")
    const span = tracer?.startSpan("x402.merchant_relayer.settle")

    try {
      // 0. Preflight: validate validity window (SDD §4.4.1)
      const nowSec = Math.floor(Date.now() / 1000)
      if (nowSec < auth.valid_after - CLOCK_SKEW_SECONDS) {
        throw new X402Error(
          `Authorization not yet valid (validAfter=${auth.valid_after}, now=${nowSec})`,
          "AUTHORIZATION_NOT_YET_VALID",
          402,
        )
      }
      if (nowSec > auth.valid_before + CLOCK_SKEW_SECONDS) {
        throw new X402Error(
          `Authorization expired (validBefore=${auth.valid_before}, now=${nowSec})`,
          "AUTHORIZATION_EXPIRED",
          402,
        )
      }

      const effectiveChainId = chainId ?? this.chainConfig.chainId
      const idempotencyKey = buildIdempotencyKey(effectiveChainId, this.chainConfig.usdcAddress, auth.from, auth.nonce)
      span?.setAttribute("idempotency_key", idempotencyKey)

      // 1. Check existing state
      const existing = await this.store.get(idempotencyKey)

      if (existing) {
        if (existing.status === "confirmed" && existing.txHash) {
          // Idempotent replay — return cached result (AC30c)
          return { idempotencyKey, txHash: existing.txHash, status: "confirmed", idempotent: true }
        }
        if (existing.status === "reverted") {
          throw new X402Error(
            `Settlement previously reverted: ${existing.revertReason ?? "unknown"}`,
            "SETTLEMENT_FAILED",
            402,
          )
        }
        if (existing.status === "gas_failed") {
          throw new X402Error(
            "Settlement previously failed due to insufficient gas",
            "RELAYER_UNAVAILABLE",
            503,
          )
        }
        if (existing.status === "submitted" && existing.txHash) {
          // Resume: wait for confirmation on existing tx
          return this.resumeSettlement(idempotencyKey, existing.txHash, span)
        }
        // pending = another process is handling it — treat as in-flight
        if (existing.status === "pending") {
          throw new X402Error(
            "Settlement already in progress",
            "SETTLEMENT_IN_PROGRESS",
            409,
          )
        }
      }

      // 2. Bounded concurrency check (AC30e)
      if (this.activeConcurrent >= this.maxConcurrent) {
        throw new X402Error(
          `Settlement queue full (${this.activeConcurrent}/${this.maxConcurrent})`,
          "RELAYER_BUSY",
          503,
        )
      }

      // 3. Claim pending slot via conditional write
      const claimed = await this.store.claimPending(idempotencyKey, quoteId)
      if (!claimed) {
        // Race condition: another process claimed it
        throw new X402Error(
          "Settlement already in progress (race)",
          "SETTLEMENT_IN_PROGRESS",
          409,
        )
      }

      this.activeConcurrent++
      // Audit: settlement claimed (best-effort, never blocks settlement)
      void this.auditLogger?.log("settlement_claimed", {
        idempotencyKey, quoteId, from: auth.from, nonce: auth.nonce, chainId: effectiveChainId,
      })
      try {
        // 4. Submit on-chain
        const result = await this.service.settle(auth, quoteId)
        span?.setAttribute("tx_hash", result.tx_hash)

        // 5. Update state to submitted
        await this.store.update(idempotencyKey, {
          status: "submitted",
          txHash: result.tx_hash,
        })

        // 6. Wait for confirmation (AC30b: inference only after receipt confirmed)
        if (this.waitForConfirmation) {
          try {
            await this.waitForConfirmation(result.tx_hash, this.confirmationTimeoutMs)
            await this.store.update(idempotencyKey, { status: "confirmed" })
          } catch (err) {
            // Timeout = tx still pending — 503 Retry-After (AC30f)
            if (isTimeoutError(err)) {
              throw new X402Error(
                "Settlement confirmation timeout — transaction still pending",
                "SETTLEMENT_TIMEOUT",
                503,
              )
            }
            // Gas failure (AC30d)
            if (isGasError(err)) {
              await this.store.update(idempotencyKey, { status: "gas_failed" })
              throw new X402Error(
                "Settlement failed: insufficient relayer gas",
                "RELAYER_UNAVAILABLE",
                503,
              )
            }
            // Reverted
            await this.store.update(idempotencyKey, {
              status: "reverted",
              revertReason: err instanceof Error ? err.message : String(err),
            })
            throw new X402Error(
              `Settlement reverted: ${err instanceof Error ? err.message : String(err)}`,
              "SETTLEMENT_FAILED",
              402,
            )
          }
        } else {
          // No confirmation waiter — mark confirmed optimistically
          await this.store.update(idempotencyKey, { status: "confirmed" })
        }

        // Audit: settlement confirmed
        void this.auditLogger?.log("settlement_confirmed", {
          idempotencyKey, txHash: result.tx_hash, quoteId, chainId: effectiveChainId,
        })
        return {
          idempotencyKey,
          txHash: result.tx_hash,
          status: "confirmed",
          idempotent: false,
        }
      } finally {
        this.activeConcurrent--
      }
    } finally {
      span?.end()
    }
  }

  private async resumeSettlement(
    idempotencyKey: string,
    txHash: string,
    span?: { setAttribute(key: string, value: string): void },
  ): Promise<MerchantRelayerResult> {
    span?.setAttribute("resume", "true")

    if (this.waitForConfirmation) {
      try {
        await this.waitForConfirmation(txHash, this.confirmationTimeoutMs)
        await this.store.update(idempotencyKey, { status: "confirmed" })
      } catch (err) {
        if (isTimeoutError(err)) {
          throw new X402Error(
            "Settlement confirmation timeout on resume",
            "SETTLEMENT_TIMEOUT",
            503,
          )
        }
        throw new X402Error(
          `Settlement resume failed: ${err instanceof Error ? err.message : String(err)}`,
          "SETTLEMENT_FAILED",
          402,
        )
      }
    } else {
      await this.store.update(idempotencyKey, { status: "confirmed" })
    }

    return { idempotencyKey, txHash, status: "confirmed", idempotent: false }
  }

  /** Current number of in-flight settlements. */
  get activeSettlements(): number {
    return this.activeConcurrent
  }
}

// ---------------------------------------------------------------------------
// Error Classification Helpers
// ---------------------------------------------------------------------------

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes("timeout") || err.message.includes("TIMEOUT")
  }
  return false
}

function isGasError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes("insufficient funds") ||
      err.message.includes("gas") ||
      err.message.includes("INSUFFICIENT_FUNDS")
  }
  return false
}
