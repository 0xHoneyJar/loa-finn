// tests/finn/routing-matrix.test.ts — Native vs Remote Decision Matrix (Task 3.4)
// Config-driven routing, health-based fallback, prefer_native mode.

import { describe, it, expect } from "vitest"
import {
  RoutingMatrix,
  type PoolRouteConfig,
} from "../../src/hounfour/routing-matrix.js"
import type {
  ModelPortBase,
  CompletionRequest,
  CompletionResult,
  ModelCapabilities,
  HealthStatus,
} from "../../src/hounfour/types.js"

// --- Mock Adapters ---

function createMockAdapter(opts: {
  healthy?: boolean
  name?: string
  healthDelayMs?: number
} = {}): ModelPortBase {
  const { healthy = true, name = "mock", healthDelayMs = 0 } = opts
  return {
    capabilities(): ModelCapabilities {
      return { streaming: false, tools: true, thinking: false, maxContextTokens: 128000, maxOutputTokens: 4096 }
    },
    async healthCheck(): Promise<HealthStatus> {
      if (healthDelayMs > 0) await new Promise(r => setTimeout(r, healthDelayMs))
      return { healthy, latency_ms: healthDelayMs || 1 }
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      return {
        content: `response from ${name}`,
        thinking: null,
        tool_calls: null,
        usage: { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
        metadata: { model: name },
      }
    },
  }
}

// --- Tests ---

describe("RoutingMatrix", () => {
  describe("mode=remote", () => {
    it("always routes to remote adapter", async () => {
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "gpt-4o", mode: "remote", remote }],
      })

      const decision = await matrix.route("gpt-4o")

      expect(decision.source).toBe("remote")
      expect(decision.fallback).toBe(false)
      expect(decision.adapter).toBe(remote)
    })
  })

  describe("mode=native", () => {
    it("routes to native adapter when present", async () => {
      const native = createMockAdapter({ name: "native" })
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "native", native, remote }],
      })

      const decision = await matrix.route("qwen-7b")

      expect(decision.source).toBe("native")
      expect(decision.fallback).toBe(false)
      expect(decision.adapter).toBe(native)
    })

    it("throws when native not configured", async () => {
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "native", remote }],
      })

      await expect(matrix.route("qwen-7b")).rejects.toThrow("no native adapter")
    })
  })

  describe("mode=prefer_native", () => {
    it("uses native when healthy", async () => {
      const native = createMockAdapter({ name: "native", healthy: true })
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "prefer_native", native, remote }],
      })

      const decision = await matrix.route("qwen-7b")

      expect(decision.source).toBe("native")
      expect(decision.fallback).toBe(false)
    })

    it("falls back to remote when native unhealthy", async () => {
      const native = createMockAdapter({ name: "native", healthy: false })
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "prefer_native", native, remote }],
      })

      const decision = await matrix.route("qwen-7b")

      expect(decision.source).toBe("remote")
      expect(decision.fallback).toBe(true)
    })

    it("falls back to remote when native missing", async () => {
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "prefer_native", remote }],
      })

      const decision = await matrix.route("qwen-7b")

      expect(decision.source).toBe("remote")
      expect(decision.fallback).toBe(true)
    })

    it("falls back on health check timeout", async () => {
      const native = createMockAdapter({ name: "native", healthy: true, healthDelayMs: 500 })
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "prefer_native", native, remote }],
        healthCheckTimeoutMs: 50, // Timeout before health check completes
      })

      const decision = await matrix.route("qwen-7b")

      expect(decision.source).toBe("remote")
      expect(decision.fallback).toBe(true)
    })
  })

  describe("pool management", () => {
    it("throws on unknown pool", async () => {
      const matrix = new RoutingMatrix({ pools: [] })
      await expect(matrix.route("unknown")).rejects.toThrow('unknown pool "unknown"')
    })

    it("lists all configured pools", () => {
      const remote = createMockAdapter()
      const matrix = new RoutingMatrix({
        pools: [
          { pool: "gpt-4o", mode: "remote", remote },
          { pool: "qwen-7b", mode: "native", native: createMockAdapter(), remote },
        ],
      })

      expect(matrix.pools()).toEqual(["gpt-4o", "qwen-7b"])
    })

    it("returns pool config", () => {
      const remote = createMockAdapter()
      const matrix = new RoutingMatrix({
        pools: [{ pool: "gpt-4o", mode: "remote", remote }],
      })

      const config = matrix.getConfig("gpt-4o")
      expect(config?.mode).toBe("remote")
    })
  })

  describe("health cache", () => {
    it("caches health check results (5s TTL)", async () => {
      let callCount = 0
      const native: ModelPortBase = {
        ...createMockAdapter({ name: "native", healthy: true }),
        async healthCheck() {
          callCount++
          return { healthy: true, latency_ms: 1 }
        },
      }
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "prefer_native", native, remote }],
      })

      await matrix.route("qwen-7b")
      await matrix.route("qwen-7b")
      await matrix.route("qwen-7b")

      // Only 1 health check despite 3 route calls (cached)
      expect(callCount).toBe(1)
    })

    it("invalidateHealth forces re-check", async () => {
      let callCount = 0
      const native: ModelPortBase = {
        ...createMockAdapter({ name: "native", healthy: true }),
        async healthCheck() {
          callCount++
          return { healthy: true, latency_ms: 1 }
        },
      }
      const remote = createMockAdapter({ name: "remote" })
      const matrix = new RoutingMatrix({
        pools: [{ pool: "qwen-7b", mode: "prefer_native", native, remote }],
      })

      await matrix.route("qwen-7b")
      matrix.invalidateHealth("qwen-7b")
      await matrix.route("qwen-7b")

      expect(callCount).toBe(2)
    })
  })
})
