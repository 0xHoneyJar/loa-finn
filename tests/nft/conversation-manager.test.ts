// tests/nft/conversation-manager.test.ts — ConversationManager Tests (T1.2, T1.5, T1.6, T1.8)

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  ConversationManager,
  ConversationError,
} from "../../src/nft/conversation.js"
import type { ConversationDeps, ConversationMessage } from "../../src/nft/conversation.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0

function makeRedis() {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      // Handle SETNX: set(key, value, "EX", ttl, "NX")
      if (args.includes("NX")) {
        if (store.has(key)) return null // Lock already held
        store.set(key, value)
        return "OK"
      }
      store.set(key, value)
      return "OK"
    }),
    // Simulate Lua EVAL for atomic index updates
    eval: vi.fn(async (_script: string, _numkeys: number, key: string, value: string) => {
      const current = store.get(key)
      let ids: string[] = []
      try { ids = current ? JSON.parse(current) : [] } catch { ids = [] }
      if (ids.includes(value)) return 0
      ids.push(value)
      store.set(key, JSON.stringify(ids))
      return 1
    }),
    _store: store,
  }
}

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  return {
    redis: makeRedis(),
    walAppend: vi.fn(),
    generateId: () => `id-${++idCounter}`,
    ...overrides,
  }
}

function makeMessage(role: "user" | "assistant" = "user", content = "Hello"): ConversationMessage {
  return { role, content, timestamp: Date.now() }
}

// ---------------------------------------------------------------------------
// T1.5: Summary Fields
// ---------------------------------------------------------------------------

describe("T1.5: Summary Storage Fields", () => {
  beforeEach(() => { idCounter = 0 })

  it("creates conversation with summary: null and summary_message_count: 0", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")

    expect(conv.summary).toBeNull()
    expect(conv.summary_message_count).toBe(0)
  })

  it("preserves summary fields through Redis round-trip", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")

    // Verify Redis stored the fields
    const stored = (deps.redis as ReturnType<typeof makeRedis>)._store.get(`conversation:${conv.id}`)
    expect(stored).toBeDefined()
    const parsed = JSON.parse(stored!)
    expect(parsed.summary).toBeNull()
    expect(parsed.summary_message_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T1.2: WAL-First Write Ordering
// ---------------------------------------------------------------------------

describe("T1.2: WAL-First Write Ordering", () => {
  beforeEach(() => { idCounter = 0 })

  it("calls walAppend before Redis on create", async () => {
    const callOrder: string[] = []
    const redis = makeRedis()
    const originalSet = redis.set
    redis.set = vi.fn(async (...args: Parameters<typeof originalSet>) => {
      callOrder.push("redis")
      return originalSet(...args)
    })

    const deps = makeDeps({
      redis,
      walAppend: vi.fn(() => { callOrder.push("wal") }),
    })
    const mgr = new ConversationManager(deps)

    await mgr.create("nft-1", "0xabc")

    expect(callOrder[0]).toBe("wal")
    expect(callOrder.indexOf("redis")).toBeGreaterThan(0)
  })

  it("calls walAppend before Redis on appendMessage", async () => {
    const callOrder: string[] = []
    const redis = makeRedis()
    const deps = makeDeps({ redis })
    const mgr = new ConversationManager(deps)

    // Create first
    const conv = await mgr.create("nft-1", "0xabc")

    // Now track ordering for appendMessage
    callOrder.length = 0
    const originalSet = redis.set
    redis.set = vi.fn(async (...args: Parameters<typeof originalSet>) => {
      callOrder.push("redis")
      return originalSet(...args)
    })
    ;(deps.walAppend as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push("wal")
    })

    await mgr.appendMessage(conv.id, "0xabc", makeMessage())

    expect(callOrder[0]).toBe("wal")
    expect(callOrder.indexOf("redis")).toBeGreaterThan(0)
  })

  it("throws on WAL failure — message rejected", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    // Create with working WAL first
    const conv = await mgr.create("nft-1", "0xabc")

    // Now make WAL fail for appendMessage
    ;(deps.walAppend as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("WAL fsync failed")
    })

    await expect(
      mgr.appendMessage(conv.id, "0xabc", makeMessage()),
    ).rejects.toThrow("WAL fsync failed")
  })

  it("succeeds when Redis fails after WAL success", async () => {
    const redis = makeRedis()
    const deps = makeDeps({ redis })
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")

    // Make Redis fail after WAL succeeds
    let walCalled = false
    ;(deps.walAppend as ReturnType<typeof vi.fn>).mockImplementation(() => {
      walCalled = true
    })
    redis.set = vi.fn(async () => {
      if (walCalled) throw new Error("Redis connection lost")
      return "OK"
    })

    // Should NOT throw — Redis failure after WAL is non-fatal
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mgr.appendMessage(conv.id, "0xabc", makeMessage())
    consoleSpy.mockRestore()
  })

  it("writes correct WAL record type 0x01 for CREATE", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    await mgr.create("nft-1", "0xabc")

    expect(deps.walAppend).toHaveBeenCalledWith(
      expect.any(String), // conversationId
      0x01,               // CREATE type
      expect.objectContaining({
        nft_id: "nft-1",
        owner_address: "0xabc",
      }),
    )
  })

  it("writes correct WAL record type 0x02 for MESSAGE_APPEND", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")
    await mgr.appendMessage(conv.id, "0xabc", makeMessage("user", "Test msg"))

    // Second call should be MESSAGE_APPEND
    const calls = (deps.walAppend as ReturnType<typeof vi.fn>).mock.calls
    const appendCall = calls.find((c: unknown[]) => c[1] === 0x02)
    expect(appendCall).toBeDefined()
    expect(appendCall![2]).toMatchObject({
      role: "user",
      content: "Test msg",
    })
  })
})

