// tests/nft/tier-billing.test.ts — Personality-Tiered Billing Tests (Sprint 28 Task 28.3)
//
// Tests: tier enforcement, cap validation, structural ordering invariant,
// tier comparison, parsing, and integration with tier-billing-bridge.

import { describe, it, expect } from "vitest"
import {
  TIER_LIMITS,
  TIER_ORDER,
  getTierLimits,
  enforceTierLimits,
  isWithinTierLimits,
  parseTier,
  compareTiers,
  validateTierOrdering,
  TierError,
} from "../../src/nft/tier-billing.js"
import type { PersonalityTier, TierTokenLimits } from "../../src/nft/tier-billing.js"
import {
  buildBillingTierTag,
  determineSubsidy,
  validateGovernanceOverride,
  annotateCostWithTier,
  TierBillingBridgeError,
} from "../../src/nft/tier-billing-bridge.js"
import type { GovernanceOverride } from "../../src/nft/tier-billing-bridge.js"

// ---------------------------------------------------------------------------
// Structural Ordering Invariant
// ---------------------------------------------------------------------------

describe("Tier structural ordering", () => {
  it("Basic < Standard < Premium for input tokens", () => {
    expect(TIER_LIMITS.basic.max_input_tokens).toBeLessThan(TIER_LIMITS.standard.max_input_tokens)
    expect(TIER_LIMITS.standard.max_input_tokens).toBeLessThan(TIER_LIMITS.premium.max_input_tokens)
  })

  it("Basic < Standard < Premium for output tokens", () => {
    expect(TIER_LIMITS.basic.max_output_tokens).toBeLessThan(TIER_LIMITS.standard.max_output_tokens)
    expect(TIER_LIMITS.standard.max_output_tokens).toBeLessThan(TIER_LIMITS.premium.max_output_tokens)
  })

  it("validateTierOrdering passes with correct definitions", () => {
    // Should not throw
    expect(() => validateTierOrdering()).not.toThrow()
  })

  it("TIER_ORDER has exactly 3 tiers in ascending order", () => {
    expect(TIER_ORDER).toEqual(["basic", "standard", "premium"])
  })
})

// ---------------------------------------------------------------------------
// Tier Limit Values
// ---------------------------------------------------------------------------

describe("Tier limit values", () => {
  it("Basic: 1000 input / 500 output", () => {
    const limits = getTierLimits("basic")
    expect(limits.max_input_tokens).toBe(1000)
    expect(limits.max_output_tokens).toBe(500)
  })

  it("Standard: 4000 input / 2000 output", () => {
    const limits = getTierLimits("standard")
    expect(limits.max_input_tokens).toBe(4000)
    expect(limits.max_output_tokens).toBe(2000)
  })

  it("Premium: 10000 input / 5000 output", () => {
    const limits = getTierLimits("premium")
    expect(limits.max_input_tokens).toBe(10000)
    expect(limits.max_output_tokens).toBe(5000)
  })
})

// ---------------------------------------------------------------------------
// Tier Enforcement
// ---------------------------------------------------------------------------

describe("Tier enforcement", () => {
  it("caps input tokens to tier limit", () => {
    const result = enforceTierLimits("basic", 5000, 200)
    expect(result.effective_input_tokens).toBe(1000)
    expect(result.input_capped).toBe(true)
  })

  it("caps output tokens to tier limit", () => {
    const result = enforceTierLimits("basic", 500, 1000)
    expect(result.effective_output_tokens).toBe(500)
    expect(result.output_capped).toBe(true)
  })

  it("does not cap tokens within limits", () => {
    const result = enforceTierLimits("premium", 5000, 3000)
    expect(result.effective_input_tokens).toBe(5000)
    expect(result.effective_output_tokens).toBe(3000)
    expect(result.input_capped).toBe(false)
    expect(result.output_capped).toBe(false)
  })

  it("caps both input and output simultaneously", () => {
    const result = enforceTierLimits("basic", 2000, 1000)
    expect(result.effective_input_tokens).toBe(1000)
    expect(result.effective_output_tokens).toBe(500)
    expect(result.input_capped).toBe(true)
    expect(result.output_capped).toBe(true)
  })

  it("exact tier limit is not capped", () => {
    const result = enforceTierLimits("standard", 4000, 2000)
    expect(result.effective_input_tokens).toBe(4000)
    expect(result.effective_output_tokens).toBe(2000)
    expect(result.input_capped).toBe(false)
    expect(result.output_capped).toBe(false)
  })

  it("always sets allowed to true", () => {
    const result = enforceTierLimits("basic", 99999, 99999)
    expect(result.allowed).toBe(true)
  })

  it("preserves tier in result", () => {
    const result = enforceTierLimits("premium", 100, 100)
    expect(result.tier).toBe("premium")
  })
})

