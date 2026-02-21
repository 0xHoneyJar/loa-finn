/**
 * Quality Governance — Sprint 1 (GID 124), Tasks T1.2 + T1.3
 *
 * Transforms the quality signal ontology from a passive measurement layer into
 * an active governance model. The principle: what you measure determines what
 * the system optimizes for.
 *
 * Parallel: Google's Panda update (2011) — added counter-signals (long click,
 * pogo-sticking) to prevent click-through optimization from rewarding clickbait.
 * Our counter-signals (challenge_rate, response_depth) prevent satisfaction
 * optimization from rewarding sycophancy.
 *
 * Fire-and-Forget Invariant: All governance functions are exception-safe.
 * They NEVER throw — callers get fallback behavior on any error.
 */

import type { QualitySignals } from "./routing-quality.js"
import type { Archetype } from "./signal-types.js"
import { metrics } from "../gateway/metrics-endpoint.js"

// ---------------------------------------------------------------------------
// Safe Metrics Helper — never throws (fire-and-forget invariant)
// ---------------------------------------------------------------------------

function safeIncrementCounter(name: string, labels?: Record<string, string>): void {
  try {
    metrics.incrementCounter(name, labels)
  } catch {
    // Swallow — metrics emission is best-effort
  }
}

// ---------------------------------------------------------------------------
// Sycophancy Detection (T1.2)
// ---------------------------------------------------------------------------

export interface SycophancyResult {
  /** Whether sycophancy risk was detected */
  risk: boolean
  /** Confidence in the detection [0-1] */
  confidence: number
  /** Human-readable reason (for logging/debugging) */
  reason?: string
}

/**
 * Detect sycophancy risk from quality signals.
 *
 * Detection rules (each catches a different gaming strategy):
 * (a) HIGH: user_satisfaction=1.0 AND coherence<0.5 → agreeable but incoherent
 * (b) MEDIUM: satisfaction>0.8 AND challenge_rate<0.1 → never pushes back
 * (c) MEDIUM: satisfaction>0.9 AND response_depth<0.3 → surface agreement
 *
 * Returns { risk: false } when any required signal is absent —
 * we don't penalize missing data.
 */
export function detectSycophancyRisk(signals: QualitySignals): SycophancyResult {
  const { user_satisfaction, coherence_score, challenge_rate, response_depth } = signals

  // Rule (a): agreeable but incoherent
  if (
    user_satisfaction !== undefined &&
    coherence_score !== undefined &&
    user_satisfaction >= 1.0 &&
    coherence_score < 0.5
  ) {
    return {
      risk: true,
      confidence: 0.9,
      reason: `high satisfaction (${user_satisfaction}) with low coherence (${coherence_score})`,
    }
  }

  // Rule (b): never challenges the user
  if (
    user_satisfaction !== undefined &&
    challenge_rate !== undefined &&
    user_satisfaction > 0.8 &&
    challenge_rate < 0.1
  ) {
    return {
      risk: true,
      confidence: 0.7,
      reason: `high satisfaction (${user_satisfaction}) with near-zero challenge rate (${challenge_rate})`,
    }
  }

  // Rule (c): surface agreement without depth
  if (
    user_satisfaction !== undefined &&
    response_depth !== undefined &&
    user_satisfaction > 0.9 &&
    response_depth < 0.3
  ) {
    return {
      risk: true,
      confidence: 0.6,
      reason: `very high satisfaction (${user_satisfaction}) with shallow depth (${response_depth})`,
    }
  }

  return { risk: false, confidence: 0 }
}

/**
 * Adjust signals when sycophancy is detected.
 * Caps effective user_satisfaction at coherence_score value.
 *
 * Returns a new signals object — never mutates input.
 */
export function adjustForSycophancy(signals: QualitySignals): QualitySignals {
  const detection = detectSycophancyRisk(signals)
  if (!detection.risk) return signals

  const adjusted = { ...signals }
  if (
    adjusted.user_satisfaction !== undefined &&
    adjusted.coherence_score !== undefined
  ) {
    // Cap satisfaction at coherence — if the response isn't coherent,
    // high satisfaction is likely gamed.
    adjusted.user_satisfaction = Math.min(
      adjusted.user_satisfaction,
      adjusted.coherence_score,
    )
  }
  return adjusted
}

