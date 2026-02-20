// src/x402/receipt-verifier.ts — On-Chain Receipt Verification (Sprint 2 T2.4)
//
// Full x402 receipt verification algorithm (SDD §4.2.2):
// 1. Fetch challenge by nonce from Redis
// 2. Verify HMAC integrity + expiry + request_binding
// 3. getTransactionReceipt from Base RPC
// 4. Check receipt.status === "success"
// 5. Check confirmation depth >= minConfirmations
// 6. Parse Transfer logs with STRICT matching
// 7. Atomic Lua script: consume nonce + set replay key
//
// Challenge validation BEFORE on-chain checks.
// Replay protection LAST (prevents replay cache poisoning).

import { type Log, parseAbiItem, decodeEventLog } from "viem"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { RpcPool } from "./rpc-pool.js"
import {
  type X402Challenge,
  verifyChallenge,
  computeRequestBinding,
} from "./hmac.js"
import {
  atomicVerify,
  getChallenge,
  VerifyAtomicResult,
} from "./atomic-verify.js"
import { USDC_BASE_ADDRESS } from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifiedReceipt {
  tx_hash: string
  sender: string
  amount: string
  block_number: bigint
  confirmations: number
}

export interface ReceiptVerifierDeps {
  redis: RedisCommandClient
  rpcPool: RpcPool
  /** HMAC challenge secret (current) */
  challengeSecret: string
  /** Previous HMAC secret for rotation grace period (T2.8) */
  challengeSecretPrevious?: string
  /** Minimum confirmation depth (default: 10) */
  minConfirmations?: number
  /** USDC contract address (default: Base USDC) */
  usdcAddress?: string
  /** Record verification failure callback (T2.7) */
  onVerificationFailure?: (failure: VerificationFailure) => Promise<void>
}

export interface VerificationFailure {
  tx_hash: string | null
  reason: string
  metadata: Record<string, unknown>
}

export interface VerifyReceiptParams {
  tx_hash: string
  nonce: string
  request_path: string
  request_method: string
  token_id: string
  model: string
  max_tokens: number
}

// ---------------------------------------------------------------------------
// USDC Transfer event ABI
// ---------------------------------------------------------------------------

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
)

// ---------------------------------------------------------------------------
// X402 Receipt Verifier
// ---------------------------------------------------------------------------

export class X402ReceiptVerifier {
  private readonly redis: RedisCommandClient
  private readonly rpcPool: RpcPool
  private readonly challengeSecret: string
  private readonly challengeSecretPrevious: string | undefined
  private readonly minConfirmations: number
  private readonly usdcAddress: string
  private readonly onFailure: ReceiptVerifierDeps["onVerificationFailure"]

  constructor(deps: ReceiptVerifierDeps) {
    this.redis = deps.redis
    this.rpcPool = deps.rpcPool
    this.challengeSecret = deps.challengeSecret
    this.challengeSecretPrevious = deps.challengeSecretPrevious
    this.minConfirmations = deps.minConfirmations ?? 10
    this.usdcAddress = (deps.usdcAddress ?? USDC_BASE_ADDRESS).toLowerCase()
    this.onFailure = deps.onVerificationFailure
  }

