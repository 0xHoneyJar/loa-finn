// src/nft/nft-id.ts — Canonical NFT ID construction
//
// Single source of truth for the collection:tokenId composite key format.
// Used by: identity routes, personality pipeline, ownership cache, siwe-ownership.

/**
 * Build a canonical nftId from collection and tokenId.
 *
 * Format: "collection:tokenId" (e.g., "mibera:42")
 *
 * This is the standard composite key used across the codebase for:
 * - Identity resolution (GET /api/identity/wallet/:wallet/nfts)
 * - Personality pipeline (PersonalityPipelineOrchestrator)
 * - Ownership cache (siwe-ownership.ts)
 * - Redis key namespacing
 */
export function buildNftId(collection: string, tokenId: string): string {
  return `${collection}:${tokenId}`
}

/**
 * Parse an nftId back into collection and tokenId.
 * Returns null if the format is invalid.
 */
export function parseNftId(nftId: string): { collection: string; tokenId: string } | null {
  const idx = nftId.indexOf(":")
  if (idx <= 0 || idx === nftId.length - 1) return null
  return {
    collection: nftId.slice(0, idx),
    tokenId: nftId.slice(idx + 1),
  }
}