// ---------------------------------------------------------------------------
// Signal Weights — Archetype-Aware Governance (T1.3)
// ---------------------------------------------------------------------------

/** The 5 non-boolean signal keys eligible for weighting */
export const GOVERNANCE_SIGNAL_KEYS = [
  "user_satisfaction",
  "coherence_score",
  "challenge_rate",
  "task_completion",
  "response_depth",
] as const

export type GovernanceSignalKey = (typeof GOVERNANCE_SIGNAL_KEYS)[number]

/** Weight configuration for quality signal governance */
export type SignalWeights = Record<GovernanceSignalKey, number>

/** Default weights — balanced governance */
const DEFAULT_WEIGHTS: SignalWeights = {
  user_satisfaction: 0.3,
  coherence_score: 0.3,
  challenge_rate: 0.2,
  task_completion: 0.15,
  response_depth: 0.05,
}

/** Archetype-specific overrides (only the differing weights) */
const ARCHETYPE_OVERRIDES: Partial<Record<Archetype, Partial<SignalWeights>>> = {
  freetekno: { challenge_rate: 0.3, user_satisfaction: 0.2 },
  milady: { user_satisfaction: 0.4, challenge_rate: 0.1 },
  chicago_detroit: { task_completion: 0.3, response_depth: 0.0, coherence_score: 0.2 },
  acidhouse: { response_depth: 0.25, coherence_score: 0.2, task_completion: 0.1 },
}

/**
 * Normalize weights so they sum to 1.0.
 * If all weights are 0, returns equal distribution.
 */
function normalizeWeights(weights: SignalWeights): SignalWeights {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0)
  if (sum === 0) {
    // Equal distribution
    const equal = 1 / GOVERNANCE_SIGNAL_KEYS.length
    const result = {} as SignalWeights
    for (const key of GOVERNANCE_SIGNAL_KEYS) result[key] = equal
    return result
  }
  const result = {} as SignalWeights
  for (const key of GOVERNANCE_SIGNAL_KEYS) {
    result[key] = weights[key] / sum
  }
  return result
}

/**
 * Parse and validate governance overrides from env var.
 *
 * Strict schema validation (GPT-5.2 fix #6):
 * - Only known signal keys accepted
 * - Weights must be finite numbers >= 0
 * - safety_pass key is rejected
 * - Malformed JSON → returns null (caller uses defaults)
 */
export function parseGovernanceOverrides(raw: string | undefined): Partial<SignalWeights> | null {
  if (!raw || raw.trim() === "") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    safeIncrementCounter("finn_quality_governance_error_total")
    console.warn("[quality-governance] Malformed JSON in FINN_QUALITY_GOVERNANCE_OVERRIDES, using defaults")
    return null
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    safeIncrementCounter("finn_quality_governance_error_total")
    console.warn("[quality-governance] Invalid override format (expected object), using defaults")
    return null
  }

  const knownKeys = new Set<string>(GOVERNANCE_SIGNAL_KEYS)
  const overrides: Partial<SignalWeights> = {}
  let hasValid = false

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Reject safety_pass — it's a hard floor, not a weight
    if (key === "safety_pass") {
      safeIncrementCounter("finn_quality_governance_error_total")
      console.warn("[quality-governance] safety_pass cannot be overridden in governance weights")
      continue
    }

    // Reject unknown keys
    if (!knownKeys.has(key)) {
      safeIncrementCounter("finn_quality_governance_error_total")
      console.warn(`[quality-governance] Unknown signal key '${key}' rejected`)
      continue
    }

    // Validate value
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      safeIncrementCounter("finn_quality_governance_error_total")
      console.warn(`[quality-governance] Invalid weight for '${key}': ${value} (must be finite >= 0)`)
      continue
    }

    overrides[key as GovernanceSignalKey] = value
    hasValid = true
  }

  return hasValid ? overrides : null
}