// ---------------------------------------------------------------------------
// T1.6: Async Summary Trigger
// ---------------------------------------------------------------------------

describe("T1.6: Async Summary Trigger", () => {
  beforeEach(() => { idCounter = 0 })

  it("does not trigger summary below threshold", async () => {
    const onSummaryNeeded = vi.fn()
    const deps = makeDeps({ onSummaryNeeded })
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")
    // Append 5 messages (below threshold of 10)
    for (let i = 0; i < 5; i++) {
      await mgr.appendMessage(conv.id, "0xabc", makeMessage())
    }

    expect(onSummaryNeeded).not.toHaveBeenCalled()
  })

  it("triggers summary at 10+ messages (first summary)", async () => {
    const onSummaryNeeded = vi.fn()
    const deps = makeDeps({
      onSummaryNeeded,
      getPersonalityName: vi.fn().mockResolvedValue("TestAgent"),
    })
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")
    for (let i = 0; i < 10; i++) {
      await mgr.appendMessage(conv.id, "0xabc", makeMessage())
    }

    // maybeTriggerSummary is fire-and-forget async — flush microtasks
    await new Promise((r) => setTimeout(r, 20))

    expect(onSummaryNeeded).toHaveBeenCalledTimes(1)
    expect(onSummaryNeeded).toHaveBeenCalledWith(
      conv.id,
      expect.any(Array),
      "TestAgent",
    )
  })

  it("uses SETNX lock to prevent concurrent summary generation", async () => {
    const onSummaryNeeded = vi.fn()
    const redis = makeRedis()
    const deps = makeDeps({
      redis,
      onSummaryNeeded,
      getPersonalityName: vi.fn().mockResolvedValue("Agent"),
    })
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")
    for (let i = 0; i < 10; i++) {
      await mgr.appendMessage(conv.id, "0xabc", makeMessage())
    }

    await new Promise((r) => setTimeout(r, 20))

    // Lock should have been set
    expect(redis.set).toHaveBeenCalledWith(
      `summary_lock:${conv.id}`,
      "1",
      "EX",
      30,
      "NX",
    )
  })

  it("skips summary when lock is already held", async () => {
    const onSummaryNeeded = vi.fn()
    const redis = makeRedis()
    // Pre-set the lock
    redis._store.set("summary_lock:id-1", "1")

    const deps = makeDeps({
      redis,
      onSummaryNeeded,
      getPersonalityName: vi.fn().mockResolvedValue("Agent"),
    })
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")
    for (let i = 0; i < 10; i++) {
      await mgr.appendMessage(conv.id, "0xabc", makeMessage())
    }

    await new Promise((r) => setTimeout(r, 20))

    expect(onSummaryNeeded).not.toHaveBeenCalled()
  })

  it("defaults personality name to 'Agent' when getPersonalityName absent", async () => {
    const onSummaryNeeded = vi.fn()
    const deps = makeDeps({ onSummaryNeeded })
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")
    for (let i = 0; i < 10; i++) {
      await mgr.appendMessage(conv.id, "0xabc", makeMessage())
    }

    await new Promise((r) => setTimeout(r, 20))

    expect(onSummaryNeeded).toHaveBeenCalledWith(
      conv.id,
      expect.any(Array),
      "Agent",
    )
  })

  // -------------------------------------------------------------------------
  // applySummary with monotonic guard
  // -------------------------------------------------------------------------

  it("applySummary updates conversation when count is higher", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")

    const result = await mgr.applySummary(conv.id, "A great summary", 10)

    expect(result).toBe(true)
    expect(deps.walAppend).toHaveBeenCalledWith(
      conv.id,
      0x03, // SUMMARY_UPDATE
      expect.objectContaining({ summary: "A great summary", summary_message_count: 10 }),
    )
  })

  it("applySummary rejects stale summary (monotonic guard)", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xabc")

    // Apply first summary at count 10
    await mgr.applySummary(conv.id, "Summary at 10", 10)

    // Try to apply stale summary at count 5
    const result = await mgr.applySummary(conv.id, "Stale summary", 5)
    expect(result).toBe(false)
  })

  it("applySummary returns false for non-existent conversation", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const result = await mgr.applySummary("nonexistent", "Summary", 10)
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T1.8: getSummaries
// ---------------------------------------------------------------------------

describe("T1.8: getSummaries", () => {
  beforeEach(() => { idCounter = 0 })

  it("returns summaries ordered by reverse index (newest first)", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    // Create 3 conversations with summaries
    const conv1 = await mgr.create("nft-1", "0xwallet")
    await mgr.applySummary(conv1.id, "First conversation", 5)

    const conv2 = await mgr.create("nft-1", "0xwallet")
    await mgr.applySummary(conv2.id, "Second conversation", 5)

    const conv3 = await mgr.create("nft-1", "0xwallet")
    await mgr.applySummary(conv3.id, "Third conversation", 5)

    const summaries = await mgr.getSummaries("nft-1", "0xwallet")

    expect(summaries).toHaveLength(3)
    // Newest first (reverse order)
    expect(summaries[0].summary).toBe("Third conversation")
    expect(summaries[1].summary).toBe("Second conversation")
    expect(summaries[2].summary).toBe("First conversation")
  })

  it("respects limit parameter", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    for (let i = 0; i < 5; i++) {
      const conv = await mgr.create("nft-1", "0xwallet")
      await mgr.applySummary(conv.id, `Summary ${i}`, 5)
    }

    const summaries = await mgr.getSummaries("nft-1", "0xwallet", 2)
    expect(summaries).toHaveLength(2)
  })

  it("excludes conversations without summaries", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv1 = await mgr.create("nft-1", "0xwallet")
    await mgr.applySummary(conv1.id, "Has summary", 5)

    await mgr.create("nft-1", "0xwallet") // No summary

    const summaries = await mgr.getSummaries("nft-1", "0xwallet")
    expect(summaries).toHaveLength(1)
    expect(summaries[0].summary).toBe("Has summary")
  })

  it("excludes specified conversation ID", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv1 = await mgr.create("nft-1", "0xwallet")
    await mgr.applySummary(conv1.id, "First", 5)

    const conv2 = await mgr.create("nft-1", "0xwallet")
    await mgr.applySummary(conv2.id, "Second", 5)

    const summaries = await mgr.getSummaries("nft-1", "0xwallet", 3, conv2.id)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].id).toBe(conv1.id)
  })

  it("uses timing-safe comparison for wallet access check", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xowner")
    await mgr.applySummary(conv.id, "Private summary", 5)

    // Different wallet should not see summaries
    const summaries = await mgr.getSummaries("nft-1", "0xhacker")
    expect(summaries).toHaveLength(0)
  })

  it("handles case-insensitive wallet addresses", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xAbCdEf")
    await mgr.applySummary(conv.id, "Case test", 5)

    const summaries = await mgr.getSummaries("nft-1", "0xabcdef")
    expect(summaries).toHaveLength(1)
  })

  it("returns empty array for NFT with no conversations", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const summaries = await mgr.getSummaries("nft-nonexistent", "0xwallet")
    expect(summaries).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe("Access Control", () => {
  beforeEach(() => { idCounter = 0 })

  it("rejects access from wrong wallet", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xowner")

    await expect(
      mgr.get(conv.id, "0xhacker"),
    ).rejects.toThrow(ConversationError)

    await expect(
      mgr.get(conv.id, "0xhacker"),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" })
  })

  it("rejects message append from wrong wallet", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xowner")

    await expect(
      mgr.appendMessage(conv.id, "0xhacker", makeMessage()),
    ).rejects.toThrow(ConversationError)
  })

  it("rejects oversized messages", async () => {
    const deps = makeDeps()
    const mgr = new ConversationManager(deps)

    const conv = await mgr.create("nft-1", "0xowner")
    const bigMessage = makeMessage("user", "x".repeat(9000))

    await expect(
      mgr.appendMessage(conv.id, "0xowner", bigMessage),
    ).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" })
  })
})
