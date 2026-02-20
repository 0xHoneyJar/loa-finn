// src/gateway/metrics-endpoint.ts — Prometheus Metrics Endpoint (Sprint 6 T6.1)
//
// Serves /metrics in Prometheus exposition format.
// Counters, gauges, and histograms.
// Requires Bearer token auth in production (SDD §4.7).

import { Hono } from "hono"

// ---------------------------------------------------------------------------
// Histogram Buckets
// ---------------------------------------------------------------------------

/** Standard HTTP latency buckets in seconds */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

// ---------------------------------------------------------------------------
// Metric Types
// ---------------------------------------------------------------------------

interface CounterMetric {
  name: string
  help: string
  labels: Map<string, number>
}

interface GaugeMetric {
  name: string
  help: string
  labels: Map<string, number>
}

interface HistogramMetric {
  name: string
  help: string
  buckets: number[]
  /** Map<serializedLabels, { bucketCounts, sum, count }> */
  observations: Map<string, HistogramObservation>
}

interface HistogramObservation {
  bucketCounts: number[] // same length as buckets
  sum: number
  count: number
}

// ---------------------------------------------------------------------------
// MetricRegistry
// ---------------------------------------------------------------------------

export class MetricRegistry {
  private readonly counters = new Map<string, CounterMetric>()
  private readonly gauges = new Map<string, GaugeMetric>()
  private readonly histograms = new Map<string, HistogramMetric>()

  registerCounter(name: string, help: string): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, { name, help, labels: new Map() })
    }
  }

  registerGauge(name: string, help: string): void {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, { name, help, labels: new Map() })
    }
  }

  registerHistogram(name: string, help: string, buckets?: number[]): void {
    if (!this.histograms.has(name)) {
      const sorted = [...(buckets ?? DEFAULT_BUCKETS)].sort((a, b) => a - b)
      this.histograms.set(name, { name, help, buckets: sorted, observations: new Map() })
    }
  }

  incrementCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
    const counter = this.counters.get(name)
    if (!counter) return
    const key = this.serializeLabels(labels)
    counter.labels.set(key, (counter.labels.get(key) ?? 0) + value)
  }

  setGauge(name: string, labels: Record<string, string> = {}, value: number): void {
    const gauge = this.gauges.get(name)
    if (!gauge) return
    const key = this.serializeLabels(labels)
    gauge.labels.set(key, value)
  }

  observeHistogram(name: string, labels: Record<string, string> = {}, value: number): void {
    const histogram = this.histograms.get(name)
    if (!histogram) return
    const key = this.serializeLabels(labels)

    let obs = histogram.observations.get(key)
    if (!obs) {
      obs = { bucketCounts: new Array(histogram.buckets.length).fill(0), sum: 0, count: 0 }
      histogram.observations.set(key, obs)
    }

    obs.sum += value
    obs.count++
    for (let i = 0; i < histogram.buckets.length; i++) {
      if (value <= histogram.buckets[i]) {
        obs.bucketCounts[i]++
        break // only count in smallest applicable bucket; serialize() accumulates
      }
    }
  }

  serialize(): string {
    const lines: string[] = []

    for (const [, counter] of this.counters) {
      lines.push(`# HELP ${counter.name} ${counter.help}`)
      lines.push(`# TYPE ${counter.name} counter`)
      for (const [labels, value] of counter.labels) {
        const labelStr = labels ? `{${labels}}` : ""
        lines.push(`${counter.name}${labelStr} ${value}`)
      }
    }

    for (const [, gauge] of this.gauges) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`)
      lines.push(`# TYPE ${gauge.name} gauge`)
      for (const [labels, value] of gauge.labels) {
        const labelStr = labels ? `{${labels}}` : ""
        lines.push(`${gauge.name}${labelStr} ${value}`)
      }
    }

    for (const [, histogram] of this.histograms) {
      lines.push(`# HELP ${histogram.name} ${histogram.help}`)
      lines.push(`# TYPE ${histogram.name} histogram`)
      for (const [labels, obs] of histogram.observations) {
        const baseLabels = labels ? `${labels},` : ""
        let cumulative = 0
        for (let i = 0; i < histogram.buckets.length; i++) {
          cumulative += obs.bucketCounts[i]
          lines.push(`${histogram.name}_bucket{${baseLabels}le="${histogram.buckets[i]}"} ${cumulative}`)
        }
        lines.push(`${histogram.name}_bucket{${baseLabels}le="+Inf"} ${obs.count}`)
        lines.push(`${histogram.name}_sum{${labels}} ${obs.sum}`)
        lines.push(`${histogram.name}_count{${labels}} ${obs.count}`)
      }
    }

    return lines.join("\n") + "\n"
  }

  serializeLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels)
    if (entries.length === 0) return ""
    return entries.map(([k, v]) => {
      const escaped = v
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
      return `${k}="${escaped}"`
    }).join(",")
  }
}

