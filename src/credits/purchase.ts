// src/credits/purchase.ts — Credit Purchase Handler (SDD §5.2, Sprint 2 Task 2.4)
//
// On-chain USDC transfer verification on Base L2 via viem.
// Idempotent via (tx_hash, log_index) dedup key.
// Double-entry ledger: treasury:usdc_received -N, user:{id}:available +N.

import { createPublicClient, http, parseAbiItem, type PublicClient, type Log, getAddress } from "viem"
import { base } from "viem/chains"
import { Hono } from "hono"
import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"
import { parseMicroUSD } from "../hounfour/wire-boundary.js"
import type { CreditUnit } from "../hounfour/wire-boundary.js"
import { parseCreditUnit } from "../hounfour/wire-boundary.js"
import type { BillingEntryId } from "../billing/types.js"
import type { Ledger, JournalEntry } from "../billing/ledger.js"
import {
  userAvailableAccount,
  TREASURY_USDC_RECEIVED,
} from "../billing/ledger.js"
import {
  CREDIT_PACKS,
  isValidPackSize,
  USDC_CONTRACT_ADDRESS,
  MIN_CONFIRMATIONS,
  getTreasuryAddress,
  CreditPurchaseError,
  type CreditPurchaseRequest,
  type CreditPurchaseResult,
  type PaymentProof,
  type VerificationBinding,
} from "./types.js"

// ---------------------------------------------------------------------------
// USDC Transfer event signature
// ---------------------------------------------------------------------------

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CreditPurchaseDeps {
  /** Primary RPC client (Alchemy) */
  primaryClient: PublicClient
  /** Fallback RPC client (public Base RPC) */
  fallbackClient?: PublicClient
  /** WAL append for credit_mint entry */
  walAppend: (entryType: string, payload: unknown) => Promise<string>
  /** Ledger for double-entry journal */
  ledger: Ledger
  /** Redis get for idempotency check */
  redisGet: (key: string) => Promise<string | null>
  /** Redis set for idempotency */
  redisSet: (key: string, value: string, ttlSec: number) => Promise<void>
  /** Redis balance update */
  redisIncrBy: (key: string, amount: bigint) => Promise<void>
  /** Generate billing entry ID */
  generateId: () => BillingEntryId
}

// ---------------------------------------------------------------------------
// Credit Purchase Service
// ---------------------------------------------------------------------------

export class CreditPurchaseService {
  constructor(private deps: CreditPurchaseDeps) {}

