// src/gateway/routes/agent-chat.ts — Agent Chat Route (Sprint 4 T4.7)
//
// POST /api/v1/agent/chat → resolve tokenId → load personality → inject as
// systemPrompt → return personality-conditioned response.
//
// Payment is handled upstream by the payment decision middleware.
// This route reads the PaymentDecision from Hono context.

import { Hono } from "hono"
import type { PersonalityProvider, PersonalityConfig } from "../../nft/personality-provider.js"
import type { PersonalityContext } from "../../nft/personality-context.js"
import type { PaymentDecision } from "../payment-decision.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentChatDeps {
  /** PersonalityProvider for resolving tokenId → config */
  personalityProvider: PersonalityProvider
  /** Generate agent response given a system prompt and user message.
   *  When personalityContext is provided, the router uses personality-aware
   *  pool selection (Sprint 2, T2.5). */
  generateResponse: (systemPrompt: string, userMessage: string, personalityContext?: PersonalityContext | null) => Promise<string>
  /** Resolve PersonalityContext from a token ID.
   *  Returns null if fingerprint is unavailable (legacy v1 personalities).
   *  Optional — when absent, routing falls back to standard pool selection. */
  resolvePersonalityContext?: (tokenId: string, archetype: string) => Promise<PersonalityContext | null>
}

interface ChatRequest {
  token_id: string
  message: string
  session_id?: string
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Create the agent chat route.
 *
 * Expects payment decision middleware to have run upstream and set
 * "payment_decision" on the Hono context.
 */
export function createAgentChatRoutes(deps: AgentChatDeps): Hono {
  const app = new Hono()

  app.post("/", async (c) => {
    // Parse request
    let body: ChatRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid request body" }, 400)
    }

    if (!body.token_id || typeof body.token_id !== "string") {
      return c.json({ error: "token_id is required" }, 400)
    }

    if (!body.message || typeof body.message !== "string") {
      return c.json({ error: "message is required" }, 400)
    }

    // Resolve personality
    const personality = await deps.personalityProvider.get(body.token_id)
    if (!personality) {
      return c.json({ error: "Token ID not found", code: "PERSONALITY_NOT_FOUND" }, 404)
    }

    // Resolve PersonalityContext for personality-aware routing (Sprint 2, T2.5)
    // Returns null for legacy v1 personalities without dAMP fingerprints —
    // in that case, the router falls back to standard pool selection.
    let personalityContext: PersonalityContext | null = null
    if (deps.resolvePersonalityContext) {
      try {
        personalityContext = await deps.resolvePersonalityContext(body.token_id, personality.archetype)
      } catch {
        // Non-fatal: routing falls back to standard pool selection
        console.warn(`[agent-chat] personality context resolution failed for token_id="${body.token_id}"`)
      }
    }

    // Generate response with personality-conditioned system prompt
    let response: string
    try {
      response = await deps.generateResponse(personality.beauvoir_template, body.message, personalityContext)
    } catch (err) {
      console.error(
        JSON.stringify({
          metric: "finn.agent_chat_error",
          token_id: body.token_id,
          error: (err as Error).message,
        }),
      )
      return c.json({ error: "Agent temporarily unavailable" }, 503)
    }

    // Read payment decision from context (set by payment decision middleware)
    const paymentDecision = c.get("payment_decision") as PaymentDecision | undefined

    return c.json({
      response,
      personality: {
        archetype: personality.archetype,
        display_name: personality.display_name,
        ...(personalityContext && {
          routing_version: personalityContext.protocol_version,
          dominant_dimensions: personalityContext.dominant_dimensions.slice(0, 3).map(d => d.dial_id),
        }),
      },
      billing: paymentDecision
        ? {
            method: paymentDecision.method,
            amount_micro: paymentDecision.amountMicro
              ? String(paymentDecision.amountMicro)
              : undefined,
            request_id: paymentDecision.requestId,
          }
        : undefined,
    })
  })

  return app
}
