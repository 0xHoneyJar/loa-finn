// src/credits/rektdrop-ledger.ts — Credit Sub-Ledger (SDD §21, Sprint 21 Task 21.1)
//
// Double-entry ledger for the Rektdrop credit system.
// Every state transition is a debit+credit pair.
// Conservation invariant: sum(all state balances) = initial_allocation.
// In-memory storage — no Redis dependency.

import {
  type CreditAccount,
  type CreditAccountId,
  type CreditTransaction,
  type CreditTransactionId,
  type CreditState,
  type CreditEventType,
  type AllocationTier,
  CreditState as CS,
  CreditLedgerError,
  CreditStateError,
  VALID_CREDIT_TRANSITIONS,
  generateCreditTransactionId,
  parseCreditAccountId,
  DEFAULT_CREDIT_TTL_MS,
  TIER_AMOUNTS,
} from "./rektdrop-types.js"

// ---------------------------------------------------------------------------
// Credit Sub-Ledger
// ---------------------------------------------------------------------------

export class CreditSubLedger {
  /** In-memory account store: accountId → CreditAccount */
  private readonly accounts = new Map<CreditAccountId, CreditAccount>()

  /** Transaction journal — append-only */
  private readonly journal: CreditTransaction[] = []

  /** Idempotency set: tracks processed idempotency keys */
  private readonly processedKeys = new Set<string>()

  /** Used nonces for replay protection */
  private readonly usedNonces = new Set<string>()

  // =========================================================================
  // Account Operations
  // =========================================================================

  /**
   * Create a new credit account with an initial allocation.
   * All credits start in the ALLOCATED state.
   * Idempotent: re-creating an existing account is a no-op returning the existing account.
   */
  createAccount(
    wallet: string,
    tier: AllocationTier,
    amount?: bigint,
    ttlMs?: number,
    idempotencyKey?: string,
  ): CreditAccount {
    const accountId = parseCreditAccountId(wallet)

    // Idempotency check
    if (idempotencyKey && this.processedKeys.has(idempotencyKey)) {
      const existing = this.accounts.get(accountId)
      if (existing) return existing
    }

    // Already exists — return existing (idempotent)
    if (this.accounts.has(accountId)) {
      const existing = this.accounts.get(accountId)!
      if (idempotencyKey) this.processedKeys.add(idempotencyKey)
      return existing
    }

    const allocationAmount = amount ?? TIER_AMOUNTS[tier]
    if (allocationAmount <= 0n) {
      throw new CreditLedgerError(`Invalid allocation amount: ${allocationAmount}`)
    }

    const now = Date.now()
    const account: CreditAccount = {
      account_id: accountId,
      initial_allocation: allocationAmount,
      balances: {
        ALLOCATED: allocationAmount,
        UNLOCKED: 0n,
        RESERVED: 0n,
        CONSUMED: 0n,
        EXPIRED: 0n,
      },
      tier,
      expires_at: now + (ttlMs ?? DEFAULT_CREDIT_TTL_MS),
      created_at: now,
      updated_at: now,
    }

    this.accounts.set(accountId, account)

    // Record the allocation transaction
    const txId = generateCreditTransactionId()
    this.appendTransaction({
      tx_id: txId,
      account_id: accountId,
      event_type: "rektdrop_allocate",
      debit_state: CS.ALLOCATED,
      credit_state: CS.ALLOCATED,
      amount: allocationAmount,
      correlation_id: `alloc_${accountId}`,
      idempotency_key: idempotencyKey ?? `alloc_${accountId}_${now}`,
      metadata: { tier, initial_allocation: allocationAmount.toString() },
      timestamp: now,
    })

    if (idempotencyKey) this.processedKeys.add(idempotencyKey)
    return account
  }

  /**
   * Get account by ID. Returns null if not found.
   */
  getAccount(wallet: string): CreditAccount | null {
    const accountId = parseCreditAccountId(wallet)
    return this.accounts.get(accountId) ?? null
  }

  /**
   * Get all accounts.
   */
  getAllAccounts(): CreditAccount[] {
    return Array.from(this.accounts.values())
  }

  // =========================================================================
  // State Transitions (Double-Entry)
  // =========================================================================

