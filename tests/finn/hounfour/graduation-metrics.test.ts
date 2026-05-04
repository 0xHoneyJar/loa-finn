// tests/finn/hounfour/graduation-metrics.test.ts — Graduation Metrics tests (cycle-035 T-2.8)

import { describe, it, expect, beforeEach } from "vitest"
import { GraduationMetrics } from "../../../src/hounfour/graduation-metrics.js"

let metrics: GraduationMetrics

beforeEach(() => {
  metrics = new GraduationMetrics()
})

describe("GraduationMetrics", () => {
  describe("counters", () => {
    it("increments shadow total by tier", () => {
      metrics.recordShadowDecision("alpha", false)
      metrics.recordShadowDecision("alpha", false)
      metrics.recordShadowDecision("beta", true)

      expect(metrics.shadowTotal.get({ tier: "alpha" })).toBe(2)
      expect(metrics.shadowTotal.get({ tier: "beta" })).toBe(1)
    })

    it("increments shadow diverged only when diverged", () => {
      metrics.recordShadowDecision("alpha", false)
      metrics.recordShadowDecision("alpha", true)
      metrics.recordShadowDecision("alpha", true)

      expect(metrics.shadowDiverged.get({ tier: "alpha" })).toBe(2)
    })

    it("increments reputation query total by status", () => {
      metrics.recordReputationQuery(50, "success")
      metrics.recordReputationQuery(100, "success")
      metrics.recordReputationQuery(350, "timeout")

      expect(metrics.reputationQueryTotal.get({ status: "success" })).toBe(2)
      expect(metrics.reputationQueryTotal.get({ status: "timeout" })).toBe(1)
    })

    it("increments exploration total", () => {
      metrics.recordExploration("alpha")
      metrics.recordExploration("alpha")
      metrics.recordExploration("beta")

      expect(metrics.explorationTotal.get({ tier: "alpha" })).toBe(2)
      expect(metrics.explorationTotal.get({ tier: "beta" })).toBe(1)
    })

    it("increments EMA updates", () => {
      metrics.recordEMAUpdate()
      metrics.recordEMAUpdate()
      metrics.recordEMAUpdate()

      expect(metrics.emaUpdatesTotal.get()).toBe(3)
    })

    it("tracks mode transitions", () => {
      metrics.recordModeTransition("shadow", "enabled")
      metrics.recordModeTransition("enabled", "disabled")
      metrics.recordModeTransition("disabled", "shadow")

      expect(metrics.routingModeTransitionsTotal.get({ from: "shadow", to: "enabled" })).toBe(1)
      expect(metrics.routingModeTransitionsTotal.get({ from: "enabled", to: "disabled" })).toBe(1)
    })
  })

  describe("histogram", () => {
    it("records reputation query latency in seconds", () => {
      metrics.recordReputationQuery(50, "success")   // 0.05s
      metrics.recordReputationQuery(150, "success")  // 0.15s
      metrics.recordReputationQuery(350, "timeout")  // 0.35s

      const successBuckets = metrics.reputationQueryDuration.getBuckets({ status: "success" })
      expect(successBuckets).toBeDefined()
      expect(successBuckets!.count).toBe(2)
      expect(successBuckets!.sum).toBeCloseTo(0.2) // 0.05 + 0.15

      const timeoutBuckets = metrics.reputationQueryDuration.getBuckets({ status: "timeout" })
      expect(timeoutBuckets).toBeDefined()
      expect(timeoutBuckets!.count).toBe(1)
    })

    it("histogram buckets are not double-accumulated (C-1 fix)", () => {
      // Boundaries for routing duration: [0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5]
      // Observe 3 values: 0.003s, 0.008s, 0.15s
      metrics.recordRoutingDuration("shadow", 3)    // 0.003s → le=0.005 bucket
      metrics.recordRoutingDuration("shadow", 8)    // 0.008s → le=0.01 bucket
      metrics.recordRoutingDuration("shadow", 150)  // 0.15s  → le=0.2 bucket

      const buckets = metrics.routingDuration.getBuckets({ path: "shadow" })
      expect(buckets).toBeDefined()
      expect(buckets!.count).toBe(3)

      // Verify per-bucket (non-cumulative) counts:
      // le=0.001: 0 (nothing <= 0.001)
      // le=0.005: 1 (0.003)
      // le=0.01:  1 (0.008)
      // le=0.05:  0
      // le=0.1:   0
      // le=0.2:   1 (0.15)
      // le=0.5:   0
      // +Inf:     3
      expect(buckets!.counts[0]).toBe(0)  // le=0.001
      expect(buckets!.counts[1]).toBe(1)  // le=0.005 (0.003 placed here)
      expect(buckets!.counts[2]).toBe(1)  // le=0.01 (0.008 placed here)
      expect(buckets!.counts[3]).toBe(0)  // le=0.05
      expect(buckets!.counts[4]).toBe(0)  // le=0.1
      expect(buckets!.counts[5]).toBe(1)  // le=0.2 (0.15 placed here)
      expect(buckets!.counts[6]).toBe(0)  // le=0.5
      expect(buckets!.counts[7]).toBe(3)  // +Inf (always == count)

      // Verify Prometheus output has correct cumulative values
      const output = metrics.toPrometheus()
      // Cumulative: le=0.001→0, le=0.005→1, le=0.01→2, le=0.05→2, le=0.1→2, le=0.2→3, le=0.5→3, +Inf→3
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.001"} 0')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.005"} 1')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.01"} 2')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.05"} 2')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.1"} 2')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.2"} 3')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="0.5"} 3')
      expect(output).toContain('finn_routing_duration_seconds_bucket{path="shadow",le="+Inf"} 3')
    })
  })

  describe("Prometheus export", () => {
    it("produces valid Prometheus text format", () => {
      metrics.recordShadowDecision("alpha", true)
      metrics.recordReputationQuery(100, "success")

      const output = metrics.toPrometheus()

      expect(output).toContain("# HELP finn_shadow_total")
      expect(output).toContain("# TYPE finn_shadow_total counter")
      expect(output).toContain('finn_shadow_total{tier="alpha"} 1')
      expect(output).toContain("# HELP finn_shadow_diverged")
      expect(output).toContain('finn_shadow_diverged{tier="alpha"} 1')
      expect(output).toContain("# TYPE finn_reputation_query_duration_seconds histogram")
      expect(output).toContain("finn_reputation_query_duration_seconds_bucket")
      expect(output).toContain('le="+Inf"')
    })

    it("exports all metric families", () => {
      const output = metrics.toPrometheus()

      expect(output).toContain("finn_shadow_total")
      expect(output).toContain("finn_shadow_diverged")
      expect(output).toContain("finn_reputation_query_total")
      expect(output).toContain("finn_reputation_query_duration_seconds")
      expect(output).toContain("finn_exploration_total")
      expect(output).toContain("finn_ema_updates_total")
      expect(output).toContain("finn_routing_mode_transitions_total")
    })
  })

  describe("reset", () => {
    it("clears all counters and histograms", () => {
      metrics.recordShadowDecision("alpha", true)
      metrics.recordReputationQuery(100, "success")
      metrics.recordExploration("alpha")
      metrics.recordEMAUpdate()
      metrics.recordModeTransition("shadow", "enabled")

      metrics.reset()

      expect(metrics.shadowTotal.get({ tier: "alpha" })).toBe(0)
      expect(metrics.shadowDiverged.get({ tier: "alpha" })).toBe(0)
      expect(metrics.reputationQueryTotal.get({ status: "success" })).toBe(0)
      expect(metrics.explorationTotal.get({ tier: "alpha" })).toBe(0)
      expect(metrics.emaUpdatesTotal.get()).toBe(0)
    })
  })

  describe("label cardinality", () => {
    it("uses fixed label sets (no nftId/poolId)", () => {
      // Record many different "tiers" — but labels are tier/status only
      for (let i = 0; i < 10; i++) {
        metrics.recordShadowDecision("alpha", false)
        metrics.recordShadowDecision("beta", false)
      }

      const output = metrics.toPrometheus()
      // Only 2 label combinations for shadow_total (alpha, beta)
      const shadowLines = output.split("\n").filter(l => l.startsWith("finn_shadow_total{"))
      expect(shadowLines.length).toBe(2)
    })
  })
})
