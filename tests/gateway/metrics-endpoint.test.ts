// tests/gateway/metrics-endpoint.test.ts — Prometheus Metrics Tests (Sprint 6 T6.1-T6.4)

import { describe, it, expect, beforeEach } from "vitest"
import { MetricRegistry, metrics, metricsRoutes } from "../../src/gateway/metrics-endpoint.js"

// ---------------------------------------------------------------------------
// T6.1: MetricRegistry — counters and gauges
// ---------------------------------------------------------------------------

describe("T6.1: MetricRegistry — counters", () => {
  let registry: MetricRegistry

  beforeEach(() => {
    registry = new MetricRegistry()
  })

  it("registers and increments a counter", () => {
    registry.registerCounter("test_total", "A test counter")
    registry.incrementCounter("test_total", {}, 1)
    registry.incrementCounter("test_total", {}, 2)

    const output = registry.serialize()
    expect(output).toContain("# HELP test_total A test counter")
    expect(output).toContain("# TYPE test_total counter")
    expect(output).toContain("test_total 3")
  })

  it("tracks counters with labels independently", () => {
    registry.registerCounter("http_total", "HTTP requests")
    registry.incrementCounter("http_total", { method: "GET" })
    registry.incrementCounter("http_total", { method: "POST" })
    registry.incrementCounter("http_total", { method: "GET" })

    const output = registry.serialize()
    expect(output).toContain('http_total{method="GET"} 2')
    expect(output).toContain('http_total{method="POST"} 1')
  })

  it("ignores increments to unregistered counters", () => {
    registry.incrementCounter("nonexistent", {}, 1)
    const output = registry.serialize()
    expect(output).not.toContain("nonexistent")
  })

  it("escapes label values correctly", () => {
    registry.registerCounter("test_total", "Test")
    registry.incrementCounter("test_total", { path: '/api/"test"' })

    const output = registry.serialize()
    expect(output).toContain('path="/api/\\"test\\""')
  })
})

describe("T6.1: MetricRegistry — gauges", () => {
  let registry: MetricRegistry

  beforeEach(() => {
    registry = new MetricRegistry()
  })

  it("registers and sets a gauge", () => {
    registry.registerGauge("connections", "Active connections")
    registry.setGauge("connections", {}, 42)

    const output = registry.serialize()
    expect(output).toContain("# TYPE connections gauge")
    expect(output).toContain("connections 42")
  })

  it("overwrites gauge values", () => {
    registry.registerGauge("temp", "Temperature")
    registry.setGauge("temp", {}, 100)
    registry.setGauge("temp", {}, 200)

    const output = registry.serialize()
    expect(output).toContain("temp 200")
    expect(output).not.toContain("temp 100")
  })
})

// ---------------------------------------------------------------------------
// T6.4: MetricRegistry — histograms
// ---------------------------------------------------------------------------

describe("T6.4: MetricRegistry — histograms", () => {
  let registry: MetricRegistry

  beforeEach(() => {
    registry = new MetricRegistry()
  })

  it("registers and observes histogram values", () => {
    registry.registerHistogram("duration_seconds", "Request duration", [0.1, 0.5, 1.0])
    registry.observeHistogram("duration_seconds", {}, 0.05)
    registry.observeHistogram("duration_seconds", {}, 0.3)
    registry.observeHistogram("duration_seconds", {}, 0.8)
    registry.observeHistogram("duration_seconds", {}, 2.0)

    const output = registry.serialize()
    expect(output).toContain("# TYPE duration_seconds histogram")
    expect(output).toContain('duration_seconds_bucket{le="0.1"} 1')
    expect(output).toContain('duration_seconds_bucket{le="0.5"} 2')
    expect(output).toContain('duration_seconds_bucket{le="1"} 3')
    expect(output).toContain('duration_seconds_bucket{le="+Inf"} 4')
    expect(output).toContain("duration_seconds_count{} 4")
  })

  it("computes sum correctly", () => {
    registry.registerHistogram("latency", "Latency", [1, 5, 10])
    registry.observeHistogram("latency", {}, 2.5)
    registry.observeHistogram("latency", {}, 7.5)

    const output = registry.serialize()
    expect(output).toContain("latency_sum{} 10")
    expect(output).toContain("latency_count{} 2")
  })

  it("handles histogram with labels", () => {
    registry.registerHistogram("req_duration", "Duration", [0.1, 1.0])
    registry.observeHistogram("req_duration", { route: "/api" }, 0.05)
    registry.observeHistogram("req_duration", { route: "/health" }, 0.5)

    const output = registry.serialize()
    expect(output).toContain('req_duration_bucket{route="/api",le="0.1"} 1')
    expect(output).toContain('req_duration_bucket{route="/health",le="0.1"} 0')
    expect(output).toContain('req_duration_bucket{route="/health",le="1"} 1')
  })

  it("sorts buckets regardless of registration order", () => {
    registry.registerHistogram("test", "Test", [1.0, 0.1, 0.5])
    registry.observeHistogram("test", {}, 0.3)

    const output = registry.serialize()
    const lines = output.split("\n")
    const bucketLines = lines.filter((l) => l.includes("test_bucket"))
    // Buckets should be in ascending order
    expect(bucketLines[0]).toContain('le="0.1"')
    expect(bucketLines[1]).toContain('le="0.5"')
    expect(bucketLines[2]).toContain('le="1"')
  })

  it("cumulative bucket counts are correct", () => {
    registry.registerHistogram("h", "H", [1, 5, 10])
    // All 3 observations ≤ 1
    registry.observeHistogram("h", {}, 0.5)
    registry.observeHistogram("h", {}, 0.8)
    registry.observeHistogram("h", {}, 1.0)

    const output = registry.serialize()
    // All 3 should be in the ≤1 bucket
    expect(output).toContain('h_bucket{le="1"} 3')
    // Cumulative: also 3 in ≤5 and ≤10
    expect(output).toContain('h_bucket{le="5"} 3')
    expect(output).toContain('h_bucket{le="10"} 3')
  })

  it("ignores observations on unregistered histograms", () => {
    registry.observeHistogram("missing", {}, 1.0)
    const output = registry.serialize()
    expect(output).not.toContain("missing")
  })
})

