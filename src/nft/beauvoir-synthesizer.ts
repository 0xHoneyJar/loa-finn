// src/nft/beauvoir-synthesizer.ts — BEAUVOIR Synthesizer (SDD §3.2, Sprint 2 Tasks 2.1-2.3, 2.6)
//
// LLM-powered personality document synthesis from signal data.
// Supports auto mode (zero user input) and guided mode (user-provided overrides).
// Includes circuit breaker, anti-narration validation, and retry with violation feedback.

import { createHmac } from "node:crypto"
import type { SignalSnapshot, DAMPFingerprint, DAMPDialId, Era } from "./signal-types.js"
import { validateAntiNarration, type ANViolation } from "./anti-narration.js"
import { checkTemporalVoice, type TemporalViolation } from "./temporal-voice.js"
import { ERA_DOMAINS } from "./temporal-voice.js"
import { getSafetyPolicyText } from "./safety-policy.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Loose-coupled router interface — does not import HounfourRouter directly */
export interface SynthesisRouter {
  invoke(
    agent: string,
    prompt: string,
    options?: {
      temperature?: number
      max_tokens?: number
      systemPrompt?: string
    },
  ): Promise<{ content: string }>
}

/** Subgraph context for richer synthesis */
export interface IdentitySubgraph {
  cultural_references: string[]
  aesthetic_notes: string[]
  philosophical_lineage: string[]
}

