// src/nft/onboarding.ts — 6-Step Onboarding Flow (Sprint 6 Task 6.3)
//
// Onboarding wizard: wallet connect → NFT detection → NFT selection →
// personality config → credit purchase → agent live.
// Server-side orchestration endpoints consumed by public/onboard/ client.

import { Hono } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import type { OwnershipService } from "./ownership.js"
import type { PersonalityService } from "./personality.js"
import type { AllowlistService } from "../gateway/allowlist.js"
import type { FeatureFlagService } from "../gateway/feature-flags.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingStep =
  | "wallet_connect"
  | "nft_detect"
  | "nft_select"
  | "personality_config"
  | "credit_purchase"
  | "agent_live"

const STEP_ORDER: OnboardingStep[] = [
  "wallet_connect",
  "nft_detect",
  "nft_select",
  "personality_config",
  "credit_purchase",
  "agent_live",
]

export interface OnboardingState {
  session_id: string
  wallet_address: string
  current_step: OnboardingStep
  step_index: number
  completed_steps: OnboardingStep[]
  selected_nft: { collection: string; token_id: string } | null
  personality_configured: boolean
  credits_purchased: boolean
  created_at: number
  updated_at: number
}

export class OnboardingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = "OnboardingError"
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONBOARDING_PREFIX = "onboarding:"
const ONBOARDING_TTL = 3600 // 1 hour session

// ---------------------------------------------------------------------------
// Onboarding Service
// ---------------------------------------------------------------------------

export interface OnboardingDeps {
  redis: RedisCommandClient
  ownershipService: OwnershipService
  personalityService: PersonalityService
  allowlistService: AllowlistService
  featureFlagService: FeatureFlagService
  walAppend?: (namespace: string, operation: string, key: string, payload: unknown) => string
  generateId?: () => string
}

export class OnboardingService {
  private readonly redis: RedisCommandClient
  private readonly ownership: OwnershipService
  private readonly personality: PersonalityService
  private readonly allowlist: AllowlistService
  private readonly featureFlags: FeatureFlagService
  private readonly walAppend: OnboardingDeps["walAppend"]
  private readonly generateId: () => string

  constructor(deps: OnboardingDeps) {
    this.redis = deps.redis
    this.ownership = deps.ownershipService
    this.personality = deps.personalityService
    this.allowlist = deps.allowlistService
    this.featureFlags = deps.featureFlagService
    this.walAppend = deps.walAppend
    this.generateId = deps.generateId ?? (() => `onb_${Date.now().toString(36)}`)
  }

  /**
   * Step 1: Start onboarding after wallet connect + allowlist check.
   */
  async startOnboarding(walletAddress: string): Promise<OnboardingState> {
    const normalized = walletAddress.toLowerCase()

    // Check allowlist
    const allowed = await this.allowlist.isAllowed(normalized)
    if (!allowed) {
      throw new OnboardingError(
        "Wallet not on allowlist",
        "NOT_ALLOWLISTED",
        403,
      )
    }

    // Check feature flag
    const onboardingEnabled = await this.featureFlags.isEnabled("onboarding")
    if (!onboardingEnabled) {
      throw new OnboardingError(
        "Onboarding is currently disabled",
        "FEATURE_DISABLED",
        503,
      )
    }

    const sessionId = this.generateId()
    const now = Date.now()

    const state: OnboardingState = {
      session_id: sessionId,
      wallet_address: normalized,
      current_step: "nft_detect",
      step_index: 1,
      completed_steps: ["wallet_connect"],
      selected_nft: null,
      personality_configured: false,
      credits_purchased: false,
      created_at: now,
      updated_at: now,
    }

    await this.saveState(state)
    this.writeAudit("onboarding_start", { session_id: sessionId, wallet: normalized })

    return state
  }

  /**
   * Step 2: Detect NFTs owned by the wallet.
   */
  async detectNfts(
    sessionId: string,
    collections: Array<{ address: string; name: string }>,
  ): Promise<{ nfts: Array<{ collection: string; token_id: string; name: string }> }> {
    const state = await this.getState(sessionId)
    this.validateStep(state, "nft_detect")

    const nfts: Array<{ collection: string; token_id: string; name: string }> = []

    for (const collection of collections) {
      // Check a range of token IDs (simplified — real impl would use ERC-721 enumeration)
      for (let tokenId = 1; tokenId <= 100; tokenId++) {
        try {
          const isOwner = await this.ownership.verifyOwnership(
            collection.address,
            String(tokenId),
            state.wallet_address,
          )
          if (isOwner) {
            nfts.push({
              collection: collection.address,
              token_id: String(tokenId),
              name: collection.name,
            })
          }
        } catch {
          // Skip failed lookups
        }
      }
    }

    // Advance to nft_select
    state.completed_steps.push("nft_detect")
    state.current_step = "nft_select"
    state.step_index = 2
    state.updated_at = Date.now()
    await this.saveState(state)

    return { nfts }
  }

