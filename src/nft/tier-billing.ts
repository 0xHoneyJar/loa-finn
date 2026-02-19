// src/nft/tier-billing.ts — Personality-Tiered Billing (Sprint 28 Task 28.1)
//
// Three tiers with structurally enforced token caps:
//   Basic:    1000 input / 500 output tokens
//   Standard: 4000 input / 2000 output tokens
//   Premium:  10000 input / 5000 output tokens
//
// Tier caps are enforced at synthesis time — not probabilistically.
// Structural ordering invariant: Basic < Standard < Premium for both input and output.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Personality tier identifiers */
export type PersonalityTier = "basic" | "standard" | "premium"

/** Token limits for a personality tier */
export interface TierTokenLimits {
  /** Maximum input tokens for this tier */
  max_input_tokens: number
  /** Maximum output tokens for this tier */
  max_output_tokens: number
}

/** Result of a tier enforcement check */
export interface TierEnforcementResult {
  /** Whether the request is within tier limits */
  allowed: boolean
  /** The tier that was enforced */
  tier: PersonalityTier
  /** Effective input tokens (capped to tier limit) */
  effective_input_tokens: number
  /** Effective output tokens (capped to tier limit) */
  effective_output_tokens: number
  /** Whether input tokens were capped */
  input_capped: boolean
  /** Whether output tokens were capped */
  output_capped: boolean
}

// ---------------------------------------------------------------------------
// Tier Definitions (structural ordering enforced by type + runtime assertion)
// ---------------------------------------------------------------------------

/**
 * Token limits per tier. Structural ordering invariant:
 *   basic.max_input_tokens < standard.max_input_tokens < premium.max_input_tokens
 *   basic.max_output_tokens < standard.max_output_tokens < premium.max_output_tokens
 */
export const TIER_LIMITS: Readonly<Record<PersonalityTier, TierTokenLimits>> = {
  basic: {
    max_input_tokens: 1000,
    max_output_tokens: 500,
  },
  standard: {
    max_input_tokens: 4000,
    max_output_tokens: 2000,
  },
  premium: {
    max_input_tokens: 10000,
    max_output_tokens: 5000,
  },
} as const

/** All tiers in ascending order */
export const TIER_ORDER: readonly PersonalityTier[] = ["basic", "standard", "premium"] as const

// ---------------------------------------------------------------------------
// Structural Ordering Validation
// ---------------------------------------------------------------------------

/**
 * Validate the structural ordering invariant at module load time.
 * This is a defense-in-depth check — the const values above are correct,
 * but this guards against accidental edits.
 *
 * @throws Error if the ordering invariant is violated
 */
export function validateTierOrdering(): void {
  for (let i = 1; i < TIER_ORDER.length; i++) {
    const prev = TIER_LIMITS[TIER_ORDER[i - 1]]
    const curr = TIER_LIMITS[TIER_ORDER[i]]

    if (curr.max_input_tokens <= prev.max_input_tokens) {
      throw new Error(
        `Tier ordering violation: ${TIER_ORDER[i]}.max_input_tokens (${curr.max_input_tokens}) ` +
        `must be > ${TIER_ORDER[i - 1]}.max_input_tokens (${prev.max_input_tokens})`,
      )
    }
    if (curr.max_output_tokens <= prev.max_output_tokens) {
      throw new Error(
        `Tier ordering violation: ${TIER_ORDER[i]}.max_output_tokens (${curr.max_output_tokens}) ` +
        `must be > ${TIER_ORDER[i - 1]}.max_output_tokens (${prev.max_output_tokens})`,
      )
    }
  }
}

// Run at module load — fail fast on misconfiguration
validateTierOrdering()

// ---------------------------------------------------------------------------
// Tier Resolution
// ---------------------------------------------------------------------------

/** Valid tier strings for validation */
const VALID_TIERS: ReadonlySet<string> = new Set(TIER_ORDER)

/**
 * Validate and parse a tier string.
 *
 * @param tier - Raw tier string
 * @returns Validated PersonalityTier
 * @throws TierError if tier is invalid
 */
export function parseTier(tier: string): PersonalityTier {
  const normalized = tier.toLowerCase().trim()
  if (!VALID_TIERS.has(normalized)) {
    throw new TierError(
      `Invalid personality tier: "${tier}". Must be one of: ${TIER_ORDER.join(", ")}`,
    )
  }
  return normalized as PersonalityTier
}

/**
 * Get token limits for a tier.
 *
 * @param tier - Personality tier
 * @returns TierTokenLimits for the tier
 */
export function getTierLimits(tier: PersonalityTier): TierTokenLimits {
  return TIER_LIMITS[tier]
}

// ---------------------------------------------------------------------------
// Tier Enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce tier token limits on a synthesis request.
 *
 * Caps input and output tokens to the tier maximum. This is structural
 * enforcement — tokens beyond the cap are silently truncated, not rejected.
 * The caller receives the effective token counts for billing.
 *
 * @param tier - Personality tier to enforce
 * @param requestedInputTokens - Requested input token count
 * @param requestedOutputTokens - Requested output token count
 * @returns TierEnforcementResult with capped values and flags
 */
export function enforceTierLimits(
  tier: PersonalityTier,
  requestedInputTokens: number,
  requestedOutputTokens: number,
): TierEnforcementResult {
  const limits = TIER_LIMITS[tier]

  const effectiveInput = Math.min(requestedInputTokens, limits.max_input_tokens)
  const effectiveOutput = Math.min(requestedOutputTokens, limits.max_output_tokens)

  return {
    allowed: true,
    tier,
    effective_input_tokens: effectiveInput,
    effective_output_tokens: effectiveOutput,
    input_capped: requestedInputTokens > limits.max_input_tokens,
    output_capped: requestedOutputTokens > limits.max_output_tokens,
  }
}

/**
 * Check whether a request fits within tier limits without capping.
 * Returns false if either input or output tokens exceed the tier maximum.
 *
 * @param tier - Personality tier to check against
 * @param inputTokens - Input token count
 * @param outputTokens - Output token count
 * @returns true if within limits, false otherwise
 */
export function isWithinTierLimits(
  tier: PersonalityTier,
  inputTokens: number,
  outputTokens: number,
): boolean {
  const limits = TIER_LIMITS[tier]
  return inputTokens <= limits.max_input_tokens && outputTokens <= limits.max_output_tokens
}

/**
 * Compare two tiers. Returns:
 *   -1 if a < b (a has lower caps)
 *    0 if a === b
 *    1 if a > b (a has higher caps)
 */
export function compareTiers(a: PersonalityTier, b: PersonalityTier): -1 | 0 | 1 {
  const indexA = TIER_ORDER.indexOf(a)
  const indexB = TIER_ORDER.indexOf(b)
  if (indexA < indexB) return -1
  if (indexA > indexB) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class TierError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TierError"
  }
}
