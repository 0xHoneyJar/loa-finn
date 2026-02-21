// src/x402/atomic-verify.ts — Redis Lua script wrapper (Sprint 2 T2.6)
//
// Wraps the x402_verify_atomic.lua script for TypeScript consumption.
// Provides typed return codes and error handling.

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Lua Script (inlined for deployment simplicity — no file reads at runtime)
// ---------------------------------------------------------------------------

const X402_VERIFY_ATOMIC_LUA = `
local challenge = redis.call('GET', KEYS[1])
if not challenge then return 1 end

local consumed = redis.call('GET', KEYS[1] .. ':consumed')
if consumed then return 3 end

local replay = redis.call('EXISTS', KEYS[2])
if replay == 1 then return 2 end

redis.call('SET', KEYS[1] .. ':consumed', '1', 'EX', 300)
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[1]))
redis.call('DEL', KEYS[1])

return 0
`

// ---------------------------------------------------------------------------
// Return Codes
// ---------------------------------------------------------------------------

export const VerifyAtomicResult = {
  SUCCESS: 0,
  NONCE_NOT_FOUND: 1,
  REPLAY_DETECTED: 2,
  RACE_LOST: 3,
} as const

export type VerifyAtomicResultCode = (typeof VerifyAtomicResult)[keyof typeof VerifyAtomicResult]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AtomicVerifyParams {
  nonce: string
  txHash: string
  /** Replay key TTL in seconds (default: 86400 = 24h) */
  replayTtlSeconds?: number
}

/**
 * Execute atomic nonce consumption + replay protection.
 *
 * This single Lua script atomically:
 * 1. Checks challenge nonce exists
 * 2. Guards against concurrent consumption
 * 3. Checks tx_hash replay
 * 4. Marks nonce consumed + sets replay key
 *
 * Returns a typed result code.
 */
export async function atomicVerify(
  redis: RedisCommandClient,
  params: AtomicVerifyParams,
): Promise<VerifyAtomicResultCode> {
  const challengeKey = `x402:challenge:${params.nonce}`
  const replayKey = `x402:replay:${params.txHash}`
  const replayTtl = params.replayTtlSeconds ?? 86400

  const result = await redis.eval(
    X402_VERIFY_ATOMIC_LUA,
    2,
    challengeKey,
    replayKey,
    String(replayTtl),
    params.txHash,
  )

  const code = Number(result)
  if (code < 0 || code > 3 || isNaN(code)) {
    throw new Error(`Unexpected Lua script return code: ${result}`)
  }
  return code as VerifyAtomicResultCode
}

/**
 * Store a challenge in Redis for later verification.
 * Called during challenge issuance (402 response).
 */
export async function storeChallenge(
  redis: RedisCommandClient,
  nonce: string,
  challengeJson: string,
  ttlSeconds: number = 300,
): Promise<void> {
  const key = `x402:challenge:${nonce}`
  await redis.set(key, challengeJson, "EX", ttlSeconds)
}

/**
 * Retrieve a stored challenge by nonce.
 * Returns null if expired or not found.
 */
export async function getChallenge(
  redis: RedisCommandClient,
  nonce: string,
): Promise<string | null> {
  const key = `x402:challenge:${nonce}`
  return redis.get(key)
}
