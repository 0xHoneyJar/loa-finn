// src/nft/temporal-voice.ts — Temporal Voice Domain Checker (SDD §3.2, Sprint 2 Task 2.5)
//
// Validates synthesized text against era-specific metaphor domain constraints.
// Each era has required and forbidden vocabulary domains to maintain temporal fidelity.

import type { Era } from "./signal-types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single temporal voice violation */
export interface TemporalViolation {
  /** The era that was violated */
  era: Era
  /** The forbidden domain category that was matched */
  forbidden_domain: string
  /** The specific term that was matched */
  matched_term: string
  /** The source text fragment containing the violation */
  source_text: string
}

// ---------------------------------------------------------------------------
// Era Domain Definitions
// ---------------------------------------------------------------------------

export interface EraDomainDef {
  /** Keywords/phrases that are encouraged for this era */
  required_domains: string[]
  /** Keywords/phrases that are anachronistic for this era */
  forbidden_domains: Record<string, string[]>
}

/**
 * Era domain definitions with required and forbidden metaphor vocabularies.
 *
 * Forbidden domains map category names to arrays of keyword patterns.
 * "contemporary" is unrestricted (no forbidden domains).
 */
export const ERA_DOMAINS: Record<Era, EraDomainDef> = {
  ancient: {
    required_domains: [
      "stone", "bronze", "iron", "temple", "oracle", "myth",
      "river", "harvest", "stars", "clay", "scroll", "fire",
    ],
    forbidden_domains: {
      "industrial machinery": [
        "engine", "steam engine", "factory", "assembly line", "conveyor",
        "turbine", "piston", "locomotive",
      ],
      "digital/cyber": [
        "digital", "cyber", "algorithm", "CPU", "processor", "binary",
        "software", "hardware", "internet", "download", "upload", "wifi",
        "bluetooth", "pixel", "megabyte", "gigabyte", "terabyte",
      ],
      "corporate jargon": [
        "startup", "synergy", "leverage", "pivot", "disrupt",
        "stakeholder", "KPI", "ROI", "scalable", "bandwidth",
        "onboarding", "deliverable",
      ],
    },
  },

  medieval: {
    required_domains: [
      "castle", "guild", "forge", "manuscript", "cathedral",
      "pilgrimage", "feudal", "knight", "monastery", "tapestry",
    ],
    forbidden_domains: {
      "electronics": [
        "circuit", "transistor", "voltage", "semiconductor",
        "battery", "electrode", "amplifier", "diode",
      ],
      "computing": [
        "computing", "computer", "algorithm", "CPU", "processor",
        "database", "server", "cloud computing", "machine learning",
        "artificial intelligence", "neural network",
      ],
      "startup culture": [
        "startup", "venture capital", "pitch deck", "unicorn",
        "accelerator", "incubator", "MVP", "growth hacking",
      ],
      "social media": [
        "social media", "tweet", "post", "follower", "influencer",
        "viral", "hashtag", "trending", "livestream", "content creator",
        "smartphone", "selfie", "emoji",
      ],
    },
  },

  early_modern: {
    required_domains: [
      "compass", "printing press", "telescope", "merchant",
      "colony", "enlightenment", "revolution", "salon",
      "pamphlet", "musket", "cartography",
    ],
    forbidden_domains: {
      "digital technology": [
        "digital", "internet", "website", "app", "smartphone",
        "tablet", "laptop", "streaming", "download", "upload",
        "cloud", "blockchain", "cryptocurrency",
      ],
      "aerospace": [
        "aerospace", "satellite", "rocket", "spacecraft", "orbit",
        "astronaut", "space station", "launch pad", "mission control",
      ],
      "nuclear": [
        "nuclear", "atomic", "radiation", "reactor", "fission",
        "fusion", "isotope", "uranium", "plutonium",
      ],
      "streaming": [
        "streaming", "podcast", "playlist", "subscription",
        "binge-watch", "on-demand", "algorithm",
      ],
    },
  },

  modern: {
    required_domains: [
      "telegraph", "railroad", "photograph", "cinema",
      "broadcast", "telephone", "automobile", "aviation",
      "typewriter", "gramophone", "factory",
    ],
    forbidden_domains: {
      "internet": [
        "internet", "website", "URL", "browser", "search engine",
        "email", "online", "wifi", "broadband", "fiber optic",
      ],
      "smartphones": [
        "smartphone", "iPhone", "Android", "touchscreen", "app store",
        "mobile app", "notification", "swipe", "tap",
      ],
      "AI": [
        "AI", "artificial intelligence", "machine learning",
        "deep learning", "neural network", "GPT", "LLM",
        "chatbot", "generative", "transformer model",
      ],
      "cloud computing": [
        "cloud computing", "SaaS", "PaaS", "IaaS", "serverless",
        "microservices", "containerization", "kubernetes", "docker",
        "DevOps", "CI/CD",
      ],
    },
  },

  contemporary: {
    required_domains: [],
    forbidden_domains: {},
  },
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Extract a context window around a match position for the source_text field.
 * Returns up to ~60 characters of surrounding context.
 */
function extractContext(text: string, matchStart: number, matchEnd: number): string {
  const contextPad = 25
  const start = Math.max(0, matchStart - contextPad)
  const end = Math.min(text.length, matchEnd + contextPad)
  let ctx = text.slice(start, end).replace(/\n/g, " ")
  if (start > 0) ctx = "..." + ctx
  if (end < text.length) ctx = ctx + "..."
  return ctx
}

/**
 * Check synthesized text for temporal voice violations.
 *
 * Scans the text for forbidden domain terms based on the given era.
 * Contemporary era is unrestricted and always returns empty.
 *
 * @param text - The synthesized BEAUVOIR.md text to validate
 * @param era - The era to check against
 * @returns Array of TemporalViolation objects (empty if no violations)
 */
export function checkTemporalVoice(text: string, era: Era): TemporalViolation[] {
  const domains = ERA_DOMAINS[era]
  if (!domains) return []

  const violations: TemporalViolation[] = []

  for (const [domainName, terms] of Object.entries(domains.forbidden_domains)) {
    for (const term of terms) {
      // Build case-insensitive word-boundary regex for each term
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re = new RegExp(`\\b${escaped}\\b`, "gi")
      let match: RegExpExecArray | null

      while ((match = re.exec(text)) !== null) {
        violations.push({
          era,
          forbidden_domain: domainName,
          matched_term: term,
          source_text: extractContext(text, match.index, match.index + match[0].length),
        })
      }
    }
  }

  return violations
}
