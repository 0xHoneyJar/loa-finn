// src/gateway/siwe-ownership.ts — SIWE NFT Ownership Middleware (SDD §6.2, Sprint 6 Tasks 6.1 + 6.3)
//
// Hono middleware that enforces NFT ownership on V2 write endpoints.
// - Verifies JWT (from wallet-auth.ts) and extracts wallet_address
// - Checks on-chain ownership via OwnershipProvider
// - Write-path: ALWAYS fresh ownerOf() call (bypasses cache)
// - Read-path: cached ownership with 5-min TTL
// - Sets `wallet_address` on Hono context for downstream handlers

import type { Context, Next } from "hono"
import type { OwnershipProvider } from "../nft/chain-config.js"
import * as jose from "jose"

// ---------------------------------------------------------------------------
// Owner Cache (read-path, 5-min TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  owner: string
  expiresAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/** In-memory owner cache keyed by `collection:tokenId` */
const ownerCache = new Map<string, CacheEntry>()

/** Get cached owner for a collection:tokenId pair. Returns null on miss/expired. */
export function getCachedOwner(collection: string, tokenId: string): string | null {
  const key = `${collection}:${tokenId}`
  const entry = ownerCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    ownerCache.delete(key)
    return null
  }
  return entry.owner
}

/** Set cached owner with TTL. */
export function setCachedOwner(collection: string, tokenId: string, owner: string): void {
  const key = `${collection}:${tokenId}`
  ownerCache.set(key, {
    owner,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

/** Invalidate cached owner entry. */
export function invalidateOwnerCache(collection: string, tokenId: string): void {
  const key = `${collection}:${tokenId}`
  ownerCache.delete(key)
}

/** Clear entire cache (useful for tests). */
export function clearOwnerCache(): void {
  ownerCache.clear()
}

// ---------------------------------------------------------------------------
// JWT Verification Config
// ---------------------------------------------------------------------------

export interface OwnershipMiddlewareConfig {
  /** JWT public key for verifying access tokens */
  jwtPublicKey: jose.KeyLike | Uint8Array
  /** JWT algorithm (default: ES256) */
  jwtAlgorithm?: string
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

/**
 * Create Hono middleware that enforces NFT ownership for write endpoints.
 *
 * Flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Verify JWT and extract `sub` (wallet_address)
 * 3. Extract collection + tokenId from route params
 * 4. Verify on-chain ownership (fresh call, no cache on write path)
 * 5. Set `wallet_address` on context for downstream handlers
 *
 * Errors:
 * - 401 AUTH_REQUIRED: missing or invalid JWT
 * - 403 OWNERSHIP_REQUIRED: wallet does not own the NFT
 * - 403 OWNERSHIP_CHANGED: ownership changed between JWT issuance and write
 */
export function requireNFTOwnership(
  provider: OwnershipProvider,
  config: OwnershipMiddlewareConfig,
) {
  return async (c: Context, next: Next) => {
    // Step 1: Extract Bearer token
    const authHeader = c.req.header("authorization")
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        { error: "Missing or invalid Authorization header", code: "AUTH_REQUIRED" },
        401,
      )
    }
    const token = authHeader.slice(7)

    // Step 2: Verify JWT and extract wallet address
    let walletAddress: string
    try {
      const { payload } = await jose.jwtVerify(token, config.jwtPublicKey, {
        algorithms: [config.jwtAlgorithm ?? "ES256"],
      })
      if (!payload.sub) {
        return c.json(
          { error: "JWT missing sub claim", code: "AUTH_REQUIRED" },
          401,
        )
      }
      walletAddress = payload.sub
    } catch {
      return c.json(
        { error: "Invalid or expired access token", code: "AUTH_REQUIRED" },
        401,
      )
    }

    // Step 3: Extract collection + tokenId from route params
    const collection = c.req.param("collection")
    const tokenId = c.req.param("tokenId")

    if (!collection || !tokenId) {
      return c.json(
        { error: "Missing collection or tokenId in route", code: "AUTH_REQUIRED" },
        401,
      )
    }

    // Step 4: Fresh on-chain ownership check (write-path ALWAYS bypasses cache)
    let onChainOwner: string
    try {
      onChainOwner = await provider.getOwnerOf(collection, tokenId)
    } catch (err) {
      // Ownership lookup failure = 403 (fail-closed)
      return c.json(
        {
          error: "Unable to verify NFT ownership",
          code: "OWNERSHIP_REQUIRED",
          detail: err instanceof Error ? err.message : String(err),
        },
        403,
      )
    }

    // Step 5: Compare wallet address to on-chain owner
    if (walletAddress.toLowerCase() !== onChainOwner.toLowerCase()) {
      // Distinguish: was the wallet once the owner? (ownership changed)
      // Check if cache had this wallet as owner (indicates transfer happened)
      const cachedOwner = getCachedOwner(collection, tokenId)
      if (cachedOwner && cachedOwner.toLowerCase() === walletAddress.toLowerCase()) {
        // Cache had this wallet as owner, but on-chain says otherwise -> transfer happened
        invalidateOwnerCache(collection, tokenId)
        return c.json(
          { error: "NFT ownership changed since authentication", code: "OWNERSHIP_CHANGED" },
          403,
        )
      }
      return c.json(
        { error: "Wallet does not own this NFT", code: "OWNERSHIP_REQUIRED" },
        403,
      )
    }

    // Update cache with fresh ownership data
    setCachedOwner(collection, tokenId, onChainOwner)

    // Step 6: Set wallet_address on context for downstream handlers
    c.set("wallet_address", walletAddress)

    await next()
  }
}

/**
 * Read-path ownership check using cache.
 * Returns cached owner or fetches fresh and caches.
 * Intended for non-write endpoints that want ownership info without forcing fresh calls.
 */
export async function getOwnerCached(
  provider: OwnershipProvider,
  collection: string,
  tokenId: string,
): Promise<string> {
  const cached = getCachedOwner(collection, tokenId)
  if (cached) return cached

  const owner = await provider.getOwnerOf(collection, tokenId)
  setCachedOwner(collection, tokenId, owner)
  return owner
}