  /**
   * Step 3: Select an NFT as the agent avatar.
   */
  async selectNft(
    sessionId: string,
    collection: string,
    tokenId: string,
  ): Promise<OnboardingState> {
    const state = await this.getState(sessionId)
    this.validateStep(state, "nft_select")

    // Verify ownership
    const isOwner = await this.ownership.verifyOwnership(
      collection,
      tokenId,
      state.wallet_address,
    )
    if (!isOwner) {
      throw new OnboardingError(
        "You do not own this NFT",
        "NOT_OWNER",
        403,
      )
    }

    state.selected_nft = { collection, token_id: tokenId }
    state.completed_steps.push("nft_select")
    state.current_step = "personality_config"
    state.step_index = 3
    state.updated_at = Date.now()

    await this.saveState(state)
    return state
  }

  /**
   * Step 4: Configure personality (or use default).
   */
  async configurePersonality(
    sessionId: string,
    personalityConfig: { voice?: string; expertise_domains?: string[]; custom_instructions?: string } | null,
  ): Promise<OnboardingState> {
    const state = await this.getState(sessionId)
    this.validateStep(state, "personality_config")

    if (!state.selected_nft) {
      throw new OnboardingError("No NFT selected", "NO_NFT", 400)
    }

    if (personalityConfig) {
      const collection = state.selected_nft.collection
      const tokenId = state.selected_nft.token_id
      const existing = await this.personality.get(collection, tokenId)

      if (existing) {
        // Personality exists — update it
        await this.personality.update(collection, tokenId, {
          voice: personalityConfig.voice as "analytical" | "creative" | "witty" | "sage",
          expertise_domains: personalityConfig.expertise_domains,
          custom_instructions: personalityConfig.custom_instructions,
        })
      } else {
        // No existing personality — create one
        await this.personality.create(collection, tokenId, {
          name: `Agent ${tokenId}`,
          voice: (personalityConfig.voice as "analytical" | "creative" | "witty" | "sage") ?? "analytical",
          expertise_domains: personalityConfig.expertise_domains ?? [],
          custom_instructions: personalityConfig.custom_instructions ?? "",
        })
      }
    }

    state.personality_configured = true
    state.completed_steps.push("personality_config")
    state.current_step = "credit_purchase"
    state.step_index = 4
    state.updated_at = Date.now()

    await this.saveState(state)
    return state
  }

  /**
   * Step 5: Acknowledge credit purchase (or BYOK activation).
   */
  async acknowledgeCreditPurchase(sessionId: string): Promise<OnboardingState> {
    const state = await this.getState(sessionId)
    this.validateStep(state, "credit_purchase")

    state.credits_purchased = true
    state.completed_steps.push("credit_purchase")
    state.current_step = "agent_live"
    state.step_index = 5
    state.updated_at = Date.now()

    await this.saveState(state)
    return state
  }

  /**
   * Step 6: Finalize onboarding — agent goes live.
   */
  async completeOnboarding(sessionId: string): Promise<{
    redirect_url: string
    state: OnboardingState
  }> {
    const state = await this.getState(sessionId)
    this.validateStep(state, "agent_live")

    if (!state.selected_nft) {
      throw new OnboardingError("No NFT selected", "NO_NFT", 400)
    }

    state.completed_steps.push("agent_live")
    state.step_index = 6
    state.updated_at = Date.now()

    await this.saveState(state)
    this.writeAudit("onboarding_complete", {
      session_id: sessionId,
      wallet: state.wallet_address,
      nft: state.selected_nft,
    })

    // Clean up session after completion
    const key = `${ONBOARDING_PREFIX}${sessionId}`
    await this.redis.del(key)

    const redirectUrl = `/agent/${state.selected_nft.collection}/${state.selected_nft.token_id}`
    return { redirect_url: redirectUrl, state }
  }

