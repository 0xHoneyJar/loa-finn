// src/hounfour/redis/ensemble-budget.ts — Ensemble Budget Reservation (SDD §4.6, Task 3.6)
//
// Atomic N-branch pre-reservation via Redis Lua. Commit/release per branch.
// 5-min TTL on reservation hash for crash recovery.

import type { RedisStateBackend } from "./client.js"

// --- Lua Scripts ---

/**
 * Atomic N-branch reservation.
 *
 * KEYS[1] = tenant:{id}:budget_micro (spent counter)
 * KEYS[2] = tenant:{id}:budget_limit_micro (limit)
 * KEYS[3] = ensemble:{ensemble_id}:reserved (hash: branch_idx → amount)
 *
 * ARGV[1] = total reservation amount (sum of all branches)
 * ARGV[2..N] = per-branch reservation amounts
 *
 * Returns JSON: { ok: bool, idempotent?: bool, reason?: string, budget_after: number }
 */
const ENSEMBLE_RESERVE_LUA = `
-- Check if reservation already exists (idempotency)
local existing_len = redis.call('HLEN', KEYS[3])
if existing_len > 0 then
  local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
  return cjson.encode({ok = true, idempotent = true, budget_after = spent})
end

local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(redis.call('GET', KEYS[2]) or '0')
local total_reserve = tonumber(ARGV[1])

-- Check budget (limit=0 means unlimited)
if limit > 0 and spent + total_reserve > limit then
  return cjson.encode({ok = false, reason = 'BUDGET_EXCEEDED', spent = spent, limit = limit})
end

-- Reserve: increment budget spent
redis.call('INCRBY', KEYS[1], total_reserve)

-- Store per-branch reservations
for i = 2, #ARGV do
  redis.call('HSET', KEYS[3], tostring(i - 2), ARGV[i])
end

-- 5-min TTL for crash recovery (auto-expires on crash)
redis.call('EXPIRE', KEYS[3], 300)

return cjson.encode({ok = true, idempotent = false, budget_after = spent + total_reserve})
`

/**
 * Per-branch commit: release unused reservation.
 *
 * KEYS[1] = tenant:{id}:budget_micro (spent counter)
 * KEYS[2] = ensemble:{ensemble_id}:reserved (hash)
 *
 * ARGV[1] = branch_index (string)
 * ARGV[2] = actual_cost_micro (string integer)
 *
 * Returns JSON: { refund: number, actual: number, reserved: number }
 */
const ENSEMBLE_COMMIT_LUA = `
local reserved = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
local actual = tonumber(ARGV[2])
local refund = reserved - actual

if refund > 0 then
  redis.call('DECRBY', KEYS[1], refund)
end

-- Remove branch from reservation hash
redis.call('HDEL', KEYS[2], ARGV[1])

-- Clean up hash if empty (all branches committed)
if redis.call('HLEN', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[2])
end

return cjson.encode({refund = refund, actual = actual, reserved = reserved})
`

// --- Types ---

export interface EnsembleReservation {
  ensembleId: string
  tenantId: string
  branchReservations: number[] // micro-USD per branch
}

export interface ReserveResult {
  ok: boolean
  idempotent: boolean
  reason?: string
  budgetAfter: number
}

export interface CommitResult {
  refund: number
  actual: number
  reserved: number
}

export interface EnsembleBudgetConfig {
  redis: RedisStateBackend
}

// --- EnsembleBudgetReserver ---

/**
 * Manages atomic N-branch budget reservation for ensemble runs.
 *
 * Lifecycle:
 *   1. reserve() — pre-reserve total budget before launching branches
 *   2. commitBranch() — release unused budget per branch as results arrive
 *
 * Crash recovery: reservation hash has 5-min TTL. On crash, auto-expires
 * and budget reconciliation recomputes from JSONL source of truth.
 */
export class EnsembleBudgetReserver {
  private redis: RedisStateBackend

  constructor(config: EnsembleBudgetConfig) {
    this.redis = config.redis
  }

