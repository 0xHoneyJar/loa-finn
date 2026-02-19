// src/credits/unlock.ts — USDC Unlock Flow (SDD §21, Sprint 21 Task 21.3)
//
// POST /api/v1/credits/unlock
// Accepts EIP-3009 authorization parameters.
// Verifies USDC transfer on-chain before unlocking.
// Nonce replay protection.
// ALLOCATED → UNLOCKED transition via credit sub-ledger.

import { createHash } from "node:crypto"
import { CreditSubLedger } from "./rektdrop-ledger.js"
import {
  type EIP3009UnlockAuth,
  type UnlockRequest,
  type UnlockResult,
  type CreditAccount,
  CreditState,
  RektdropError,
  parseCreditAccountId,
} from "./rektdrop-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnlockServiceDeps {
  ledger: CreditSubLedger
  /** Verify the USDC transfer occurred on-chain. Returns true if confirmed. */
  verifyOnChainTransfer?: (auth: EIP3009UnlockAuth) => Promise<boolean>
  /** Optional: log audit events */
  onUnlock?: (wallet: string, amount: bigint, txId: string) => void
}

export interface UnlockServiceConfig {
  /** Treasury address that receives USDC payments */
  treasuryAddress: string
  /** Minimum USDC amount per credit (in base units, 6 decimals) */
  usdcPerCredit?: bigint
}

// ---------------------------------------------------------------------------
// Unlock Service
// ---------------------------------------------------------------------------

export class UnlockService {
  private readonly ledger: CreditSubLedger
  private readonly verifyOnChain: (auth: EIP3009UnlockAuth) => Promise<boolean>
  private readonly onUnlock: UnlockServiceDeps["onUnlock"]
  private readonly treasuryAddress: string
  private readonly usdcPerCredit: bigint

  constructor(deps: UnlockServiceDeps, config: UnlockServiceConfig) {
    this.ledger = deps.ledger
    this.verifyOnChain = deps.verifyOnChainTransfer ?? (async () => true)
    this.onUnlock = deps.onUnlock
    this.treasuryAddress = config.treasuryAddress.toLowerCase()
    // Default: 1 USDC (1_000_000 base units) = 1000 credits → 1000 base units per credit
    this.usdcPerCredit = config.usdcPerCredit ?? 1_000n
  }

