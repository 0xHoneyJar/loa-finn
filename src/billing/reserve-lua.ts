// src/billing/reserve-lua.ts — Redis Lua script for atomic balance check + hold (Sprint 1 Task 1.6)
//
// All amounts in MicroUSD only — CreditUnit conversion deferred to Sprint 3.1.
// Atomic: check balance >= estimatedCost AND hold reserve in a single Redis eval.

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Lua Script: Atomic Reserve
// ---------------------------------------------------------------------------

/**
 * Atomically check available balance and hold a reserve.
 *
 * KEYS[1] = balance:{account_id}:value (available balance in MicroUSD)
 * KEYS[2] = reserve:{billing_entry_id} (reserve hold marker)
 * KEYS[3] = balance:{account_id}:held (total held amount)
 *
 * ARGV[1] = estimated_cost (MicroUSD string)
 * ARGV[2] = billing_entry_id
 * ARGV[3] = reserve_ttl_seconds (default: 300)
 *
 * Returns:
 *   1 = success (reserve held)
 *   0 = insufficient balance
 *  -1 = reserve already exists (idempotent)
 */
const RESERVE_LUA = `
local balance_key = KEYS[1]
local reserve_key = KEYS[2]
local held_key = KEYS[3]
local cost = ARGV[1]
local billing_entry_id = ARGV[2]
local ttl = tonumber(ARGV[3])

-- Idempotency: if reserve already exists, return -1
if redis.call('EXISTS', reserve_key) == 1 then
  return -1
end

-- Check available balance (MicroUSD, integer string)
local balance_str = redis.call('GET', balance_key) or '0'
local balance = tonumber(balance_str) or 0
local cost_num = tonumber(cost) or 0

if balance < cost_num then
  return 0
end

-- Hold reserve: deduct from available, add to held, set reserve marker with TTL
redis.call('SET', balance_key, tostring(balance - cost_num))
local held_str = redis.call('GET', held_key) or '0'
local held = tonumber(held_str) or 0
redis.call('SET', held_key, tostring(held + cost_num))
redis.call('SET', reserve_key, cost, 'EX', ttl)

return 1
`

// ---------------------------------------------------------------------------
// Lua Script: Release Reserve
// ---------------------------------------------------------------------------

/**
 * Release a reserve: return held amount to available balance.
 *
 * KEYS[1] = balance:{account_id}:value
 * KEYS[2] = reserve:{billing_entry_id}
 * KEYS[3] = balance:{account_id}:held
 *
 * Returns:
 *   1 = success (reserve released)
 *   0 = reserve not found (already released or expired)
 */
const RELEASE_LUA = `
local balance_key = KEYS[1]
local reserve_key = KEYS[2]
local held_key = KEYS[3]

-- Get reserve amount
local cost_str = redis.call('GET', reserve_key)
if not cost_str then
  return 0
end

local cost_num = tonumber(cost_str) or 0

-- Return to available, remove from held
local balance_str = redis.call('GET', balance_key) or '0'
local balance = tonumber(balance_str) or 0
redis.call('SET', balance_key, tostring(balance + cost_num))

local held_str = redis.call('GET', held_key) or '0'
local held = tonumber(held_str) or 0
redis.call('SET', held_key, tostring(math.max(0, held - cost_num)))

-- Remove reserve marker
redis.call('DEL', reserve_key)

return 1
`

// ---------------------------------------------------------------------------
// Lua Script: Commit Reserve
// ---------------------------------------------------------------------------

/**
 * Commit a reserve: move from held to revenue, return overage to available.
 *
 * KEYS[1] = balance:{account_id}:value
 * KEYS[2] = reserve:{billing_entry_id}
 * KEYS[3] = balance:{account_id}:held
 *
 * ARGV[1] = actual_cost (MicroUSD string)
 *
 * Returns:
 *   1 = success (committed)
 *   0 = reserve not found
 */
const COMMIT_LUA = `
local balance_key = KEYS[1]
local reserve_key = KEYS[2]
local held_key = KEYS[3]
local actual_cost = ARGV[1]

-- Get reserve (estimated cost)
local estimated_str = redis.call('GET', reserve_key)
if not estimated_str then
  return 0
end

local estimated = tonumber(estimated_str) or 0
local actual = tonumber(actual_cost) or 0
local overage = estimated - actual

-- Remove from held
local held_str = redis.call('GET', held_key) or '0'
local held = tonumber(held_str) or 0
redis.call('SET', held_key, tostring(math.max(0, held - estimated)))

-- Return overage to available (if any)
if overage > 0 then
  local balance_str = redis.call('GET', balance_key) or '0'
  local balance = tonumber(balance_str) or 0
  redis.call('SET', balance_key, tostring(balance + overage))
end

-- Remove reserve marker
redis.call('DEL', reserve_key)

return 1
`

// ---------------------------------------------------------------------------
// Reserve Operations
// ---------------------------------------------------------------------------

export const RESERVE_TTL_SECONDS = 300 // 5 minutes

export interface ReserveResult {
  success: boolean
  reason: "held" | "insufficient_balance" | "already_exists"
}

/**
 * Atomically reserve funds from an account.
 * All amounts in MicroUSD — CreditUnit conversion layered in Sprint 3.
 */
export async function atomicReserve(
  redis: RedisCommandClient,
  accountId: string,
  billingEntryId: string,
  estimatedCostMicro: string,
  ttlSeconds: number = RESERVE_TTL_SECONDS,
): Promise<ReserveResult> {
  const result = await redis.eval(
    RESERVE_LUA,
    3,
    `balance:${accountId}:value`,
    `reserve:${billingEntryId}`,
    `balance:${accountId}:held`,
    estimatedCostMicro,
    billingEntryId,
    String(ttlSeconds),
  ) as number

  switch (result) {
    case 1:
      return { success: true, reason: "held" }
    case 0:
      return { success: false, reason: "insufficient_balance" }
    case -1:
      return { success: true, reason: "already_exists" }
    default:
      return { success: false, reason: "insufficient_balance" }
  }
}

/**
 * Release a reserve, returning funds to available balance.
 */
export async function atomicRelease(
  redis: RedisCommandClient,
  accountId: string,
  billingEntryId: string,
): Promise<boolean> {
  const result = await redis.eval(
    RELEASE_LUA,
    3,
    `balance:${accountId}:value`,
    `reserve:${billingEntryId}`,
    `balance:${accountId}:held`,
  ) as number
  return result === 1
}

/**
 * Commit a reserve, moving funds from held to revenue with overage return.
 */
export async function atomicCommit(
  redis: RedisCommandClient,
  accountId: string,
  billingEntryId: string,
  actualCostMicro: string,
): Promise<boolean> {
  const result = await redis.eval(
    COMMIT_LUA,
    3,
    `balance:${accountId}:value`,
    `reserve:${billingEntryId}`,
    `balance:${accountId}:held`,
    actualCostMicro,
  ) as number
  return result === 1
}
