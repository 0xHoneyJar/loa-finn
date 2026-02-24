// tests/finn/identity-routes.test.ts — Identity route unit tests (Sprint 3 T3.2)
// Tests: multi-NFT resolution, single-NFT array behavior, deprecated endpoint, wallet validation.

import assert from "node:assert/strict"
import { createIdentityRoutes, type IdentityRouteDeps } from "../../src/gateway/routes/identity.js"

// ── Test Harness ────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++
      console.log(`  \u2713 ${name}`)
    })
    .catch((err) => {
      failed++
      console.error(`  \u2717 ${name}`)
      console.error(`    ${err.message}`)
    })
}

// ── Mock Data ───────────────────────────────────────────────

const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678"
const MULTI_NFTS = [
  { collection: "0xaaa", tokenId: "1", title: "Bear #1" },
  { collection: "0xbbb", tokenId: "42", title: "Milady #42" },
  { collection: "0xccc", tokenId: "7", title: "Honey #7" },
]

function makeDeps(nfts: Array<{ collection: string; tokenId: string; title: string }> = []): IdentityRouteDeps {
  return {
    detectNfts: async (_wallet: string) => ({
      nfts,
      total: nfts.length,
    }),
  }
}

function makeApp(deps: IdentityRouteDeps) {
  return createIdentityRoutes(deps)
}

async function request(app: ReturnType<typeof makeApp>, path: string) {
  const req = new Request(`http://localhost${path}`, { method: "GET" })
  return app.fetch(req)
}

// ── Tests ───────────────────────────────────────────────────

console.log("\nIdentity Routes Tests")
console.log("═".repeat(50))

await test("GET /wallet/:wallet/nfts — multi-NFT wallet returns correct count", async () => {
  const app = makeApp(makeDeps(MULTI_NFTS))
  const res = await request(app, `/wallet/${VALID_WALLET}/nfts`)

  assert.equal(res.status, 200)
  const body = await res.json() as { nfts: unknown[]; total: number }
  assert.equal(body.total, 3)
  assert.equal(body.nfts.length, 3)
})

await test("GET /wallet/:wallet/nfts — single-NFT wallet returns array with 1 element", async () => {
  const singleNft = [MULTI_NFTS[0]]
  const app = makeApp(makeDeps(singleNft))
  const res = await request(app, `/wallet/${VALID_WALLET}/nfts`)

  assert.equal(res.status, 200)
  const body = await res.json() as { nfts: unknown[]; total: number }
  assert.equal(body.total, 1)
  assert.equal(body.nfts.length, 1)
  assert.ok(Array.isArray(body.nfts), "nfts should be an array even for single result")
})

await test("GET /wallet/:wallet/nfts — empty wallet returns empty array", async () => {
  const app = makeApp(makeDeps([]))
  const res = await request(app, `/wallet/${VALID_WALLET}/nfts`)

  assert.equal(res.status, 200)
  const body = await res.json() as { nfts: unknown[]; total: number }
  assert.equal(body.total, 0)
  assert.equal(body.nfts.length, 0)
})

await test("GET /wallet/:wallet/nfts — invalid wallet returns 400", async () => {
  const app = makeApp(makeDeps(MULTI_NFTS))
  const res = await request(app, "/wallet/not-a-wallet/nfts")

  assert.equal(res.status, 400)
  const body = await res.json() as { error: string; code: string }
  assert.equal(body.code, "INVALID_WALLET")
})

await test("GET /wallet/:wallet/nfts — short address returns 400", async () => {
  const app = makeApp(makeDeps(MULTI_NFTS))
  const res = await request(app, "/wallet/0x1234/nfts")

  assert.equal(res.status, 400)
  assert.equal((await res.json() as { code: string }).code, "INVALID_WALLET")
})

await test("GET /wallet/:wallet/nft (deprecated) — returns first NFT only", async () => {
  const app = makeApp(makeDeps(MULTI_NFTS))
  const res = await request(app, `/wallet/${VALID_WALLET}/nft`)

  assert.equal(res.status, 200)
  const body = await res.json() as { nft: { collection: string; tokenId: string; title: string } | null }
  assert.ok(body.nft !== null, "nft should not be null when wallet has NFTs")
  assert.equal(body.nft.collection, "0xaaa")
  assert.equal(body.nft.tokenId, "1")
})

await test("GET /wallet/:wallet/nft (deprecated) — returns deprecation headers", async () => {
  const app = makeApp(makeDeps(MULTI_NFTS))
  const res = await request(app, `/wallet/${VALID_WALLET}/nft`)

  assert.equal(res.headers.get("Deprecation"), "true")
  assert.ok(res.headers.get("Sunset")?.includes("2026-09-01"), "Sunset header should include 2026-09-01")
  assert.ok(res.headers.get("Link")?.includes("/nfts"), "Link header should point to /nfts endpoint")
})

await test("GET /wallet/:wallet/nft (deprecated) — empty wallet returns null nft", async () => {
  const app = makeApp(makeDeps([]))
  const res = await request(app, `/wallet/${VALID_WALLET}/nft`)

  assert.equal(res.status, 200)
  const body = await res.json() as { nft: null }
  assert.equal(body.nft, null)
})

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
