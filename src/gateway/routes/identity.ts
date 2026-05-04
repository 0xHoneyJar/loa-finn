// src/gateway/routes/identity.ts — Identity Resolution Endpoints (Sprint 3 T3.2, Issue #136)
//
// Public endpoints for multi-NFT identity resolution:
// - GET /wallet/:wallet/nfts  → all NFTs for a wallet (plural, canonical)
// - GET /wallet/:wallet/nft   → first NFT for a wallet (singular, deprecated)
//
// Response shape aligned with Dixie NftOwnershipResolver (loa-dixie PR #83).

import { Hono } from "hono"
import { buildNftId } from "../../nft/nft-id.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** NFT info returned by the plural /nfts endpoint (Issue #136). */
export interface NFTOwnershipInfo {
  nftId: string
  contractAddress: string
  tokenId: number
  ownerWallet: string
  delegatedWallets: string[]
}

/** Legacy NFT info returned by the singular /nft endpoint. */
export interface NFTInfo {
  collection: string
  tokenId: string
  title: string
}

/** Internal detection result from the dependency. */
export interface DetectedNFT {
  collection: string
  tokenId: string
  title: string
  /** Contract address (if available from on-chain reader) */
  contractAddress?: string
  /** Owner wallet (if available from on-chain reader) */
  ownerWallet?: string
  /** Delegated wallets (if available) */
  delegatedWallets?: string[]
}

/** Dependencies injected into identity route factory. */
export interface IdentityRouteDeps {
  /** Resolve all NFTs for a wallet address */
  detectNfts: (wallet: string) => Promise<{
    nfts: DetectedNFT[]
    total: number
  }>
  /** Contract address for the Mibera collection (used as default if not in detection result) */
  defaultContractAddress?: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Ethereum wallet address: 0x followed by exactly 40 hex characters. */
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/

/** Sunset date for deprecated /nft endpoint (RFC 8594). */
const DEPRECATED_NFT_SUNSET = "2026-09-01T00:00:00Z"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert internal detection result to the Issue #136 response shape.
 * Dixie's NftOwnershipResolver expects: { nftId, contractAddress, tokenId, ownerWallet, delegatedWallets }
 */
function toOwnershipInfo(nft: DetectedNFT, wallet: string, defaultContract: string): NFTOwnershipInfo {
  return {
    nftId: buildNftId(nft.collection, nft.tokenId),
    contractAddress: nft.contractAddress ?? defaultContract,
    tokenId: Number(nft.tokenId),
    ownerWallet: nft.ownerWallet ?? wallet,
    delegatedWallets: nft.delegatedWallets ?? [],
  }
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create identity resolution routes.
 * All routes are public (no auth required).
 */
export function createIdentityRoutes(deps: IdentityRouteDeps): Hono {
  const app = new Hono()
  const defaultContract = deps.defaultContractAddress ?? ""

  // GET /wallet/:wallet/nfts — All NFTs for a wallet (canonical endpoint, Issue #136)
  app.get("/wallet/:wallet/nfts", async (c) => {
    const wallet = c.req.param("wallet")

    if (!WALLET_RE.test(wallet)) {
      return c.json(
        { error: "Invalid wallet address format", code: "INVALID_WALLET" },
        400,
      )
    }

    let result: Awaited<ReturnType<typeof deps.detectNfts>>
    try {
      result = await deps.detectNfts(wallet)
    } catch (err) {
      console.error("[identity] NFT detection failed:", (err as Error).message)
      return c.json(
        { error: "NFT resolution failed", code: "NFT_RESOLUTION_FAILED" },
        502,
      )
    }

    // Issue #136: empty wallet returns { nfts: [] }, not 404
    return c.json({
      nfts: result.nfts.map((nft) => toOwnershipInfo(nft, wallet, defaultContract)),
    })
  })

  // GET /wallet/:wallet/nft — First NFT only (deprecated, use /nfts instead)
  app.get("/wallet/:wallet/nft", async (c) => {
    const wallet = c.req.param("wallet")

    if (!WALLET_RE.test(wallet)) {
      return c.json(
        { error: "Invalid wallet address format", code: "INVALID_WALLET" },
        400,
      )
    }

    let result: Awaited<ReturnType<typeof deps.detectNfts>>
    try {
      result = await deps.detectNfts(wallet)
    } catch (err) {
      console.error("[identity] NFT detection failed:", (err as Error).message)
      return c.json(
        { error: "NFT resolution failed", code: "NFT_RESOLUTION_FAILED" },
        502,
      )
    }
    const firstNft: NFTInfo | null = result.nfts.length > 0
      ? result.nfts[0] as NFTInfo
      : null

    // RFC 8594 deprecation headers
    c.header("Deprecation", "true")
    c.header("Sunset", DEPRECATED_NFT_SUNSET)
    c.header("Link", `</wallet/${wallet}/nfts>; rel="successor-version"`)

    return c.json({ nft: firstNft })
  })

  return app
}