  /**
   * Process a credit unlock request.
   *
   * Flow:
   * 1. Validate wallet has an account with ALLOCATED credits
   * 2. Validate EIP-3009 authorization parameters
   * 3. Check nonce replay protection
   * 4. Verify USDC transfer on-chain
   * 5. Execute ALLOCATED → UNLOCKED transition
   */
  async unlock(request: UnlockRequest): Promise<UnlockResult> {
    const { wallet, amount, authorization, idempotency_key } = request

    // 1. Validate account exists and has allocated credits
    const account = this.ledger.getAccount(wallet)
    if (!account) {
      throw new RektdropError(
        "INVALID_WALLET",
        `No credit account found for wallet: ${wallet}`,
      )
    }

    if (account.balances[CreditState.ALLOCATED] === 0n) {
      throw new RektdropError(
        "ALREADY_UNLOCKED",
        `All credits for ${wallet} have already been unlocked or expired`,
      )
    }

    if (amount > account.balances[CreditState.ALLOCATED]) {
      throw new RektdropError(
        "INSUFFICIENT_ALLOCATED",
        `Requested unlock ${amount} exceeds allocated balance ${account.balances[CreditState.ALLOCATED]}`,
      )
    }

    if (amount <= 0n) {
      throw new RektdropError(
        "INVALID_AMOUNT",
        `Unlock amount must be positive: ${amount}`,
      )
    }

    // 2. Validate authorization parameters
    this.validateAuthorization(authorization, amount)

    // 3. Nonce replay protection — atomic check-and-set
    const nonceKey = this.computeNonceKey(authorization)
    if (!this.ledger.markNonceUsed(nonceKey)) {
      throw new RektdropError(
        "NONCE_REPLAY",
        `Nonce already used: ${authorization.nonce}`,
      )
    }

    // 4. Verify on-chain USDC transfer
    let verified: boolean
    try {
      verified = await this.verifyOnChain(authorization)
    } catch (err) {
      throw new RektdropError(
        "UNLOCK_VERIFICATION_FAILED",
        `On-chain verification failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!verified) {
      throw new RektdropError(
        "UNLOCK_VERIFICATION_FAILED",
        "USDC transfer could not be verified on-chain",
      )
    }

    // 5. Execute ALLOCATED → UNLOCKED transition
    const tx = this.ledger.unlock(
      wallet,
      amount,
      `unlock_${authorization.nonce}`,
      idempotency_key,
      {
        nonce: authorization.nonce,
        usdc_value: authorization.value,
        from: authorization.from,
      },
    )

    // Verify conservation invariant post-unlock
    if (!this.ledger.verifyConservation(wallet)) {
      throw new RektdropError(
        "CONSERVATION_VIOLATION",
        "Conservation invariant violated after unlock",
      )
    }

    // Get updated account
    const updatedAccount = this.ledger.getAccount(wallet)!

    // Notify
    this.onUnlock?.(wallet, amount, tx.tx_id)

    return {
      tx_id: tx.tx_id,
      account_id: account.account_id,
      unlocked_amount: amount,
      remaining_allocated: updatedAccount.balances[CreditState.ALLOCATED],
      remaining_unlocked: updatedAccount.balances[CreditState.UNLOCKED],
      status: "unlocked",
    }
  }

  /**
   * Check if a wallet's credits can be unlocked (preview without executing).
   */
  canUnlock(wallet: string, amount: bigint): { eligible: boolean; reason?: string } {
    const account = this.ledger.getAccount(wallet)
    if (!account) {
      return { eligible: false, reason: "No credit account found" }
    }

    if (account.balances[CreditState.ALLOCATED] === 0n) {
      return { eligible: false, reason: "No allocated credits remaining" }
    }

    if (amount > account.balances[CreditState.ALLOCATED]) {
      return {
        eligible: false,
        reason: `Requested ${amount} exceeds allocated ${account.balances[CreditState.ALLOCATED]}`,
      }
    }

    // Check TTL
    if (Date.now() > account.expires_at) {
      return { eligible: false, reason: "Credits have expired" }
    }

    return { eligible: true }
  }

  /**
   * Compute the minimum USDC required to unlock a given credit amount.
   */
  computeRequiredUsdc(creditAmount: bigint): bigint {
    return creditAmount * this.usdcPerCredit
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private validateAuthorization(auth: EIP3009UnlockAuth, creditAmount: bigint): void {
    // Validate recipient is treasury
    if (auth.to.toLowerCase() !== this.treasuryAddress) {
      throw new RektdropError(
        "UNLOCK_VERIFICATION_FAILED",
        `Payment recipient must be treasury: expected ${this.treasuryAddress}, got ${auth.to.toLowerCase()}`,
      )
    }

    // Validate USDC amount sufficient for credits
    const requiredUsdc = this.computeRequiredUsdc(creditAmount)
    const paidUsdc = BigInt(auth.value)
    if (paidUsdc < requiredUsdc) {
      throw new RektdropError(
        "INVALID_AMOUNT",
        `Insufficient USDC: paid ${paidUsdc}, required ${requiredUsdc} for ${creditAmount} credits`,
      )
    }

    // Validate not expired
    const now = Math.floor(Date.now() / 1000)
    if (auth.valid_before < now) {
      throw new RektdropError(
        "AUTHORIZATION_EXPIRED",
        "EIP-3009 authorization has expired",
      )
    }

    // Validate validAfter
    if (auth.valid_after > now) {
      throw new RektdropError(
        "AUTHORIZATION_EXPIRED",
        "EIP-3009 authorization is not yet valid",
      )
    }

    // Validate nonce is present
    if (!auth.nonce || auth.nonce.length === 0) {
      throw new RektdropError(
        "UNLOCK_VERIFICATION_FAILED",
        "Authorization nonce is required",
      )
    }
  }

  /**
   * Compute a deterministic nonce key for replay protection.
   * SHA-256(from:to:nonce:value:validBefore)
   */
  private computeNonceKey(auth: EIP3009UnlockAuth): string {
    const data = [
      auth.from.toLowerCase(),
      auth.to.toLowerCase(),
      auth.nonce,
      auth.value,
      String(auth.valid_before),
    ].join(":")
    return createHash("sha256").update(data).digest("hex")
  }
}