  /**
   * Transfer credits between states (double-entry).
   * Validates: transition legality, sufficient balance, conservation invariant.
   * Idempotent on idempotency_key.
   */
  transfer(
    wallet: string,
    fromState: CreditState,
    toState: CreditState,
    amount: bigint,
    eventType: CreditEventType,
    correlationId: string,
    idempotencyKey: string,
    metadata?: Record<string, string>,
  ): CreditTransaction {
    // Idempotency
    if (this.processedKeys.has(idempotencyKey)) {
      const existing = this.journal.find(t => t.idempotency_key === idempotencyKey)
      if (existing) return existing
    }

    const accountId = parseCreditAccountId(wallet)
    const account = this.accounts.get(accountId)
    if (!account) {
      throw new CreditLedgerError(`Account not found: ${wallet}`)
    }

    // Validate transition
    if (fromState !== toState) {
      this.validateTransition(fromState, toState)
    }

    // Validate sufficient balance
    if (account.balances[fromState] < amount) {
      throw new CreditLedgerError(
        `Insufficient balance in ${fromState}: has ${account.balances[fromState]}, needs ${amount}`,
      )
    }

    // Validate non-zero amount
    if (amount <= 0n) {
      throw new CreditLedgerError(`Transfer amount must be positive: ${amount}`)
    }

    // Snapshot pre-transfer balances for invariant check
    const preTotalBigint = this.sumBalances(account)

    // Execute double-entry: debit fromState, credit toState
    account.balances[fromState] -= amount
    account.balances[toState] += amount
    account.updated_at = Date.now()

    // Post-transfer conservation invariant
    const postTotalBigint = this.sumBalances(account)
    if (preTotalBigint !== postTotalBigint) {
      // Rollback
      account.balances[fromState] += amount
      account.balances[toState] -= amount
      throw new CreditLedgerError(
        `Conservation invariant violated: pre=${preTotalBigint}, post=${postTotalBigint}`,
      )
    }

    // Record transaction
    const tx: CreditTransaction = {
      tx_id: generateCreditTransactionId(),
      account_id: accountId,
      event_type: eventType,
      debit_state: fromState,
      credit_state: toState,
      amount,
      correlation_id: correlationId,
      idempotency_key: idempotencyKey,
      metadata,
      timestamp: Date.now(),
    }

    this.appendTransaction(tx)
    this.processedKeys.add(idempotencyKey)

    return tx
  }

  /**
   * Unlock credits: ALLOCATED → UNLOCKED
   */
  unlock(
    wallet: string,
    amount: bigint,
    correlationId: string,
    idempotencyKey: string,
    metadata?: Record<string, string>,
  ): CreditTransaction {
    return this.transfer(
      wallet,
      CS.ALLOCATED,
      CS.UNLOCKED,
      amount,
      "usdc_unlock",
      correlationId,
      idempotencyKey,
      metadata,
    )
  }

  /**
   * Reserve credits: UNLOCKED → RESERVED
   */
  reserve(
    wallet: string,
    amount: bigint,
    correlationId: string,
    idempotencyKey: string,
  ): CreditTransaction {
    return this.transfer(
      wallet,
      CS.UNLOCKED,
      CS.RESERVED,
      amount,
      "credit_reserve",
      correlationId,
      idempotencyKey,
    )
  }

  /**
   * Consume credits: RESERVED → CONSUMED
   */
  consume(
    wallet: string,
    amount: bigint,
    correlationId: string,
    idempotencyKey: string,
  ): CreditTransaction {
    return this.transfer(
      wallet,
      CS.RESERVED,
      CS.CONSUMED,
      amount,
      "credit_consume",
      correlationId,
      idempotencyKey,
    )
  }

  /**
   * Release reserved credits: RESERVED → UNLOCKED
   */
  release(
    wallet: string,
    amount: bigint,
    correlationId: string,
    idempotencyKey: string,
  ): CreditTransaction {
    return this.transfer(
      wallet,
      CS.RESERVED,
      CS.UNLOCKED,
      amount,
      "credit_release",
      correlationId,
      idempotencyKey,
    )
  }

  /**
   * Expire credits from any non-terminal state.
   * Only ALLOCATED and UNLOCKED can expire.
   */
  expire(
    wallet: string,
    fromState: CreditState,
    amount: bigint,
    correlationId: string,
    idempotencyKey: string,
  ): CreditTransaction {
    if (fromState !== CS.ALLOCATED && fromState !== CS.UNLOCKED) {
      throw new CreditStateError(
        fromState,
        "expire",
        `Cannot expire credits from ${fromState} — only ALLOCATED and UNLOCKED can expire`,
      )
    }
    return this.transfer(
      wallet,
      fromState,
      CS.EXPIRED,
      amount,
      "credit_expire",
      correlationId,
      idempotencyKey,
    )
  }