  /**
   * Full verification algorithm (SDD §4.2.2).
   * Strict ordering: challenge → HMAC → on-chain → atomic replay protection.
   */
  async verify(params: VerifyReceiptParams): Promise<VerifiedReceipt> {
    // Step 1: Fetch challenge by nonce from Redis
    const challengeJson = await getChallenge(this.redis, params.nonce)
    if (!challengeJson) {
      await this.recordFailure(params.tx_hash, "nonce_not_found", {
        nonce: params.nonce,
      })
      throw new X402VerifyError("Challenge not found or expired", "nonce_not_found", 402)
    }

    let challenge: X402Challenge
    try {
      challenge = JSON.parse(challengeJson) as X402Challenge
    } catch {
      await this.recordFailure(params.tx_hash, "challenge_corrupt", {
        nonce: params.nonce,
      })
      throw new X402VerifyError("Challenge data corrupted", "challenge_corrupt", 402)
    }

    // Step 2: Verify HMAC integrity (try current secret, then previous for rotation)
    const hmacValid = this.verifyHmacWithRotation(challenge)
    if (!hmacValid) {
      await this.recordFailure(params.tx_hash, "hmac_invalid", {
        nonce: params.nonce,
      })
      throw new X402VerifyError("Challenge HMAC verification failed", "hmac_invalid", 402)
    }

    // Step 2b: Verify challenge expiry
    const now = Math.floor(Date.now() / 1000)
    if (challenge.expiry < now) {
      await this.recordFailure(params.tx_hash, "challenge_expired", {
        nonce: params.nonce,
        expiry: challenge.expiry,
        now,
      })
      throw new X402VerifyError("Challenge has expired", "challenge_expired", 402)
    }

    // Step 2c: Verify request binding matches
    const expectedBinding = computeRequestBinding({
      token_id: params.token_id,
      model: params.model,
      max_tokens: params.max_tokens,
    })
    if (challenge.request_binding !== expectedBinding) {
      await this.recordFailure(params.tx_hash, "binding_mismatch", {
        nonce: params.nonce,
        expected: expectedBinding,
        actual: challenge.request_binding,
      })
      throw new X402VerifyError(
        "Request binding mismatch — receipt does not match this request",
        "binding_mismatch",
        402,
      )
    }

    // Step 2d: Verify request path and method match
    if (
      challenge.request_path !== params.request_path ||
      challenge.request_method !== params.request_method
    ) {
      await this.recordFailure(params.tx_hash, "path_mismatch", {
        nonce: params.nonce,
        expected_path: challenge.request_path,
        actual_path: params.request_path,
      })
      throw new X402VerifyError(
        "Request path/method mismatch",
        "path_mismatch",
        402,
      )
    }

    // Step 3: Get transaction receipt from Base RPC
    let receipt: Awaited<ReturnType<typeof this.getTransactionReceipt>>
    try {
      receipt = await this.getTransactionReceipt(params.tx_hash)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if ((error as Error & { code?: string }).code === "rpc_unreachable") {
        await this.recordFailure(params.tx_hash, "rpc_unreachable", {
          error: error.message,
        })
        throw new X402VerifyError("RPC providers unreachable", "rpc_unreachable", 503)
      }
      await this.recordFailure(params.tx_hash, "rpc_error", {
        error: error.message,
      })
      throw new X402VerifyError(`RPC error: ${error.message}`, "rpc_error", 503)
    }

    if (!receipt) {
      await this.recordFailure(params.tx_hash, "tx_not_found", {})
      throw new X402VerifyError("Transaction not found", "tx_not_found", 402)
    }

    // Step 4: Check receipt.status === "success"
    if (receipt.status !== "success") {
      await this.recordFailure(params.tx_hash, "tx_reverted", {
        status: receipt.status,
      })
      throw new X402VerifyError("Transaction reverted", "tx_reverted", 402)
    }

    // Step 5: Check confirmation depth
    let currentBlock: bigint
    try {
      currentBlock = await this.rpcPool.execute((client) =>
        client.getBlockNumber(),
      )
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      await this.recordFailure(params.tx_hash, "rpc_unreachable", {
        phase: "block_number",
        error: error.message,
      })
      throw new X402VerifyError("RPC providers unreachable", "rpc_unreachable", 503)
    }

    const confirmations = Number(currentBlock - receipt.blockNumber)
    if (confirmations < this.minConfirmations) {
      throw new X402VerifyError(
        `Insufficient confirmations: ${confirmations}/${this.minConfirmations}`,
        "pending",
        402,
      )
    }

    // Step 6: Parse Transfer logs with STRICT matching
    const transfer = this.parseTransferLogs(
      receipt.logs,
      challenge.recipient,
      challenge.amount,
    )
    if (!transfer) {
      await this.recordFailure(params.tx_hash, "transfer_not_found", {
        recipient: challenge.recipient,
        amount: challenge.amount,
        log_count: receipt.logs.length,
      })
      throw new X402VerifyError(
        "No matching USDC Transfer found in transaction",
        "transfer_not_found",
        402,
      )
    }

    // Step 7: Atomic Redis Lua script — consume nonce + set replay key
    const atomicResult = await atomicVerify(this.redis, {
      nonce: params.nonce,
      txHash: params.tx_hash,
    })

    switch (atomicResult) {
      case VerifyAtomicResult.SUCCESS:
        break
      case VerifyAtomicResult.NONCE_NOT_FOUND:
        throw new X402VerifyError("Challenge expired during verification", "nonce_expired", 402)
      case VerifyAtomicResult.REPLAY_DETECTED:
        await this.recordFailure(params.tx_hash, "replay_detected", {
          nonce: params.nonce,
        })
        throw new X402VerifyError("Transaction already used", "replay_detected", 402)
      case VerifyAtomicResult.RACE_LOST:
        throw new X402VerifyError("Concurrent verification in progress", "race_lost", 402)
    }

    return {
      tx_hash: params.tx_hash,
      sender: transfer.from,
      amount: transfer.value.toString(),
      block_number: receipt.blockNumber,
      confirmations,
    }
  }

