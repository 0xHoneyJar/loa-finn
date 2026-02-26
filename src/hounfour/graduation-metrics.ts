// src/hounfour/graduation-metrics.ts — Prometheus Graduation Metrics (SDD §9.2, cycle-035 T-2.5)
//
// Lightweight Prometheus text format metrics without external dependencies.
// Fixed label sets (tier, status) — no nftId/poolId to prevent cardinality explosion.
//
// Counters: finn_shadow_total, finn_shadow_diverged, finn_reputation_query_total,
//   finn_exploration_total, finn_ema_updates_total, finn_routing_mode_transitions_total
// Histogram: finn_reputation_query_duration_seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HistogramBuckets {
  boundaries: number[]
  counts: number[]
  sum: number
  count: number
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

class Counter {
  private readonly name: string
  private readonly help: string
  private readonly labelNames: string[]
  private values = new Map<string, number>()

  constructor(name: string, help: string, labelNames: string[] = []) {
    this.name = name
    this.help = help
    this.labelNames = labelNames
  }

  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = this.labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + value)
  }

  get(labels: Record<string, string> = {}): number {
    return this.values.get(this.labelKey(labels)) ?? 0
  }

  reset(): void {
    this.values.clear()
  }

  toPrometheus(): string {
    const lines: string[] = []
    lines.push(`# HELP ${this.name} ${this.help}`)
    lines.push(`# TYPE ${this.name} counter`)
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`)
    } else {
      for (const [key, value] of this.values) {
        const labelStr = key ? `{${key}}` : ""
        lines.push(`${this.name}${labelStr} ${value}`)
      }
    }
    return lines.join("\n")
  }

  private labelKey(labels: Record<string, string>): string {
    if (this.labelNames.length === 0) return ""
    return this.labelNames
      .filter(n => labels[n] !== undefined)
      .map(n => `${n}="${labels[n]}"`)
      .join(",")
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

class Histogram {
  private readonly name: string
  private readonly help: string
  private readonly labelNames: string[]
  private readonly boundaries: number[]
  private buckets = new Map<string, HistogramBuckets>()

  constructor(name: string, help: string, labelNames: string[], boundaries: number[]) {
    this.name = name
    this.help = help
    this.labelNames = labelNames
    this.boundaries = boundaries.sort((a, b) => a - b)
  }

  observe(labels: Record<string, string>, value: number): void {
    const key = this.labelKey(labels)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = {
        boundaries: [...this.boundaries],
        counts: new Array(this.boundaries.length + 1).fill(0),
        sum: 0,
        count: 0,
      }
      this.buckets.set(key, bucket)
    }

    bucket.sum += value
    bucket.count++

    for (let i = 0; i < this.boundaries.length; i++) {
      if (value <= this.boundaries[i]) {
        bucket.counts[i]++
      }
    }
    // +Inf bucket
    bucket.counts[this.boundaries.length]++
  }

  getBuckets(labels: Record<string, string> = {}): HistogramBuckets | undefined {
    return this.buckets.get(this.labelKey(labels))
  }

  reset(): void {
    this.buckets.clear()
  }

  toPrometheus(): string {
    const lines: string[] = []
    lines.push(`# HELP ${this.name} ${this.help}`)
    lines.push(`# TYPE ${this.name} histogram`)

    for (const [key, bucket] of this.buckets) {
      const baseLabels = key ? `${key},` : ""
      let cumulative = 0
      for (let i = 0; i < this.boundaries.length; i++) {
        cumulative += bucket.counts[i]
        lines.push(`${this.name}_bucket{${baseLabels}le="${this.boundaries[i]}"} ${cumulative}`)
      }
      lines.push(`${this.name}_bucket{${baseLabels}le="+Inf"} ${bucket.count}`)
      lines.push(`${this.name}_sum{${key ? key : ""}} ${bucket.sum}`)
      lines.push(`${this.name}_count{${key ? key : ""}} ${bucket.count}`)
    }

    return lines.join("\n")
  }

  private labelKey(labels: Record<string, string>): string {
    if (this.labelNames.length === 0) return ""
    return this.labelNames
      .filter(n => labels[n] !== undefined)
      .map(n => `${n}="${labels[n]}"`)
      .join(",")
  }
}

// ---------------------------------------------------------------------------
// GraduationMetrics
// ---------------------------------------------------------------------------

export class GraduationMetrics {
  readonly shadowTotal = new Counter(
    "finn_shadow_total",
    "Total shadow routing decisions",
    ["tier"],
  )

  readonly shadowDiverged = new Counter(
    "finn_shadow_diverged",
    "Shadow decisions that diverged from deterministic",
    ["tier"],
  )

  readonly reputationQueryTotal = new Counter(
    "finn_reputation_query_total",
    "Total reputation queries",
    ["status"],
  )

  readonly reputationQueryDuration = new Histogram(
    "finn_reputation_query_duration_seconds",
    "Reputation query latency in seconds",
    ["status"],
    [0.01, 0.05, 0.1, 0.3, 0.5, 1, 5],
  )

  readonly explorationTotal = new Counter(
    "finn_exploration_total",
    "Total exploration events",
    ["tier"],
  )

  readonly emaUpdatesTotal = new Counter(
    "finn_ema_updates_total",
    "Total EMA score updates",
  )

  readonly routingModeTransitionsTotal = new Counter(
    "finn_routing_mode_transitions_total",
    "Total routing mode transitions",
    ["from", "to"],
  )

  // --- Convenience methods ---

  recordShadowDecision(tier: string, diverged: boolean): void {
    this.shadowTotal.inc({ tier })
    if (diverged) {
      this.shadowDiverged.inc({ tier })
    }
  }

  recordReputationQuery(latencyMs: number, status: "success" | "timeout" | "error"): void {
    this.reputationQueryTotal.inc({ status })
    this.reputationQueryDuration.observe({ status }, latencyMs / 1000)
  }

  recordExploration(tier: string): void {
    this.explorationTotal.inc({ tier })
  }

  recordEMAUpdate(): void {
    this.emaUpdatesTotal.inc()
  }

  recordModeTransition(from: string, to: string): void {
    this.routingModeTransitionsTotal.inc({ from, to })
  }

  // --- Export ---

  toPrometheus(): string {
    return [
      this.shadowTotal.toPrometheus(),
      this.shadowDiverged.toPrometheus(),
      this.reputationQueryTotal.toPrometheus(),
      this.reputationQueryDuration.toPrometheus(),
      this.explorationTotal.toPrometheus(),
      this.emaUpdatesTotal.toPrometheus(),
      this.routingModeTransitionsTotal.toPrometheus(),
    ].join("\n\n")
  }

  reset(): void {
    this.shadowTotal.reset()
    this.shadowDiverged.reset()
    this.reputationQueryTotal.reset()
    this.reputationQueryDuration.reset()
    this.explorationTotal.reset()
    this.emaUpdatesTotal.reset()
    this.routingModeTransitionsTotal.reset()
  }
}
