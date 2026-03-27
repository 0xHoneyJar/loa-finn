// src/nft/ownership-gate.ts — Centralized Ownership Verification (Cycle 040, Sprint 1 T-1.3)
//
// All session creation paths MUST route through verifyOwnership().
// Deny-by-default: if tokenId is present but ownership not validated, reject.
//
// Separate 60s TTL auth cache (NOT 24h signal cache) per Flatline SKP-002.
// Transfer-listener.ts invalidates immediately on Transfer event.

import type { Redis as RedisClient } from "ioredis"
import type { Context, Next } from "hono"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnershipGateConfig {
  redis: RedisClient
  /** Read on-chain owner for a tokenId. Injected to avoid circular deps. */
  readOwner: (tokenId: string) => Promise<string>
  /** TTL for auth-layer ownership cache in seconds (default: 60) */
  ownerCacheTtlSeconds?: number
  /** Soft launch allowlist (comma-separated addresses in env var) */
  allowedAddresses?: Set<string>
}

export interface OwnershipResult {
  verified: boolean
  owner: string
  fromCache: boolean
  code?: "OWNERSHIP_REQUIRED" | "ALLOWLIST_DENIED"
  message?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNER_CACHE_PREFIX = "finn:auth-owner:"

// ---------------------------------------------------------------------------
// Centralized Ownership Service
// ---------------------------------------------------------------------------

/**
 * Verify that a wallet address owns a given tokenId.
 *
 * Uses a separate 60s TTL Redis cache for auth decisions (NOT the 24h signal cache).
 * All session creation paths MUST call this function.
 */
export async function verifyOwnership(
  config: OwnershipGateConfig,
  tokenId: string,
  wallet: string,
): Promise<OwnershipResult> {
  const ttl = config.ownerCacheTtlSeconds ?? 60

  // 1. Check allowlist (soft launch gate)
  if (config.allowedAddresses && config.allowedAddresses.size > 0) {
    const normalizedWallet = wallet.toLowerCase()
    if (!config.allowedAddresses.has(normalizedWallet)) {
      return {
        verified: false,
        owner: "",
        fromCache: false,
        code: "ALLOWLIST_DENIED",
        message: "Wallet not in soft launch allowlist",
      }
    }
  }

  // 2. Check auth-layer cache (60s TTL)
  const cacheKey = `${OWNER_CACHE_PREFIX}${tokenId}`
  const cached = await config.redis.get(cacheKey)

  if (cached) {
    const match = cached.toLowerCase() === wallet.toLowerCase()
    if (match) {
      return { verified: true, owner: cached, fromCache: true }
    }
    return {
      verified: false,
      owner: cached,
      fromCache: true,
      code: "OWNERSHIP_REQUIRED",
      message: "You do not own this token",
    }
  }

  // 3. On-chain verification
  let owner: string
  try {
    owner = await config.readOwner(tokenId)
  } catch (err) {
    console.error(
      JSON.stringify({
        metric: "finn.ownership_gate",
        stage: "on_chain_read",
        token_id: tokenId,
        error: (err as Error).message,
        severity: "error",
      }),
    )
    return {
      verified: false,
      owner: "",
      fromCache: false,
      code: "OWNERSHIP_REQUIRED",
      message: "Unable to verify ownership — on-chain read failed",
    }
  }

  // 4. Cache the result (60s TTL)
  await config.redis.set(cacheKey, owner, "EX", ttl).catch(() => {})

  // 5. Compare
  const match = owner.toLowerCase() === wallet.toLowerCase()
  if (!match) {
    return {
      verified: false,
      owner,
      fromCache: false,
      code: "OWNERSHIP_REQUIRED",
      message: "You do not own this token",
    }
  }

  return { verified: true, owner, fromCache: false }
}

/**
 * Invalidate auth-layer ownership cache for a tokenId.
 * Called by transfer-listener.ts on NFT Transfer events.
 */
export async function invalidateOwnershipCache(
  redis: RedisClient,
  tokenId: string,
): Promise<void> {
  await redis.del(`${OWNER_CACHE_PREFIX}${tokenId}`)
}

// ---------------------------------------------------------------------------
// Hono Middleware
// ---------------------------------------------------------------------------

/**
 * Create Hono middleware for ownership verification.
 *
 * Expects:
 * - `wallet_address` set on context by upstream SIWE/JWT auth middleware
 * - `token_id` in request body (JSON)
 *
 * Sets `verified_owner` on context if verification passes.
 */
export function createOwnershipMiddleware(config: OwnershipGateConfig) {
  return async (c: Context, next: Next) => {
    // Extract token_id from request body (peek without consuming)
    let tokenId: string | undefined
    try {
      const body = await c.req.json()
      tokenId = body?.token_id
      // Re-set the body so downstream handlers can read it
      // Hono caches parsed JSON, so this is safe
    } catch {
      // Not a JSON request or no body — skip ownership check
      return next()
    }

    if (!tokenId) {
      // No token_id in request — not an NFT chat request, skip
      return next()
    }

    // Get wallet from upstream auth middleware
    const wallet = c.get("wallet_address") as string | undefined
    if (!wallet) {
      return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401)
    }

    const result = await verifyOwnership(config, tokenId, wallet)

    if (!result.verified) {
      return c.json(
        {
          error: result.message ?? "Ownership verification failed",
          code: result.code ?? "OWNERSHIP_REQUIRED",
        },
        403,
      )
    }

    // Set verified owner on context for downstream use
    c.set("verified_owner", result.owner)
    return next()
  }
}
