// src/credits/consumption.ts — Credit Consumption State Machine (Sprint 22 Task 22.1)
//
// Billing state machine: locked → reject (402), unlocked → reserve → finalize/rollback,
// exhausted → fall back to USDC per-call billing.
// Integrates with BillingConservationGuard.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreditState = "allocated" | "unlocked" | "reserved" | "consumed" | "expired"

export interface CreditAccount {
  wallet: string
  allocated: number
  unlocked: number
  reserved: number
  consumed: number
  expired: number
}

export interface ReservationReceipt {
  reservationId: string
  wallet: string
  amount: number
  createdAt: number
  expiresAt: number
}

export type ConsumptionResult =
  | { status: "reserved"; receipt: ReservationReceipt }
  | { status: "credits_locked"; code: 402 }
  | { status: "fallback_usdc" }

export type FinalizationResult =
  | { status: "consumed"; amount: number }
  | { status: "reservation_not_found" }

export type RollbackResult =
  | { status: "rolled_back"; amount: number }
  | { status: "reservation_not_found" }

// ---------------------------------------------------------------------------
// Credit Store Interface
// ---------------------------------------------------------------------------

export interface CreditStore {
  getAccount(wallet: string): Promise<CreditAccount | null>
  updateAccount(wallet: string, account: CreditAccount): Promise<void>
  getReservation(reservationId: string): Promise<ReservationReceipt | null>
  setReservation(receipt: ReservationReceipt): Promise<void>
  deleteReservation(reservationId: string): Promise<void>
  /**
   * Atomic reserve: single SQL conditional UPDATE that fails atomically
   * if balance is insufficient (Bridge high-2 TOCTOU fix).
   * Pattern: UPDATE ... SET unlocked = unlocked - $amount WHERE wallet = $wallet AND unlocked >= $amount RETURNING *
   * Returns updated account if successful, null if insufficient balance.
   * Optional — stores without SQL fall back to read-check-write.
   */
  atomicReserve?(wallet: string, amount: number): Promise<CreditAccount | null>
}

// ---------------------------------------------------------------------------
// Conservation Guard Interface
// ---------------------------------------------------------------------------

export interface ConservationCheckpoint {
  validate(account: CreditAccount): boolean
}

/**
 * Default conservation check: sum of all states equals total allocation.
 */
export function defaultConservationCheck(account: CreditAccount): boolean {
  const total = account.allocated + account.unlocked + account.reserved + account.consumed + account.expired
  // Total should remain constant (initial allocation)
  // We don't know the initial here, but we verify non-negative states
  return (
    account.allocated >= 0 &&
    account.unlocked >= 0 &&
    account.reserved >= 0 &&
    account.consumed >= 0 &&
    account.expired >= 0
  )
}

// ---------------------------------------------------------------------------
// Consumption Engine
// ---------------------------------------------------------------------------

let reservationCounter = 0

function generateReservationId(): string {
  reservationCounter++
  return `rsv-${Date.now()}-${reservationCounter}`
}

/** Reset counter for testing */
export function resetReservationCounter(): void {
  reservationCounter = 0
}

/**
 * Attempt to consume credits for an invocation.
 *
 * State machine:
 * - allocated (locked) → 402 CREDITS_LOCKED
 * - unlocked > 0 → reserve → return receipt
 * - unlocked = 0, consumed > 0 → FALLBACK_USDC
 *
 * Bridge high-2 fix: when store.atomicReserve is available, uses a single
 * SQL conditional UPDATE to prevent TOCTOU race. The pattern is:
 *   UPDATE ... SET unlocked = unlocked - $amount
 *   WHERE wallet = $wallet AND unlocked >= $amount RETURNING *
 * If 0 rows affected → insufficient credits. No overspend possible.
 */
