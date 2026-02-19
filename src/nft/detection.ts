// src/nft/detection.ts — Alchemy Batch NFT Detection (Sprint 13 Task 13.1)
//
// Replaces O(100×C) per-collection RPC loop with Alchemy's getNFTsForOwner
// batch API. Single API call returns all NFTs for a wallet. Falls back to
// RPC-based detection (OwnershipService) if Alchemy API unavailable.

import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlchemyNFT {
  contract: { address: string }
  tokenId: string
  tokenType: string
  title: string
  description: string
}

export interface AlchemyResponse {
  ownedNfts: AlchemyNFT[]
  totalCount: number
  pageKey?: string
}

export interface DetectedNFT {
  collection: string
  tokenId: string
  title: string
}

export interface NFTDetectionResult {
  wallet: string
  nfts: DetectedNFT[]
  source: "alchemy" | "rpc_fallback"
  cached: boolean
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AlchemyDetectorConfig {
  /** Alchemy API key (required) */
  apiKey: string
  /** Alchemy API base URL (defaults to Base mainnet) */
  baseUrl?: string
  /** Known collection addresses to filter by (lowercase hex) */
  collections: string[]
  /** Redis client for caching */
  redis: RedisCommandClient
  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  cacheTtlSeconds?: number
  /** Fallback detection function when Alchemy is unavailable */
  rpcFallback?: (wallet: string, collections: string[]) => Promise<DetectedNFT[]>
}

/** Cache TTL: 5 minutes */
const DEFAULT_CACHE_TTL = 300

/** Circuit breaker: trip after 3 consecutive failures */
const CIRCUIT_BREAKER_THRESHOLD = 3
/** Circuit breaker: recovery window = 60 seconds */
const CIRCUIT_BREAKER_RECOVERY_MS = 60_000

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export class AlchemyNFTDetector {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly collections: Set<string>
  private readonly redis: RedisCommandClient
  private readonly cacheTtl: number
  private readonly rpcFallback?: (wallet: string, collections: string[]) => Promise<DetectedNFT[]>

  // Circuit breaker state
  private consecutiveFailures = 0
  private circuitOpenUntil = 0

  constructor(config: AlchemyDetectorConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? `https://base-mainnet.g.alchemy.com/nft/v3/${config.apiKey}`
    this.collections = new Set(config.collections.map(c => c.toLowerCase()))
    this.redis = config.redis
    this.cacheTtl = config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL
    this.rpcFallback = config.rpcFallback
  }

  /**
   * Detect all NFTs owned by a wallet from known collections.
   * O(1) API calls via Alchemy instead of O(100×C) RPC calls.
   */
  async detectNFTs(wallet: string): Promise<NFTDetectionResult> {
    const normalizedWallet = wallet.toLowerCase()

    // Check cache first
    const cacheKey = `nft:detection:${normalizedWallet}`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as DetectedNFT[]
        return { wallet: normalizedWallet, nfts: parsed, source: "alchemy", cached: true }
      } catch {
        // Corrupted cache entry — proceed with fresh fetch
      }
    }

    // Check circuit breaker
    if (this.isCircuitOpen()) {
      return this.fallbackDetection(normalizedWallet)
    }

    // Call Alchemy API
    try {
      const nfts = await this.fetchFromAlchemy(normalizedWallet)

      // Reset circuit breaker on success
      this.consecutiveFailures = 0

      // Cache result
      await this.redis.set(cacheKey, JSON.stringify(nfts))
      await this.redis.expire(cacheKey, this.cacheTtl)

      return { wallet: normalizedWallet, nfts, source: "alchemy", cached: false }
    } catch (err) {
      // Record failure for circuit breaker
      this.consecutiveFailures++
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_RECOVERY_MS
        console.log(JSON.stringify({
          metric: "nft.detection.circuit_open",
          failures: this.consecutiveFailures,
          recovery_at: new Date(this.circuitOpenUntil).toISOString(),
          timestamp: Date.now(),
        }))
      }

      return this.fallbackDetection(normalizedWallet)
    }
  }

  /**
   * Check if a wallet owns any NFT from a specific collection.
   */
  async ownsCollectionNFT(wallet: string, collection: string): Promise<boolean> {
    const result = await this.detectNFTs(wallet)
    return result.nfts.some(nft => nft.collection === collection.toLowerCase())
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private isCircuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false
    if (Date.now() >= this.circuitOpenUntil) {
      // Recovery window elapsed — allow one attempt (half-open)
      this.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD - 1
      return false
    }
    return true
  }

  private async fetchFromAlchemy(wallet: string): Promise<DetectedNFT[]> {
    const url = `${this.baseUrl}/getNFTsForOwner?owner=${wallet}&withMetadata=true&pageSize=100`

    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      throw new Error(`Alchemy API returned ${response.status}: ${response.statusText}`)
    }

    const data = (await response.json()) as AlchemyResponse
    return this.filterKnownCollections(data.ownedNfts)
  }

  private filterKnownCollections(nfts: AlchemyNFT[]): DetectedNFT[] {
    return nfts
      .filter(nft => this.collections.has(nft.contract.address.toLowerCase()))
      .map(nft => ({
        collection: nft.contract.address.toLowerCase(),
        tokenId: nft.tokenId,
        title: nft.title || `Token #${nft.tokenId}`,
      }))
  }

  private async fallbackDetection(wallet: string): Promise<NFTDetectionResult> {
    if (!this.rpcFallback) {
      return { wallet, nfts: [], source: "rpc_fallback", cached: false }
    }

    try {
      const nfts = await this.rpcFallback(wallet, [...this.collections])
      return { wallet, nfts, source: "rpc_fallback", cached: false }
    } catch {
      return { wallet, nfts: [], source: "rpc_fallback", cached: false }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create AlchemyNFTDetector from environment.
 * Returns null if ALCHEMY_API_KEY not set.
 */
export function createAlchemyDetector(
  redis: RedisCommandClient,
  rpcFallback?: (wallet: string, collections: string[]) => Promise<DetectedNFT[]>,
): AlchemyNFTDetector | null {
  const apiKey = process.env.ALCHEMY_API_KEY
  if (!apiKey) {
    console.log("[nft] ALCHEMY_API_KEY not set — NFT detection disabled")
    return null
  }

  const collectionsRaw = process.env.NFT_COLLECTIONS ?? "[]"
  let collections: string[]
  try {
    collections = JSON.parse(collectionsRaw)
    if (!Array.isArray(collections)) throw new Error("not an array")
  } catch {
    console.warn("[nft] NFT_COLLECTIONS must be a JSON array, using empty list")
    collections = []
  }

  return new AlchemyNFTDetector({ apiKey, collections, redis, rpcFallback })
}
