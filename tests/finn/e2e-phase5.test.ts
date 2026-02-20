// tests/finn/e2e-phase5.test.ts — Phase 5 E2E Validation (Sprint 30 Task 30.3)
//
// Validates success metrics I-11 (marketplace conservation), I-12 (experience drift),
// I-13 (tier ordering), I-14 (anti-narration enforcement).

import { describe, it, expect } from "vitest"
import { MarketplaceStorage } from "../../src/marketplace/storage.js"
import { SettlementEngine } from "../../src/marketplace/settlement.js"
import { DEFAULT_LOT_SIZE, FEE_RATE } from "../../src/marketplace/types.js"
import type { Order, Match } from "../../src/marketplace/types.js"
import {
  ExperienceStore,
  PER_EPOCH_CLAMP,
  CUMULATIVE_CLAMP,
} from "../../src/nft/experience-types.js"
import type { InteractionAggregate } from "../../src/nft/experience-types.js"
import {
  processEpoch,
  clampEpochDelta,
  clampCumulativeOffset,
} from "../../src/nft/experience-engine.js"
import {
  TIER_LIMITS,
  TIER_ORDER,
  validateTierOrdering,
  compareTiers,
} from "../../src/nft/tier-billing.js"
import type { PersonalityTier } from "../../src/nft/tier-billing.js"
import { validateGovernanceOverride } from "../../src/nft/tier-billing-bridge.js"
import {
  PersonalityReviewerAdapter,
  checkAntiNarration,
} from "../../src/nft/reviewer-adapter.js"
import type { PersonalityReviewInput } from "../../src/nft/reviewer-adapter.js"
import { ARCHETYPES } from "../../src/nft/signal-types.js"
import type { Archetype, Era, Element } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// I-11: Marketplace Conservation
// ---------------------------------------------------------------------------

