// src/nft/personality-resolver.ts — NFT Personality → System Prompt Resolver (Sprint 4 Task 4.3)
//
// Resolves NFT personality BEAUVOIR.md into system prompt content for inference.
// Wraps personality in <system-personality> delimiters for prompt boundary enforcement.
// Missing personality → default BEAUVOIR.md (fail-safe, not error).

import { DEFAULT_BEAUVOIR_MD } from "./beauvoir-template.js"
import type { PersonalityService } from "./personality.js"

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
}

/**
 * Resolve NFT personality into a system prompt prefix.
 *
 * Returns the personality content wrapped in <system-personality> delimiters.
 * If no personality exists, returns the default BEAUVOIR.md content.
 *
 * IMPORTANT: User input is NEVER interpolated into this template.
 * The personality content is fully determined by the stored BEAUVOIR.md.
 */
export async function resolvePersonalityPrompt(
  service: PersonalityService,
  nftId: string,
): Promise<string> {
  // nftId format: "collection:tokenId"
  const parts = nftId.split(":")
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    // Invalid nftId format — return default
    return wrapPersonality(DEFAULT_BEAUVOIR_MD)
  }

  const [collection, tokenId] = parts
  const beauvoirMd = await service.getBeauvoirMd(collection, tokenId)
  return wrapPersonality(beauvoirMd)
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