  // -------------------------------------------------------------------------
  // HMAC verification with rotation support (T2.8)
  // -------------------------------------------------------------------------

  private verifyHmacWithRotation(challenge: X402Challenge): boolean {
    // Try current secret first
    if (verifyChallenge(challenge, this.challengeSecret)) {
      return true
    }
    // Try previous secret during rotation grace window
    if (this.challengeSecretPrevious) {
      return verifyChallenge(challenge, this.challengeSecretPrevious)
    }
    return false
  }

  // -------------------------------------------------------------------------
  // On-chain reads
  // -------------------------------------------------------------------------

  private async getTransactionReceipt(txHash: string) {
    return this.rpcPool.execute((client) =>
      client.getTransactionReceipt({ hash: txHash as `0x${string}` }),
    )
  }

  // -------------------------------------------------------------------------
  // Transfer log parsing (Step 6)
  // -------------------------------------------------------------------------

  /**
   * Parse Transfer logs with STRICT matching:
   * - Emitter === USDC contract address
   * - to === recipient (case-insensitive)
   * - value === challenged amount (exact match)
   * - Exactly ONE matching Transfer log (fail-closed on multiple)
   *
   * Payer identity is NOT bound to tx.from to support smart contract
   * wallets and relayers (SDD §4.2.2, PRD FR-2.2).
   */
  private parseTransferLogs(
    logs: Log[],
    recipient: string,
    amount: string,
  ): { from: string; to: string; value: bigint } | null {
    const expectedAmount = BigInt(amount)
    const expectedRecipient = recipient.toLowerCase()
    const matches: Array<{ from: string; to: string; value: bigint }> = []

    for (const log of logs) {
      // Check emitter is USDC contract
      if (log.address.toLowerCase() !== this.usdcAddress) continue

      // Try to decode as Transfer event
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        })

        if (decoded.eventName !== "Transfer") continue

        const args = decoded.args as { from: `0x${string}`; to: `0x${string}`; value: bigint }

        // Check recipient matches
        if (args.to.toLowerCase() !== expectedRecipient) continue

        // Check exact amount match
        if (args.value !== expectedAmount) continue

        matches.push({
          from: args.from,
          to: args.to,
          value: args.value,
        })
      } catch {
        // Not a Transfer event — skip
        continue
      }
    }

    // Exactly ONE matching Transfer log (fail-closed on multiple)
    if (matches.length !== 1) return null

    return matches[0]
  }

  // -------------------------------------------------------------------------
  // Failure recording (T2.7)
  // -------------------------------------------------------------------------

  private async recordFailure(
    txHash: string | null,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.onFailure) return
    try {
      await this.onFailure({ tx_hash: txHash, reason, metadata })
    } catch {
      // Best-effort — never let failure recording break verification flow
    }
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class X402VerifyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = "X402VerifyError"
  }
}
