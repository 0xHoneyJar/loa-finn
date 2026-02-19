// src/gateway/metrics-endpoint.ts — Prometheus Metrics Endpoint (Sprint 7 Task 7.3)
//
// Serves /metrics in Prometheus exposition format.
// Counters: requests, errors, billing events.
// Gauges: active connections, credit balances, conservation guard state.

import { Hono } from "hono"
import type { RedisCommandClient } from "../hounfour/redis/client.js"

// ---------------------------------------------------------------------------
// Metric Registry
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

class MetricRegistry {
  private readonly counters = new Map<string, CounterMetric>()
  private readonly gauges = new Map<string, GaugeMetric>()

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

    return lines.join("\n") + "\n"
  }

  private serializeLabels(labels: Record<string, string>): string {
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

// Request metrics
metrics.registerCounter("loa_finn_http_requests_total", "Total HTTP requests")
metrics.registerCounter("loa_finn_http_errors_total", "Total HTTP errors by status code")

// Billing metrics
metrics.registerCounter("loa_finn_billing_events_total", "Billing state machine events")
metrics.registerCounter("loa_finn_billing_dlq_enqueued_total", "DLQ entries enqueued")
metrics.registerCounter("loa_finn_billing_dlq_processed_total", "DLQ entries processed")

// Conservation guard metrics
metrics.registerCounter("loa_finn_conservation_guard_checks_total", "Conservation guard invariant checks")
metrics.registerCounter("loa_finn_conservation_guard_failures_total", "Conservation guard hard failures")
metrics.registerGauge("loa_finn_conservation_guard_state", "Conservation guard state (1=ready, 0=degraded)")

// Credit metrics
metrics.registerCounter("loa_finn_credit_purchases_total", "Credit purchases")
metrics.registerCounter("loa_finn_credit_deductions_total", "Credit deductions")

// x402 metrics
metrics.registerCounter("loa_finn_x402_quotes_total", "x402 payment quotes issued")
metrics.registerCounter("loa_finn_x402_payments_verified_total", "x402 payments verified")
metrics.registerCounter("loa_finn_x402_nonce_replays_blocked_total", "x402 nonce replay attempts blocked")

// Settlement circuit breaker metrics
metrics.registerGauge("loa_finn_settlement_circuit_state", "Settlement circuit breaker state (1=current)")

// Connection metrics
metrics.registerGauge("loa_finn_ws_connections_active", "Active WebSocket connections")
metrics.registerGauge("loa_finn_onboarding_sessions_active", "Active onboarding sessions")

// ---------------------------------------------------------------------------
// Metrics Endpoint Route
// ---------------------------------------------------------------------------

export function metricsRoutes(): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    return c.text(metrics.serialize())
  })

  return app
}
