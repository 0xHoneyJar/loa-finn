// tests/finn/hounfour/graduation-evaluation.test.ts — Graduation Evaluation Unit Tests (T-4.4)
//
// Tests all 8 graduation thresholds with mock Prometheus + Redis responses.
// Uses vi.stubGlobal("fetch") to intercept Prometheus HTTP calls.
// Uses redis-mock for EMA and calibration key checks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { evaluateGraduation } from "../../../scripts/evaluate-graduation.js"

// ---------------------------------------------------------------------------
// Prometheus Mock
// ---------------------------------------------------------------------------

type PromResponse = {
  status: string
  data: {
    resultType: string
    result: Array<{ value: [number, string] }>
  }
}

function promSuccessResponse(value: number): PromResponse {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: [{ value: [Date.now() / 1000, String(value)] }],
    },
  }
}

function promEmptyResponse(): PromResponse {
  return {
    status: "success",
    data: { resultType: "vector", result: [] },
  }
}

/**
 * Create a mock fetch that routes Prometheus queries to handlers.
 * Query matching is substring-based for simplicity.
 */
function createPrometheusMock(handlers: Record<string, number | null>) {
  return async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    const query = parsed.searchParams.get("query") ?? ""

    // Check handlers by substring match
    for (const [pattern, value] of Object.entries(handlers)) {
      if (query.includes(pattern)) {
        if (value === null) {
          return new Response(JSON.stringify(promEmptyResponse()), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify(promSuccessResponse(value)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
    }

    // Default: empty result
    return new Response(JSON.stringify(promEmptyResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
}

// ---------------------------------------------------------------------------
// Redis Mock (vi.mock for the redis module)
// ---------------------------------------------------------------------------

// Store for mock Redis data
let mockRedisStore: Map<string, string>

vi.mock("redis", () => {
  return {
    createClient: () => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation(async (key: string) => {
        return mockRedisStore.get(key) ?? null
      }),
      scanIterator: vi.fn().mockImplementation(function* (opts: { MATCH: string }) {
        const pattern = opts.MATCH.replace("*", "")
        for (const key of mockRedisStore.keys()) {
          if (key.startsWith(pattern)) {
            yield key
          }
        }
      }),
    }),
  }
})

// ---------------------------------------------------------------------------
// Test Config
// ---------------------------------------------------------------------------

const baseConfig = {
  prometheusUrl: "http://mock-prometheus:9090",
  prometheusJobName: "finn",
  redisUrl: "redis://mock-redis:6379",
  adminEndpoint: "http://mock-admin:3000/admin",
  evaluationWindowHours: 72,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Graduation Evaluation", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockRedisStore = new Map()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe("Smoke Query (Prometheus connectivity)", () => {
    it("returns INSUFFICIENT_DATA when Prometheus is down", async () => {
      vi.stubGlobal("fetch", async () => {
        return new Response("", { status: 503 })
      })

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("INSUFFICIENT_DATA")
      expect(result.results).toHaveLength(1)
      expect(result.results[0].id).toBe("SMOKE")
    })

    it("returns INSUFFICIENT_DATA when up{job} returns 0", async () => {
      vi.stubGlobal("fetch", createPrometheusMock({
        'up{job="finn"}': 0,
      }))

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("INSUFFICIENT_DATA")
      expect(result.results[0].id).toBe("SMOKE")
    })
  })

  describe("All thresholds PASS → GRADUATE", () => {
    it("returns GRADUATE when all 8 thresholds pass", async () => {
      // Mock Prometheus responses for all thresholds
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        // Admin endpoint check (T7)
        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        // Prometheus queries
        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20, // 2% < 5% → PASS
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000, // 98% > 95% → PASS
          "finn_reputation_query_duration_seconds_bucket": 0.3, // 300ms < 500ms → PASS
          "finn_exploration_total": 50, // 5% → PASS (1-10%)
          "finn_ema_updates_total": 100, // > 0 → PASS
        })(input, init)
      })

      // Mock Redis EMA keys for T5
      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0.85, count: 10 }))
      mockRedisStore.set("ema:pool1:key2", JSON.stringify({ value: 0.82, count: 8 }))
      mockRedisStore.set("ema:pool2:key1", JSON.stringify({ value: 0.88, count: 12 }))

      // Mock Redis calibration freshness for T8
      mockRedisStore.set("calibration:last_refresh_ts", new Date().toISOString())

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("GRADUATE")
      expect(result.results).toHaveLength(8)

      for (const r of result.results) {
        expect(r.status).toBe("PASS")
      }
    })
  })

  describe("Individual threshold failures → NOT_READY", () => {
    // Helper: all-passing Prometheus with one override
    function setupAllPassingExcept(overrides: Record<string, number | null>) {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
          ...overrides,
        })(input, init)
      })

      // Default Redis data
      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0.85, count: 10 }))
      mockRedisStore.set("ema:pool1:key2", JSON.stringify({ value: 0.82, count: 8 }))
      mockRedisStore.set("calibration:last_refresh_ts", new Date().toISOString())
    }

    it("T1 FAIL: shadow divergence > 5%", async () => {
      setupAllPassingExcept({
        "finn_shadow_diverged": 100, // 10% > 5%
      })

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("NOT_READY")
      const t1 = result.results.find(r => r.id === "T1")
      expect(t1?.status).toBe("FAIL")
    })

    it("T2 FAIL: reputation success < 95%", async () => {
      setupAllPassingExcept({
        'finn_reputation_query_total{status="success"}': 900, // 90% < 95%
      })

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("NOT_READY")
      const t2 = result.results.find(r => r.id === "T2")
      expect(t2?.status).toBe("FAIL")
    })

    it("T3 FAIL: P99 latency > 500ms", async () => {
      setupAllPassingExcept({
        "finn_reputation_query_duration_seconds_bucket": 0.8, // 800ms > 500ms
      })

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("NOT_READY")
      const t3 = result.results.find(r => r.id === "T3")
      expect(t3?.status).toBe("FAIL")
    })

    it("T4 FAIL: exploration rate outside 1-10%", async () => {
      setupAllPassingExcept({
        "finn_exploration_total": 200, // 200/(1000+200) = 16.7% > 10%
      })

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("NOT_READY")
      const t4 = result.results.find(r => r.id === "T4")
      expect(t4?.status).toBe("FAIL")
    })

    it("T6 FAIL: no EMA updates", async () => {
      setupAllPassingExcept({
        "finn_ema_updates_total": 0,
      })

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("NOT_READY")
      const t6 = result.results.find(r => r.id === "T6")
      expect(t6?.status).toBe("FAIL")
    })

    it("T7 FAIL: admin endpoint returns non-200", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response("", { status: 503 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
        })(input, init)
      })

      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0.85, count: 10 }))
      mockRedisStore.set("ema:pool1:key2", JSON.stringify({ value: 0.82, count: 8 }))
      mockRedisStore.set("calibration:last_refresh_ts", new Date().toISOString())

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("NOT_READY")
      const t7 = result.results.find(r => r.id === "T7")
      expect(t7?.status).toBe("FAIL")
    })
  })

  describe("INSUFFICIENT_DATA handling", () => {
    it("returns INSUFFICIENT_DATA when no shadow data", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          // All queries return empty → INSUFFICIENT_DATA for T1-T4, T6
        })(input, init)
      })

      // No Redis data → INSUFFICIENT_DATA for T5, T8

      const result = await evaluateGraduation(baseConfig)
      expect(result.verdict).toBe("INSUFFICIENT_DATA")

      const insufficientIds = result.results
        .filter(r => r.status === "INSUFFICIENT_DATA")
        .map(r => r.id)
      expect(insufficientIds).toContain("T1")
    })

    it("T5 INSUFFICIENT_DATA when no EMA keys in Redis", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
        })(input, init)
      })

      // No EMA keys → T5 INSUFFICIENT_DATA
      mockRedisStore.set("calibration:last_refresh_ts", new Date().toISOString())

      const result = await evaluateGraduation(baseConfig)
      const t5 = result.results.find(r => r.id === "T5")
      expect(t5?.status).toBe("INSUFFICIENT_DATA")
    })

    it("T8 INSUFFICIENT_DATA when no calibration key", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
        })(input, init)
      })

      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0.85, count: 10 }))
      mockRedisStore.set("ema:pool1:key2", JSON.stringify({ value: 0.82, count: 8 }))
      // No calibration key → T8 INSUFFICIENT_DATA

      const result = await evaluateGraduation(baseConfig)
      const t8 = result.results.find(r => r.id === "T8")
      expect(t8?.status).toBe("INSUFFICIENT_DATA")
    })

    it("T8 FAIL when calibration is stale (>24h)", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
        })(input, init)
      })

      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0.85, count: 10 }))
      mockRedisStore.set("ema:pool1:key2", JSON.stringify({ value: 0.82, count: 8 }))

      // Stale calibration: 48h ago
      const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      mockRedisStore.set("calibration:last_refresh_ts", staleDate)

      const result = await evaluateGraduation(baseConfig)
      const t8 = result.results.find(r => r.id === "T8")
      expect(t8?.status).toBe("FAIL")
    })
  })

  describe("T5 EMA Stability (CV) edge cases", () => {
    it("FAIL when mean EMA is 0", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
        })(input, init)
      })

      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0, count: 10 }))
      mockRedisStore.set("ema:pool1:key2", JSON.stringify({ value: 0, count: 8 }))
      mockRedisStore.set("calibration:last_refresh_ts", new Date().toISOString())

      const result = await evaluateGraduation(baseConfig)
      const t5 = result.results.find(r => r.id === "T5")
      expect(t5?.status).toBe("FAIL")
      expect(t5?.value).toBe(Infinity)
    })

    it("INSUFFICIENT_DATA when only 1 EMA key", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

        if (url.includes("mock-admin")) {
          return new Response(JSON.stringify({ mode: "shadow" }), { status: 200 })
        }

        return createPrometheusMock({
          'up{job="finn"}': 1,
          "finn_shadow_total": 1000,
          "finn_shadow_diverged": 20,
          'finn_reputation_query_total{status="success"}': 980,
          "finn_reputation_query_total": 1000,
          "finn_reputation_query_duration_seconds_bucket": 0.3,
          "finn_exploration_total": 50,
          "finn_ema_updates_total": 100,
        })(input, init)
      })

      mockRedisStore.set("ema:pool1:key1", JSON.stringify({ value: 0.85, count: 10 }))
      // Only 1 key → need ≥ 2
      mockRedisStore.set("calibration:last_refresh_ts", new Date().toISOString())

      const result = await evaluateGraduation(baseConfig)
      const t5 = result.results.find(r => r.id === "T5")
      expect(t5?.status).toBe("INSUFFICIENT_DATA")
    })
  })

  describe("Verdict logic", () => {
    it("timestamp is ISO 8601", async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status: 503 }))
      const result = await evaluateGraduation(baseConfig)
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })
})
