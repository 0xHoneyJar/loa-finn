// src/credits/credit-persistence.ts — Postgres persistence for Credit Sub-Ledger (Bridge high-1)
//
// Write-through persistence layer: in-memory ledger remains the hot path,
// Postgres is the durable store. On startup, load from Postgres → rebuild
// in-memory state. On every mutation, write-through to Postgres atomically.
//
// Conservation invariant validated via SQL CHECK on every account update.

import { eq, sql } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import {
  finnCreditAccounts,
  finnCreditTransactions,
  finnUsedNonces,
} from "../drizzle/schema.js"
import { CreditSubLedger } from "./rektdrop-ledger.js"
import {
  type CreditAccount,
  type CreditTransaction,
  type CreditAccountId,
  type AllocationTier,
  CreditState,
  parseCreditAccountId,
} from "./rektdrop-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrizzleDB = PostgresJsDatabase<Record<string, never>>

export interface CreditPersistenceMetrics {
  accountsLoaded: number
  transactionsLoaded: number
  noncesLoaded: number
  loadDurationMs: number
}

// ---------------------------------------------------------------------------
// Persistence Operations
// ---------------------------------------------------------------------------

/**
 * Persist a credit account to Postgres (upsert).
 * Conservation invariant enforced: allocated + unlocked + reserved + consumed + expired = initial_allocation.
 */
export async function persistAccount(db: DrizzleDB, account: CreditAccount): Promise<void> {
  await db.insert(finnCreditAccounts).values({
    accountId: account.account_id,
    initialAllocation: account.initial_allocation,
    allocated: account.balances[CreditState.ALLOCATED],
    unlocked: account.balances[CreditState.UNLOCKED],
    reserved: account.balances[CreditState.RESERVED],
    consumed: account.balances[CreditState.CONSUMED],
    expired: account.balances[CreditState.EXPIRED],
    tier: account.tier,
    expiresAt: BigInt(account.expires_at),
    createdAt: BigInt(account.created_at),
    updatedAt: BigInt(account.updated_at),
  }).onConflictDoUpdate({
    target: finnCreditAccounts.accountId,
    set: {
      allocated: sql`excluded.allocated`,
      unlocked: sql`excluded.unlocked`,
      reserved: sql`excluded.reserved`,
      consumed: sql`excluded.consumed`,
      expired: sql`excluded.expired`,
      updatedAt: sql`excluded.updated_at`,
    },
  })
}

/**
 * Persist a credit transaction to Postgres (idempotent on idempotency_key).
 */
export async function persistTransaction(db: DrizzleDB, tx: CreditTransaction): Promise<void> {
  await db.insert(finnCreditTransactions).values({
    txId: tx.tx_id,
    accountId: tx.account_id,
    eventType: tx.event_type,
    debitState: tx.debit_state,
    creditState: tx.credit_state,
    amount: tx.amount,
    correlationId: tx.correlation_id,
    idempotencyKey: tx.idempotency_key,
    metadata: tx.metadata ?? null,
    timestamp: BigInt(tx.timestamp),
  }).onConflictDoNothing({
    target: finnCreditTransactions.idempotencyKey,
  })
}

/**
 * Persist a used nonce (idempotent — insert or ignore).
 */
export async function persistNonce(db: DrizzleDB, nonceKey: string): Promise<void> {
  await db.insert(finnUsedNonces).values({
    nonceKey,
  }).onConflictDoNothing({
    target: finnUsedNonces.nonceKey,
  })
}

/**
 * Persist account + transaction atomically in a single Postgres transaction.
 * This is the primary write-through path: after an in-memory mutation,
 * call this to durably persist both the updated account and the journal entry.
 */
export async function persistMutation(
  db: DrizzleDB,
  account: CreditAccount,
  tx: CreditTransaction,
): Promise<void> {
  await db.transaction(async (trx) => {
    await persistAccount(trx as unknown as DrizzleDB, account)
    await persistTransaction(trx as unknown as DrizzleDB, tx)
  })
}

