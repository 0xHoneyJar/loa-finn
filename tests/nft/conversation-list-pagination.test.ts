// tests/nft/conversation-list-pagination.test.ts — Mixed-owner list pagination (#216)
//
// The conversation index for an NFT can contain conversations owned by
// different wallets (created before/after an NFT transfer). list() must
// paginate over the FILTERED (caller-owned) stream: full pages, and
// cursor/has_more that reflect owned items — not raw index slices.

import { describe, it, expect } from "vitest"
import { ConversationManager } from "../../src/nft/conversation.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

const NFT_ID = "mibera:42"
const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

interface SeededConv {
  id: string
  owner: string
}

/** Minimal Redis stub: only get() is exercised by list()/load(). */
function fakeRedisWith(convs: SeededConv[]): RedisCommandClient {
  const store = new Map<string, string>()
  store.set(`conv_index:${NFT_ID}`, JSON.stringify(convs.map((c) => c.id)))
  for (const c of convs) {
    store.set(
      `conversation:${c.id}`,
      JSON.stringify({
        id: c.id,
        nft_id: NFT_ID,
        owner_address: c.owner,
        messages: [],
        created_at: 1,
        updated_at: 1,
        message_count: 0,
        snapshot_offset: 0,
        summary: null,
        summary_message_count: 0,
      }),
    )
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
  } as unknown as RedisCommandClient
}

function makeManager(convs: SeededConv[]): ConversationManager {
  return new ConversationManager({
    redis: fakeRedisWith(convs),
    generateId: () => "unused",
  })
}

/** Alternating ownership: c0 (A), c1 (B), c2 (A), c3 (B), ... */
function alternating(count: number): SeededConv[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    owner: i % 2 === 0 ? OWNER_A : OWNER_B,
  }))
}

describe("ConversationManager.list — mixed-owner pagination (#216)", () => {
  it("fills a page with owned items even when interleaved with other owners", async () => {
    // 10 total, 5 owned by A
    const manager = makeManager(alternating(10))

    const page = await manager.list(NFT_ID, OWNER_A, undefined, 3)
    expect(page.items.map((i) => i.id)).toEqual(["c0", "c2", "c4"])
    expect(page.has_more).toBe(true)
    expect(page.cursor).toBe("c4")
  })

  it("cursor continues the filtered stream without gaps or duplicates", async () => {
    const manager = makeManager(alternating(10))

    const page1 = await manager.list(NFT_ID, OWNER_A, undefined, 3)
    const page2 = await manager.list(NFT_ID, OWNER_A, page1.cursor!, 3)

    expect(page2.items.map((i) => i.id)).toEqual(["c6", "c8"])
    expect(page2.has_more).toBe(false)
    expect(page2.cursor).toBeNull()

    const all = [...page1.items, ...page2.items].map((i) => i.id)
    expect(new Set(all).size).toBe(all.length) // no duplicates
    expect(all).toEqual(["c0", "c2", "c4", "c6", "c8"]) // no gaps
  })

  it("has_more is false when the remaining index holds only other owners' conversations", async () => {
    // A owns the first 2; B owns the trailing 8
    const convs: SeededConv[] = [
      { id: "c0", owner: OWNER_A },
      { id: "c1", owner: OWNER_A },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `c${i + 2}`, owner: OWNER_B })),
    ]
    const manager = makeManager(convs)

    const page = await manager.list(NFT_ID, OWNER_A, undefined, 2)
    expect(page.items.map((i) => i.id)).toEqual(["c0", "c1"])
    // Old slice-based pagination reported has_more=true here (index remainder);
    // filter-aware pagination knows A has nothing further.
    expect(page.has_more).toBe(false)
    expect(page.cursor).toBeNull()
  })

  it("returns an empty page for a wallet owning nothing in the index", async () => {
    const manager = makeManager(alternating(6))
    const page = await manager.list(NFT_ID, "0xcccccccccccccccccccccccccccccccccccccccc", undefined, 5)
    expect(page.items).toEqual([])
    expect(page.has_more).toBe(false)
    expect(page.cursor).toBeNull()
  })

  it("other owner sees only their own conversations", async () => {
    const manager = makeManager(alternating(6))
    const page = await manager.list(NFT_ID, OWNER_B, undefined, 10)
    expect(page.items.map((i) => i.id)).toEqual(["c1", "c3", "c5"])
    expect(page.has_more).toBe(false)
  })
})