// ---------------------------------------------------------------------------
// T6.1: Bearer token auth on /metrics
// ---------------------------------------------------------------------------

describe("T6.1: metricsRoutes — auth", () => {
  it("returns 401 when token required but not provided", async () => {
    const app = metricsRoutes("secret-token")
    const res = await app.request("/")
    expect(res.status).toBe(401)
  })

  it("returns 403 when token is wrong", async () => {
    const app = metricsRoutes("secret-token")
    const res = await app.request("/", {
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(res.status).toBe(403)
  })

  it("returns 200 with correct token", async () => {
    const app = metricsRoutes("secret-token")
    const res = await app.request("/", {
      headers: { Authorization: "Bearer secret-token" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
  })

  it("returns 200 without auth when no token configured", async () => {
    const app = metricsRoutes()
    const res = await app.request("/")
    expect(res.status).toBe(200)
  })

  it("returns Prometheus text format", async () => {
    const app = metricsRoutes()
    const res = await app.request("/")
    const text = await res.text()
    // Global metrics registry has registered metrics
    expect(text).toContain("# HELP")
    expect(text).toContain("# TYPE")
  })
})

// ---------------------------------------------------------------------------
// T6.2 + T6.3: Global metrics registry has Sprint 6 metrics registered
// ---------------------------------------------------------------------------

describe("T6.2 + T6.3: Global metrics registry", () => {
  it("has conservation guard metrics registered", () => {
    const output = metrics.serialize()
    expect(output).toContain("finn_conservation_violations_total")
    expect(output).toContain("finn_conservation_checks_total")
    expect(output).toContain("finn_credits_by_state")
    expect(output).toContain("finn_escrow_balance_total")
    expect(output).toContain("finn_settlement_total")
  })

  it("has payment metrics registered", () => {
    const output = metrics.serialize()
    expect(output).toContain("finn_agent_requests_total")
    expect(output).toContain("finn_x402_verifications_total")
    expect(output).toContain("finn_rpc_requests_total")
    expect(output).toContain("finn_rate_limit_hits_total")
  })

  it("has latency histograms registered", () => {
    const output = metrics.serialize()
    expect(output).toContain("finn_request_duration_seconds")
    expect(output).toContain("finn_x402_verification_duration_seconds")
  })

  it("can increment conservation violation counter", () => {
    const before = metrics.serialize()
    metrics.incrementCounter("finn_conservation_violations_total", { invariant: "lot_sum" })
    const after = metrics.serialize()
    expect(after).toContain('finn_conservation_violations_total{invariant="lot_sum"} 1')
  })

  it("can record agent request with archetype + payment_method labels", () => {
    metrics.incrementCounter("finn_agent_requests_total", {
      archetype: "freetekno",
      payment_method: "x402",
    })
    const output = metrics.serialize()
    expect(output).toContain('archetype="freetekno"')
    expect(output).toContain('payment_method="x402"')
  })

  it("can observe request duration histogram", () => {
    metrics.observeHistogram("finn_request_duration_seconds", { route: "/api/v1/invoke", method: "POST" }, 0.15)
    const output = metrics.serialize()
    expect(output).toContain("finn_request_duration_seconds_bucket")
    expect(output).toContain("finn_request_duration_seconds_sum")
    expect(output).toContain("finn_request_duration_seconds_count")
  })

  it("enforces no high-cardinality labels (no wallet/tokenId/txHash/path)", () => {
    // This is a design constraint test — verify the registered metric names
    // don't include user-controlled label patterns
    const output = metrics.serialize()
    // These should NOT appear as label keys in any registered metric
    expect(output).not.toContain('wallet="')
    expect(output).not.toContain('token_id="')
    expect(output).not.toContain('tx_hash="')
  })
})
