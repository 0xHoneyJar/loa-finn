// tests/finn/identity-multi-nft.test.ts — Multi-NFT Endpoint Tests (Issue #136)

import { describe, it, expect, vi } from "vitest"
import { createIdentityRoutes } from "../../src/gateway/routes/identity.js"
import type { IdentityRouteDeps } from "../../src/gateway/routes/identity.js"

// ---------------------------------------------------------------------------
// Helper — create Hono test client
// ---------------------------------------------------------------------------

function createTestApp(overrides: Partial<IdentityRouteDeps> = {}) {
  const deps: IdentityRouteDeps = {
    detectNfts: vi.fn(async () => ({
      nfts: [
        { collection: "mibera", tokenId: "42", title: "Mibera #42" },
        { collection: "mibera", tokenId: "99", title: "Mibera #99" },
      ],
      total: 2,
    })),
    defaultContractAddress: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
    ...overrides,
  }
  return { app: createIdentityRoutes(deps), deps }
}

async function fetchJson(app: ReturnType<typeof createIdentityRoutes>, path: string) {
  const res = await app.request(path)
  const body = await res.json()
  return { status: res.status, body, headers: res.headers }
}

const VALID_WALLET = "0x40495A781095932e2FC8dccA69F5e358711Fdd41"

// ---------------------------------------------------------------------------
// GET /wallet/:wallet/nfts (plural — Issue #136)
// ---------------------------------------------------------------------------

describe("GET /wallet/:wallet/nfts (plural)", () => {
  it("returns all NFTs in Issue #136 response shape", async () => {
    const { app } = createTestApp()
    const { status, body } = await fetchJson(app, `/wallet/${VALID_WALLET}/nfts`)

    expect(status).toBe(200)
    expect(body.nfts).toHaveLength(2)
    expect(body.nfts[0]).toEqual({
      nftId: "mibera:42",
      contractAddress: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      tokenId: 42,
      ownerWallet: VALID_WALLET,
      delegatedWallets: [],
    })
    expect(body.nfts[1]).toEqual({
      nftId: "mibera:99",
      contractAddress: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      tokenId: 99,
      ownerWallet: VALID_WALLET,
      delegatedWallets: [],
    })
  })

  it("returns empty array for wallet with no NFTs (not 404)", async () => {
    const { app } = createTestApp({
      detectNfts: vi.fn(async () => ({ nfts: [], total: 0 })),
    })
    const { status, body } = await fetchJson(app, `/wallet/${VALID_WALLET}/nfts`)

    expect(status).toBe(200)
    expect(body.nfts).toEqual([])
  })

  it("returns 400 for invalid wallet address", async () => {
    const { app } = createTestApp()
    const { status, body } = await fetchJson(app, "/wallet/not-a-wallet/nfts")

    expect(status).toBe(400)
    expect(body.code).toBe("INVALID_WALLET")
  })

  it("returns 502 when detection fails", async () => {
    const { app } = createTestApp({
      detectNfts: vi.fn(async () => { throw new Error("RPC timeout") }),
    })
    const { status, body } = await fetchJson(app, `/wallet/${VALID_WALLET}/nfts`)

    expect(status).toBe(502)
    expect(body.code).toBe("NFT_RESOLUTION_FAILED")
  })

  it("includes contractAddress from detection result when available", async () => {
    const { app } = createTestApp({
      detectNfts: vi.fn(async () => ({
        nfts: [{
          collection: "mibera",
          tokenId: "7",
          title: "Mibera #7",
          contractAddress: "0xCustomContract",
          ownerWallet: "0xCustomOwner",
          delegatedWallets: ["0xDelegate1"],
        }],
        total: 1,
      })),
    })
    const { status, body } = await fetchJson(app, `/wallet/${VALID_WALLET}/nfts`)

    expect(status).toBe(200)
    expect(body.nfts[0].contractAddress).toBe("0xCustomContract")
    expect(body.nfts[0].ownerWallet).toBe("0xCustomOwner")
    expect(body.nfts[0].delegatedWallets).toEqual(["0xDelegate1"])
  })
})

// ---------------------------------------------------------------------------
// GET /wallet/:wallet/nft (singular — backward compatible)
// ---------------------------------------------------------------------------

describe("GET /wallet/:wallet/nft (singular, backward compatible)", () => {
  it("returns first NFT only with deprecation headers", async () => {
    const { app } = createTestApp()
    const { status, body, headers } = await fetchJson(app, `/wallet/${VALID_WALLET}/nft`)

    expect(status).toBe(200)
    expect(body.nft).toEqual({
      collection: "mibera",
      tokenId: "42",
      title: "Mibera #42",
    })
    expect(headers.get("Deprecation")).toBe("true")
    expect(headers.get("Sunset")).toBe("2026-09-01T00:00:00Z")
    expect(headers.get("Link")).toContain("/nfts")
  })

  it("returns null nft for empty wallet", async () => {
    const { app } = createTestApp({
      detectNfts: vi.fn(async () => ({ nfts: [], total: 0 })),
    })
    const { status, body } = await fetchJson(app, `/wallet/${VALID_WALLET}/nft`)

    expect(status).toBe(200)
    expect(body.nft).toBeNull()
  })

  it("response shape is unchanged from original (no nftId/contractAddress)", async () => {
    const { app } = createTestApp()
    const { body } = await fetchJson(app, `/wallet/${VALID_WALLET}/nft`)

    // Singular endpoint keeps the legacy shape — no nftId, contractAddress, etc.
    expect(body.nft).toHaveProperty("collection")
    expect(body.nft).toHaveProperty("tokenId")
    expect(body.nft).toHaveProperty("title")
    expect(body.nft).not.toHaveProperty("nftId")
    expect(body.nft).not.toHaveProperty("contractAddress")
  })
})
