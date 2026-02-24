// src/gateway/routes/agent-public-api.ts — Public Personality API (T2.5)
//
// GET /public — Returns public-safe personality data for an agent.
// NO auth required. Excludes BEAUVOIR.md, dAMP fingerprint, wallet address,
// and credit balance. Cached in Redis with 5-minute TTL.

import { Hono } from "hono"
import type { PersonalityProvider } from "../../nft/personality-provider.js"
import type { RedisCommandClient } from "../../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentPublicApiDeps {
  personalityProvider: PersonalityProvider
  redis: RedisCommandClient
  getConversationCount?: (nftId: string) => Promise<number>
  getReputationState?: (nftId: string) => Promise<string>
}

/** Public-safe personality response shape */
interface PublicPersonalityResponse {
  display_name: string
  archetype: string
  element: string | null
  era: string | null
  zodiac_triad: string[] | null
  reputation_state: string | null
  conversation_count: number
  created_at: number | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY_PREFIX = "public_personality"
const CACHE_TTL_SECONDS = 300 // 5 minutes

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createAgentPublicApiRoutes(deps: AgentPublicApiDeps): Hono {
  const app = new Hono()

  // GET /public — Public personality data (no auth required)
  app.get("/public", async (c) => {
    const tokenId = c.req.query("tokenId")
    if (!tokenId || typeof tokenId !== "string") {
      return c.json({ error: "tokenId query parameter is required" }, 400)
    }

    // Check Redis cache first
    const cacheKey = `${CACHE_KEY_PREFIX}:${tokenId}`
    try {
      const cached = await deps.redis.get(cacheKey)
      if (cached) {
        return c.json(JSON.parse(cached))
      }
    } catch {
      // Cache miss or Redis error — proceed to build response
    }

    // Resolve personality
    const personality = await deps.personalityProvider.get(tokenId)
    if (!personality) {
      return c.json({ error: "Token ID not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }

    // Resolve optional dynamic data (conversation count, reputation state)
    let conversationCount = 0
    let reputationState: string | null = null

    const [countResult, reputationResult] = await Promise.allSettled([
      deps.getConversationCount
        ? deps.getConversationCount(tokenId)
        : Promise.resolve(0),
      deps.getReputationState
        ? deps.getReputationState(tokenId)
        : Promise.resolve(null),
    ])

    if (countResult.status === "fulfilled") {
      conversationCount = countResult.value
    }
    if (reputationResult.status === "fulfilled") {
      reputationState = reputationResult.value
    }

    // Build public-safe response — NO beauvoir_template, NO dAMP, NO wallet, NO credits
    const response: PublicPersonalityResponse = {
      display_name: personality.display_name,
      archetype: personality.archetype,
      element: null,
      era: null,
      zodiac_triad: null,
      reputation_state: reputationState,
      conversation_count: conversationCount,
      created_at: null,
    }

    return c.json(await cacheAndReturn(deps.redis, cacheKey, response))
  })

  return app
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write the response to Redis cache with TTL, then return it.
 * Cache write failures are non-fatal — the response is returned regardless.
 */
async function cacheAndReturn(
  redis: RedisCommandClient,
  key: string,
  response: PublicPersonalityResponse,
): Promise<PublicPersonalityResponse> {
  try {
    await redis.set(key, JSON.stringify(response), "EX", CACHE_TTL_SECONDS)
  } catch {
    // Cache write failure is non-fatal
    console.warn(`[agent-public-api] Failed to cache response for key="${key}"`)
  }
  return response
}
