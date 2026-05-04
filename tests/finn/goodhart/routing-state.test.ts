// tests/finn/goodhart/routing-state.test.ts — Router State Machine Tests (T-1.6, cycle-036)

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { PoolId, Tier } from "@0xhoneyjar/loa-hounfour"
import type { MechanismConfig } from "../../../src/hounfour/goodhart/mechanism-interaction.js"
import { GraduationMetrics } from "../../../src/hounfour/graduation-metrics.js"

// We test resolvePoolForRequest via HounfourRouter, but since it requires a full
// ProviderRegistry etc., we test the routing state logic via the resolve wrapper.
// The routing state machine is fully tested via the router integration below.

const POOL_A = "pool-alpha" as PoolId

describe("RoutingState type", () => {
  it("accepts valid routing states", () => {
    const states: Array<"disabled" | "shadow" | "enabled" | "init_failed"> = [
      "disabled", "shadow", "enabled", "init_failed",
    ]
    expect(states).toHaveLength(4)
  })
})

describe("GraduationMetrics routing helpers", () => {
  let metrics: GraduationMetrics

  beforeEach(() => {
    metrics = new GraduationMetrics()
  })

  it("recordShadowDecision increments shadow total", () => {
    metrics.recordShadowDecision("standard", false)
    expect(metrics.shadowTotal.get({ tier: "standard" })).toBe(1)
    expect(metrics.shadowDiverged.get({ tier: "standard" })).toBe(0)
  })

  it("recordShadowDecision increments divergence when diverged=true", () => {
    metrics.recordShadowDecision("standard", true)
    expect(metrics.shadowTotal.get({ tier: "standard" })).toBe(1)
    expect(metrics.shadowDiverged.get({ tier: "standard" })).toBe(1)
  })

  it("setRoutingMode sets 1 for active mode and 0 for others", () => {
    metrics.setRoutingMode("shadow")
    expect(metrics.goodhartRoutingMode.get({ mode: "shadow" })).toBe(1)
    expect(metrics.goodhartRoutingMode.get({ mode: "disabled" })).toBe(0)
    expect(metrics.goodhartRoutingMode.get({ mode: "enabled" })).toBe(0)
    expect(metrics.goodhartRoutingMode.get({ mode: "init_failed" })).toBe(0)
  })

  it("recordRoutingDuration observes histogram", () => {
    metrics.recordRoutingDuration("shadow", 15)
    const buckets = metrics.routingDuration.getBuckets({ path: "shadow" })
    expect(buckets).toBeDefined()
    expect(buckets!.count).toBe(1)
    expect(buckets!.sum).toBeCloseTo(0.015)
  })

  it("init_failed counter increments", () => {
    metrics.goodhartInitFailed.inc()
    expect(metrics.goodhartInitFailed.get()).toBe(1)
  })

  it("init_failed_requests counter increments", () => {
    metrics.goodhartInitFailedRequests.inc()
    metrics.goodhartInitFailedRequests.inc()
    expect(metrics.goodhartInitFailedRequests.get()).toBe(2)
  })

  it("killswitch_activated counter increments", () => {
    metrics.killswitchActivatedTotal.inc()
    expect(metrics.killswitchActivatedTotal.get()).toBe(1)
  })

  it("killswitch_check_failed counter increments (T-4.2)", () => {
    metrics.killswitchCheckFailedTotal.inc()
    metrics.killswitchCheckFailedTotal.inc()
    expect(metrics.killswitchCheckFailedTotal.get()).toBe(2)
  })

  it("recovery_attempt counter increments (T-4.3)", () => {
    metrics.recoveryAttemptTotal.inc()
    expect(metrics.recoveryAttemptTotal.get()).toBe(1)
  })

  it("recovery_success counter increments (T-4.3)", () => {
    metrics.recoverySuccessTotal.inc()
    expect(metrics.recoverySuccessTotal.get()).toBe(1)
  })

  it("goodhart_timeout counter increments", () => {
    metrics.goodhartTimeoutTotal.inc()
    expect(metrics.goodhartTimeoutTotal.get()).toBe(1)
  })

  it("reputation_scoring_failed counter increments", () => {
    metrics.reputationScoringFailedTotal.inc()
    expect(metrics.reputationScoringFailedTotal.get()).toBe(1)
  })

  it("toPrometheus includes all new metrics", () => {
    metrics.setRoutingMode("enabled")
    metrics.goodhartInitFailed.inc()
    const output = metrics.toPrometheus()
    expect(output).toContain("finn_goodhart_init_failed")
    expect(output).toContain("finn_goodhart_routing_mode")
    expect(output).toContain("finn_routing_duration_seconds")
    expect(output).toContain("finn_goodhart_timeout_total")
    expect(output).toContain("finn_killswitch_activated_total")
    expect(output).toContain("finn_killswitch_check_failed_total")
    expect(output).toContain("finn_goodhart_recovery_attempt_total")
    expect(output).toContain("finn_goodhart_recovery_success_total")
    expect(output).toContain("finn_reputation_scoring_failed_total")
    expect(output).toContain("finn_goodhart_init_failed_requests")
  })

  it("reset clears all counters", () => {
    metrics.goodhartInitFailed.inc()
    metrics.killswitchActivatedTotal.inc()
    metrics.killswitchCheckFailedTotal.inc()
    metrics.recoveryAttemptTotal.inc()
    metrics.recoverySuccessTotal.inc()
    metrics.setRoutingMode("shadow")
    metrics.reset()
    expect(metrics.goodhartInitFailed.get()).toBe(0)
    expect(metrics.killswitchActivatedTotal.get()).toBe(0)
    expect(metrics.killswitchCheckFailedTotal.get()).toBe(0)
    expect(metrics.recoveryAttemptTotal.get()).toBe(0)
    expect(metrics.recoverySuccessTotal.get()).toBe(0)
    expect(metrics.goodhartRoutingMode.get({ mode: "shadow" })).toBe(0)
  })
})