/**
 * Cleanup expired nonces older than the given age.
 * Called periodically to prevent unbounded growth (Bridge medium-5).
 */
export async function cleanupExpiredNonces(db: DrizzleDB, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs)
  const result = await db.delete(finnUsedNonces)
    .where(sql`${finnUsedNonces.createdAt} < ${cutoff}`)
  return result.length ?? 0
}

// ---------------------------------------------------------------------------
// Load from Postgres → Rebuild In-Memory Ledger
// ---------------------------------------------------------------------------

/**
 * Load all credit state from Postgres and rebuild a CreditSubLedger.
 * Called on startup to recover from process restarts.
 *
 * Flow:
 * 1. Load all accounts from finn_credit_accounts
 * 2. Load all nonces from finn_used_nonces
 * 3. Rebuild the in-memory CreditSubLedger with loaded state
 * 4. Verify conservation invariant for every account
 */
export async function loadLedgerFromDatabase(
  db: DrizzleDB,
): Promise<{ ledger: CreditSubLedger; metrics: CreditPersistenceMetrics }> {
  const startTime = Date.now()

  // Load accounts
  const accountRows = await db.select().from(finnCreditAccounts)

  // Load nonces
  const nonceRows = await db.select().from(finnUsedNonces)

  // Count transactions (for metrics only — we don't reload the full journal into memory)
  const txCountResult = await db.select({
    count: sql<number>`count(*)`,
  }).from(finnCreditTransactions)
  const txCount = txCountResult[0]?.count ?? 0

  // Rebuild ledger
  const ledger = new CreditSubLedger()

  for (const row of accountRows) {
    const account: CreditAccount = {
      account_id: row.accountId as CreditAccountId,
      initial_allocation: row.initialAllocation,
      balances: {
        [CreditState.ALLOCATED]: row.allocated,
        [CreditState.UNLOCKED]: row.unlocked,
        [CreditState.RESERVED]: row.reserved,
        [CreditState.CONSUMED]: row.consumed,
        [CreditState.EXPIRED]: row.expired,
      },
      tier: row.tier as AllocationTier,
      expires_at: Number(row.expiresAt),
      created_at: Number(row.createdAt),
      updated_at: Number(row.updatedAt),
    }
    ledger._restoreAccount(account)
  }

  for (const row of nonceRows) {
    ledger._restoreNonce(row.nonceKey)
  }

  // Verify conservation invariant across all restored accounts
  const conservation = ledger.verifyAllConservation()
  if (!conservation.valid) {
    console.error(
      `[credit-persistence] Conservation invariant violated for ${conservation.violations.length} accounts after DB load:`,
      conservation.violations,
    )
  }

  const metrics: CreditPersistenceMetrics = {
    accountsLoaded: accountRows.length,
    transactionsLoaded: txCount,
    noncesLoaded: nonceRows.length,
    loadDurationMs: Date.now() - startTime,
  }

  return { ledger, metrics }
}

// ---------------------------------------------------------------------------
// SQL Conservation Check
// ---------------------------------------------------------------------------

/**
 * Verify conservation invariant for a specific account via SQL.
 * Returns true if allocated + unlocked + reserved + consumed + expired = initial_allocation.
 */
export async function verifyConservationSQL(db: DrizzleDB, accountId: string): Promise<boolean> {
  const result = await db.select({
    valid: sql<boolean>`(
      ${finnCreditAccounts.allocated} +
      ${finnCreditAccounts.unlocked} +
      ${finnCreditAccounts.reserved} +
      ${finnCreditAccounts.consumed} +
      ${finnCreditAccounts.expired}
    ) = ${finnCreditAccounts.initialAllocation}`,
  }).from(finnCreditAccounts)
    .where(eq(finnCreditAccounts.accountId, accountId))

  return result.length > 0 && result[0].valid === true
}
