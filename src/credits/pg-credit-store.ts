// src/credits/pg-credit-store.ts — Postgres-backed CreditStore (Bridge high-1 + high-2)
//
// Implements CreditStore interface with:
// - Atomic reserve via SQL conditional UPDATE (Bridge high-2 TOCTOU fix)
// - Persistent account state (Bridge high-1)
// - Reservation storage in Redis (fast TTL-based expiry)

import { eq, sql } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { finnCreditAccounts } from "../drizzle/schema.js"
import type {
  CreditStore,
  CreditAccount,
  ReservationReceipt,
} from "./consumption.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDB = PostgresJsDatabase<Record<string, never>>

export interface PgCreditStoreDeps {
  db: DrizzleDB
  redis: RedisCommandClient
}

// ---------------------------------------------------------------------------
// Postgres-Backed Credit Store
// ---------------------------------------------------------------------------

export class PgCreditStore implements CreditStore {
  private readonly db: DrizzleDB
  private readonly redis: RedisCommandClient

  constructor(deps: PgCreditStoreDeps) {
    this.db = deps.db
    this.redis = deps.redis
  }

  async getAccount(wallet: string): Promise<CreditAccount | null> {
    const rows = await this.db
      .select()
      .from(finnCreditAccounts)
      .where(eq(finnCreditAccounts.accountId, wallet.toLowerCase()))

    if (rows.length === 0) return null

    const row = rows[0]
    return {
      wallet: row.accountId,
      allocated: Number(row.allocated),
      unlocked: Number(row.unlocked),
      reserved: Number(row.reserved),
      consumed: Number(row.consumed),
      expired: Number(row.expired),
    }
  }

  async updateAccount(wallet: string, account: CreditAccount): Promise<void> {
    await this.db
      .update(finnCreditAccounts)
      .set({
        allocated: BigInt(account.allocated),
        unlocked: BigInt(account.unlocked),
        reserved: BigInt(account.reserved),
        consumed: BigInt(account.consumed),
        expired: BigInt(account.expired),
        updatedAt: BigInt(Date.now()),
      })
      .where(eq(finnCreditAccounts.accountId, wallet.toLowerCase()))
  }

  /**
   * Atomic reserve: single SQL conditional UPDATE that prevents TOCTOU race.
   * Bridge high-2 fix: same pattern as api-keys.ts:198-216.
   *
   * SQL: UPDATE finn_credit_accounts
   *      SET unlocked = unlocked - $amount, reserved = reserved + $amount
   *      WHERE account_id = $wallet AND unlocked >= $amount
   *      RETURNING *
   *
   * If 0 rows affected → insufficient credits (concurrent drain). No overspend.
   */
  async atomicReserve(wallet: string, amount: number): Promise<CreditAccount | null> {
    const rows = await this.db
      .update(finnCreditAccounts)
      .set({
        unlocked: sql`${finnCreditAccounts.unlocked} - ${BigInt(amount)}`,
        reserved: sql`${finnCreditAccounts.reserved} + ${BigInt(amount)}`,
        updatedAt: BigInt(Date.now()),
      })
      .where(
        sql`${finnCreditAccounts.accountId} = ${wallet.toLowerCase()} AND ${finnCreditAccounts.unlocked} >= ${BigInt(amount)}`,
      )
      .returning()

    if (rows.length === 0) return null

    const row = rows[0]
    return {
      wallet: row.accountId,
      allocated: Number(row.allocated),
      unlocked: Number(row.unlocked),
      reserved: Number(row.reserved),
      consumed: Number(row.consumed),
      expired: Number(row.expired),
    }
  }

  // Reservations stored in Redis with TTL for automatic expiry
  private reservationKey(id: string): string {
    return `credit:reservation:${id}`
  }

  async getReservation(reservationId: string): Promise<ReservationReceipt | null> {
    const data = await this.redis.get(this.reservationKey(reservationId))
    if (!data) return null
    return JSON.parse(data) as ReservationReceipt
  }

  async setReservation(receipt: ReservationReceipt): Promise<void> {
    const ttlSeconds = Math.ceil((receipt.expiresAt - Date.now()) / 1000)
    await this.redis.set(
      this.reservationKey(receipt.reservationId),
      JSON.stringify(receipt),
      "EX",
      Math.max(ttlSeconds, 1),
    )
  }

  async deleteReservation(reservationId: string): Promise<void> {
    await this.redis.del(this.reservationKey(reservationId))
  }
}