// ---------------------------------------------------------------------------
// isWithinTierLimits
// ---------------------------------------------------------------------------

describe("isWithinTierLimits", () => {
  it("returns true when both within limits", () => {
    expect(isWithinTierLimits("standard", 3000, 1500)).toBe(true)
  })

  it("returns false when input exceeds", () => {
    expect(isWithinTierLimits("basic", 1001, 100)).toBe(false)
  })

  it("returns false when output exceeds", () => {
    expect(isWithinTierLimits("basic", 100, 501)).toBe(false)
  })

  it("returns true at exact limits", () => {
    expect(isWithinTierLimits("basic", 1000, 500)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tier Parsing
// ---------------------------------------------------------------------------

describe("Tier parsing", () => {
  it("parses valid tiers", () => {
    expect(parseTier("basic")).toBe("basic")
    expect(parseTier("standard")).toBe("standard")
    expect(parseTier("premium")).toBe("premium")
  })

  it("normalizes case", () => {
    expect(parseTier("BASIC")).toBe("basic")
    expect(parseTier("Standard")).toBe("standard")
    expect(parseTier("PREMIUM")).toBe("premium")
  })

  it("trims whitespace", () => {
    expect(parseTier("  basic  ")).toBe("basic")
  })

  it("throws TierError for invalid tier", () => {
    expect(() => parseTier("gold")).toThrow(TierError)
    expect(() => parseTier("")).toThrow(TierError)
  })
})

// ---------------------------------------------------------------------------
// Tier Comparison
// ---------------------------------------------------------------------------

describe("Tier comparison", () => {
  it("basic < standard < premium", () => {
    expect(compareTiers("basic", "standard")).toBe(-1)
    expect(compareTiers("standard", "premium")).toBe(-1)
    expect(compareTiers("basic", "premium")).toBe(-1)
  })

  it("premium > standard > basic", () => {
    expect(compareTiers("premium", "standard")).toBe(1)
    expect(compareTiers("standard", "basic")).toBe(1)
    expect(compareTiers("premium", "basic")).toBe(1)
  })

  it("same tier returns 0", () => {
    expect(compareTiers("basic", "basic")).toBe(0)
    expect(compareTiers("standard", "standard")).toBe(0)
    expect(compareTiers("premium", "premium")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Platform Subsidy
// ---------------------------------------------------------------------------

describe("Platform subsidy", () => {
  it("Basic tier is subsidized", () => {
    const result = determineSubsidy("basic")
    expect(result.subsidized).toBe(true)
  })

  it("Standard tier is not subsidized", () => {
    const result = determineSubsidy("standard")
    expect(result.subsidized).toBe(false)
  })

  it("Premium tier is not subsidized", () => {
    const result = determineSubsidy("premium")
    expect(result.subsidized).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Governance Overrides
// ---------------------------------------------------------------------------

describe("Governance overrides", () => {
  it("allows escalation from basic to standard", () => {
    const override: GovernanceOverride = {
      target_tier: "standard",
      reason: "Community vote",
      authorized_by: "0xDAO",
    }
    expect(validateGovernanceOverride("basic", override)).toBeNull()
  })

  it("allows escalation from basic to premium", () => {
    const override: GovernanceOverride = {
      target_tier: "premium",
      reason: "Whale status",
      authorized_by: "0xAdmin",
    }
    expect(validateGovernanceOverride("basic", override)).toBeNull()
  })

  it("rejects de-escalation from premium to basic", () => {
    const override: GovernanceOverride = {
      target_tier: "basic",
      reason: "Downgrade",
      authorized_by: "0xAdmin",
    }
    const error = validateGovernanceOverride("premium", override)
    expect(error).not.toBeNull()
    expect(error).toContain("de-escalate")
  })

  it("rejects empty reason", () => {
    const override: GovernanceOverride = {
      target_tier: "premium",
      reason: "",
      authorized_by: "0xAdmin",
    }
    expect(validateGovernanceOverride("basic", override)).not.toBeNull()
  })

  it("rejects empty authorized_by", () => {
    const override: GovernanceOverride = {
      target_tier: "premium",
      reason: "Upgrade",
      authorized_by: "",
    }
    expect(validateGovernanceOverride("basic", override)).not.toBeNull()
  })

  it("allows same-tier override (no-op)", () => {
    const override: GovernanceOverride = {
      target_tier: "standard",
      reason: "Re-confirm",
      authorized_by: "0xAdmin",
    }
    expect(validateGovernanceOverride("standard", override)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// BillingTierTag Builder
// ---------------------------------------------------------------------------

describe("BillingTierTag builder", () => {
  it("builds tag without governance override", () => {
    const tag = buildBillingTierTag({
      tier: "standard",
      requested_input_tokens: 3000,
      requested_output_tokens: 1500,
    })

    expect(tag.tier).toBe("standard")
    expect(tag.platform_subsidy).toBe(false)
    expect(tag.effective_input_tokens).toBe(3000)
    expect(tag.effective_output_tokens).toBe(1500)
    expect(tag.governance_override).toBe(false)
    expect(tag.original_tier).toBeNull()
  })

  it("applies governance override and records original tier", () => {
    const tag = buildBillingTierTag({
      tier: "basic",
      requested_input_tokens: 5000,
      requested_output_tokens: 3000,
      governance_override: {
        target_tier: "premium",
        reason: "Community grant",
        authorized_by: "0xDAO",
      },
    })

    expect(tag.tier).toBe("premium")
    expect(tag.governance_override).toBe(true)
    expect(tag.original_tier).toBe("basic")
    // Premium limits apply: 10000 input, 5000 output
    expect(tag.effective_input_tokens).toBe(5000) // within premium limits
    expect(tag.effective_output_tokens).toBe(3000) // within premium limits
  })

  it("basic tier tag has platform_subsidy true", () => {
    const tag = buildBillingTierTag({
      tier: "basic",
      requested_input_tokens: 500,
      requested_output_tokens: 200,
    })
    expect(tag.platform_subsidy).toBe(true)
  })

  it("throws on invalid governance override (de-escalation)", () => {
    expect(() =>
      buildBillingTierTag({
        tier: "premium",
        requested_input_tokens: 1000,
        requested_output_tokens: 500,
        governance_override: {
          target_tier: "basic",
          reason: "Downgrade",
          authorized_by: "0xAdmin",
        },
      }),
    ).toThrow(TierBillingBridgeError)
  })

  it("same-tier override does not set governance_override flag", () => {
    const tag = buildBillingTierTag({
      tier: "standard",
      requested_input_tokens: 1000,
      requested_output_tokens: 500,
      governance_override: {
        target_tier: "standard",
        reason: "Re-confirm",
        authorized_by: "0xAdmin",
      },
    })

    expect(tag.governance_override).toBe(false)
    expect(tag.original_tier).toBeNull()
  })

  it("enforces tier caps on token counts in tag", () => {
    const tag = buildBillingTierTag({
      tier: "basic",
      requested_input_tokens: 5000,
      requested_output_tokens: 3000,
    })

    expect(tag.effective_input_tokens).toBe(1000) // capped to basic
    expect(tag.effective_output_tokens).toBe(500) // capped to basic
  })
})

// ---------------------------------------------------------------------------
// Cost Annotation
// ---------------------------------------------------------------------------

describe("Cost annotation", () => {
  it("produces metadata object with all tier fields", () => {
    const tag = buildBillingTierTag({
      tier: "standard",
      requested_input_tokens: 2000,
      requested_output_tokens: 1000,
    })

    const annotation = annotateCostWithTier(tag, 42000n)

    expect(annotation.personality_tier).toBe("standard")
    expect(annotation.platform_subsidy).toBe(false)
    expect(annotation.effective_input_tokens).toBe(2000)
    expect(annotation.effective_output_tokens).toBe(1000)
    expect(annotation.cost_micro_usd).toBe("42000")
    expect(annotation.billed_to).toBe("user")
  })

  it("basic tier annotation shows platform billing", () => {
    const tag = buildBillingTierTag({
      tier: "basic",
      requested_input_tokens: 500,
      requested_output_tokens: 200,
    })

    const annotation = annotateCostWithTier(tag, 1000n)

    expect(annotation.billed_to).toBe("platform")
    expect(annotation.platform_subsidy).toBe(true)
  })
})
