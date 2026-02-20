// tests/finn/conversation.test.ts — Conversation + Ownership Test Suite (Sprint 5 Task 5.6)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { ConversationManager, ConversationError } from "../../src/nft/conversation.js"
import type { RedisCommandClient } from "../../src/hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis(): RedisCommandClient {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    del: vi.fn(async (key: string) => { store.delete(key); return 1 }),
    incrby: vi.fn(async () => 1),
    expire: vi.fn(async () => true),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => null),
  } as unknown as RedisCommandClient
}

// ---------------------------------------------------------------------------
// ID Generator
// ---------------------------------------------------------------------------

let idCounter = 0
function mockGenerateId(): string {
  idCounter++
  return `01CONV${String(idCounter).padStart(20, "0")}`
}

// ---------------------------------------------------------------------------
// 1. Conversation CRUD
// ---------------------------------------------------------------------------

describe("ConversationManager: CRUD", () => {
  let manager: ConversationManager
  let walEntries: Array<{ ns: string; op: string; key: string; payload: unknown }>

  beforeEach(() => {
    idCounter = 0
    walEntries = []
    manager = new ConversationManager({
      redis: createMockRedis(),
      walAppend: (ns, op, key, payload) => {
        walEntries.push({ ns, op, key, payload })
        return "entry-id"
      },
      generateId: mockGenerateId,
    })
  })

  it("creates conversation with owner_address", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")
    expect(conv.id).toBeTruthy()
    expect(conv.nft_id).toBe("0xABC:42")
    expect(conv.owner_address).toBe("0xwalleta") // lowercase
    expect(conv.messages).toEqual([])
    expect(conv.message_count).toBe(0)
  })

  it("retrieves conversation by owner", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")
    const retrieved = await manager.get(conv.id, "0xWalletA")
    expect(retrieved.id).toBe(conv.id)
    expect(retrieved.nft_id).toBe("0xABC:42")
  })

  it("throws NOT_FOUND for missing conversation", async () => {
    await expect(
      manager.get("nonexistent", "0xWalletA"),
    ).rejects.toThrow(ConversationError)

    try {
      await manager.get("nonexistent", "0xWalletA")
    } catch (e) {
      expect((e as ConversationError).code).toBe("NOT_FOUND")
      expect((e as ConversationError).httpStatus).toBe(404)
    }
  })

  it("appends message to conversation", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")
    await manager.appendMessage(conv.id, "0xWalletA", {
      role: "user",
      content: "Hello!",
      timestamp: Date.now(),
    })

    const updated = await manager.get(conv.id, "0xWalletA")
    expect(updated.messages).toHaveLength(1)
    expect(updated.messages[0].role).toBe("user")
    expect(updated.messages[0].content).toBe("Hello!")
    expect(updated.message_count).toBe(1)
  })

  it("rejects messages over 8KB", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")
    await expect(
      manager.appendMessage(conv.id, "0xWalletA", {
        role: "user",
        content: "x".repeat(9000),
        timestamp: Date.now(),
      }),
    ).rejects.toThrow("8192 byte limit")
  })
})

// ---------------------------------------------------------------------------
// 2. Wallet-Bound Access Control
// ---------------------------------------------------------------------------

