// src/nft/ownership.ts — On-Chain NFT Ownership Verification (Sprint 5 Task 5.1)
//
// ERC-721 ownerOf() check via Base RPC (viem). Cached 5 minutes.
// Fail-closed: RPC failures deny access with 503.

import { createPublicClient, http, getAddress, type PublicClient } from "viem"
import { base } from "viem/chains"

// ---------------------------------------------------------------------------
// ERC-721 ABI (minimal — ownerOf only)
// ---------------------------------------------------------------------------

const ERC721_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000

export interface OwnershipConfig {
  /** Base RPC URL */
  rpcUrl: string
  /** Fallback RPC URL */
  rpcUrlFallback?: string
  /** Allowed NFT collection contract addresses (lowercase hex) */
  collections: string[]
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OwnershipError extends Error {
  constructor(
    public readonly code: "RPC_FAILURE" | "UNKNOWN_COLLECTION" | "NOT_OWNER",
    message: string,
    public readonly httpStatus: number = 503,
  ) {
    super(message)
    this.name = "OwnershipError"
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface CacheEntry {
  owner: string
  timestamp: number
}

export class OwnershipService {
  private primaryClient: PublicClient
  private fallbackClient: PublicClient | null
  private collections: Set<string>
  private cache: Map<string, CacheEntry>

  constructor(config: OwnershipConfig) {
    this.primaryClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) })
    this.fallbackClient = config.rpcUrlFallback
      ? createPublicClient({ chain: base, transport: http(config.rpcUrlFallback) })
      : null
    this.collections = new Set(config.collections.map((c) => c.toLowerCase()))
    this.cache = new Map()
  }

  /**
   * Verify that walletAddress owns the NFT at collection:tokenId.
   * Returns true if ownership verified, throws on RPC failure.
   */
  async verifyOwnership(
    collection: string,
    tokenId: string,
    walletAddress: string,
  ): Promise<boolean> {
    const normalizedCollection = collection.toLowerCase()
    const normalizedWallet = walletAddress.toLowerCase()

    // Validate collection is in allowed list
    if (!this.collections.has(normalizedCollection)) {
      throw new OwnershipError("UNKNOWN_COLLECTION", `Collection ${collection} not in allowed list`, 400)
    }

    // Check cache
    const cacheKey = `${normalizedCollection}:${tokenId}`
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.owner === normalizedWallet
    }

    // On-chain ownerOf() call
    const owner = await this.fetchOwner(normalizedCollection, tokenId)
    const normalizedOwner = owner.toLowerCase()

    // Cache result
    this.cache.set(cacheKey, { owner: normalizedOwner, timestamp: Date.now() })

    return normalizedOwner === normalizedWallet
  }

  /**
   * Invalidate cache for a specific NFT (e.g., on transfer event).
   */
  invalidateCache(collection: string, tokenId: string): void {
    const key = `${collection.toLowerCase()}:${tokenId}`
    this.cache.delete(key)
  }

  /** Clear all cached entries */
  clearCache(): void {
    this.cache.clear()
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async fetchOwner(collection: string, tokenId: string): Promise<string> {
    try {
      return await this.callOwnerOf(this.primaryClient, collection, tokenId)
    } catch (primaryErr) {
      if (this.fallbackClient) {
        try {
          return await this.callOwnerOf(this.fallbackClient, collection, tokenId)
        } catch {
          // Both failed — throw primary error
        }
      }
      throw new OwnershipError("RPC_FAILURE", `Failed to verify ownership: ${primaryErr instanceof Error ? primaryErr.message : "RPC error"}`, 503)
    }
  }

  private async callOwnerOf(client: PublicClient, collection: string, tokenId: string): Promise<string> {
    const owner = await client.readContract({
      address: getAddress(collection) as `0x${string}`,
      abi: ERC721_ABI,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    })
    return owner as string
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create OwnershipService from environment variables.
 * NFT_COLLECTIONS: JSON array of contract addresses.
 */
export function createOwnershipService(rpcUrl: string, rpcUrlFallback?: string): OwnershipService {
  const collectionsRaw = process.env.NFT_COLLECTIONS ?? "[]"
  let collections: string[]
  try {
    collections = JSON.parse(collectionsRaw)
    if (!Array.isArray(collections)) throw new Error("not an array")
  } catch {
    console.warn("[ownership] NFT_COLLECTIONS must be a JSON array of contract addresses, using empty list")
    collections = []
  }

  return new OwnershipService({ rpcUrl, rpcUrlFallback, collections })
}
