// src/nft/personality-resolver.ts — NFT Personality → System Prompt Resolver (Sprint 4 Tasks 4.3, 4.4)
//
// Resolves NFT personality BEAUVOIR.md into system prompt content for inference.
// Wraps personality in <system-personality> delimiters for prompt boundary enforcement.
// Missing personality → default BEAUVOIR.md (fail-safe, not error).
//
// Sprint 4 Task 4.4: signal_v2 mode composes dAMP dial summary into prompt.
// Legacy_v1 mode uses the existing template-based path (BEAUVOIR.md only).

import { DEFAULT_BEAUVOIR_MD } from "./beauvoir-template.js"
import type { PersonalityService } from "./personality.js"
import type { NFTPersonality } from "./types.js"
import type { AgentMode, DAMPFingerprint } from "./signal-types.js"
import type { RedisCommandClient } from "../hounfour/redis/client.js"
import { getSafetyPolicyText } from "./safety-policy.js"
import { deriveDAMP } from "./damp.js"

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences that could confuse prompt delimiters.
 * Flatline IMP-005: prevent delimiter confusion from personality content.
 */
function sanitizePersonalityContent(content: string): string {
  // Strip triple-backtick blocks that might contain "system" references
  return content.replace(/```[\s\S]*?```/g, (match) => {
    // Only strip if it contains potential delimiter-confusing content
    if (/system-personality|<\/system|<system/i.test(match)) {
      return match
        .replace(/```/g, "")
        .trim()
    }
    return match
  })
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface PersonalityResolverDeps {
  personalityService: PersonalityService
  /** Redis client for reading persisted agent mode (Sprint 15 Task 15.2) */
  redis?: RedisCommandClient
}

/**
 * Resolve NFT personality into a system prompt prefix.
 *
 * Returns the personality content wrapped in <system-personality> delimiters.
 * If no personality exists, returns the default BEAUVOIR.md content.
 *
 * Sprint 4 Task 4.4: For signal_v2 personalities, composes a dAMP dial summary
 * section into the prompt alongside the BEAUVOIR.md. For legacy_v1 personalities,
 * uses the existing template-based path (BEAUVOIR.md only).
 *
 * Sprint 15 Task 15.2: When redis is provided, reads the persisted agent mode
 * from `damp:mode:{collection}:{tokenId}` and uses that mode's dAMP fingerprint
 * for prompt composition. Falls back to "default" mode when no mode is persisted.
 *
 * IMPORTANT: User input is NEVER interpolated into this template.
 * The personality content is fully determined by stored personality data.
 */
export async function resolvePersonalityPrompt(
  service: PersonalityService,
  nftId: string,
  redis?: RedisCommandClient,
): Promise<string> {
  // nftId format: "collection:tokenId"
  const parts = nftId.split(":")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Invalid nftId format — return default
    return wrapPersonality(DEFAULT_BEAUVOIR_MD)
  }

  const [collection, tokenId] = parts

  // Task 4.4: Load full personality to check compatibility mode
  const personality = await service.getRaw(collection, tokenId)

  if (!personality) {
    // No personality record — fall back to BEAUVOIR.md from R2 or default
    const beauvoirMd = await service.getBeauvoirMd(collection, tokenId)
    return wrapPersonality(beauvoirMd)
  }

  // Legacy_v1: template-based path (BEAUVOIR.md only)
  if (personality.compatibility_mode !== "signal_v2") {
    return wrapPersonality(personality.beauvoir_md)
  }

  // Sprint 15 Task 15.2: Read persisted mode from Redis for mode-aware dAMP selection
  if (redis && personality.signals) {
    try {
      const modeKey = `damp:mode:${collection}:${tokenId}`
      const persistedMode = await redis.get(modeKey)

      if (persistedMode && persistedMode !== "default") {
        const agentMode = persistedMode as AgentMode
        // Re-derive dAMP for the persisted mode
        try {
          const modeFingerprint = deriveDAMP(personality.signals, agentMode)
          // Use a copy of the personality with mode-specific dAMP for prompt composition
          const modePersonality: NFTPersonality = {
            ...personality,
            damp: modeFingerprint,
          }
          return wrapSignalV2Personality(modePersonality)
        } catch {
          // dAMP derivation failure is non-fatal — fall through to default mode
        }
      }
    } catch {
      // Redis read failure is non-fatal — fall through to default mode
    }
  }

  // Signal_v2: compose dAMP dial summary alongside BEAUVOIR.md (default mode)
  return wrapSignalV2Personality(personality)
}

/**
 * Compose a signal_v2 personality prompt with dAMP behavioral summary.
 * The BEAUVOIR.md sets identity/voice, and the dAMP summary provides
 * quantitative behavioral calibration for the inference engine.
 */
function wrapSignalV2Personality(personality: NFTPersonality): string {
  const sections: string[] = []

  // BEAUVOIR.md content (identity + voice)
  sections.push(sanitizePersonalityContent(personality.beauvoir_md))

  // dAMP dial summary (behavioral calibration)
  if (personality.damp) {
    sections.push("")
    sections.push("## Behavioral Calibration (dAMP)")
    sections.push("")
    sections.push(buildDAMPSummary(personality.damp))
    // Sprint 11 Task 11.3: Top 5 most distinctive dials
    sections.push("")
    sections.push("### Most Distinctive Traits")
    sections.push(buildDistinctiveDialsSummary(personality.damp))
  }

  // Voice profile summary (if available)
  if (personality.voice_profile) {
    sections.push("")
    sections.push("## Voice Profile")
    sections.push(`Archetype influence: ${personality.voice_profile.archetype_voice}`)
    sections.push(`Cultural framing: ${personality.voice_profile.cultural_voice}`)
    sections.push(`Temporal register: ${personality.voice_profile.temporal_register}`)
    sections.push(`Energy signature: ${personality.voice_profile.energy_signature}`)
    sections.push(`Confidence level: ${personality.voice_profile.confidence.toFixed(2)}`)
  }

  // Sprint 11 Task 11.2b: Safety policy constraints (signal_v2 only)
  sections.push("")
  sections.push("## Safety Constraints")
  sections.push("")
  sections.push(getSafetyPolicyText())

  return `<system-personality>\n${sections.join("\n")}\n</system-personality>`
}

// ---------------------------------------------------------------------------
// dAMP Summary Builder (Task 4.4)
// ---------------------------------------------------------------------------

/** Category labels for dAMP dial groupings */
const DAMP_CATEGORY_LABELS: Record<string, string> = {
  sw: "Social Warmth",
  cs: "Conversational Style",
  as: "Assertiveness",
  cg: "Cognitive Style",
  ep: "Epistemic Behavior",
  cr: "Creativity",
  cv: "Convergence",
  mo: "Motivation",
  et: "Emotional Tone",
  sc: "Social Cognition",
  ag: "Agency",
  id: "Identity",
}

/**
 * Build a human-readable dAMP summary grouped by category.
 * Each category shows the average dial value and a behavioral descriptor.
 */
export function buildDAMPSummary(fingerprint: DAMPFingerprint): string {
  const categories: Record<string, number[]> = {}

  for (const [dialId, value] of Object.entries(fingerprint.dials)) {
    const prefix = dialId.split("_")[0]
    if (!categories[prefix]) categories[prefix] = []
    categories[prefix].push(value)
  }

  const lines: string[] = []
  for (const [prefix, values] of Object.entries(categories)) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    const label = DAMP_CATEGORY_LABELS[prefix] ?? prefix
    const descriptor = describeLevel(avg)
    lines.push(`- ${label}: ${descriptor} (${avg.toFixed(2)})`)
  }

  return lines.join("\n")
}

/** Map a 0-1 average to a human-readable behavioral descriptor */
function describeLevel(avg: number): string {
  if (avg >= 0.8) return "very high"
  if (avg >= 0.65) return "high"
  if (avg >= 0.45) return "moderate"
  if (avg >= 0.3) return "low"
  return "very low"
}

// ---------------------------------------------------------------------------
// Distinctive Dials Summary (Sprint 11 Task 11.3)
// ---------------------------------------------------------------------------

/**
 * Convert a dial ID like "sw_approachability" into a human-readable descriptor
 * like "Approachability". Strips the category prefix and converts underscores to spaces.
 */
function describeDialName(dialId: string): string {
  // Remove category prefix (e.g., "sw_" from "sw_approachability")
  const parts = dialId.split("_")
  const nameparts = parts.slice(1)
  // Capitalize first letter of each word
  return nameparts
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * Build a summary of the top 5 most distinctive dials (highest deviation from 0.5 neutral).
 * These represent the personality traits that diverge most from the baseline.
 *
 * Format:
 * - Dial Name: value (category)
 */
export function buildDistinctiveDialsSummary(fingerprint: DAMPFingerprint): string {
  const entries = Object.entries(fingerprint.dials) as Array<[string, number]>

  // Sort by absolute deviation from 0.5 neutral, descending
  const sorted = entries
    .map(([dialId, value]) => ({
      dialId,
      value,
      deviation: Math.abs(value - 0.5),
    }))
    .sort((a, b) => b.deviation - a.deviation)

  // Take top 5
  const top5 = sorted.slice(0, 5)

  const lines = top5.map(({ dialId, value }) => {
    const name = describeDialName(dialId)
    const prefix = dialId.split("_")[0]
    const category = DAMP_CATEGORY_LABELS[prefix] ?? prefix
    return `- ${name}: ${value.toFixed(2)} (${category})`
  })

  return lines.join("\n")
}

/**
 * Wrap personality content in prompt boundary delimiters.
 * Flatline IMP-005: explicit delimiters prevent prompt injection.
 */
function wrapPersonality(content: string): string {
  const sanitized = sanitizePersonalityContent(content)
  return `<system-personality>\n${sanitized}\n</system-personality>`
}

/**
 * Compose personality prompt with an existing system prompt.
 * Personality goes first (sets identity), then base system prompt.
 */
export function composeSystemPrompt(
  personalityPrompt: string,
  baseSystemPrompt: string | null,
): string {
  if (!baseSystemPrompt) return personalityPrompt
  return `${personalityPrompt}\n\n${baseSystemPrompt}`
}