describe("ConversationManager: access control", () => {
  let manager: ConversationManager

  beforeEach(() => {
    idCounter = 0
    manager = new ConversationManager({
      redis: createMockRedis(),
      generateId: mockGenerateId,
    })
  })

  it("wallet A creates conversation, wallet B cannot read", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")

    // Owner can read
    const result = await manager.get(conv.id, "0xWalletA")
    expect(result.id).toBe(conv.id)

    // Other wallet denied
    await expect(
      manager.get(conv.id, "0xWalletB"),
    ).rejects.toThrow(ConversationError)

    try {
      await manager.get(conv.id, "0xWalletB")
    } catch (e) {
      expect((e as ConversationError).code).toBe("ACCESS_DENIED")
      expect((e as ConversationError).httpStatus).toBe(403)
    }
  })

  it("wallet B cannot append to wallet A's conversation", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")
    await expect(
      manager.appendMessage(conv.id, "0xWalletB", {
        role: "user",
        content: "Intruder!",
        timestamp: Date.now(),
      }),
    ).rejects.toThrow("Access denied")
  })

  it("case-insensitive address matching", async () => {
    const conv = await manager.create("0xABC:42", "0xAbCdEf")
    const result = await manager.get(conv.id, "0xABCDEF") // different case
    expect(result.id).toBe(conv.id)
  })

  it("NFT transfer scenario: new owner creates new conversation, cannot access old", async () => {
    // Wallet A (original owner) creates conversation
    const convA = await manager.create("0xABC:42", "0xWalletA")
    await manager.appendMessage(convA.id, "0xWalletA", {
      role: "user",
      content: "Original owner message",
      timestamp: Date.now(),
    })

    // NFT transfers to Wallet B — B creates new conversation
    const convB = await manager.create("0xABC:42", "0xWalletB")
    expect(convB.id).not.toBe(convA.id)

    // B can read own conversation
    const bResult = await manager.get(convB.id, "0xWalletB")
    expect(bResult.messages).toHaveLength(0)

    // B cannot access A's conversation
    await expect(
      manager.get(convA.id, "0xWalletB"),
    ).rejects.toThrow("Access denied")

    // A can still access own conversation
    const aResult = await manager.get(convA.id, "0xWalletA")
    expect(aResult.messages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Pagination
// ---------------------------------------------------------------------------

describe("ConversationManager: pagination", () => {
  let manager: ConversationManager

  beforeEach(() => {
    idCounter = 0
    manager = new ConversationManager({
      redis: createMockRedis(),
      generateId: mockGenerateId,
    })
  })

  it("lists conversations filtered by wallet", async () => {
    await manager.create("0xABC:42", "0xWalletA")
    await manager.create("0xABC:42", "0xWalletB")
    await manager.create("0xABC:42", "0xWalletA")

    const result = await manager.list("0xABC:42", "0xWalletA")
    expect(result.items).toHaveLength(2)
    expect(result.items.every((i) => i.nft_id === "0xABC:42")).toBe(true)
  })

  it("paginates messages with cursor", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")

    // Add 10 messages
    for (let i = 0; i < 10; i++) {
      await manager.appendMessage(conv.id, "0xWalletA", {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      })
    }

    // Get first page (5 messages)
    const page1 = await manager.getMessages(conv.id, "0xWalletA", undefined, 5)
    expect(page1.items).toHaveLength(5)
    expect(page1.has_more).toBe(true)
    expect(page1.cursor).toBe("5")

    // Get second page
    const page2 = await manager.getMessages(conv.id, "0xWalletA", page1.cursor!, 5)
    expect(page2.items).toHaveLength(5)
    expect(page2.has_more).toBe(false)
    expect(page2.cursor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. WAL Entries
// ---------------------------------------------------------------------------

describe("ConversationManager: WAL audit", () => {
  let walEntries: Array<{ ns: string; op: string; key: string }>
  let manager: ConversationManager

  beforeEach(() => {
    idCounter = 0
    walEntries = []
    manager = new ConversationManager({
      redis: createMockRedis(),
      walAppend: (ns, op, key) => { walEntries.push({ ns, op, key }); return "entry" },
      generateId: mockGenerateId,
    })
  })

  it("conversation_create WAL entry on create", async () => {
    await manager.create("0xABC:42", "0xWalletA")
    expect(walEntries).toHaveLength(1)
    expect(walEntries[0].op).toBe("conversation_create")
  })

  it("conversation_message_append WAL entry per message", async () => {
    const conv = await manager.create("0xABC:42", "0xWalletA")
    walEntries.length = 0

    await manager.appendMessage(conv.id, "0xWalletA", {
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    })
    await manager.appendMessage(conv.id, "0xWalletA", {
      role: "assistant",
      content: "Hi!",
      timestamp: Date.now(),
    })

    expect(walEntries).toHaveLength(2)
    expect(walEntries[0].op).toBe("conversation_message_append")
    expect(walEntries[1].op).toBe("conversation_message_append")
  })
})

// ---------------------------------------------------------------------------
// 5. R2 Recovery
// ---------------------------------------------------------------------------

describe("ConversationManager: R2 persistence", () => {
  it("recovers conversation from R2 on Redis miss", async () => {
    const snapshotConv = {
      id: "conv-restored",
      nft_id: "0xABC:42",
      owner_address: "0xwalleta",
      messages: [{ role: "user", content: "Saved message", timestamp: 1000 }],
      created_at: 1000,
      updated_at: 1000,
      message_count: 1,
      snapshot_offset: 0,
    }

    idCounter = 0
    const redis = createMockRedis()
    const r2Get = vi.fn(async (key: string) => {
      if (key === "conversations/conv-restored/latest.json") {
        return JSON.stringify(snapshotConv)
      }
      return null
    })

    const manager = new ConversationManager({
      redis,
      r2Get,
      generateId: mockGenerateId,
    })

    const result = await manager.get("conv-restored", "0xWalletA")
    expect(result.id).toBe("conv-restored")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content).toBe("Saved message")
    expect(r2Get).toHaveBeenCalledWith("conversations/conv-restored/latest.json")
  })

  it("returns NOT_FOUND when both Redis and R2 miss", async () => {
    const r2Get = vi.fn(async () => null)
    const manager = new ConversationManager({
      redis: createMockRedis(),
      r2Get,
      generateId: mockGenerateId,
    })

    await expect(
      manager.get("missing-conv", "0xWalletA"),
    ).rejects.toThrow("not found")
  })
})

// ---------------------------------------------------------------------------
// 6. Homepage + Module Exports
// ---------------------------------------------------------------------------

describe("Agent Homepage: exports", () => {
  it("homepageRoutes exports a Hono app factory", async () => {
    const { homepageRoutes } = await import("../../src/nft/homepage.js")
    expect(typeof homepageRoutes).toBe("function")
  })

  it("ConversationManager exports all expected types", async () => {
    const mod = await import("../../src/nft/conversation.js")
    expect(mod.ConversationManager).toBeDefined()
    expect(mod.ConversationError).toBeDefined()
  })

  it("OwnershipService exports factory", async () => {
    const mod = await import("../../src/nft/ownership.js")
    expect(mod.OwnershipService).toBeDefined()
    expect(mod.OwnershipError).toBeDefined()
    expect(mod.createOwnershipService).toBeDefined()
  })
})
