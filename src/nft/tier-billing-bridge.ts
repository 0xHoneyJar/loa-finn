// src/nft/tier-billing-bridge.ts — Tier-Billing Integration Bridge (Sprint 28 Task 28.2)
//
// Integrates personality tiers with the billing pipeline:
// - Tags billing costs with the personality tier
// - Applies platform_subsidy for Basic tier (platform absorbs cost)
// - Supports governance overrides for tier escalation
//
// Does NOT modify existing billing types — produces BillingTierTag metadata
// that the billing pipeline can attach to cost records.

import type { PersonalityTier } from "./tier-billing.js"
import { TIER_LIMITS, getTierLimits, enforceTierLimits, compareTiers } from "./tier-billing.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Billing metadata tag attached to cost records */
export interface BillingTierTag {
  /** The personality tier at synthesis time */
  tier: PersonalityTier
  /** Whether this request is platform-subsidized (Basic tier) */
  platform_subsidy: boolean
  /** Effective input tokens after tier enforcement */
  effective_input_tokens: number
  /** Effective output tokens after tier enforcement */
  effective_output_tokens: number
  /** Whether a governance override was applied */
  governance_override: boolean
  /** Original tier before governance override (null if no override) */
  original_tier: PersonalityTier | null
}

/** Governance override configuration */
export interface GovernanceOverride {
  /** Target tier to escalate to */
  target_tier: PersonalityTier
  /** Reason for the override (logged for audit) */
  reason: string
  /** Who authorized the override (wallet address or system identifier) */
  authorized_by: string
}

/** Input for building a billing tier tag */
export interface TierBillingInput {
  /** Personality tier (resolved from personality data) */
  tier: PersonalityTier
  /** Requested input tokens */
  requested_input_tokens: number
  /** Requested output tokens */
  requested_output_tokens: number
  /** Optional governance override */
  governance_override?: GovernanceOverride | null
}

/** Subsidy calculation result */
export interface SubsidyResult {
  /** Whether the platform subsidizes this request */
  subsidized: boolean
  /** Subsidy reason (for audit trail) */
  reason: string
}

// ---------------------------------------------------------------------------
// Platform Subsidy Rules
// ---------------------------------------------------------------------------

/**
 * Determine whether a request qualifies for platform subsidy.
 *
 * Current rule: Basic tier requests are fully subsidized by the platform.
 * The user pays nothing; the platform absorbs the cost.
 *
 * This is a policy decision, not a billing calculation. The billing pipeline
 * uses the subsidy flag to route cost to platform accounts instead of user accounts.
 */
export function determineSubsidy(tier: PersonalityTier): SubsidyResult {
  if (tier === "basic") {
    return {
      subsidized: true,
      reason: "Basic tier: platform-subsidized",
    }
  }

  return {
    subsidized: false,
    reason: `${tier} tier: user-billed`,
  }
}

// ---------------------------------------------------------------------------
// Governance Override Validation
// ---------------------------------------------------------------------------

/**
 * Validate a governance override request.
 *
 * Rules:
 * - Override can only ESCALATE tier (basic -> standard/premium, standard -> premium)
 * - Override cannot de-escalate (premium -> standard is rejected)
 * - Override must have a non-empty reason and authorized_by
 *
 * @returns Error message if invalid, null if valid
 */
export function validateGovernanceOverride(
  currentTier: PersonalityTier,
  override: GovernanceOverride,
): string | null {
  // Must have reason
  if (!override.reason || override.reason.trim().length === 0) {
    return "Governance override must include a reason"
  }

  // Must have authorizer
  if (!override.authorized_by || override.authorized_by.trim().length === 0) {
    return "Governance override must include authorized_by"
  }

  // Cannot de-escalate
  const comparison = compareTiers(override.target_tier, currentTier)
  if (comparison < 0) {
    return `Governance override cannot de-escalate: ${currentTier} -> ${override.target_tier}`
  }

  // No-op override (same tier) is technically valid but logged
  return null
}

// ---------------------------------------------------------------------------
// Billing Tier Tag Builder
// ---------------------------------------------------------------------------

/**
 * Build a BillingTierTag from synthesis request parameters.
 *
 * This is the primary integration point between tiers and billing.
 * The tag carries all metadata needed for the billing pipeline to:
 * 1. Record the tier on the cost entry
 * 2. Route subsidized costs to platform accounts
 * 3. Audit governance overrides
 *
 * @param input - Tier billing input parameters
 * @returns BillingTierTag for attachment to billing records
 * @throws Error if governance override validation fails
 */
export function buildBillingTierTag(input: TierBillingInput): BillingTierTag {
  let effectiveTier = input.tier
  let governanceApplied = false
  const originalTier = input.tier

  // Apply governance override if present
  if (input.governance_override) {
    const validationError = validateGovernanceOverride(input.tier, input.governance_override)
    if (validationError) {
      throw new TierBillingBridgeError(validationError)
    }

    effectiveTier = input.governance_override.target_tier
    governanceApplied = compareTiers(effectiveTier, originalTier) !== 0
  }

  // Enforce tier limits on token counts
  const enforcement = enforceTierLimits(
    effectiveTier,
    input.requested_input_tokens,
    input.requested_output_tokens,
  )

  // Determine subsidy based on effective tier
  const subsidy = determineSubsidy(effectiveTier)

  return {
    tier: effectiveTier,
    platform_subsidy: subsidy.subsidized,
    effective_input_tokens: enforcement.effective_input_tokens,
    effective_output_tokens: enforcement.effective_output_tokens,
    governance_override: governanceApplied,
    original_tier: governanceApplied ? originalTier : null,
  }
}

// ---------------------------------------------------------------------------
// Cost Annotation
// ---------------------------------------------------------------------------

/**
 * Annotate a cost value with tier information for billing records.
 *
 * Returns a metadata object suitable for attaching to WAL entries or
 * billing ledger postings. Does not modify the cost value itself.
 *
 * @param tag - The billing tier tag
 * @param costMicroUsd - The computed cost in MicroUSD (pass-through, not modified)
 * @returns Metadata object for billing record annotation
 */
export function annotateCostWithTier(
  tag: BillingTierTag,
  costMicroUsd: bigint,
): Record<string, unknown> {
  return {
    personality_tier: tag.tier,
    platform_subsidy: tag.platform_subsidy,
    effective_input_tokens: tag.effective_input_tokens,
    effective_output_tokens: tag.effective_output_tokens,
    governance_override: tag.governance_override,
    original_tier: tag.original_tier,
    cost_micro_usd: costMicroUsd.toString(),
    billed_to: tag.platform_subsidy ? "platform" : "user",
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TierBillingBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TierBillingBridgeError"
  }
}