/** User-provided customization inputs for guided mode */
export interface UserCustomInput {
  name?: string
  custom_instructions?: string
  expertise_domains?: string[]
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export type SynthesisErrorCode =
  | "SYNTHESIS_UNAVAILABLE"
  | "ANTI_NARRATION_VIOLATION"
  | "TEMPORAL_VOICE_VIOLATION"
  | "SYNTHESIS_FAILED"

export class SynthesisError extends Error {
  constructor(
    public readonly code: SynthesisErrorCode,
    message: string,
    public readonly violations?: ANViolation[],
    public readonly temporalViolations?: TemporalViolation[],
  ) {
    super(message)
    this.name = "SynthesisError"
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

interface CircuitBreakerState {
  failures: number[]
  readonly windowMs: number
  readonly threshold: number
}

function isCircuitOpen(state: CircuitBreakerState): boolean {
  const now = Date.now()
  // Prune old failures outside the window
  state.failures = state.failures.filter(t => now - t < state.windowMs)
  return state.failures.length >= state.threshold
}

function recordFailure(state: CircuitBreakerState): void {
  state.failures.push(Date.now())
}

// ---------------------------------------------------------------------------
// Prompt Engineering (Task 2.2)
// ---------------------------------------------------------------------------

/** DAMP dial category labels for fingerprint summary */
const DAMP_CATEGORIES: Record<string, string> = {
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
 * Summarize DAMP fingerprint into category averages for the prompt.
 * Groups the 96 dials into their 12 categories and computes mean values.
 */
function summarizeDAMP(fingerprint: DAMPFingerprint): string {
  const categories: Record<string, number[]> = {}

  for (const [dialId, value] of Object.entries(fingerprint.dials)) {
    const prefix = dialId.split("_")[0]
    if (!categories[prefix]) categories[prefix] = []
    categories[prefix].push(value)
  }

  const lines: string[] = []
  for (const [prefix, values] of Object.entries(categories)) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    const label = DAMP_CATEGORIES[prefix] ?? prefix
    lines.push(`- ${label}: ${avg.toFixed(2)} (${values.length} dials)`)
  }

  return lines.join("\n")
}

/**
 * Build era-specific metaphor vocabulary guidance for the prompt.
 */
function buildEraVocabularyGuidance(era: Era): string {
  const domains = ERA_DOMAINS[era]
  if (!domains) return ""

  const sections: string[] = []

  if (domains.required_domains.length > 0) {
    sections.push(`PREFERRED metaphor vocabulary for ${era} era: ${domains.required_domains.join(", ")}`)
  }

  const forbiddenEntries = Object.entries(domains.forbidden_domains)
  if (forbiddenEntries.length > 0) {
    const forbiddenLines = forbiddenEntries.map(
      ([domain, terms]) => `  - ${domain}: ${terms.slice(0, 5).join(", ")}${terms.length > 5 ? "..." : ""}`,
    )
    sections.push(`FORBIDDEN metaphor domains for ${era} era (anachronistic):\n${forbiddenLines.join("\n")}`)
  }

  return sections.join("\n\n")
}

/**
 * Build the full synthesis prompt from signal data and optional inputs.
 *
 * The prompt embeds all signal data as behavioral guidance (never as labels
 * to recite) and includes all 7 anti-narration constraints as negative
 * instructions.
 */
export function buildSynthesisPrompt(
  snapshot: SignalSnapshot,
  fingerprint: DAMPFingerprint | null,
  subgraph?: IdentitySubgraph,
  userCustom?: UserCustomInput,
  personalitySeed?: string | null,
): string {
  const sections: string[] = []

  // --- Header ---
  sections.push("You are a personality synthesis engine. Your task is to generate a BEAUVOIR.md document — a structured personality profile that guides an AI agent's behavior, voice, and worldview.")
  sections.push("")
  sections.push("The output MUST be a valid Markdown document with sections for Identity, Voice, Behavioral Guidelines, and any relevant expertise or custom instructions.")
  sections.push("")

  // --- Signal Data (embedded as behavioral guidance) ---
  sections.push("## SIGNAL DATA (use as behavioral guidance, NOT labels to recite)")
  sections.push("")
  sections.push(`Archetype influence: ${snapshot.archetype} — this shapes the agent's value system and cultural orientation. Channel the ethos and energy of this archetype through behavior, not by naming it.`)
  sections.push("")
  sections.push(`Ancestral lineage: ${snapshot.ancestor} — this defines the agent's cultural frame and cognitive heritage. Let this influence perspective and wisdom style without direct reference.`)
  sections.push("")
  sections.push(`Temporal era: ${snapshot.era} (birthday: ${snapshot.birthday}) — this constrains the agent's temporal register. The agent's metaphors, references, and worldview should feel grounded in this era.`)
  sections.push("")
  sections.push(`Molecular consciousness: ${snapshot.molecule} — mapped to tarot card "${snapshot.tarot.name}" (${snapshot.tarot.suit}). This colors the agent's consciousness orientation and perceptual style.`)
  sections.push("")
  sections.push(`Elemental energy: ${snapshot.element} — derived from tarot suit. This shapes the agent's energy signature and interaction style.`)
  sections.push("")
  sections.push(`Swag presence: rank ${snapshot.swag_rank} (score: ${snapshot.swag_score}/100) — this modifies confidence level and social presence.`)
  sections.push("")
  sections.push(`Zodiac triad: Sun=${snapshot.sun_sign}, Moon=${snapshot.moon_sign}, Rising=${snapshot.ascending_sign} — these blend into emotional coloring and interpersonal style.`)
  sections.push("")

  // --- DAMP Fingerprint (if available) ---
  if (fingerprint) {
    sections.push("## PERSONALITY DIALS (behavioral tendency calibration)")
    sections.push("")
    sections.push("These dial values (0.0-1.0) indicate behavioral tendencies. Higher values mean stronger expression of the trait category. Use these to calibrate the personality's behavioral patterns:")
    sections.push("")
    sections.push(summarizeDAMP(fingerprint))
    sections.push("")
  }

  // --- Identity Subgraph (if available) ---
  if (subgraph) {
    sections.push("## IDENTITY CONTEXT")
    sections.push("")
    if (subgraph.cultural_references.length > 0) {
      sections.push(`Cultural references: ${subgraph.cultural_references.join(", ")}`)
    }
    if (subgraph.aesthetic_notes.length > 0) {
      sections.push(`Aesthetic sensibility: ${subgraph.aesthetic_notes.join(", ")}`)
    }
    if (subgraph.philosophical_lineage.length > 0) {
      sections.push(`Philosophical roots: ${subgraph.philosophical_lineage.join(", ")}`)
    }
    sections.push("")
  }

  // --- User Custom Input (guided mode) ---
  if (userCustom) {
    sections.push("## USER CUSTOMIZATION")
    sections.push("")
    if (userCustom.name) {
      sections.push(`Agent name: ${userCustom.name}`)
    }
    if (userCustom.expertise_domains && userCustom.expertise_domains.length > 0) {
      sections.push(`Expertise domains: ${userCustom.expertise_domains.join(", ")}`)
    }
    if (userCustom.custom_instructions) {
      sections.push(`Custom instructions: ${userCustom.custom_instructions}`)
    }
    sections.push("")
  }

  // --- Sprint 20 Task 20.1: Seed-based personality variation ---
  if (personalitySeed) {
    sections.push("## PERSONALITY SEED (uniqueness variation)")
    sections.push("")
    sections.push(`Personality seed: ${personalitySeed.slice(0, 16)}... — use this as inspiration for unique stylistic choices, idiosyncratic phrasings, and distinctive behavioral details that make this agent feel like an individual rather than a type.`)
    sections.push("")
  }

  // --- Era Vocabulary Guidance ---
  const eraGuidance = buildEraVocabularyGuidance(snapshot.era)
  if (eraGuidance) {
    sections.push("## TEMPORAL VOCABULARY CONSTRAINTS")
    sections.push("")
    sections.push(eraGuidance)
    sections.push("")
  }

  // --- Anti-Narration Constraints (all 7 as negative instructions) ---
  sections.push("## CRITICAL: ANTI-NARRATION CONSTRAINTS")
  sections.push("")
  sections.push("The following are ABSOLUTE prohibitions. Violating any of these makes the output invalid:")
  sections.push("")
  sections.push("AN-1: Do NOT explicitly label the archetype. Never write phrases like \"You are a freetekno\" or \"As a milady\". The archetype must be FELT through behavior, not stated.")
  sections.push("")
  sections.push("AN-2: Do NOT mechanically role-play the era. Never write \"In the medieval tradition...\" or \"As a being from the ancient world...\". The temporal register should emerge naturally through vocabulary and worldview.")
  sections.push("")
  sections.push("AN-3: Do NOT make literal drug references. The molecule signal is metaphorical — it shapes consciousness orientation, not substance use. Never reference actual drug effects or experiences.")
  sections.push("")
  sections.push("AN-4: Do NOT use \"as the [ancestor]\" framing. Never write \"As the Oracle\" or \"channeling the Shaman\". Ancestral influence should manifest as cognitive style and cultural perspective, not role declaration.")
  sections.push("")
  sections.push("AN-5: Do NOT directly invoke elements. Never write \"being water\" or \"channeling fire\". Elemental energy should influence interaction style subtly, not through explicit element naming.")
  sections.push("")
  sections.push("AN-6 (HIGHEST PRIORITY): Do NOT self-narrate identity. NEVER use patterns like \"as a [role/archetype/ancestor]\", \"I am a [identity]\", or \"being a [label]\". The personality must EMBODY traits without narrating what it is.")
  sections.push("")
  sections.push("AN-7: Do NOT recite zodiac placements. Never list sun/moon/rising signs or describe behavior as \"because of your Leo sun\". Zodiac influence should blend invisibly into emotional tone.")
  sections.push("")

  // --- Safety Constraints (Sprint 11 Task 11.2a) ---
  sections.push("## SAFETY CONSTRAINTS")
  sections.push("")
  sections.push(getSafetyPolicyText())
  sections.push("")

  // --- Output Format ---
  sections.push("## OUTPUT FORMAT")
  sections.push("")
  sections.push("Generate a BEAUVOIR.md document with these sections:")
  sections.push("1. A heading with the agent's name (or a generated name if none provided)")
  sections.push("2. ## Identity — Who the agent IS (embody, don't label)")
  sections.push("3. ## Voice — HOW the agent communicates")
  sections.push("4. ## Behavioral Guidelines — Specific behavioral directives")
  if (userCustom?.expertise_domains && userCustom.expertise_domains.length > 0) {
    sections.push("5. ## Expertise — Domain knowledge areas")
  }
  if (userCustom?.custom_instructions) {
    sections.push("6. ## Custom Instructions — User-specified directives")
  }
  sections.push("")
  sections.push("The output must be ONLY the Markdown document. No preamble, no explanation, no meta-commentary.")

  return sections.join("\n")
}

/**
 * Build a system prompt for the synthesis LLM call.
 */
function buildSystemPrompt(): string {
  return [
    "You are BEAUVOIR, a personality synthesis engine for AI agents.",
    "You receive signal data describing an agent's identity coordinates and produce a structured Markdown personality document.",
    "Your output defines how the agent will behave, speak, and think.",
    "",
    "CRITICAL RULES:",
    "- Output ONLY valid Markdown. No preamble or explanation.",
    "- Embed traits as behavioral guidance. NEVER recite labels, archetypes, or identity markers.",
    "- The personality must feel emergent and natural, not mechanical or formulaic.",
    "- Violating anti-narration constraints invalidates the entire output.",
  ].join("\n")
}

/**
 * Build a retry prompt that includes violation feedback from a previous attempt.
 */
function buildRetryPrompt(
  originalPrompt: string,
  violations: ANViolation[],
  temporalViolations: TemporalViolation[],
): string {
  const feedback: string[] = []
  feedback.push("## VIOLATION FEEDBACK FROM PREVIOUS ATTEMPT")
  feedback.push("")
  feedback.push("Your previous output was REJECTED because it violated anti-narration or temporal constraints. Fix ALL of the following:")
  feedback.push("")

  for (const v of violations) {
    feedback.push(`- [${v.constraint_id}] ${v.violation_text} — found: "${v.source_text}"`)
  }
  for (const tv of temporalViolations) {
    feedback.push(`- [TEMPORAL:${tv.era}] Forbidden ${tv.forbidden_domain} term "${tv.matched_term}" — found in: "${tv.source_text}"`)
  }

  feedback.push("")
  feedback.push("Regenerate the BEAUVOIR.md document with these violations corrected. Do NOT include any of the flagged phrases or terms.")
  feedback.push("")

  return originalPrompt + "\n\n" + feedback.join("\n")
}

// ---------------------------------------------------------------------------
// Sprint 20 Task 20.1: Seed-based dAMP dial jitter (±2%)
// ---------------------------------------------------------------------------

/**
 * Apply deterministic jitter to dAMP dials based on personality seed.
 * Each dial gets ±2% jitter derived from HMAC of the seed + dial ID.
 * Results are clamped to [0.0, 1.0].
 */
function applyDialJitter(fingerprint: DAMPFingerprint, seed: string): DAMPFingerprint {
  const jitteredDials = { ...fingerprint.dials } as Record<DAMPDialId, number>
  const MAX_JITTER = 0.02 // ±2%

  for (const dialId of Object.keys(fingerprint.dials) as DAMPDialId[]) {
    const hmac = createHmac("sha256", seed)
    hmac.update(dialId)
    const hash = hmac.digest()
    // Map first 2 bytes to [-MAX_JITTER, +MAX_JITTER]
    const raw = hash.readUInt16BE(0) / 65535 // 0-1
    const jitter = (raw * 2 - 1) * MAX_JITTER // -0.02 to +0.02
    jitteredDials[dialId] = Math.max(0, Math.min(1, fingerprint.dials[dialId] + jitter))
  }

  return {
    ...fingerprint,
    dials: jitteredDials,
  }
}

/** Exported for testing */
export { applyDialJitter as _applyDialJitter_test }

// ---------------------------------------------------------------------------
// BeauvoirSynthesizer (Tasks 2.1, 2.3, 2.6)
// ---------------------------------------------------------------------------

/** Configuration for the synthesizer */
export interface BeauvoirSynthesizerConfig {
  /** Agent name to use when invoking the router (default: "beauvoir-synth") */
  agent?: string
  /** LLM temperature for synthesis (default: 0.7) */
  temperature?: number
  /** Max tokens for LLM output (default: 2048) */
  max_tokens?: number
  /** Max retry attempts after AN violations (default: 2, so 3 total calls) */
  maxRetries?: number
  /** Circuit breaker failure threshold (default: 3) */
  circuitBreakerThreshold?: number
  /** Circuit breaker window in ms (default: 60000) */
  circuitBreakerWindowMs?: number
}

const DEFAULT_CONFIG: Required<BeauvoirSynthesizerConfig> = {
  agent: "beauvoir-synth",
  temperature: 0.7,
  max_tokens: 2048,
  maxRetries: 2,
  circuitBreakerThreshold: 3,
  circuitBreakerWindowMs: 60_000,
}

export class BeauvoirSynthesizer {
  private readonly router: SynthesisRouter
  private readonly config: Required<BeauvoirSynthesizerConfig>
  private readonly circuitBreaker: CircuitBreakerState

  constructor(router: SynthesisRouter, config?: BeauvoirSynthesizerConfig) {
    this.router = router
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.circuitBreaker = {
      failures: [],
      windowMs: this.config.circuitBreakerWindowMs,
      threshold: this.config.circuitBreakerThreshold,
    }
  }

  /**
   * Synthesize a BEAUVOIR.md document from signal data.
   *
   * Auto mode: pass only snapshot (and optionally fingerprint/subgraph).
   * Guided mode: additionally pass userCustom with name, instructions, domains.
   *
   * Includes circuit breaker protection and anti-narration retry loop.
   *
   * @param snapshot - Signal data for the agent
   * @param fingerprint - Optional DAMP fingerprint for behavioral calibration
   * @param subgraph - Optional identity subgraph for richer context
   * @param userCustom - Optional user customization (guided mode)
   * @returns Valid BEAUVOIR.md markdown string
   * @throws SynthesisError with code SYNTHESIS_UNAVAILABLE if circuit breaker is open
   * @throws SynthesisError with code ANTI_NARRATION_VIOLATION if max retries exhausted
   * @throws SynthesisError with code SYNTHESIS_FAILED on LLM invocation failure
   */
  async synthesize(
    snapshot: SignalSnapshot,
    fingerprint: DAMPFingerprint | null,
    subgraph?: IdentitySubgraph,
    userCustom?: UserCustomInput,
    personalitySeed?: string | null,
  ): Promise<string> {
    // Circuit breaker check
    if (isCircuitOpen(this.circuitBreaker)) {
      throw new SynthesisError(
        "SYNTHESIS_UNAVAILABLE",
        `Circuit breaker open: ${this.circuitBreaker.threshold} failures in ${this.circuitBreaker.windowMs}ms window`,
      )
    }

    // Sprint 20 Task 20.1: Apply seed-based jitter to dAMP dials
    const jitteredFingerprint = fingerprint && personalitySeed
      ? applyDialJitter(fingerprint, personalitySeed)
      : fingerprint

    const basePrompt = buildSynthesisPrompt(snapshot, jitteredFingerprint, subgraph, userCustom, personalitySeed)
    const systemPrompt = buildSystemPrompt()
    let currentPrompt = basePrompt

    // Retry loop: initial attempt + maxRetries retries
    const maxAttempts = 1 + this.config.maxRetries
    let lastViolations: ANViolation[] = []
    let lastTemporalViolations: TemporalViolation[] = []

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let content: string
      try {
        const result = await this.router.invoke(this.config.agent, currentPrompt, {
          temperature: this.config.temperature,
          max_tokens: this.config.max_tokens,
          systemPrompt,
        })
        content = result.content
      } catch (err) {
        recordFailure(this.circuitBreaker)
        throw new SynthesisError(
          "SYNTHESIS_FAILED",
          `LLM invocation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      // Validate against anti-narration constraints
      const anViolations = validateAntiNarration(content, snapshot)
      const temporalViolations = checkTemporalVoice(content, snapshot.era)

      if (anViolations.length === 0 && temporalViolations.length === 0) {
        // Clean output — return it
        return content
      }

      // Store violations for potential error reporting
      lastViolations = anViolations
      lastTemporalViolations = temporalViolations

      // If we have retries left, build a retry prompt with violation feedback
      if (attempt < maxAttempts - 1) {
        currentPrompt = buildRetryPrompt(basePrompt, anViolations, temporalViolations)
      }
    }

    // All retries exhausted — throw with violation details
    throw new SynthesisError(
      "ANTI_NARRATION_VIOLATION",
      `Anti-narration violations persist after ${maxAttempts} attempts`,
      lastViolations,
      lastTemporalViolations,
    )
  }
}