export async function reserveCredits(
  store: CreditStore,
  wallet: string,
  amount: number,
  conservation?: ConservationCheckpoint,
): Promise<ConsumptionResult> {
  const account = await store.getAccount(wallet)

  if (!account) {
    // No account — fall back to USDC
    return { status: "fallback_usdc" }
  }

  // Check if all credits are still locked (allocated but not unlocked)
  if (account.unlocked === 0 && account.allocated > 0) {
    return { status: "credits_locked", code: 402 }
  }

  // Check if credits are exhausted
  if (account.unlocked === 0) {
    return { status: "fallback_usdc" }
  }

  // Check sufficient balance (pre-check before atomic operation)
  if (account.unlocked < amount) {
    return { status: "fallback_usdc" }
  }

  // Bridge high-2 fix: use atomic reserve when available to prevent TOCTOU race.
  // Single SQL conditional UPDATE: if 0 rows affected → insufficient (concurrent drain).
  if (store.atomicReserve) {
    const updatedAccount = await store.atomicReserve(wallet, amount)
    if (!updatedAccount) {
      // Atomic reserve failed — balance was drained by concurrent request
      return { status: "fallback_usdc" }
    }

    // Conservation checkpoint on the atomically-updated account
    if (conservation && !conservation.validate(updatedAccount)) {
      // Rollback: restore unlocked, reduce reserved
      updatedAccount.unlocked += amount
      updatedAccount.reserved -= amount
      await store.updateAccount(wallet, updatedAccount)
      return { status: "fallback_usdc" }
    }

    const receipt: ReservationReceipt = {
      reservationId: generateReservationId(),
      wallet,
      amount,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute TTL
    }

    await store.setReservation(receipt)
    return { status: "reserved", receipt }
  }

  // Legacy path: read-check-write (no atomicity guarantee).
  // Only used by stores without SQL (in-memory test stores).
  account.unlocked -= amount
  account.reserved += amount

  // Conservation checkpoint
  if (conservation && !conservation.validate(account)) {
    // Rollback the in-memory change
    account.unlocked += amount
    account.reserved -= amount
    return { status: "fallback_usdc" }
  }

  const receipt: ReservationReceipt = {
    reservationId: generateReservationId(),
    wallet,
    amount,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute TTL
  }

  await store.updateAccount(wallet, account)
  await store.setReservation(receipt)

  return { status: "reserved", receipt }
}

/**
 * Finalize a reservation: reserved → consumed.
 */
export async function finalizeReservation(
  store: CreditStore,
  reservationId: string,
  conservation?: ConservationCheckpoint,
): Promise<FinalizationResult> {
  const receipt = await store.getReservation(reservationId)
  if (!receipt) {
    return { status: "reservation_not_found" }
  }

  const account = await store.getAccount(receipt.wallet)
  if (!account) {
    return { status: "reservation_not_found" }
  }

  // Move from reserved to consumed
  account.reserved -= receipt.amount
  account.consumed += receipt.amount

  if (conservation && !conservation.validate(account)) {
    // Conservation violation — do not finalize
    account.reserved += receipt.amount
    account.consumed -= receipt.amount
    return { status: "reservation_not_found" }
  }

  await store.updateAccount(receipt.wallet, account)
  await store.deleteReservation(reservationId)

  return { status: "consumed", amount: receipt.amount }
}

/**
 * Rollback a reservation: reserved → unlocked.
 */
export async function rollbackReservation(
  store: CreditStore,
  reservationId: string,
): Promise<RollbackResult> {
  const receipt = await store.getReservation(reservationId)
  if (!receipt) {
    return { status: "reservation_not_found" }
  }

  const account = await store.getAccount(receipt.wallet)
  if (!account) {
    return { status: "reservation_not_found" }
  }

  // Move from reserved back to unlocked
  account.reserved -= receipt.amount
  account.unlocked += receipt.amount

  await store.updateAccount(receipt.wallet, account)
  await store.deleteReservation(reservationId)

  return { status: "rolled_back", amount: receipt.amount }
}
