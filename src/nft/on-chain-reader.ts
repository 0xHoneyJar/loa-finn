// src/nft/on-chain-reader.ts — On-Chain Signal Reader (Sprint 5 T5.1)
//
// Reads finnNFT contract to extract signal data for personality derivation.
// Uses RpcPool (Sprint 2 T2.5) for resilient multi-provider RPC calls.
// Parses ERC-721 tokenURI metadata into SignalSnapshot.

import { getAddress } from "viem"
import type { RpcPool } from "../x402/rpc-pool.js"
import type {
  SignalSnapshot,
  Archetype,
  Era,
  SwagRank,
  ZodiacSign,
  Element,
  TarotCard,
} from "./signal-types.js"
import { ARCHETYPES, ERA_BOUNDARIES, ZODIAC_SIGNS } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Minimal ERC-721 ABI (tokenURI + ownerOf)
// ---------------------------------------------------------------------------

const FINN_NFT_ABI = [
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OnChainReaderConfig {
  rpcPool: RpcPool
  contractAddress: string
  /** Gateway for IPFS URIs (default: https://ipfs.io/ipfs/) */
  ipfsGateway?: string
  /** Fetch timeout in ms (default: 10_000) */
  fetchTimeoutMs?: number
  /** Custom fetch function for testing */
  fetchFn?: typeof fetch
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type OnChainReaderErrorCode =
  | "INVALID_CONTRACT_ADDRESS"
  | "CONTRACT_READ_FAILED"
  | "METADATA_FETCH_FAILED"
  | "METADATA_PARSE_FAILED"
  | "INVALID_METADATA"

export class OnChainReaderError extends Error {
  constructor(
    public readonly code: OnChainReaderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "OnChainReaderError"
  }
}

// ---------------------------------------------------------------------------
// Metadata types
// ---------------------------------------------------------------------------

interface NFTAttribute {
  trait_type: string
  value: string | number
}

interface NFTMetadata {
  name?: string
  description?: string
  image?: string
  attributes?: NFTAttribute[]
}

// ---------------------------------------------------------------------------
// OnChainReader
// ---------------------------------------------------------------------------

export class OnChainReader {
  private readonly rpcPool: RpcPool
  private readonly contractAddress: `0x${string}`
  private readonly ipfsGateway: string
  private readonly fetchTimeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(config: OnChainReaderConfig) {
    try {
      this.contractAddress = getAddress(config.contractAddress) as `0x${string}`
    } catch {
      throw new OnChainReaderError(
        "INVALID_CONTRACT_ADDRESS",
        `Invalid contract address: ${config.contractAddress}`,
      )
    }
    this.rpcPool = config.rpcPool
    this.ipfsGateway = config.ipfsGateway ?? "https://ipfs.io/ipfs/"
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? 10_000
    this.fetchFn = config.fetchFn ?? fetch
  }

  /**
   * Read the owner of a token via ownerOf().
   */
  async readOwner(tokenId: string): Promise<string> {
    const tokenIdBigInt = BigInt(tokenId)
    try {
      const owner = await this.rpcPool.execute((client) =>
        client.readContract({
          address: this.contractAddress,
          abi: FINN_NFT_ABI,
          functionName: "ownerOf",
          args: [tokenIdBigInt],
        }),
      )
      return getAddress(owner as string).toLowerCase()
    } catch (err) {
      throw new OnChainReaderError(
        "CONTRACT_READ_FAILED",
        `ownerOf(${tokenId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Read tokenURI from the contract.
   */
  async readTokenURI(tokenId: string): Promise<string> {
    const tokenIdBigInt = BigInt(tokenId)
    try {
      const uri = await this.rpcPool.execute((client) =>
        client.readContract({
          address: this.contractAddress,
          abi: FINN_NFT_ABI,
          functionName: "tokenURI",
          args: [tokenIdBigInt],
        }),
      )
      return uri as string
    } catch (err) {
      throw new OnChainReaderError(
        "CONTRACT_READ_FAILED",
        `tokenURI(${tokenId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Fetch and parse metadata from a URI (HTTP, IPFS, or data: URI).
   */
  async fetchMetadata(uri: string): Promise<NFTMetadata> {
    // Handle data: URIs (on-chain metadata)
    if (uri.startsWith("data:application/json")) {
      return this.parseDataUri(uri)
    }

    const httpUrl = this.resolveIpfsUri(uri)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs)
      const response = await this.fetchFn(httpUrl, { signal: controller.signal })
      clearTimeout(timeout)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      return (await response.json()) as NFTMetadata
    } catch (err) {
      if (err instanceof OnChainReaderError) throw err
      throw new OnChainReaderError(
        "METADATA_FETCH_FAILED",
        `Failed to fetch metadata from ${httpUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Read on-chain signals for a token → SignalSnapshot + owner.
   * Combines tokenURI metadata parsing with ownerOf verification.
   */
  async readSignals(tokenId: string): Promise<{ snapshot: SignalSnapshot; owner: string }> {
    // Parallel reads: tokenURI + ownerOf
    const [uri, owner] = await Promise.all([
      this.readTokenURI(tokenId),
      this.readOwner(tokenId),
    ])

    const metadata = await this.fetchMetadata(uri)
    const snapshot = this.parseMetadataToSnapshot(metadata, tokenId)

    return { snapshot, owner }
  }

  /**
   * Parse NFT metadata attributes into a SignalSnapshot.
   */
  parseMetadataToSnapshot(metadata: NFTMetadata, tokenId: string): SignalSnapshot {
    const attrs = metadata.attributes
    if (!attrs || !Array.isArray(attrs)) {
      throw new OnChainReaderError(
        "INVALID_METADATA",
        `Token ${tokenId}: metadata has no attributes array`,
      )
    }

    const attrMap = new Map<string, string | number>()
    for (const attr of attrs) {
      if (attr.trait_type && attr.value !== undefined) {
        attrMap.set(attr.trait_type.toLowerCase(), attr.value)
      }
    }

    // Extract required fields
    const archetype = this.requireString(attrMap, "archetype", tokenId) as Archetype
    if (!ARCHETYPES.includes(archetype)) {
      throw new OnChainReaderError(
        "INVALID_METADATA",
        `Token ${tokenId}: invalid archetype "${archetype}"`,
      )
    }

    const ancestor = this.requireString(attrMap, "ancestor", tokenId)
    const birthday = this.requireString(attrMap, "birthday", tokenId)
    const molecule = this.requireString(attrMap, "molecule", tokenId)
    const swagRank = this.requireString(attrMap, "swag_rank", tokenId) as SwagRank
    const swagScore = this.requireNumber(attrMap, "swag_score", tokenId)
    const sunSign = this.requireString(attrMap, "sun_sign", tokenId) as ZodiacSign
    const moonSign = this.requireString(attrMap, "moon_sign", tokenId) as ZodiacSign
    const ascendingSign = this.requireString(attrMap, "ascending_sign", tokenId) as ZodiacSign

    // Validate zodiac signs
    for (const [label, sign] of [
      ["sun_sign", sunSign],
      ["moon_sign", moonSign],
      ["ascending_sign", ascendingSign],
    ] as const) {
      if (!ZODIAC_SIGNS.includes(sign as ZodiacSign)) {
        throw new OnChainReaderError(
          "INVALID_METADATA",
          `Token ${tokenId}: invalid ${label} "${sign}"`,
        )
      }
    }

    // Derive era from birthday
    const era = this.deriveEra(birthday, tokenId)

    // Derive tarot + element from molecule (simplified — full bijection in signal-engine.ts)
    const tarot = deriveTarotFromMolecule(molecule)
    const element = tarot.element

    return {
      archetype,
      ancestor,
      birthday,
      era,
      molecule,
      tarot,
      element,
      swag_rank: swagRank,
      swag_score: swagScore,
      sun_sign: sunSign,
      moon_sign: moonSign,
      ascending_sign: ascendingSign,
    }
  }

  // --- Private helpers ---

  private resolveIpfsUri(uri: string): string {
    if (uri.startsWith("ipfs://")) {
      return `${this.ipfsGateway}${uri.slice(7)}`
    }
    return uri
  }

  private parseDataUri(uri: string): NFTMetadata {
    try {
      // data:application/json;base64,<base64>
      const base64Match = uri.match(/^data:application\/json;base64,(.+)$/)
      if (base64Match) {
        const decoded = Buffer.from(base64Match[1], "base64").toString("utf-8")
        return JSON.parse(decoded) as NFTMetadata
      }
      // data:application/json,<json>
      const jsonMatch = uri.match(/^data:application\/json,(.+)$/)
      if (jsonMatch) {
        return JSON.parse(decodeURIComponent(jsonMatch[1])) as NFTMetadata
      }
      throw new Error("Unrecognized data: URI format")
    } catch (err) {
      throw new OnChainReaderError(
        "METADATA_PARSE_FAILED",
        `Failed to parse data: URI: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private requireString(attrs: Map<string, string | number>, key: string, tokenId: string): string {
    const val = attrs.get(key)
    if (val === undefined || val === null) {
      throw new OnChainReaderError(
        "INVALID_METADATA",
        `Token ${tokenId}: missing required attribute "${key}"`,
      )
    }
    return String(val)
  }

  private requireNumber(attrs: Map<string, string | number>, key: string, tokenId: string): number {
    const val = attrs.get(key)
    if (val === undefined || val === null) {
      throw new OnChainReaderError(
        "INVALID_METADATA",
        `Token ${tokenId}: missing required attribute "${key}"`,
      )
    }
    const num = typeof val === "number" ? val : parseFloat(String(val))
    if (isNaN(num)) {
      throw new OnChainReaderError(
        "INVALID_METADATA",
        `Token ${tokenId}: attribute "${key}" must be a number (got "${val}")`,
      )
    }
    return num
  }

  private deriveEra(birthday: string, tokenId: string): Era {
    const yearMatch = birthday.match(/^(-?\d+)/)
    if (!yearMatch) {
      throw new OnChainReaderError(
        "INVALID_METADATA",
        `Token ${tokenId}: birthday "${birthday}" has no parseable year`,
      )
    }
    const year = parseInt(yearMatch[1], 10)

    for (const [era, bounds] of Object.entries(ERA_BOUNDARIES)) {
      if (year >= bounds.start && year < bounds.end) {
        return era as Era
      }
    }
    return "contemporary"
  }
}

// ---------------------------------------------------------------------------
// Tarot derivation (simplified — full bijection in signal-engine.ts)
// ---------------------------------------------------------------------------

/** Derive a TarotCard from molecule name. Deterministic hash-based. */
export function deriveTarotFromMolecule(molecule: string): TarotCard {
  const hash = simpleHash(molecule.toLowerCase())
  const cardNumber = hash % 78

  let suit: TarotCard["suit"]
  let element: Element

  if (cardNumber < 22) {
    suit = "major"
    element = "fire"
  } else {
    const minorIndex = cardNumber - 22
    const suitIndex = Math.floor(minorIndex / 14)
    const suits = ["wands", "cups", "swords", "pentacles"] as const
    const elements: Element[] = ["fire", "water", "air", "earth"]
    suit = suits[suitIndex]
    element = elements[suitIndex]
  }

  return { name: `Card ${cardNumber}`, number: cardNumber, suit, element }
}

/** Deterministic string hash → non-negative integer. Not crypto-safe. */
function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}
