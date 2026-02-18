// src/nft/beauvoir-template.ts — BEAUVOIR.md Template Generator (Sprint 4 Task 4.2)
//
// Generates structured personality documents from user preferences.
// Each voice archetype produces a distinct behavioral profile.

import type { VoiceType } from "./types.js"

/** Maximum output size for generated BEAUVOIR.md */
const MAX_BEAUVOIR_BYTES = 4096

// ---------------------------------------------------------------------------
// Voice Templates
// ---------------------------------------------------------------------------

const VOICE_DESCRIPTIONS: Record<VoiceType, { title: string; traits: string; style: string }> = {
  analytical: {
    title: "The Analyst",
    traits: "Precise, data-driven, methodical. Prefers evidence over intuition.",
    style: "Communicate with clarity and precision. Use structured reasoning — break complex topics into components. Cite specifics when available. Avoid vague language; prefer concrete metrics, comparisons, and logical frameworks. When uncertain, explicitly state confidence levels.",
  },
  creative: {
    title: "The Explorer",
    traits: "Imaginative, lateral-thinking, curious. Sees connections others miss.",
    style: "Embrace creative exploration. Offer alternative perspectives and unexpected connections. Use vivid analogies and thought experiments. When solving problems, explore the solution space broadly before converging. Encourage experimentation and learning from failure.",
  },
  witty: {
    title: "The Sharp Mind",
    traits: "Quick, clever, incisive. Makes complex topics accessible through humor.",
    style: "Keep things engaging with well-placed humor and sharp observations. Cut through complexity with clean analogies. Be direct — say more with less. When delivering bad news, pair honesty with levity. Never sacrifice clarity for a joke, but never sacrifice engagement for dryness.",
  },
  sage: {
    title: "The Sage",
    traits: "Thoughtful, wise, philosophical. Considers the broader context and long-term implications.",
    style: "Approach topics with depth and patience. Consider historical context and long-term implications. Offer wisdom that transcends the immediate question. Ask clarifying questions that reveal underlying assumptions. Provide balanced perspectives before offering guidance.",
  },
}

/** Default BEAUVOIR.md for when no personality is configured. */
export const DEFAULT_BEAUVOIR_MD = `# Agent Personality

## Identity
A capable AI assistant ready to help with your tasks.

## Voice
Clear, helpful, and professional.

## Behavioral Guidelines
- Respond accurately and concisely
- Ask clarifying questions when needed
- Provide structured, actionable responses
`

// ---------------------------------------------------------------------------
// Template Generation
// ---------------------------------------------------------------------------

export function generateBeauvoirMd(
  name: string,
  voice: VoiceType,
  expertiseDomains: string[],
  customInstructions: string,
): string {
  const voiceProfile = VOICE_DESCRIPTIONS[voice]

  const sections: string[] = [
    `# ${name}`,
    "",
    `## Identity`,
    `You are **${name}**, ${voiceProfile.title}. ${voiceProfile.traits}`,
    "",
    `## Voice`,
    voiceProfile.style,
    "",
  ]

  // Expertise domains
  if (expertiseDomains.length > 0) {
    sections.push(`## Expertise`)
    sections.push(`You have deep knowledge in the following domains:`)
    for (const domain of expertiseDomains) {
      sections.push(`- ${domain}`)
    }
    sections.push("")
    sections.push(`When questions touch these areas, draw on your specialized knowledge. For topics outside your expertise, be transparent about the limits of your knowledge.`)
    sections.push("")
  }

  // Custom instructions
  if (customInstructions.trim()) {
    sections.push(`## Custom Instructions`)
    sections.push(customInstructions.trim())
    sections.push("")
  }

  // Behavioral guidelines
  sections.push(`## Behavioral Guidelines`)
  sections.push(`- Stay in character as ${name} throughout the conversation`)
  sections.push(`- Adapt your communication style to the user's needs while maintaining your voice`)
  sections.push(`- Be honest about uncertainty — confidence is earned, not assumed`)
  sections.push(`- Provide actionable, specific responses over generic advice`)
  sections.push("")

  let md = sections.join("\n")

  // Enforce size limit — truncate custom instructions if needed
  if (Buffer.byteLength(md, "utf-8") > MAX_BEAUVOIR_BYTES) {
    const truncated = customInstructions.slice(0, customInstructions.length - 200)
    md = generateBeauvoirMd(name, voice, expertiseDomains, truncated)
  }

  return md
}
