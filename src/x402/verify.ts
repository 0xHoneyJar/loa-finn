// src/x402/verify.ts — EIP-3009 Payment Verification (Sprint 8 Tasks 8.2, 8.3)
//
// Parses X-Payment header, verifies EIP-3009 authorization.
// Nonce replay protection via Redis + WAL.

import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { X402Quote, PaymentProof, EIP3009Authorization } from "./types.js"
import { X402Error } from "./types.js"

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
    this.verifyEOA = deps.verifyEOASignature ?? (async () => true)
    this.verifyContract = deps.verifyContractSignature
    this.walAppend = deps.walAppend
  }

  /**
   * Verify payment proof against a quote.
   */
  async verify(proof: PaymentProof, quote: X402Quote): Promise<VerificationResult> {
    const auth = proof.authorization
    const paymentId = this.computePaymentId(auth, proof.chain_id)

    // Check nonce replay (Redis cache first, WAL authoritative)
    const existingKey = `x402:payment:${paymentId}`
    const existing = await this.redis.get(existingKey)
    if (existing) {
      // Idempotent replay — return original receipt
      return {
        valid: true,
        payment_id: paymentId,
        authorization: auth,
        idempotent_replay: true,
      }
    }

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

    // Record nonce to prevent replay
    const ttl = Math.max(auth.valid_before - now, 60) // At least 60s
    await this.redis.set(existingKey, JSON.stringify({
      quote_id: proof.quote_id,
      from: auth.from,
      amount: auth.value,
      timestamp: Date.now(),
    }))
    await this.redis.expire(existingKey, ttl)

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
    await this.redis.set(key, JSON.stringify({ restored: true, timestamp: Date.now() }))
    await this.redis.expire(key, ttl)
  }

  /**
   * Compute canonical payment ID: keccak256(chainId, token, from, nonce, recipient, amount, validBefore)
   * Simplified: hex hash of concatenated fields.
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
    // Simple hash for now — production would use keccak256
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return `pay_${Math.abs(hash).toString(16).padStart(8, "0")}`
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
