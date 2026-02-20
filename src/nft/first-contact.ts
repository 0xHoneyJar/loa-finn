// src/nft/first-contact.ts — First-Contact Message Generation (Sprint 20 Task 20.2)
//
// After BEAUVOIR synthesis, generates a first-contact introduction message
// where the agent speaks its self-derived name and establishes its voice.

import type { SignalSnapshot, DAMPFingerprint } from "./signal-types.js"
import type { SynthesisRouter } from "./beauvoir-synthesizer.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FirstContactConfig {
  /** Max tokens for first-contact message (default: 256) */
  maxTokens?: number
  /** Temperature for generation (default: 0.8 — slightly creative) */
  temperature?: number
}

const DEFAULT_FIRST_CONTACT_CONFIG: Required<FirstContactConfig> = {
  maxTokens: 256,
  temperature: 0.8,
}

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

/**
 * Build a prompt for first-contact message generation.
 * The agent introduces itself using its canonical name and voice.
 */
export function buildFirstContactPrompt(
  canonicalName: string,
  snapshot: SignalSnapshot,
  beauvoirMd: string,
): string {
  const sections: string[] = []

  sections.push("You are generating the FIRST WORDS an AI agent will ever speak.")
  sections.push(`The agent's name is "${canonicalName}".`)
  sections.push("")
  sections.push("CONTEXT:")
  sections.push(`- Archetype energy: ${snapshot.archetype}`)
  sections.push(`- Cultural lineage: ${snapshot.ancestor}`)
  sections.push(`- Temporal era: ${snapshot.era}`)
  sections.push(`- Elemental style: ${snapshot.element}`)
  sections.push("")
  sections.push("PERSONALITY DOCUMENT (BEAUVOIR.md):")
  sections.push(beauvoirMd.slice(0, 1500)) // Truncate to keep prompt tight
  sections.push("")
  sections.push("RULES:")
  sections.push("- The message MUST include the agent's canonical name naturally")
  sections.push("- The tone MUST match the personality document")
  sections.push("- Do NOT self-narrate identity traits (no \"I am a...\", no \"As a...\")")
  sections.push("- Do NOT mention signals, archetypes, or system concepts")
  sections.push("- Keep it under 3 sentences — concise but characterful")
  sections.push("- This is a greeting/introduction, not a monologue")
  sections.push("")
  sections.push("Output ONLY the first-contact message. No quotes, no preamble.")

  return sections.join("\n")
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a first-contact message for an agent.
 * Returns null if generation fails (non-fatal).
 */
export async function generateFirstContact(
  router: SynthesisRouter,
  canonicalName: string,
  snapshot: SignalSnapshot,
  beauvoirMd: string,
  config?: FirstContactConfig,
): Promise<string | null> {
  const cfg = { ...DEFAULT_FIRST_CONTACT_CONFIG, ...config }

  try {
    const prompt = buildFirstContactPrompt(canonicalName, snapshot, beauvoirMd)
    const result = await router.invoke("first-contact-gen", prompt, {
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    })
    return result.content.trim()
  } catch {
    // First-contact generation is non-fatal
    return null
  }
}