/**
 * Get signal weights for an archetype, with env var overrides applied.
 *
 * Priority: env var > archetype-specific > default
 * Weights are always normalized to sum to 1.0.
 */
export function getSignalWeights(archetype?: Archetype): SignalWeights {
  // Start with defaults
  const weights: SignalWeights = { ...DEFAULT_WEIGHTS }

  // Apply archetype-specific overrides
  if (archetype) {
    const archetypeOverrides = ARCHETYPE_OVERRIDES[archetype]
    if (archetypeOverrides) {
      Object.assign(weights, archetypeOverrides)
    }
  }

  // Apply env var overrides (highest priority)
  const envOverrides = parseGovernanceOverrides(
    typeof process !== "undefined" ? process.env.FINN_QUALITY_GOVERNANCE_OVERRIDES : undefined,
  )
  if (envOverrides) {
    Object.assign(weights, envOverrides)
  }

  return normalizeWeights(weights)
}

// ---------------------------------------------------------------------------
// Governed Quality Scoring (T1.4 support)
// ---------------------------------------------------------------------------

/**
 * Compute governed quality score from signals with archetype-aware weighting.
 *
 * Algorithm:
 * 1. Apply anti-sycophancy adjustment (if detection is enabled)
 * 2. Get archetype-specific weights
 * 3. Compute weighted average of available signals
 * 4. Normalize by total weight of available signals
 *
 * safety_pass=false is handled by the caller (returns 0 before governance).
 *
 * @returns quality score [0-1] or null if no signals available
 */
export function governedQualityFromSignals(
  signals: QualitySignals,
  archetype?: Archetype,
): number | null {
  // Backward compatibility: when no archetype, use ungoverned simple average
  // (no sycophancy adjustment, no weighting — matches legacy qualityFromSignals)
  if (!archetype) {
    const values: number[] = []
    if (signals.user_satisfaction !== undefined) values.push(signals.user_satisfaction)
    if (signals.coherence_score !== undefined) values.push(signals.coherence_score)
    if (signals.challenge_rate !== undefined) values.push(signals.challenge_rate)
    if (signals.task_completion !== undefined) values.push(signals.task_completion)
    if (signals.response_depth !== undefined) values.push(signals.response_depth)

    if (values.length === 0) return null
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    return Math.max(0, Math.min(1, avg))
  }

  const sycophancyEnabled = typeof process !== "undefined"
    ? process.env.FINN_SYCOPHANCY_DETECTION_ENABLED !== "false"
    : true

  // Step 1: Anti-sycophancy adjustment
  let adjusted = signals
  if (sycophancyEnabled) {
    const detection = detectSycophancyRisk(signals)
    if (detection.risk) {
      adjusted = adjustForSycophancy(signals)
      safeIncrementCounter("finn_quality_sycophancy_detected_total", {
        archetype,
      })
    }
  }

  // Step 2: Get weights
  const weights = getSignalWeights(archetype)

  // Step 3: Weighted average of available signals
  const signalValues: Array<{ key: GovernanceSignalKey; value: number }> = []
  if (adjusted.user_satisfaction !== undefined) {
    signalValues.push({ key: "user_satisfaction", value: adjusted.user_satisfaction })
  }
  if (adjusted.coherence_score !== undefined) {
    signalValues.push({ key: "coherence_score", value: adjusted.coherence_score })
  }
  if (adjusted.challenge_rate !== undefined) {
    signalValues.push({ key: "challenge_rate", value: adjusted.challenge_rate })
  }
  if (adjusted.task_completion !== undefined) {
    signalValues.push({ key: "task_completion", value: adjusted.task_completion })
  }
  if (adjusted.response_depth !== undefined) {
    signalValues.push({ key: "response_depth", value: adjusted.response_depth })
  }

  if (signalValues.length === 0) return null

  // Step 4: Weighted score normalized by available weight
  let weightedSum = 0
  let totalWeight = 0
  for (const { key, value } of signalValues) {
    weightedSum += value * weights[key]
    totalWeight += weights[key]
  }

  if (totalWeight === 0) return null

  return Math.max(0, Math.min(1, weightedSum / totalWeight))
}
