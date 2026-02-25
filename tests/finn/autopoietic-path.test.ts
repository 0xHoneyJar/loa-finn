// tests/finn/autopoietic-path.test.ts — Integration test: quality signal → observation → routing (Sprint 6 T-6.5)
//
// End-to-end test documenting the 6-stage autopoietic path:
//   Stage 1: Quality signal (QualityGateScorer.scoreToObservation)
//   Stage 2: Reputation event (mock — dixie integration out of scope)
//   Stage 3: Reputation store (mock — dixie integration out of scope)
//   Stage 4: Tier resolution with reputation query (resolvePoolWithReputation)
//   Stage 5: Model selection (pool → model mapping via PoolRegistry)
//   Stage 6: Quality measurement (observation conforms to QualityObservationSchema)

import { describe, it, expect, vi } from "vitest"
import { Value } from "@sinclair/typebox/value"
import "../../src/hounfour/typebox-formats.js"
import { QualityObservationSchema } from "@0xhoneyjar/loa-hounfour/governance"
import { QualityGateScorer } from "../../src/hounfour/quality-gate-scorer.js"
import { resolvePoolWithReputation } from "../../src/hounfour/tier-bridge.js"
import { PoolRegistry, DEFAULT_POOLS } from "../../src/hounfour/pool-registry.js"
import type { ReputationQueryFn } from "../../src/hounfour/types.js"
import type { QualityMetricsCollector } from "../../src/hounfour/metrics.js"

describe("Autopoietic path integration (T-6.5)", () => {
  it("quality signal → observation → routing path", async () => {
    // --- Stage 1: Quality signal (QualityGateScorer produces observation) ---
    const metrics: QualityMetricsCollector = {
      qualityObservationProduced: vi.fn(),
      qualityGateFailure: vi.fn(),
    }

    const scorer = new QualityGateScorer({
      gateScriptPath: "/nonexistent/quality-gates.sh", // Will fail → score 0.0
      metrics,
    })

    const mockResult = {
      content: "quality test content",
      thinking: null,
      tool_calls: null,
      usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0 },
      metadata: { model: "test-model", latency_ms: 500, trace_id: "trace-001" },
    }

    const observation = await scorer.scoreToObservation(mockResult, {
      coherence: 0.95,
      accuracy: 0.88,
    })

    // --- Stage 6: Quality measurement (observation conforms to schema) ---
    expect(Value.Check(QualityObservationSchema, observation)).toBe(true)
    expect(observation.evaluated_by).toBe("quality-gate-scorer")
    expect(observation.dimensions).toEqual({ coherence: 0.95, accuracy: 0.88 })
    expect(metrics.qualityObservationProduced).toHaveBeenCalledOnce()

    // --- Stages 2-3: Reputation event → store (mocked) ---
    // In production, the observation feeds into dixie's reputation event pipeline.
    // Here we mock the reputation store that would aggregate observation scores
    // into per-pool reputation scores.
    const mockReputationStore: Record<string, number> = {
      "cheap": 0.3,
      "fast-code": 0.85,
      "reviewer": 0.7,
      "reasoning": 0.92,
      "architect": 0.6,
    }

    // --- Stage 4: Tier resolution with reputation query ---
    const reputationQuery: ReputationQueryFn = async (poolId) => {
      return mockReputationStore[poolId] ?? null
    }

    const selectedPool = await resolvePoolWithReputation(
      "enterprise",
      "analysis",
      undefined,
      reputationQuery,
    )

    // Enterprise has access to all pools; reasoning has highest reputation (0.92)
    expect(selectedPool).toBe("reasoning")

    // --- Stage 5: Model selection (pool → model via registry) ---
    const registry = new PoolRegistry(DEFAULT_POOLS)
    const pool = registry.resolve(selectedPool)
    expect(pool).not.toBeNull()
    expect(pool!.id).toBe("reasoning")
    // The pool maps to a specific model — verify the pool exists and has model info
    expect(pool!.model).toBeTruthy()
    expect(pool!.provider).toBeTruthy()
  })

  it("degraded path: all reputation queries return null → falls back to tier default", async () => {
    // Simulate reputation service outage — all queries return null
    const reputationQuery: ReputationQueryFn = async () => null

    const selectedPool = await resolvePoolWithReputation(
      "pro",
      "code_review",
      undefined,
      reputationQuery,
    )

    // Falls back to pro tier default
    expect(selectedPool).toBe("fast-code")
  })

  it("degraded path: no reputation query → existing resolution order", async () => {
    // No reputation query at all — pure tier-based resolution
    const selectedPool = await resolvePoolWithReputation("enterprise", "analysis")
    // Enterprise default pool (no NFT preferences, no reputation)
    expect(selectedPool).toBe("reviewer")
  })
})