  /**
   * Atomically reserve budget for N ensemble branches.
   *
   * @param reservation - Ensemble ID, tenant ID, and per-branch amounts
   * @returns Reserve result with budget_after or BUDGET_EXCEEDED
   */
  async reserve(reservation: EnsembleReservation): Promise<ReserveResult> {
    if (!this.redis.isConnected()) {
      throw new Error("ENSEMBLE_BUDGET: Redis not connected")
    }

    const totalReserve = reservation.branchReservations.reduce((sum, r) => sum + r, 0)

    const spentKey = this.redis.key("budget", `${reservation.tenantId}:spent_micro`)
    const limitKey = this.redis.key("budget", `${reservation.tenantId}:budget_limit_micro`)
    const reservedKey = this.redis.key("ensemble", `${reservation.ensembleId}:reserved`)

    const args: (string | number)[] = [
      spentKey,
      limitKey,
      reservedKey,
      String(totalReserve),
      ...reservation.branchReservations.map(String),
    ]

    const result = await this.redis.getClient().eval(
      ENSEMBLE_RESERVE_LUA,
      3, // numkeys
      ...args,
    ) as string

    const parsed = JSON.parse(result) as {
      ok: boolean
      idempotent?: boolean
      reason?: string
      budget_after: number
      spent?: number
      limit?: number
    }

    return {
      ok: parsed.ok,
      idempotent: parsed.idempotent ?? false,
      reason: parsed.reason,
      budgetAfter: parsed.budget_after,
    }
  }

  /**
   * Commit a single branch's actual cost, releasing unused reservation.
   *
   * @param ensembleId - Ensemble run ID
   * @param tenantId - Tenant identifier
   * @param branchIndex - Branch index (0-based)
   * @param actualCostMicro - Actual cost in micro-USD
   * @returns Commit result with refund amount
   */
  async commitBranch(
    ensembleId: string,
    tenantId: string,
    branchIndex: number,
    actualCostMicro: number,
  ): Promise<CommitResult> {
    if (!this.redis.isConnected()) {
      throw new Error("ENSEMBLE_BUDGET: Redis not connected")
    }

    const spentKey = this.redis.key("budget", `${tenantId}:spent_micro`)
    const reservedKey = this.redis.key("ensemble", `${ensembleId}:reserved`)

    const result = await this.redis.getClient().eval(
      ENSEMBLE_COMMIT_LUA,
      2, // numkeys
      spentKey,
      reservedKey,
      String(branchIndex),
      String(actualCostMicro),
    ) as string

    return JSON.parse(result) as CommitResult
  }

  /**
   * Check if a reservation exists for an ensemble.
   * Returns branch count if exists, 0 if not.
   */
  async hasReservation(ensembleId: string): Promise<number> {
    if (!this.redis.isConnected()) return 0

    try {
      const reservedKey = this.redis.key("ensemble", `${ensembleId}:reserved`)
      const result = await this.redis.getClient().hgetall(reservedKey)
      return Object.keys(result).length
    } catch {
      return 0
    }
  }

  /**
   * Force-release all remaining reservation for an ensemble.
   * Used for error recovery when branches fail without committing.
   */
  async releaseAll(
    ensembleId: string,
    tenantId: string,
  ): Promise<number> {
    if (!this.redis.isConnected()) return 0

    try {
      const spentKey = this.redis.key("budget", `${tenantId}:spent_micro`)
      const reservedKey = this.redis.key("ensemble", `${ensembleId}:reserved`)

      // Get all remaining reservations
      const remaining = await this.redis.getClient().hgetall(reservedKey)
      let totalRefund = 0

      for (const amount of Object.values(remaining)) {
        totalRefund += parseInt(amount, 10)
      }

      if (totalRefund > 0) {
        // Refund in one operation
        await this.redis.getClient().incrby(spentKey, -totalRefund)
      }

      // Delete the reservation hash
      await this.redis.getClient().del(reservedKey)

      return totalRefund
    } catch {
      return 0
    }
  }
}
