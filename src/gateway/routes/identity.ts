// src/gateway/routes/identity.ts — Identity Resolution Endpoints (Sprint 3 T3.2)
//
// Public endpoints for multi-NFT identity resolution:
// - GET /wallet/:wallet/nfts  → all NFTs for a wallet (plural, canonical)
// - GET /wallet/:wallet/nft   → first NFT for a wallet (singular, deprecated)

import { Hono } from "hono"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal NFT info returned by identity resolution. */
export interface NFTInfo {
  collection: string
  tokenId: string
  title: string
}

/** Dependencies injected into identity route factory. */
export interface IdentityRouteDeps {
  /** Resolve all NFTs for a wallet address */
  detectNfts: (wallet: string) => Promise<{
    nfts: Array<{ collection: string; tokenId: string; title: string }>
    total: number
  }>
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Ethereum wallet address: 0x followed by exactly 40 hex characters. */
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/

/** Sunset date for deprecated /nft endpoint (RFC 8594). */
const DEPRECATED_NFT_SUNSET = "2026-09-01T00:00:00Z"

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create identity resolution routes.
 * All routes are public (no auth required).
 */
export function createIdentityRoutes(deps: IdentityRouteDeps): Hono {
  const app = new Hono()

  // GET /wallet/:wallet/nfts — All NFTs for a wallet (canonical endpoint)
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

    return c.json({
      nfts: result.nfts as NFTInfo[],
      total: result.total,
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