describe("I-11: Marketplace Conservation", () => {
  const NOW = 1_700_000_000_000

  /** Helper: create a seller ask order */
  function makeAskOrder(id: string, wallet: string, lots: number, priceMicro: number): Order {
    return {
      id,
      wallet,
      side: "ask",
      priceMicro,
      lots,
      lotsRemaining: lots,
      status: "open",
      createdAt: NOW,
      expiresAt: NOW + 7 * 86_400_000,
      updatedAt: NOW,
    }
  }

  /** Helper: create a match from a bid/ask pair */
  function makeMatch(
    id: string,
    bidOrderId: string,
    askOrderId: string,
    buyerWallet: string,
    sellerWallet: string,
    priceMicro: number,
    lots: number,
    escrowId: string,
  ): Match {
    const totalMicro = priceMicro * lots
    const feeMicro = Math.floor(totalMicro * FEE_RATE)
    return {
      id,
      bidOrderId,
      askOrderId,
      buyerWallet,
      sellerWallet,
      priceMicro,
      lots,
      totalMicro,
      feeMicro,
      sellerProceedsMicro: totalMicro - feeMicro,
      settlement: {
        creditsToTransfer: lots * DEFAULT_LOT_SIZE,
        usdcToSeller: totalMicro - feeMicro,
        usdcFee: feeMicro,
        escrowId,
      },
      matchedAt: NOW,
    }
  }

  it("total credits (available + escrowed) = constant after lock + settle cycle", () => {
    const storage = new MarketplaceStorage(() => NOW)
    const engine = new SettlementEngine(storage, () => NOW)

    // Seed wallets: seller has 1000 credits, buyer has 0 credits + 10M USDC
    const INITIAL_CREDITS = 1000
    storage.setBalance("seller", { credits: INITIAL_CREDITS, usdcMicro: 0 })
    storage.setBalance("buyer", { credits: 0, usdcMicro: 10_000_000 })

    // Verify conservation before any action
    const pre = engine.verifyConservation(INITIAL_CREDITS)
    expect(pre.valid).toBe(true)
    expect(pre.actual).toBe(INITIAL_CREDITS)

    // Seller places ask for 5 lots (500 credits)
    const askOrder = makeAskOrder("ask-1", "seller", 5, 500_000)
    storage.putOrder(askOrder)
    const escrow = engine.lockCredits(askOrder)

    // After locking: seller available should decrease, but total conserved
    const postLock = engine.verifyConservation(INITIAL_CREDITS)
    expect(postLock.valid).toBe(true)
    expect(postLock.totalEscrowed).toBe(500)
    expect(postLock.totalAvailable).toBe(500)

    // Match and settle: buyer gets credits, seller gets USDC
    const match = makeMatch(
      "match-1", "bid-1", "ask-1",
      "buyer", "seller",
      500_000, 5, escrow.id,
    )
    const result = engine.settle(match)
    expect(result.status).toBe("success")

    // After settlement: credits transferred to buyer, escrow drained
    const postSettle = engine.verifyConservation(INITIAL_CREDITS)
    expect(postSettle.valid).toBe(true)
    expect(postSettle.actual).toBe(INITIAL_CREDITS)
  })

  it("settlement + rollback preserves conservation", () => {
    const storage = new MarketplaceStorage(() => NOW)
    const engine = new SettlementEngine(storage, () => NOW)

    const INITIAL_CREDITS = 2000
    storage.setBalance("alice", { credits: INITIAL_CREDITS, usdcMicro: 0 })
    storage.setBalance("bob", { credits: 0, usdcMicro: 50_000_000 })

    // Alice sells 10 lots (1000 credits)
    const askOrder = makeAskOrder("ask-2", "alice", 10, 1_000_000)
    storage.putOrder(askOrder)
    const escrow = engine.lockCredits(askOrder)

    const preLock = engine.verifyConservation(INITIAL_CREDITS)
    expect(preLock.valid).toBe(true)

    // Settle the match
    const match = makeMatch(
      "match-2", "bid-2", "ask-2",
      "bob", "alice",
      1_000_000, 10, escrow.id,
    )
    engine.settle(match)

    // Now roll it back
    const rollbackResult = engine.rollback(match)
    expect(rollbackResult.status).toBe("rolled_back")

    // Conservation must still hold after rollback
    const postRollback = engine.verifyConservation(INITIAL_CREDITS)
    expect(postRollback.valid).toBe(true)
    expect(postRollback.actual).toBe(INITIAL_CREDITS)
  })
})

// ---------------------------------------------------------------------------
// I-12: Experience Drift Bounds
// ---------------------------------------------------------------------------