  /**
   * Process a credit purchase request.
   *
   * Steps:
   * 1. Validate pack size
   * 2. Check idempotency (tx_hash, log_index)
   * 3. Verify on-chain USDC transfer
   * 4. Check confirmation depth
   * 5. Write WAL credit_mint entry
   * 6. Update ledger (double-entry)
   * 7. Update Redis balance
   * 8. Return result
   */
  async purchase(
    request: CreditPurchaseRequest,
    authenticatedWallet: string,
  ): Promise<CreditPurchaseResult> {
    // 1. Validate pack size
    if (!isValidPackSize(request.pack_size)) {
      throw new CreditPurchaseError("INVALID_PACK_SIZE", `Invalid pack size: ${request.pack_size}. Valid: 500, 1000, 2500`)
    }

    const pack = CREDIT_PACKS[request.pack_size]
    const proof = request.payment_proof

    // Validate chain ID
    if (proof.chain_id !== 8453) {
      throw new CreditPurchaseError("INVALID_PROOF", `Expected chain_id 8453 (Base), got ${proof.chain_id}`)
    }

    // Validate token is USDC
    if (getAddress(proof.token) !== getAddress(USDC_CONTRACT_ADDRESS)) {
      throw new CreditPurchaseError("INVALID_PROOF", "Token must be Base USDC")
    }

    // Validate sender matches authenticated wallet
    if (getAddress(proof.sender) !== getAddress(authenticatedWallet)) {
      throw new CreditPurchaseError("SENDER_MISMATCH", "payment_proof.sender must match authenticated wallet")
    }

    // 2. Check idempotency — find log_index by verifying the tx first
    const binding = await this.verifyTransfer(proof, pack.usdc_amount)

    const dedupKey = `credit:mint:${binding.tx_hash}:${binding.log_index}`
    const existing = await this.deps.redisGet(dedupKey)
    if (existing) {
      const cached = JSON.parse(existing) as CreditPurchaseResult
      return cached
    }

    // 3-4. Transfer verified + confirmations checked (done in verifyTransfer)

    // 5. WAL credit_mint entry
    const billingEntryId = this.deps.generateId()
    const walOffset = await this.deps.walAppend("credit_mint", {
      billing_entry_id: billingEntryId,
      pack_size: request.pack_size,
      credit_units: pack.credit_units,
      payment_proof: proof,
      verification_binding: {
        tx_hash: binding.tx_hash,
        log_index: binding.log_index,
        block_number: binding.block_number.toString(),
        block_hash: binding.block_hash,
      },
      authenticated_wallet: authenticatedWallet,
      idempotency_key: request.idempotency_key,
    })

    // 6. Double-entry ledger
    const creditAmount = parseMicroUSD(String(pack.usdc_amount)) // USDC amount maps 1:1 to MicroUSD at peg
    const journalEntry: JournalEntry = {
      billing_entry_id: billingEntryId,
      event_type: "credit_mint",
      correlation_id: request.idempotency_key,
      postings: [
        { account: TREASURY_USDC_RECEIVED, delta: -(creditAmount as bigint), denom: "MicroUSDC" },
        { account: userAvailableAccount(authenticatedWallet), delta: BigInt(pack.credit_units), denom: "CreditUnit" },
      ],
      exchange_rate: null, // Direct purchase, no exchange rate
      rounding_direction: null,
      wal_offset: walOffset,
      timestamp: Date.now(),
    }
    this.deps.ledger.appendEntry(journalEntry)

    // 7. Update Redis balance
    await this.deps.redisIncrBy(
      `balance:${authenticatedWallet}:available`,
      BigInt(pack.credit_units),
    )

    // 8. Cache result for idempotency (24h)
    const currentBalance = await this.deps.redisGet(`balance:${authenticatedWallet}:available`)
    const result: CreditPurchaseResult = {
      credit_balance: currentBalance ?? String(pack.credit_units),
      pack_size: request.pack_size,
      billing_entry_id: billingEntryId,
      status: "minted",
    }
    await this.deps.redisSet(dedupKey, JSON.stringify(result), 86400)

    return result
  }

  // -----------------------------------------------------------------------
  // On-Chain Verification
  // -----------------------------------------------------------------------

