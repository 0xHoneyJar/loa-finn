// src/nft/chain-config.ts — On-Chain Ownership Provider (SDD §6.1, Sprint 6 Task 6.0)
//
// Abstraction layer for NFT ownership verification.
// EthersOwnershipProvider uses viem for on-chain ERC-721 ownerOf() calls.
// MockOwnershipProvider for CI/test environments — deterministic, no network.

import { createPublicClient, http, getAddress, type PublicClient } from "viem"
import { base } from "viem/chains"

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface OwnershipProvider {
  /** Resolve the current owner of an NFT by collection + tokenId */
  getOwnerOf(collection: string, tokenId: string): Promise<string>

  /** Subscribe to transfer events (best-effort, used for cache invalidation) */
  onTransfer(callback: (from: string, to: string, tokenId: string) => void): void
}

// ---------------------------------------------------------------------------
// Minimal ERC-721 ABI (ownerOf only)
// ---------------------------------------------------------------------------

const ERC721_OWNER_OF_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const

// ---------------------------------------------------------------------------
// Collection-to-Contract Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a collection slug to a contract address.
 * Currently single-collection: FINN_CONTRACT_ADDRESS env var.
 * Future: lookup table or registry contract.
 */
function resolveContract(collection: string): `0x${string}` {
  const contractAddress = process.env.FINN_CONTRACT_ADDRESS
  if (!contractAddress) {
    throw new OwnershipError(
      "CONFIG_MISSING",
      "FINN_CONTRACT_ADDRESS environment variable is not set",
    )
  }
  // Validate it's a proper address
  try {
    return getAddress(contractAddress) as `0x${string}`
  } catch {
    throw new OwnershipError(
      "CONFIG_INVALID",
      `FINN_CONTRACT_ADDRESS is not a valid Ethereum address: ${contractAddress}`,
    )
  }
}

// ---------------------------------------------------------------------------
// EthersOwnershipProvider (viem-based, production)
// ---------------------------------------------------------------------------

export interface EthersOwnershipProviderConfig {
  /** RPC URL (defaults to RPC_URL env var) */
  rpcUrl?: string
  /** Optional contract address override (defaults to FINN_CONTRACT_ADDRESS env) */
  contractAddress?: string
}

export class EthersOwnershipProvider implements OwnershipProvider {
  private client: PublicClient
  private transferCallbacks: Array<(from: string, to: string, tokenId: string) => void> = []

  constructor(config?: EthersOwnershipProviderConfig) {
    const rpcUrl = config?.rpcUrl ?? process.env.RPC_URL
    if (!rpcUrl) {
      throw new OwnershipError("CONFIG_MISSING", "RPC_URL environment variable is not set")
    }
    this.client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    })
  }

  async getOwnerOf(collection: string, tokenId: string): Promise<string> {
    const contractAddress = resolveContract(collection)

    try {
      const owner = await this.client.readContract({
        address: contractAddress,
        abi: ERC721_OWNER_OF_ABI,
        functionName: "ownerOf",
        args: [BigInt(tokenId)],
      })
      return getAddress(owner as string).toLowerCase()
    } catch (err) {
      throw new OwnershipError(
        "OWNERSHIP_LOOKUP_FAILED",
        `Failed to read ownerOf(${tokenId}) on ${contractAddress}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  onTransfer(callback: (from: string, to: string, tokenId: string) => void): void {
    this.transferCallbacks.push(callback)
    // Note: Full event subscription (watchContractEvent) deferred to Sprint 7.
    // For now, cache invalidation relies on TTL expiry + fresh read on write path.
  }
}

// ---------------------------------------------------------------------------
// MockOwnershipProvider (CI / test)
// ---------------------------------------------------------------------------

export class MockOwnershipProvider implements OwnershipProvider {
  /** Deterministic owner map: `collection:tokenId` -> owner address */
  private owners = new Map<string, string>()
  private transferCallbacks: Array<(from: string, to: string, tokenId: string) => void> = []

  /** Set a mock owner for a collection:tokenId pair */
  setOwner(collection: string, tokenId: string, owner: string): void {
    this.owners.set(`${collection}:${tokenId}`, owner.toLowerCase())
  }

  /** Remove ownership (simulates burn or transfer to unknown) */
  removeOwner(collection: string, tokenId: string): void {
    this.owners.delete(`${collection}:${tokenId}`)
  }

  /** Simulate a transfer event (fires callbacks) */
  simulateTransfer(from: string, to: string, collection: string, tokenId: string): void {
    this.owners.set(`${collection}:${tokenId}`, to.toLowerCase())
    for (const cb of this.transferCallbacks) {
      cb(from.toLowerCase(), to.toLowerCase(), tokenId)
    }
  }

  async getOwnerOf(collection: string, tokenId: string): Promise<string> {
    const key = `${collection}:${tokenId}`
    const owner = this.owners.get(key)
    if (!owner) {
      throw new OwnershipError(
        "OWNERSHIP_LOOKUP_FAILED",
        `No mock owner configured for ${key}`,
      )
    }
    return owner
  }

  onTransfer(callback: (from: string, to: string, tokenId: string) => void): void {
    this.transferCallbacks.push(callback)
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type OwnershipErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "OWNERSHIP_LOOKUP_FAILED"

export class OwnershipError extends Error {
  constructor(
    public readonly code: OwnershipErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "OwnershipError"
  }
}
