// src/hounfour/active-health.ts — Active Health Probes for vLLM (SDD §4.7 + T-3.6)
// Extends passive circuit breaker with HTTP probes and Prometheus metrics scraping.

import type { FullHealthProber } from "./health.js"

// --- Config ---

export interface ActiveHealthConfig {
  enabled: boolean
  intervalMs: number             // Default: 30000 (30s)
  timeoutMs: number              // Default: 5000
  endpoints: ActiveProbeEndpoint[]
}

export interface ActiveProbeEndpoint {
  name: string                   // e.g., "vllm-7b"
  provider: string               // Maps to circuit breaker provider key
  modelId: string                // Maps to circuit breaker model key
  healthUrl: string              // e.g., "http://vllm-7b:8000/health"
  metricsUrl?: string            // e.g., "http://vllm-7b:8000/metrics" (Prometheus)
}

export const DEFAULT_ACTIVE_HEALTH_CONFIG: ActiveHealthConfig = {
  enabled: false,
  intervalMs: 30_000,
  timeoutMs: 5_000,
  endpoints: [],
}

// --- Parsed Metrics ---

export interface VllmMetrics {
  gpuUtilization?: number        // 0-1
  inferenceLatencyMs?: number    // P50 or avg
  tokensPerSecond?: number       // Generation throughput
  pendingRequests?: number       // Queue depth
  runningRequests?: number
}

// --- Active Health Prober ---

export class ActiveHealthProber {
  private timer: ReturnType<typeof setInterval> | null = null
  private config: ActiveHealthConfig
  private health: FullHealthProber
  private latestMetrics = new Map<string, VllmMetrics>()
  private probing = false

  constructor(config: ActiveHealthConfig, health: FullHealthProber) {
    this.config = config
    this.health = health
  }

  /** Start periodic health probes. */
  start(): void {
    if (!this.config.enabled || this.config.endpoints.length === 0) return
    if (this.timer) return

    // Probe immediately on start
    void this.probeAll()

    this.timer = setInterval(() => {
      void this.probeAll()
    }, this.config.intervalMs)
  }

  /** Stop health probing. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run all probes once (with in-flight guard to prevent overlapping cycles). */
  async probeAll(): Promise<void> {
    if (this.probing) return
    this.probing = true
    try {
      await Promise.allSettled(
        this.config.endpoints.map(ep => this.probeEndpoint(ep)),
      )
    } finally {
      this.probing = false
    }
  }

  /** Get latest scraped metrics for an endpoint. */
  getMetrics(name: string): VllmMetrics | undefined {
    return this.latestMetrics.get(name)
  }

  /** Get aggregated health snapshot for all probed endpoints. */
  getSnapshot(): Record<string, {
    healthy: boolean
    latencyMs?: number
    metrics?: VllmMetrics
  }> {
    const result: Record<string, {
      healthy: boolean
      latencyMs?: number
      metrics?: VllmMetrics
    }> = {}

    const stats = this.health.getStats()

    for (const ep of this.config.endpoints) {
      const metrics = this.latestMetrics.get(ep.name)
      const key = `${ep.provider}:${ep.modelId}`
      const entry = stats[key]

      result[ep.name] = {
        healthy: entry ? entry.state !== "OPEN" : false,
        latencyMs: metrics?.inferenceLatencyMs,
        metrics,
      }
    }

    return result
  }

  // --- Private ---

  private async probeEndpoint(ep: ActiveProbeEndpoint): Promise<void> {
    const start = Date.now()

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

      try {
        const res = await fetch(ep.healthUrl, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        })

        if (res.ok) {
          this.health.recordSuccess(ep.provider, ep.modelId)
        } else if (res.status >= 500) {
          // Only 5xx are health failures per error taxonomy (SDD §4.7)
          const err = new Error(`Health probe returned ${res.status}`)
          ;(err as any).statusCode = res.status
          this.health.recordFailure(ep.provider, ep.modelId, err)
        } else {
          // 4xx (400/401/403/429) are not health failures per taxonomy
          console.warn(`[active-health] Non-failing status ${res.status} for ${ep.name}`)
        }
      } finally {
        clearTimeout(timeout)
      }

      // Scrape Prometheus metrics if available
      if (ep.metricsUrl) {
        await this.scrapeMetrics(ep)
      }
    } catch (err) {
      const latency = Date.now() - start
      const error = err instanceof Error ? err : new Error(String(err))
      this.health.recordFailure(ep.provider, ep.modelId, error)
      console.warn(`[active-health] Probe failed for ${ep.name} (${latency}ms):`, error.message)
    }
  }

  private async scrapeMetrics(ep: ActiveProbeEndpoint): Promise<void> {
    if (!ep.metricsUrl) return

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

      try {
        const res = await fetch(ep.metricsUrl, { signal: controller.signal })
        if (!res.ok) return

        const text = await res.text()
        const metrics = this.parsePrometheusMetrics(text)
        this.latestMetrics.set(ep.name, metrics)
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      // Non-critical: metrics scrape failure doesn't affect health
    }
  }

  /**
   * Parse Prometheus exposition format for vLLM metrics.
   * Extracts key metrics from text lines like:
   *   vllm:gpu_cache_usage_perc 0.85
   *   vllm:avg_generation_throughput_toks_per_s 42.5
   */
  private parsePrometheusMetrics(text: string): VllmMetrics {
    const metrics: VllmMetrics = {}
    let latencySum: number | undefined
    let latencyCount: number | undefined

    for (const line of text.split("\n")) {
      if (line.startsWith("#") || !line.trim()) continue

      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue

      const rawName = parts[0]
      const name = rawName.split("{")[0] // strip Prometheus labels
      const value = parseFloat(parts[1])
      if (isNaN(value)) continue

      if (name.includes("gpu_cache_usage_perc")) {
        metrics.gpuUtilization = value
      } else if (name.includes("avg_generation_throughput_toks_per_s")) {
        metrics.tokensPerSecond = value
      } else if (name.includes("num_requests_waiting")) {
        metrics.pendingRequests = value
      } else if (name.includes("num_requests_running")) {
        metrics.runningRequests = value
      } else if (name.includes("e2e_request_latency_seconds")) {
        if (name.endsWith("_sum")) {
          latencySum = value
        } else if (name.endsWith("_count")) {
          latencyCount = value
        } else if (!name.includes("_bucket")) {
          metrics.inferenceLatencyMs = value * 1000
        }
      }
    }

    // Compute average latency from sum/count histogram if direct value unavailable
    if (metrics.inferenceLatencyMs === undefined && latencySum !== undefined && latencyCount && latencyCount > 0) {
      metrics.inferenceLatencyMs = (latencySum / latencyCount) * 1000
    }

    return metrics
  }
}