// ---------------------------------------------------------------------------
// Global Registry + Default Metrics
// ---------------------------------------------------------------------------

export const metrics = new MetricRegistry()

// --- Request metrics ---
metrics.registerCounter("finn_http_requests_total", "Total HTTP requests")
metrics.registerCounter("finn_http_errors_total", "Total HTTP errors by status code")

// --- Conservation guard metrics (T6.2) ---
metrics.registerCounter("finn_conservation_violations_total", "Conservation guard invariant violations")
metrics.registerCounter("finn_conservation_checks_total", "Conservation guard invariant checks")
metrics.registerGauge("finn_credits_by_state", "Credit balance by state (reserved, available, settled)")
metrics.registerGauge("finn_escrow_balance_total", "Total escrow balance in micro-USDC")
metrics.registerCounter("finn_settlement_total", "Settlement events by status")

// --- Payment metrics (T6.3) ---
metrics.registerCounter("finn_agent_requests_total", "Agent requests by archetype and payment method")
metrics.registerCounter("finn_x402_verifications_total", "x402 payment verifications by result")
metrics.registerCounter("finn_rpc_requests_total", "RPC requests by provider and result")
metrics.registerCounter("finn_rate_limit_hits_total", "Rate limit hits by tier")

// --- Latency histograms (T6.4) ---
metrics.registerHistogram("finn_request_duration_seconds", "Request latency in seconds")
metrics.registerHistogram("finn_x402_verification_duration_seconds", "x402 verification latency in seconds")

// --- Billing metrics ---
metrics.registerCounter("finn_billing_events_total", "Billing state machine events")
metrics.registerCounter("finn_billing_dlq_enqueued_total", "DLQ entries enqueued")
metrics.registerCounter("finn_billing_dlq_processed_total", "DLQ entries processed")

// --- Credit metrics ---
metrics.registerCounter("finn_credit_purchases_total", "Credit purchases")
metrics.registerCounter("finn_credit_deductions_total", "Credit deductions")

// --- x402 metrics ---
metrics.registerCounter("finn_x402_quotes_total", "x402 payment quotes issued")
metrics.registerCounter("finn_x402_nonce_replays_blocked_total", "x402 nonce replay attempts blocked")

// --- Settlement circuit breaker metrics ---
metrics.registerGauge("finn_settlement_circuit_state", "Settlement circuit breaker state (1=current)")

// --- Connection metrics ---
metrics.registerGauge("finn_ws_connections_active", "Active WebSocket connections")

// ---------------------------------------------------------------------------
// Metrics Endpoint Route (T6.1)
// ---------------------------------------------------------------------------

/**
 * Create metrics routes with optional bearer token auth.
 * In production, METRICS_BEARER_TOKEN must be set. Without it, /metrics is open.
 */
export function metricsRoutes(bearerToken?: string): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    // Bearer token auth when configured
    if (bearerToken) {
      const authHeader = c.req.header("Authorization")
      if (!authHeader) {
        return c.json({ error: "Authorization required" }, 401)
      }
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader
      if (token !== bearerToken) {
        return c.json({ error: "Invalid token" }, 403)
      }
    }

    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    return c.text(metrics.serialize())
  })

  return app
}
