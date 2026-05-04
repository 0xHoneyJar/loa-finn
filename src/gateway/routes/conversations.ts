// src/gateway/routes/conversations.ts — Conversation CRUD Routes
//
// REST endpoints for conversation lifecycle:
// - POST /         — Create conversation
// - GET /          — List conversations (by nft_id)
// - GET /:id/messages — Get paginated messages
//
// All routes expect `wallet_address` on Hono context (set by upstream auth middleware).

import { Hono } from "hono"
import type { Context } from "hono"
import { ConversationError } from "../../nft/conversation.js"
import type { ConversationManager } from "../../nft/conversation.js"
import { requireSiweSession } from "../siwe-auth.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationRouteDeps {
  conversationManager: ConversationManager
  /** JWT secret for SIWE session validation */
  jwtSecret: string
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create conversation CRUD routes.
 *
 * Wires SIWE session middleware internally — sets `siwe_wallet` on Hono context.
 */
export function createConversationRoutes(deps: ConversationRouteDeps): Hono {
  const app = new Hono()

  // SIWE session middleware — validates JWT and sets siwe_wallet on context
  app.use("/*", requireSiweSession(deps.jwtSecret))

  // -------------------------------------------------------------------------
  // POST / — Create conversation
  // -------------------------------------------------------------------------

  app.post("/", async (c) => {
    const walletAddress = c.get("siwe_wallet") as string | undefined
    if (!walletAddress) {
      return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401)
    }

    let body: { nft_id?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid request body" }, 400)
    }

    if (!body.nft_id || typeof body.nft_id !== "string") {
      return c.json({ error: "nft_id is required", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const conversation = await deps.conversationManager.create(body.nft_id, walletAddress)
      return c.json(conversation, 200)
    } catch (err) {
      return handleConversationError(c, err)
    }
  })

  // -------------------------------------------------------------------------
  // GET / — List conversations
  // -------------------------------------------------------------------------

  app.get("/", async (c) => {
    const walletAddress = c.get("siwe_wallet") as string | undefined
    if (!walletAddress) {
      return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401)
    }

    const nftId = c.req.query("nft_id")
    if (!nftId) {
      return c.json({ error: "nft_id query parameter is required", code: "INVALID_REQUEST" }, 400)
    }

    const cursor = c.req.query("cursor") || undefined
    const limitParam = c.req.query("limit")
    const limit = limitParam ? parseInt(limitParam, 10) : undefined

    if (limitParam && (isNaN(limit!) || limit! < 1)) {
      return c.json({ error: "limit must be a positive integer", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const result = await deps.conversationManager.list(nftId, walletAddress, cursor, limit)
      return c.json(result, 200)
    } catch (err) {
      return handleConversationError(c, err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /:id/messages — Get messages
  // -------------------------------------------------------------------------

  app.get("/:id/messages", async (c) => {
    const walletAddress = c.get("siwe_wallet") as string | undefined
    if (!walletAddress) {
      return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401)
    }

    const conversationId = c.req.param("id")

    const cursor = c.req.query("cursor") || undefined
    const limitParam = c.req.query("limit")
    const limit = limitParam ? parseInt(limitParam, 10) : undefined

    if (limitParam && (isNaN(limit!) || limit! < 1)) {
      return c.json({ error: "limit must be a positive integer", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const result = await deps.conversationManager.getMessages(conversationId, walletAddress, cursor, limit)
      return c.json(result, 200)
    } catch (err) {
      return handleConversationError(c, err)
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleConversationError(c: Context<any, any>, err: unknown) {
  if (err instanceof ConversationError) {
    const status = mapErrorCodeToStatus(err.code)
    return c.json({ error: err.message, code: err.code }, status as 400 | 403 | 404)
  }

  console.error("[conversations] Unexpected error:", err)
  return c.json({ error: "Internal server error" }, 500)
}

function mapErrorCodeToStatus(code: ConversationError["code"]): number {
  switch (code) {
    case "NOT_FOUND":
      return 404
    case "ACCESS_DENIED":
      return 403
    case "MESSAGE_TOO_LARGE":
      return 400
    case "INVALID_REQUEST":
      return 400
  }
}
