// src/hounfour/goodhart/quality-signal.ts — Quality Observation Signal (SDD §4.1.1b, T-2.5)
//
// After each inference response, feed the composite quality score into the EMA.
// Signal flow: QualityGateScorer → ReputationEventNormalizer → TemporalDecayEngine.updateEMA()

import { createHash } from "node:crypto"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../nft-routing-config.js"
import type { TemporalDecayEngine, EMAKey } from "./temporal-decay.js"
import {
  computeDampenedScore,
  FeedbackDampeningConfigSchema,
} from "../protocol-types.js"
import type { FeedbackDampeningConfig } from "../protocol-types.js"
import { Value } from "@sinclair/typebox/value"

// --- Types ---

export interface QualityObservation {
  nftId: string
  poolId: PoolId
  routingKey: NFTRoutingKey
  latencyMs: number
  success: boolean
  finishReason: "stop" | "tool_calls" | "length" | "error"
  tokenUtilization: number // ratio of completion_tokens / max_tokens, [0, 1]
}

export interface QualitySignalConfig {
  decay: TemporalDecayEngine
  /** Weight applied to exploration observations (default: 0.5) */
  explorationFeedbackWeight: number
  /** Latency thresholds per pool (if available) */
  latencyP50Ms?: number
  latencyP95Ms?: number
}

export interface ReputationEvent {
  key: EMAKey
  score: number
  timestamp: number
  hash: string
}

// --- Feature-flagged canonical dampening (T-3.1, T-3.2) ---

const CANONICAL_DAMPENING_ENABLED = process.env.FINN_CANONICAL_DAMPENING === "true"

/** Validated dampening config — null if invalid or unconfigured (T-3.2). */
let dampeningConfig: FeedbackDampeningConfig | undefined
let dampeningConfigValid = true

if (CANONICAL_DAMPENING_ENABLED) {
  const rawConfig = process.env.FINN_DAMPENING_CONFIG
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig)
      if (Value.Check(FeedbackDampeningConfigSchema, parsed)) {
        dampeningConfig = parsed
      } else {
        console.warn("[quality-signal] FINN_DAMPENING_CONFIG failed schema validation — falling back to local EMA")
        dampeningConfigValid = false
      }
    } catch {
      console.warn("[quality-signal] FINN_DAMPENING_CONFIG is not valid JSON — falling back to local EMA")
      dampeningConfigValid = false
    }
  }
  // undefined config → computeDampenedScore uses built-in defaults
}

/**
 * Apply dampening to a quality score (T-3.1, SDD §3.7).
 *
 * When FINN_CANONICAL_DAMPENING=true and config is valid:
 *   uses canonical computeDampenedScore() from hounfour v8.3.0.
 * Otherwise: returns newScore unchanged (local EMA handles dampening).
 */
export function applyDampening(
  oldScore: number | null,
  newScore: number,
  sampleCount: number,
): number {
  if (!CANONICAL_DAMPENING_ENABLED || !dampeningConfigValid) {
    return newScore
  }
  return computeDampenedScore(oldScore, newScore, sampleCount, dampeningConfig)
}

// --- Scorer ---

/**
 * Compute composite quality score from an observation (SDD §4.1.1b).
 *
 * | Factor            | Weight | Range    |
 * |-------------------|--------|----------|
 * | Latency percentile| 0.3    | 0–1      |
 * | Error indicator   | 0.4    | binary   |
 * | Content quality   | 0.3    | 0–1      |
 */
export function scoreObservation(
  obs: QualityObservation,
  p50Ms: number = 1000,
  p95Ms: number = 5000,
): number {
  // Latency score: 1.0 if < p50, 0.0 if > p95, linear interpolation between
  let latencyScore: number
  if (obs.latencyMs <= p50Ms) {
    latencyScore = 1.0
  } else if (obs.latencyMs >= p95Ms) {
    latencyScore = 0.0
  } else {
    latencyScore = 1.0 - (obs.latencyMs - p50Ms) / (p95Ms - p50Ms)
  }

  // Error indicator: 0 if error/timeout, 1 if success
  const errorScore = obs.success ? 1.0 : 0.0

  // Content quality: finish_reason + token utilization
  let contentScore: number
  if (obs.finishReason === "error") {
    contentScore = 0.0
  } else if (obs.finishReason === "length") {
    contentScore = 0.3 // Hit token limit — partial quality
  } else {
    // "stop" or "tool_calls" — good completion
    contentScore = 0.5 + 0.5 * Math.max(0, Math.min(1, obs.tokenUtilization))
  }

  return latencyScore * 0.3 + errorScore * 0.4 + contentScore * 0.3
}

/**
 * Generate deterministic event hash for EMA idempotency (SDD §4.1.1b).
 * SHA-256(nftId + poolId + routingKey + timestamp + score)
 */
export function computeEventHash(
  nftId: string,
  poolId: PoolId,
  routingKey: NFTRoutingKey,
  timestamp: number,
  score: number,
): string {
  // T-7.4: Null byte delimiters prevent collision (e.g., "ab"+"c" vs "a"+"bc")
  const input = `${nftId}\0${poolId}\0${routingKey}\0${timestamp}\0${score}`
  return createHash("sha256").update(input).digest("hex")
}

/**
 * Normalize an observation into a reputation event for EMA update.
 */
export function normalizeToEvent(
  obs: QualityObservation,
  p50Ms?: number,
  p95Ms?: number,
): ReputationEvent {
  const score = scoreObservation(obs, p50Ms, p95Ms)
  const timestamp = Date.now()
  const hash = computeEventHash(obs.nftId, obs.poolId, obs.routingKey, timestamp, score)

  return {
    key: { nftId: obs.nftId, poolId: obs.poolId, routingKey: obs.routingKey },
    score,
    timestamp,
    hash,
  }
}

/**
 * Feed a quality observation into the EMA (complete signal flow).
 * For exploration-path observations, score is weighted at explorationFeedbackWeight.
 *
 * When FINN_CANONICAL_DAMPENING=true, applies canonical dampening before EMA update
 * and logs delta when local vs canonical differ by >0.001. (T-3.1)
 */
export async function feedQualitySignal(
  config: QualitySignalConfig,
  obs: QualityObservation,
  isExploration: boolean = false,
): Promise<void> {
  const event = normalizeToEvent(obs, config.latencyP50Ms, config.latencyP95Ms)

  let score = isExploration
    ? event.score * config.explorationFeedbackWeight
    : event.score

  // Apply canonical dampening when enabled (T-3.1)
  if (CANONICAL_DAMPENING_ENABLED && dampeningConfigValid) {
    const currentState = await config.decay.getRawState(event.key)
    const oldScore = currentState?.ema ?? null
    const sampleCount = (currentState?.sampleCount ?? 0) + 1

    const dampened = applyDampening(oldScore, score, sampleCount)
    const delta = Math.abs(dampened - score)
    if (delta > 0.001) {
      // Structured JSON telemetry (T-4.2, Finding #9 — enables log aggregation/alerting)
      console.log(JSON.stringify({
        event: "dampening_delta",
        local: Number(score.toFixed(6)),
        canonical: Number(dampened.toFixed(6)),
        delta: Number(delta.toFixed(6)),
        nftId: obs.nftId,
        sampleCount,
      }))
    }
    score = dampened
  }

  await config.decay.updateEMA(event.key, score, event.timestamp, event.hash)
}
