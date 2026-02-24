// tests/gateway/conversations.test.ts — Conversation CRUD Route Tests

import { describe, it, expect, beforeEach, vi } from "vitest"
import { Hono } from "hono"
import { createConversationRoutes } from "../../src/gateway/routes/conversations.js"
import { ConversationError } from "../../src/nft/conversation.js"
import type { ConversationManager, Conversation, ConversationSummary, ConversationMessage, PaginatedResult } from "../../src/nft/conversation.js"

// ---------------------------------------------------------------------------
// Mock ConversationManager
// ---------------------------------------------------------------------------

function createMockConversationManager() {
  const mockCreate = vi.fn<(nftId: string, ownerAddress: string) => Promise<Conversation>>()
  const mockList = vi.fn<(nftId: string, walletAddress: string, cursor?: string, limit?: number) => Promise<PaginatedResult<ConversationSummary>>>()
  const mockGetMessages = vi.fn<(conversationId: string, walletAddress: string, cursor?: string, limit?: number) => Promise<PaginatedResult<ConversationMessage>>>()
  const mockGet = vi.fn<(conversationId: string, walletAddress: string) => Promise<Conversation>>()
  const mockAppendMessage = vi.fn<(conversationId: string, walletAddress: string, message: ConversationMessage) => Promise<void>>()

  const manager = {
    create: mockCreate,
    list: mockList,
    getMessages: mockGetMessages,
    get: mockGet,
    appendMessage: mockAppendMessage,
  } as unknown as ConversationManager

  return { manager, mockCreate, mockList, mockGetMessages, mockGet, mockAppendMessage }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WALLET = "0x742d35cc6634c0532925a3b844bc9e7595f2bd18"
const OTHER_WALLET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
const NFT_ID = "nft-42"
const CONV_ID = "conv-abc-123"

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONV_ID,
    nft_id: NFT_ID,
    owner_address: WALLET,
    messages: [],
    created_at: 1700000000000,
    updated_at: 1700000000000,
    message_count: 0,
    snapshot_offset: 0,
    summary: null,
    summary_message_count: 0,
    ...overrides,
  }
}

function makeSummary(id: string, messageCount = 5): ConversationSummary {
  return {
    id,
    nft_id: NFT_ID,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    message_count: messageCount,
    last_message_preview: "Last message preview...",
  }
}

function makeMessage(role: "user" | "assistant", content: string): ConversationMessage {
  return { role, content, timestamp: Date.now() }
}

/**
 * Build a Hono app with the conversation routes mounted,
 * injecting wallet_address via middleware to simulate upstream auth.
 */
function buildApp(manager: ConversationManager, wallet: string = WALLET): Hono {
  const app = new Hono()

  // Simulate upstream auth middleware setting wallet_address
  app.use("/api/v1/conversations/*", async (c, next) => {
    c.set("wallet_address", wallet)
    await next()
  })

  const routes = createConversationRoutes({ conversationManager: manager })
  app.route("/api/v1/conversations", routes)
  return app
}

/**
 * Build app WITHOUT wallet_address set (no auth middleware).
 */