  private async verifyTransfer(
    proof: PaymentProof,
    expectedAmount: bigint,
  ): Promise<VerificationBinding> {
    const treasuryAddress = getTreasuryAddress()

    // Fetch receipt from primary RPC
    let receipt
    try {
      receipt = await this.deps.primaryClient.getTransactionReceipt({
        hash: proof.tx_hash as `0x${string}`,
      })
    } catch {
      // Try fallback RPC
      if (this.deps.fallbackClient) {
        try {
          receipt = await this.deps.fallbackClient.getTransactionReceipt({
            hash: proof.tx_hash as `0x${string}`,
          })
        } catch {
          throw new CreditPurchaseError("VERIFICATION_UNAVAILABLE", "Unable to fetch transaction receipt from any RPC")
        }
      } else {
        throw new CreditPurchaseError("VERIFICATION_UNAVAILABLE", "Unable to fetch transaction receipt")
      }
    }

    // Check tx status
    if (receipt.status !== "success") {
      throw new CreditPurchaseError("INVALID_PROOF", "Transaction failed on-chain")
    }

    // Find matching USDC Transfer event log
    const transferLog = this.findTransferLog(receipt.logs, treasuryAddress, expectedAmount)
    if (!transferLog) {
      throw new CreditPurchaseError("PAYMENT_MISMATCH", "No matching USDC Transfer event found in transaction")
    }

    // Multi-RPC consistency check (Flatline SKP-004)
    if (this.deps.fallbackClient) {
      try {
        const fallbackReceipt = await this.deps.fallbackClient.getTransactionReceipt({
          hash: proof.tx_hash as `0x${string}`,
        })
        if (fallbackReceipt.blockHash !== receipt.blockHash) {
          throw new CreditPurchaseError("VERIFICATION_UNAVAILABLE", "RPC providers disagree on block hash — rejecting until consistent")
        }
      } catch (e) {
        if (e instanceof CreditPurchaseError) throw e
        // Fallback unavailable — proceed with primary only
      }
    }

    // Check confirmation depth
    const currentBlock = await this.deps.primaryClient.getBlockNumber()
    const confirmations = currentBlock - receipt.blockNumber
    if (confirmations < BigInt(MIN_CONFIRMATIONS)) {
      throw new CreditPurchaseError(
        "PAYMENT_NOT_CONFIRMED",
        `Insufficient confirmations: ${confirmations}/${MIN_CONFIRMATIONS}`,
      )
    }

    return {
      tx_hash: proof.tx_hash,
      log_index: transferLog.logIndex!,
      block_number: receipt.blockNumber,
      block_hash: receipt.blockHash,
      amount_micro_usdc: expectedAmount,
      sender: proof.sender,
      recipient: treasuryAddress,
      verified_at: Date.now(),
    }
  }

  private findTransferLog(
    logs: Log[],
    treasuryAddress: string,
    expectedAmount: bigint,
  ): Log | null {
    const usdcAddress = getAddress(USDC_CONTRACT_ADDRESS).toLowerCase()
    const treasuryLower = treasuryAddress.toLowerCase()

    for (const log of logs) {
      // Check contract address
      if (log.address.toLowerCase() !== usdcAddress) continue

      // Check Transfer event signature (topic[0])
      // Transfer(address,address,uint256) = 0xddf252ad...
      if (log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue

      // Check recipient (topic[2]) — address is zero-padded to 32 bytes
      const recipientTopic = log.topics[2]
      if (!recipientTopic) continue
      const recipient = "0x" + recipientTopic.slice(26) // last 20 bytes
      if (recipient.toLowerCase() !== treasuryLower) continue

      // Check amount (data field)
      if (log.data) {
        const amount = BigInt(log.data)
        if (amount === expectedAmount) return log
      }
    }

    return null
  }
}

// ---------------------------------------------------------------------------
// Hono Routes
// ---------------------------------------------------------------------------

export function creditPurchaseRoutes(
  purchaseService: CreditPurchaseService,
  walletAuth: { verifyAccessToken: (token: string) => Promise<{ address: string }> },
  rateLimitCheck: (wallet: string) => boolean,
): Hono {
  const app = new Hono()

  // POST /api/v1/credits/purchase
  app.post("/purchase", async (c) => {
    // Authenticate
    const authHeader = c.req.header("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, 401)
    }

    let session
    try {
      session = await walletAuth.verifyAccessToken(authHeader.slice(7))
    } catch {
      return c.json({ error: "Invalid token", code: "AUTH_INVALID" }, 401)
    }

    // Rate limit (Flatline IMP-007)
    if (!rateLimitCheck(session.address)) {
      return c.json({ error: "Rate limited", code: "RATE_LIMITED" }, 429)
    }

    // Parse request
    const body = await c.req.json<CreditPurchaseRequest>()

    try {
      const result = await purchaseService.purchase(body, session.address)
      return c.json(result)
    } catch (e) {
      if (e instanceof CreditPurchaseError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400)
      }
      throw e
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPurchaseClients(rpcUrl: string, fallbackRpcUrl?: string) {
  const primary = createPublicClient({ chain: base, transport: http(rpcUrl) })
  const fallback = fallbackRpcUrl
    ? createPublicClient({ chain: base, transport: http(fallbackRpcUrl) })
    : undefined
  return { primary, fallback }
}