  /**
   * Expire all remaining non-terminal credits for an account.
   * Used when TTL expires.
   */
  expireAll(wallet: string, correlationId: string): CreditTransaction[] {
    const accountId = parseCreditAccountId(wallet)
    const account = this.accounts.get(accountId)
    if (!account) return []

    const txns: CreditTransaction[] = []

    if (account.balances[CS.ALLOCATED] > 0n) {
      txns.push(
        this.expire(
          wallet,
          CS.ALLOCATED,
          account.balances[CS.ALLOCATED],
          correlationId,
          `expire_allocated_${accountId}_${Date.now()}`,
        ),
      )
    }

    if (account.balances[CS.UNLOCKED] > 0n) {
      txns.push(
        this.expire(
          wallet,
          CS.UNLOCKED,
          account.balances[CS.UNLOCKED],
          correlationId,
          `expire_unlocked_${accountId}_${Date.now()}`,
        ),
      )
    }

    return txns
  }

  // =========================================================================
  // Nonce Management (for unlock replay protection)
  // =========================================================================

  /**
   * Check if a nonce has been used.
   */
  isNonceUsed(nonce: string): boolean {
    return this.usedNonces.has(nonce)
  }

  /**
   * Mark a nonce as used. Returns false if already used (replay).
   */
  markNonceUsed(nonce: string): boolean {
    if (this.usedNonces.has(nonce)) return false
    this.usedNonces.add(nonce)
    return true
  }

  // =========================================================================
  // Conservation Invariant
  // =========================================================================

  /**
   * Verify conservation invariant for a specific account.
   * sum(all state balances) must equal initial_allocation.
   */
  verifyConservation(wallet: string): boolean {
    const accountId = parseCreditAccountId(wallet)
    const account = this.accounts.get(accountId)
    if (!account) return false
    return this.sumBalances(account) === account.initial_allocation
  }

  /**
   * Verify conservation invariant for ALL accounts.
   * Returns list of accounts that violate the invariant.
   */
  verifyAllConservation(): { valid: boolean; violations: CreditAccountId[] } {
    const violations: CreditAccountId[] = []
    for (const [accountId, account] of this.accounts) {
      if (this.sumBalances(account) !== account.initial_allocation) {
        violations.push(accountId)
      }
    }
    return { valid: violations.length === 0, violations }
  }

  // =========================================================================
  // Journal Queries
  // =========================================================================

  /**
   * Get all transactions for an account.
   */
  getTransactions(wallet: string): CreditTransaction[] {
    const accountId = parseCreditAccountId(wallet)
    return this.journal.filter(tx => tx.account_id === accountId)
  }

  /**
   * Get all transactions.
   */
  getAllTransactions(): CreditTransaction[] {
    return [...this.journal]
  }

  /**
   * Get transaction count.
   */
  get transactionCount(): number {
    return this.journal.length
  }

  /**
   * Get account count.
   */
  get accountCount(): number {
    return this.accounts.size
  }

  // =========================================================================
  // Persistence Restore (Bridge high-1: load from Postgres on startup)
  // =========================================================================

  /**
   * Restore an account from persistent storage (Postgres).
   * Bypasses normal creation flow — used only during startup recovery.
   * @internal Called by credit-persistence.ts loadLedgerFromDatabase()
   */
  _restoreAccount(account: CreditAccount): void {
    this.accounts.set(account.account_id, account)
  }

  /**
   * Restore a used nonce from persistent storage.
   * @internal Called by credit-persistence.ts loadLedgerFromDatabase()
   */
  _restoreNonce(nonceKey: string): void {
    this.usedNonces.add(nonceKey)
  }

  /**
   * Restore a processed idempotency key from persistent storage.
   * @internal Called by credit-persistence.ts loadLedgerFromDatabase()
   */
  _restoreProcessedKey(key: string): void {
    this.processedKeys.add(key)
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private validateTransition(from: CreditState, to: CreditState): void {
    const validTargets = VALID_CREDIT_TRANSITIONS[from]
    if (!validTargets.includes(to)) {
      throw new CreditStateError(from, to)
    }
  }

  private sumBalances(account: CreditAccount): bigint {
    return (
      account.balances[CS.ALLOCATED] +
      account.balances[CS.UNLOCKED] +
      account.balances[CS.RESERVED] +
      account.balances[CS.CONSUMED] +
      account.balances[CS.EXPIRED]
    )
  }

  private appendTransaction(tx: CreditTransaction): void {
    this.journal.push(tx)
  }
}