describe("I-12: Experience Drift Bounds", () => {
  /**
   * Helper: create an interaction aggregate that pushes a single dial
   * by a large positive amount (attempting to exceed clamp).
   */
  function makeAggressiveInteraction(timestamp: string): InteractionAggregate {
    return {
      timestamp,
      topic_frequencies: { "crypto": 3 },
      style_counts: { "formal": 1 },
      metaphor_families: { "journey": 1 },
      // Push sw_approachability hard (+0.1 per interaction, well above clamp)
      dial_impacts: {
        sw_approachability: 0.1,
        cs_formality: -0.1,
      },
    }
  }

  it("after N epoch triggers, cumulative drift stays within +/-5%", () => {
    const personalityId = "test:drift-cumulative"
    const snapshot = ExperienceStore.createEmpty(personalityId)

    // Process 20 epochs, each with 50 aggressive interactions
    const EPOCH_COUNT = 20
    const INTERACTIONS_PER_EPOCH = 50
    const BASE_TIME = 1_700_000_000_000

    for (let epoch = 0; epoch < EPOCH_COUNT; epoch++) {
      // Fill pending interactions
      for (let i = 0; i < INTERACTIONS_PER_EPOCH; i++) {
        const ts = new Date(BASE_TIME + epoch * 86_400_000 + i * 1000).toISOString()
        snapshot.pending_interactions.push(makeAggressiveInteraction(ts))
      }

      // Process the epoch (use a "now" slightly after the interactions)
      const epochNow = BASE_TIME + (epoch + 1) * 86_400_000
      processEpoch(snapshot, epochNow, 30)
    }

    // Verify all cumulative offsets are within CUMULATIVE_CLAMP
    for (const [dialId, offset] of Object.entries(snapshot.offsets.dial_offsets)) {
      expect(Math.abs(offset!)).toBeLessThanOrEqual(CUMULATIVE_CLAMP + 1e-12)
    }

    // Specifically check the dials we pushed hard
    const approachOffset = snapshot.offsets.dial_offsets.sw_approachability ?? 0
    expect(approachOffset).toBeLessThanOrEqual(CUMULATIVE_CLAMP)
    expect(approachOffset).toBeGreaterThanOrEqual(-CUMULATIVE_CLAMP)

    const formalityOffset = snapshot.offsets.dial_offsets.cs_formality ?? 0
    expect(formalityOffset).toBeLessThanOrEqual(CUMULATIVE_CLAMP)
    expect(formalityOffset).toBeGreaterThanOrEqual(-CUMULATIVE_CLAMP)
  })

  it("per-epoch drift stays within +/-0.5%", () => {
    // Verify the clamp functions enforce per-epoch bounds
    // A massive raw delta should be clamped to PER_EPOCH_CLAMP
    expect(clampEpochDelta(1.0)).toBe(PER_EPOCH_CLAMP)
    expect(clampEpochDelta(-1.0)).toBe(-PER_EPOCH_CLAMP)
    expect(clampEpochDelta(0.003)).toBe(0.003) // within bounds

    // Also verify via processEpoch: a single epoch with extreme impacts
    const snapshot = ExperienceStore.createEmpty("test:per-epoch-clamp")
    const NOW = 1_700_000_000_000

    // 50 interactions all pushing the same dial by +0.5 each (massive)
    for (let i = 0; i < 50; i++) {
      snapshot.pending_interactions.push({
        timestamp: new Date(NOW + i * 1000).toISOString(),
        topic_frequencies: {},
        style_counts: {},
        metaphor_families: {},
        dial_impacts: { sw_approachability: 0.5 },
      })
    }

    const deltas = processEpoch(snapshot, NOW + 60_000, 30)

    // The epoch delta for sw_approachability must be clamped to PER_EPOCH_CLAMP
    const approachDelta = deltas.sw_approachability ?? 0
    expect(approachDelta).toBeLessThanOrEqual(PER_EPOCH_CLAMP)
    expect(approachDelta).toBeGreaterThanOrEqual(-PER_EPOCH_CLAMP)

    // Cumulative offset after one epoch should also be within PER_EPOCH_CLAMP
    const cumOffset = snapshot.offsets.dial_offsets.sw_approachability ?? 0
    expect(cumOffset).toBeLessThanOrEqual(PER_EPOCH_CLAMP)
  })
})

// ---------------------------------------------------------------------------
// I-13: Tier Ordering Invariant
// ---------------------------------------------------------------------------