function buildUnauthApp(manager: ConversationManager): Hono {
  const app = new Hono()
  const routes = createConversationRoutes({ conversationManager: manager })
  app.route("/api/v1/conversations", routes)
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation CRUD Routes", () => {
  let mocks: ReturnType<typeof createMockConversationManager>
  let app: Hono

  beforeEach(() => {
    mocks = createMockConversationManager()
    app = buildApp(mocks.manager)
  })

  // -------------------------------------------------------------------------
  // POST / — Create conversation
  // -------------------------------------------------------------------------

  describe("POST / — Create conversation", () => {
    it("creates a conversation and returns 200", async () => {
      const conversation = makeConversation()
      mocks.mockCreate.mockResolvedValue(conversation)

      const res = await app.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nft_id: NFT_ID }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(CONV_ID)
      expect(body.nft_id).toBe(NFT_ID)
      expect(body.owner_address).toBe(WALLET)
      expect(body.messages).toEqual([])

      expect(mocks.mockCreate).toHaveBeenCalledWith(NFT_ID, WALLET)
    })

    it("returns 400 when nft_id is missing", async () => {
      const res = await app.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("nft_id")
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("returns 400 when nft_id is not a string", async () => {
      const res = await app.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nft_id: 42 }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("nft_id")
    })

    it("returns 400 for invalid request body", async () => {
      const res = await app.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })

      expect(res.status).toBe(400)
    })

    it("returns 401 when wallet_address is not set", async () => {
      const unauthApp = buildUnauthApp(mocks.manager)
      const res = await unauthApp.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nft_id: NFT_ID }),
      })

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.code).toBe("AUTH_REQUIRED")
    })
  })

  // -------------------------------------------------------------------------
  // GET / — List conversations
  // -------------------------------------------------------------------------

  describe("GET / — List conversations", () => {
    it("lists conversations with pagination", async () => {
      const paginatedResult: PaginatedResult<ConversationSummary> = {
        items: [
          makeSummary("conv-1", 10),
          makeSummary("conv-2", 5),
        ],
        cursor: "conv-2",
        has_more: true,
      }
      mocks.mockList.mockResolvedValue(paginatedResult)

      const res = await app.request("/api/v1/conversations?nft_id=nft-42")
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.items).toHaveLength(2)
      expect(body.items[0].id).toBe("conv-1")
      expect(body.items[1].id).toBe("conv-2")
      expect(body.cursor).toBe("conv-2")
      expect(body.has_more).toBe(true)

      expect(mocks.mockList).toHaveBeenCalledWith(NFT_ID, WALLET, undefined, undefined)
    })

    it("passes cursor and limit to manager", async () => {
      mocks.mockList.mockResolvedValue({ items: [], cursor: null, has_more: false })

      const res = await app.request("/api/v1/conversations?nft_id=nft-42&cursor=conv-5&limit=10")
      expect(res.status).toBe(200)

      expect(mocks.mockList).toHaveBeenCalledWith(NFT_ID, WALLET, "conv-5", 10)
    })

    it("returns empty list when no conversations exist", async () => {
      mocks.mockList.mockResolvedValue({ items: [], cursor: null, has_more: false })

      const res = await app.request("/api/v1/conversations?nft_id=nft-42")
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.items).toEqual([])
      expect(body.cursor).toBeNull()
      expect(body.has_more).toBe(false)
    })

    it("returns 400 when nft_id is missing", async () => {
      const res = await app.request("/api/v1/conversations")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("nft_id")
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("returns 400 when limit is not a valid positive integer", async () => {
      const res = await app.request("/api/v1/conversations?nft_id=nft-42&limit=abc")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("limit")
    })

    it("returns 400 when limit is zero", async () => {
      const res = await app.request("/api/v1/conversations?nft_id=nft-42&limit=0")
      expect(res.status).toBe(400)
    })

    it("returns 401 when wallet_address is not set", async () => {
      const unauthApp = buildUnauthApp(mocks.manager)
      const res = await unauthApp.request("/api/v1/conversations?nft_id=nft-42")
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // GET /:id/messages — Get messages
  // -------------------------------------------------------------------------

  describe("GET /:id/messages — Get messages", () => {
    it("returns paginated messages", async () => {
      const messages: ConversationMessage[] = [
        makeMessage("user", "Hello"),
        makeMessage("assistant", "Hi there!"),
        makeMessage("user", "How are you?"),
      ]
      const paginatedResult: PaginatedResult<ConversationMessage> = {
        items: messages,
        cursor: "3",
        has_more: true,
      }
      mocks.mockGetMessages.mockResolvedValue(paginatedResult)

      const res = await app.request(`/api/v1/conversations/${CONV_ID}/messages`)
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.items).toHaveLength(3)
      expect(body.items[0].role).toBe("user")
      expect(body.items[0].content).toBe("Hello")
      expect(body.items[1].role).toBe("assistant")
      expect(body.cursor).toBe("3")
      expect(body.has_more).toBe(true)

      expect(mocks.mockGetMessages).toHaveBeenCalledWith(CONV_ID, WALLET, undefined, undefined)
    })

    it("passes cursor and limit to manager", async () => {
      mocks.mockGetMessages.mockResolvedValue({ items: [], cursor: null, has_more: false })

      const res = await app.request(`/api/v1/conversations/${CONV_ID}/messages?cursor=10&limit=5`)
      expect(res.status).toBe(200)

      expect(mocks.mockGetMessages).toHaveBeenCalledWith(CONV_ID, WALLET, "10", 5)
    })

    it("returns empty list when conversation has no messages", async () => {
      mocks.mockGetMessages.mockResolvedValue({ items: [], cursor: null, has_more: false })

      const res = await app.request(`/api/v1/conversations/${CONV_ID}/messages`)
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.items).toEqual([])
      expect(body.has_more).toBe(false)
    })

    it("returns 400 when limit is invalid", async () => {
      const res = await app.request(`/api/v1/conversations/${CONV_ID}/messages?limit=-1`)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("limit")
    })

    it("returns 401 when wallet_address is not set", async () => {
      const unauthApp = buildUnauthApp(mocks.manager)
      const res = await unauthApp.request(`/api/v1/conversations/${CONV_ID}/messages`)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Error handling — ConversationError mapping
  // -------------------------------------------------------------------------

  describe("Error handling", () => {
    it("returns 403 when ConversationManager throws ACCESS_DENIED", async () => {
      mocks.mockGetMessages.mockRejectedValue(
        new ConversationError("ACCESS_DENIED", "Access denied", 403),
      )

      // Build app with a different wallet to trigger access denied
      const wrongWalletApp = buildApp(mocks.manager, OTHER_WALLET)
      const res = await wrongWalletApp.request(`/api/v1/conversations/${CONV_ID}/messages`)

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe("ACCESS_DENIED")
    })

    it("returns 404 when ConversationManager throws NOT_FOUND", async () => {
      mocks.mockGetMessages.mockRejectedValue(
        new ConversationError("NOT_FOUND", "Conversation not found", 404),
      )

      const res = await app.request("/api/v1/conversations/nonexistent/messages")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.code).toBe("NOT_FOUND")
    })

    it("returns 400 when ConversationManager throws MESSAGE_TOO_LARGE", async () => {
      mocks.mockCreate.mockRejectedValue(
        new ConversationError("MESSAGE_TOO_LARGE", "Message exceeds 8192 byte limit", 400),
      )

      const res = await app.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nft_id: NFT_ID }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe("MESSAGE_TOO_LARGE")
    })

    it("returns 400 when ConversationManager throws INVALID_REQUEST", async () => {
      mocks.mockList.mockRejectedValue(
        new ConversationError("INVALID_REQUEST", "Invalid parameters", 400),
      )

      const res = await app.request("/api/v1/conversations?nft_id=nft-42")
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("returns 500 for unexpected errors", async () => {
      mocks.mockCreate.mockRejectedValue(new Error("Redis connection failed"))

      const res = await app.request("/api/v1/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nft_id: NFT_ID }),
      })

      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error).toBe("Internal server error")
    })
  })

  // -------------------------------------------------------------------------
  // Access control — wrong wallet
  // -------------------------------------------------------------------------

  describe("Access control", () => {
    it("returns 403 when listing conversations with wrong wallet triggers ACCESS_DENIED", async () => {
      mocks.mockList.mockRejectedValue(
        new ConversationError("ACCESS_DENIED", "Access denied", 403),
      )

      const wrongWalletApp = buildApp(mocks.manager, OTHER_WALLET)
      const res = await wrongWalletApp.request("/api/v1/conversations?nft_id=nft-42")

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe("ACCESS_DENIED")
    })

    it("returns 403 when getting messages with wrong wallet triggers ACCESS_DENIED", async () => {
      mocks.mockGetMessages.mockRejectedValue(
        new ConversationError("ACCESS_DENIED", "Access denied", 403),
      )

      const wrongWalletApp = buildApp(mocks.manager, OTHER_WALLET)
      const res = await wrongWalletApp.request(`/api/v1/conversations/${CONV_ID}/messages`)

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe("ACCESS_DENIED")
    })
  })
})
