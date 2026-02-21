// src/nft/experience-accumulator.ts — Experience Accumulator (Sprint 26 Task 26.1)
//
// Feeds CompletionResult metadata into ExperienceSnapshot via the ExperienceEngine.
// Async, fire-and-forget design — accumulation never blocks the response path.
//
// Privacy: extracts metadata signals only. NO content storage.
// No user identifiers are captured or stored.

import type { DAMPDialId } from "./signal-types.js"
import type { InteractionAggregate } from "./experience-types.js"
import type { ExperienceEngine } from "./experience-engine.js"
import type { RoutingQualityStore, RoutingQualityEvent } from "./routing-quality.js"

// ---------------------------------------------------------------------------
// CompletionResult Metadata — minimal interface for decoupling
// ---------------------------------------------------------------------------

/**
 * Minimal metadata extracted from a CompletionResult for experience accumulation.
 * This interface decouples the accumulator from the full CompletionResult type.
 *
 * Privacy: we only consume metadata fields — content is NEVER stored or read
 * for experience accumulation purposes.
 */
export interface CompletionMetadata {
  /** Model used for completion */
  model: string
  /** Latency in milliseconds */
  latency_ms: number
  /** Token usage */
  usage: {
    prompt_tokens: number
    completion_tokens: number
    reasoning_tokens: number
  }
  /** Optional: detected topics from the interaction (external classifier) */
  detected_topics?: Record<string, number>
  /** Optional: detected style labels (external classifier) */
  detected_styles?: Record<string, number>
  /** Optional: detected metaphor families (external classifier) */
  detected_metaphors?: Record<string, number>
  /** Optional: pre-computed dial impacts (external scorer) */
  dial_impacts?: Partial<Record<DAMPDialId, number>>
}

// ---------------------------------------------------------------------------
// Accumulator Configuration
// ---------------------------------------------------------------------------

export interface AccumulatorConfig {
  /** Whether accumulation is enabled (default true) */
  enabled?: boolean
  /** Maximum queue depth before dropping (default 1000) */
  maxQueueDepth?: number
  /** Optional RoutingQualityStore for emitting quality feedback events (Sprint 3, T3.2) */
  qualityStore?: RoutingQualityStore | null
}

const DEFAULT_MAX_QUEUE_DEPTH = 1000

// ---------------------------------------------------------------------------
// Accumulation Result
// ---------------------------------------------------------------------------

export interface AccumulationResult {
  /** Whether the interaction was successfully queued/processed */
  accepted: boolean
  /** Reason for rejection if not accepted */
  rejection_reason?: "disabled" | "queue_full" | "missing_personality_id"
  /** Whether an epoch was triggered by this interaction */
  epoch_triggered: boolean
}

// ---------------------------------------------------------------------------
// Experience Accumulator
// ---------------------------------------------------------------------------

/**
 * Feeds CompletionResult metadata into the ExperienceEngine.
 *
 * Design principles:
 * - Async, fire-and-forget: accumulation never blocks the response path
 * - No content storage: only metadata signals are extracted
 * - No user identifiers: keyed by personality_id only
 * - Graceful degradation: errors are swallowed, never propagated to caller
 */
export class ExperienceAccumulator {
  private readonly engine: ExperienceEngine
  private readonly qualityStore: RoutingQualityStore | null
  private readonly enabled: boolean
  private readonly maxQueueDepth: number
  private queueDepth = 0

  constructor(engine: ExperienceEngine, config: AccumulatorConfig = {}) {
    this.engine = engine
    this.qualityStore = config.qualityStore ?? null
    this.enabled = config.enabled ?? true
    this.maxQueueDepth = config.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
  }