describe("I-13: Tier Ordering Invariant", () => {
  it("Basic < Standard < Premium for both input and output token caps", () => {
    // Structural ordering: each successive tier must have strictly greater caps
    const basic = TIER_LIMITS.basic
    const standard = TIER_LIMITS.standard
    const premium = TIER_LIMITS.premium

    // Input tokens: basic < standard < premium
    expect(basic.max_input_tokens).toBeLessThan(standard.max_input_tokens)
    expect(standard.max_input_tokens).toBeLessThan(premium.max_input_tokens)

    // Output tokens: basic < standard < premium
    expect(basic.max_output_tokens).toBeLessThan(standard.max_output_tokens)
    expect(standard.max_output_tokens).toBeLessThan(premium.max_output_tokens)
  })

  it("validateTierOrdering does not throw (module-load-time defense-in-depth)", () => {
    expect(() => validateTierOrdering()).not.toThrow()
  })

  it("compareTiers reflects ordering: basic < standard < premium", () => {
    expect(compareTiers("basic", "standard")).toBe(-1)
    expect(compareTiers("basic", "premium")).toBe(-1)
    expect(compareTiers("standard", "premium")).toBe(-1)
    expect(compareTiers("premium", "basic")).toBe(1)
    expect(compareTiers("standard", "standard")).toBe(0)
  })

  it("governance overrides only allow escalation (not de-escalation)", () => {
    // Escalation: basic -> standard (allowed)
    const escalateResult = validateGovernanceOverride("basic", {
      target_tier: "standard",
      reason: "Upgraded by governance vote",
      authorized_by: "0xDAO",
    })
    expect(escalateResult).toBeNull()

    // Escalation: basic -> premium (allowed)
    const bigEscalate = validateGovernanceOverride("basic", {
      target_tier: "premium",
      reason: "Premium grant",
      authorized_by: "0xDAO",
    })
    expect(bigEscalate).toBeNull()

    // De-escalation: premium -> standard (rejected)
    const deescalate = validateGovernanceOverride("premium", {
      target_tier: "standard",
      reason: "Attempted downgrade",
      authorized_by: "0xDAO",
    })
    expect(deescalate).not.toBeNull()
    expect(deescalate).toContain("cannot de-escalate")

    // De-escalation: premium -> basic (rejected)
    const bigDeescalate = validateGovernanceOverride("premium", {
      target_tier: "basic",
      reason: "Attempted downgrade",
      authorized_by: "0xDAO",
    })
    expect(bigDeescalate).not.toBeNull()
    expect(bigDeescalate).toContain("cannot de-escalate")

    // Same tier: standard -> standard (no-op, allowed)
    const sameResult = validateGovernanceOverride("standard", {
      target_tier: "standard",
      reason: "Refresh",
      authorized_by: "0xDAO",
    })
    expect(sameResult).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// I-14: Anti-Narration Enforcement
// ---------------------------------------------------------------------------

describe("I-14: Anti-Narration Enforcement", () => {
  const adapter = new PersonalityReviewerAdapter()

  /** All eras and elements for exhaustive archetype coverage */
  const ERAS: Era[] = ["ancient", "medieval", "early_modern", "modern", "contemporary"]
  const ELEMENTS: Element[] = ["fire", "water", "air", "earth"]

  it("every archetype produces NO forbidden identity terms in system_prompt_fragment", () => {
    for (const archetype of ARCHETYPES) {
      for (const era of ERAS) {
        for (const element of ELEMENTS) {
          const input: PersonalityReviewInput = {
            personality_id: `test:${archetype}-${era}-${element}`,
            archetype: archetype as Archetype,
            ancestor: "greek_philosopher",
            era,
            element,
            fingerprint: null, // balanced defaults
          }

          const perspective = adapter.buildPerspective(input)

          // The system_prompt_fragment must contain no forbidden terms
          const violations = checkAntiNarration(perspective.system_prompt_fragment)
          expect(violations).toEqual([])

          // Extra: must have non-empty content
          expect(perspective.system_prompt_fragment.length).toBeGreaterThan(0)
          expect(perspective.perspective_id).toContain("personality:")
        }
      }
    }
  })

  it("FORBIDDEN_IDENTITY_TERMS list includes 'persona', 'archetype', 'ancestor'", () => {
    // These are the core meta-identity terms that must always be forbidden
    // checkAntiNarration uses the FORBIDDEN_IDENTITY_TERMS list internally
    const testWithPersona = checkAntiNarration("You are a persona of an archetype with an ancestor")
    expect(testWithPersona).toContain("persona")
    expect(testWithPersona).toContain("archetype")
    expect(testWithPersona).toContain("ancestor")
  })

  it("checkAntiNarration catches archetype labels in text", () => {
    const testArchetypes = checkAntiNarration(
      "The freetekno archetype and the milady ancestor"
    )
    expect(testArchetypes.length).toBeGreaterThan(0)
    expect(testArchetypes).toContain("freetekno")
    expect(testArchetypes).toContain("milady")
    expect(testArchetypes).toContain("archetype")
    expect(testArchetypes).toContain("ancestor")
  })

  it("clean text passes anti-narration check", () => {
    const clean = checkAntiNarration(
      "Review orientation: Prioritizes decentralization and autonomy. " +
      "Pay strong attention to logical correctness."
    )
    expect(clean).toEqual([])
  })
})