  /**
   * Get current onboarding state.
   */
  async getState(sessionId: string): Promise<OnboardingState> {
    const key = `${ONBOARDING_PREFIX}${sessionId}`
    const raw = await this.redis.get(key)
    if (!raw) {
      throw new OnboardingError(
        "Onboarding session not found or expired",
        "SESSION_NOT_FOUND",
        404,
      )
    }
    return JSON.parse(raw) as OnboardingState
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async saveState(state: OnboardingState): Promise<void> {
    const key = `${ONBOARDING_PREFIX}${state.session_id}`
    await this.redis.set(key, JSON.stringify(state))
    await this.redis.expire(key, ONBOARDING_TTL)
  }

  private validateStep(state: OnboardingState, expectedStep: OnboardingStep): void {
    if (state.current_step !== expectedStep) {
      throw new OnboardingError(
        `Expected step '${expectedStep}', currently at '${state.current_step}'`,
        "INVALID_STEP",
        400,
      )
    }
  }

  private writeAudit(operation: string, payload: Record<string, unknown>): void {
    if (!this.walAppend) return
    try {
      this.walAppend("onboarding", operation, "onboarding", {
        ...payload,
        timestamp: Date.now(),
      })
    } catch {
      // Best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Onboarding Routes
// ---------------------------------------------------------------------------

export interface OnboardingRouteDeps {
  onboardingService: OnboardingService
  /** Validate session JWT — returns wallet address */
  getWalletAddress: (c: { req: { header: (name: string) => string | undefined } }) => string | null
  /** Known NFT collections for detection */
  collections: Array<{ address: string; name: string }>
}

export function onboardingRoutes(deps: OnboardingRouteDeps): Hono {
  const app = new Hono()

  // POST /api/v1/onboarding/start
  app.post("/start", async (c) => {
    const wallet = deps.getWalletAddress(c)
    if (!wallet) {
      return c.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401)
    }

    try {
      const state = await deps.onboardingService.startOnboarding(wallet)
      return c.json(state)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 403 | 503)
      }
      throw e
    }
  })

  // POST /api/v1/onboarding/:sessionId/detect-nfts
  app.post("/:sessionId/detect-nfts", async (c) => {
    const sessionId = c.req.param("sessionId")
    try {
      const result = await deps.onboardingService.detectNfts(sessionId, deps.collections)
      return c.json(result)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 404 | 400)
      }
      throw e
    }
  })

  // POST /api/v1/onboarding/:sessionId/select-nft
  app.post("/:sessionId/select-nft", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{ collection: string; token_id: string }>()

    if (!body.collection || !body.token_id) {
      return c.json({ error: "collection and token_id required", code: "INVALID_REQUEST" }, 400)
    }

    try {
      const state = await deps.onboardingService.selectNft(sessionId, body.collection, body.token_id)
      return c.json(state)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 403 | 404 | 400)
      }
      throw e
    }
  })

  // POST /api/v1/onboarding/:sessionId/personality
  app.post("/:sessionId/personality", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{
      voice?: string
      expertise_domains?: string[]
      custom_instructions?: string
      skip?: boolean
    }>()

    try {
      const config = body.skip ? null : body
      const state = await deps.onboardingService.configurePersonality(sessionId, config)
      return c.json(state)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400 | 404)
      }
      throw e
    }
  })

  // POST /api/v1/onboarding/:sessionId/credits
  app.post("/:sessionId/credits", async (c) => {
    const sessionId = c.req.param("sessionId")
    try {
      const state = await deps.onboardingService.acknowledgeCreditPurchase(sessionId)
      return c.json(state)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400 | 404)
      }
      throw e
    }
  })

  // POST /api/v1/onboarding/:sessionId/complete
  app.post("/:sessionId/complete", async (c) => {
    const sessionId = c.req.param("sessionId")
    try {
      const result = await deps.onboardingService.completeOnboarding(sessionId)
      return c.json(result)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 400 | 404)
      }
      throw e
    }
  })

  // GET /api/v1/onboarding/:sessionId
  app.get("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId")
    try {
      const state = await deps.onboardingService.getState(sessionId)
      return c.json(state)
    } catch (e) {
      if (e instanceof OnboardingError) {
        return c.json({ error: e.message, code: e.code }, e.httpStatus as 404)
      }
      throw e
    }
  })

  return app
}
