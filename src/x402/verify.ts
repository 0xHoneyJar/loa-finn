// src/x402/verify.ts — EIP-3009 Payment Verification (Sprint 8 Tasks 8.2, 8.3)
//
// Parses X-Payment header, verifies EIP-3009 authorization.
// Nonce replay protection via Redis + WAL.

import { createHash } from "node:crypto"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { X402Quote, PaymentProof, EIP3009Authorization } from "./types.js"
import { X402Error } from "./types.js"
import { getTracer } from "../tracing/otlp.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyDeps {
  redis: RedisCommandClient
  treasuryAddress: string
  /** Verify EOA signature (ecrecover) */
  verifyEOASignature?: (authorization: EIP3009Authorization) => Promise<boolean>
  /** Verify EIP-1271 smart wallet signature */
  verifyContractSignature?: (authorization: EIP3009Authorization) => Promise<boolean>
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
}

export interface VerificationResult {
  valid: boolean
  payment_id: string
  authorization: EIP3009Authorization
  /** Whether this is an idempotent replay of a used payment */
  idempotent_replay: boolean
}

// ---------------------------------------------------------------------------
// Payment Verification Service
// ---------------------------------------------------------------------------

export class PaymentVerifier {
  private readonly redis: RedisCommandClient
  private readonly treasuryAddress: string
  private readonly verifyEOA: (auth: EIP3009Authorization) => Promise<boolean>
  private readonly verifyContract: ((auth: EIP3009Authorization) => Promise<boolean>) | undefined
  private readonly walAppend: VerifyDeps["walAppend"]

  constructor(deps: VerifyDeps) {
    this.redis = deps.redis
    this.treasuryAddress = deps.treasuryAddress
    this.verifyEOA = deps.verifyEOASignature ?? (async () => false)
    this.verifyContract = deps.verifyContractSignature
    this.walAppend = deps.walAppend
  }

  /**
   * Verify payment proof against a quote.
   */
  async verify(proof: PaymentProof, quote: X402Quote): Promise<VerificationResult> {
    const tracer = getTracer("x402")
    const span = tracer?.startSpan("x402.verify")

    try {
      const auth = proof.authorization
      const paymentId = this.computePaymentId(auth, proof.chain_id)

      span?.setAttribute("payment_id", paymentId)
      span?.setAttribute("wallet_address", auth.from)
      span?.setAttribute("is_replay", false)

      // Verify recipient is treasury
      if (auth.to.toLowerCase() !== this.treasuryAddress.toLowerCase()) {
        throw new X402Error(
          "Payment recipient must be treasury address",
          "INVALID_RECIPIENT",
          402,
        )
      }

      // Verify amount >= quoted max_cost
      const paymentAmount = BigInt(auth.value)
      const quotedCost = BigInt(quote.max_cost)
      if (paymentAmount < quotedCost) {
        throw new X402Error(
          `Insufficient payment: ${auth.value} < ${quote.max_cost}`,
          "INSUFFICIENT_PAYMENT",
          402,
        )
      }

      // Verify not expired
      const now = Math.floor(Date.now() / 1000)
      if (auth.valid_before < now) {
        throw new X402Error(
          "Payment authorization expired",
          "PAYMENT_EXPIRED",
          402,
        )
      }

      // Verify signature (EOA first, then EIP-1271 if available)
      let signatureValid = await this.verifyEOA(auth)
      if (!signatureValid && this.verifyContract) {
        signatureValid = await this.verifyContract(auth)
      }
      if (!signatureValid) {
        throw new X402Error(
          "Invalid payment signature",
          "INVALID_SIGNATURE",
          402,
        )
      }

      // Atomic nonce replay protection via SETNX (fixes TOCTOU race)
      // If the key already exists, this is an idempotent replay.
      // If it does not exist, atomically set it with TTL.
      const existingKey = `x402:payment:${paymentId}`
      const ttl = Math.max(auth.valid_before - now, 60) // At least 60s
      const paymentData = JSON.stringify({
        quote_id: proof.quote_id,
        from: auth.from,
        amount: auth.value,
        timestamp: Date.now(),
      })
      const setResult = await this.redis.set(existingKey, paymentData, "EX", ttl, "NX")
      if (setResult === null) {
        // Key already existed — idempotent replay
        span?.setAttribute("is_replay", true)
        return {
          valid: true,
          payment_id: paymentId,
          authorization: auth,
          idempotent_replay: true,
        }
      }

      // WAL authoritative record
      this.writeAudit("x402_payment", {
        payment_id: paymentId,
        quote_id: proof.quote_id,
        from: auth.from,
        amount: auth.value,
        chain_id: proof.chain_id,
      })

      return {
        valid: true,
        payment_id: paymentId,
        authorization: auth,
        idempotent_replay: false,
      }
    } finally {
      span?.end()
    }
  }

  /**
   * Check if a payment ID has been used (for WAL replay restoration).
   */
  async isPaymentUsed(paymentId: string): Promise<boolean> {
    const key = `x402:payment:${paymentId}`
    const result = await this.redis.get(key)
    return result !== null
  }

  /**
   * Restore a used payment ID from WAL replay.
   */
  async restorePaymentId(paymentId: string, validBefore: number): Promise<void> {
    const key = `x402:payment:${paymentId}`
    const now = Math.floor(Date.now() / 1000)
    const ttl = Math.max(validBefore - now, 60)
    await this.redis.set(key, JSON.stringify({ restored: true, timestamp: Date.now() }), "EX", ttl)
  }

  /**
   * Compute canonical payment ID: SHA-256(chainId:from:to:nonce:value:validBefore)
   * Produces a cryptographically secure 256-bit hash to prevent collisions.
   */
  private computePaymentId(auth: EIP3009Authorization, chainId: number): string {
    const data = [
      String(chainId),
      auth.from.toLowerCase(),
      auth.to.toLowerCase(),
      auth.nonce,
      auth.value,
      String(auth.valid_before),
    ].join(":")
    const sha256hex = createHash("sha256").update(data).digest("hex")
    return `pid_${sha256hex}`
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