  /**
   * Accumulate experience from a completion result.
   *
   * This is the primary entry point for the feedback loop.
   * Called after each successful completion, asynchronously.
   *
   * When a RoutingQualityStore is configured and routingContext is provided,
   * also emits a RoutingQualityEvent (fire-and-forget, MUST NOT block response).
   *
   * @param personalityId - Personality ID (collection:tokenId)
   * @param metadata - Extracted completion metadata (NO content)
   * @param routingContext - Optional routing context for quality feedback (Sprint 3, T3.2)
   * @returns AccumulationResult indicating acceptance and epoch status
   */
  async accumulate(
    personalityId: string,
    metadata: CompletionMetadata,
    routingContext?: { pool_id: string; task_type: string; safety_pass?: boolean },
  ): Promise<AccumulationResult> {
    // Gate: disabled
    if (!this.enabled) {
      return { accepted: false, rejection_reason: "disabled", epoch_triggered: false }
    }

    // Gate: missing personality ID
    if (!personalityId || personalityId.trim() === "") {
      return { accepted: false, rejection_reason: "missing_personality_id", epoch_triggered: false }
    }

    // Gate: queue depth (backpressure)
    if (this.queueDepth >= this.maxQueueDepth) {
      return { accepted: false, rejection_reason: "queue_full", epoch_triggered: false }
    }

    this.queueDepth++

    try {
      // Extract interaction aggregate from metadata (NO content)
      const aggregate = extractAggregate(metadata)

      // Feed into engine (synchronous — engine handles epoch trigger)
      const { epochTriggered } = this.engine.recordInteraction(personalityId, aggregate)

      // Emit routing quality event (fire-and-forget, Sprint 3 T3.2)
      if (this.qualityStore && routingContext) {
        const qualityEvent: RoutingQualityEvent = {
          personality_id: personalityId,
          pool_id: routingContext.pool_id,
          model: metadata.model,
          task_type: routingContext.task_type,
          latency_ms: metadata.latency_ms,
          tokens_used: metadata.usage.prompt_tokens + metadata.usage.completion_tokens,
          quality_signals: {
            safety_pass: routingContext.safety_pass ?? true,
          },
        }
        // Fire-and-forget — quality emission MUST NOT block response path
        this.qualityStore.recordQuality(qualityEvent, `acc-${personalityId}-${Date.now()}`).catch(() => {
          // Swallowed — quality emission is best-effort
        })
      }

      return { accepted: true, epoch_triggered: epochTriggered }
    } catch {
      // Swallow errors — accumulation is best-effort
      return { accepted: true, epoch_triggered: false }
    } finally {
      this.queueDepth--
    }
  }

  /**
   * Get current queue depth (for monitoring).
   */
  getQueueDepth(): number {
    return this.queueDepth
  }

  /**
   * Check if accumulation is enabled.
   */
  isEnabled(): boolean {
    return this.enabled
  }
}

// ---------------------------------------------------------------------------
// Metadata → InteractionAggregate Extraction
// ---------------------------------------------------------------------------

/**
 * Extract an InteractionAggregate from CompletionMetadata.
 *
 * Privacy: This function ONLY reads metadata fields.
 * No message content is accessed, stored, or logged.
 *
 * @param metadata - Completion metadata
 * @returns InteractionAggregate for the experience engine
 */
export function extractAggregate(metadata: CompletionMetadata): InteractionAggregate {
  return {
    timestamp: new Date().toISOString(),
    topic_frequencies: metadata.detected_topics ?? {},
    style_counts: metadata.detected_styles ?? {},
    metaphor_families: metadata.detected_metaphors ?? {},
    dial_impacts: metadata.dial_impacts ?? deriveDefaultDialImpacts(metadata),
  }
}

/**
 * Derive default dial impacts from basic completion metadata.
 *
 * This is a heuristic fallback when no external classifier provides
 * pre-computed dial impacts. Uses token usage and latency as weak signals.
 *
 * The impacts are intentionally small (order of 0.0001-0.001) so that
 * individual interactions have minimal effect — drift emerges from
 * sustained patterns over many interactions.
 */
function deriveDefaultDialImpacts(
  metadata: CompletionMetadata,
): Partial<Record<DAMPDialId, number>> {
  const impacts: Partial<Record<DAMPDialId, number>> = {}

  // Token ratio as a weak signal for verbosity
  const totalTokens = metadata.usage.prompt_tokens + metadata.usage.completion_tokens
  if (totalTokens > 0) {
    const completionRatio = metadata.usage.completion_tokens / totalTokens
    // Higher completion ratio → slight push toward verbosity
    if (completionRatio > 0.6) {
      impacts.cs_verbosity = 0.0002
    } else if (completionRatio < 0.3) {
      impacts.cs_verbosity = -0.0001
    }
  }

  // Reasoning tokens as a signal for analytical thinking
  if (metadata.usage.reasoning_tokens > 0) {
    impacts.cg_analytical_intuitive = 0.0001
    impacts.cg_metacognition = 0.0001
  }

  return impacts
}
