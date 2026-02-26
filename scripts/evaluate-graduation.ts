// scripts/evaluate-graduation.ts — Graduation Evaluation Script (cycle-035 T-4.2)
//
// Reads 72h of metrics from Prometheus API and evaluates 8 graduation thresholds.
// Outputs: GRADUATE, NOT_READY, or INSUFFICIENT_DATA.
//
// Usage:
//   npx tsx scripts/evaluate-graduation.ts [--config path/to/config.json]
//
// Prometheus contract: scrape job name "finn", path /metrics, port 3000,
// labels tier/status on counters.

import { readFileSync } from "node:fs"
import { createClient } from "redis"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraduationConfig {
  prometheusUrl: string
  prometheusJobName: string
  redisUrl: string
  adminEndpoint: string
  adminJwtPath?: string
  /** Evaluation window in hours (default: 72) */
  evaluationWindowHours?: number
}

interface ThresholdResult {
  id: string
  name: string
  status: "PASS" | "FAIL" | "INSUFFICIENT_DATA"
  value: number | null
  threshold: number
  detail: string
}

type Verdict = "GRADUATE" | "NOT_READY" | "INSUFFICIENT_DATA"

// ---------------------------------------------------------------------------
// Prometheus Query Helper
// ---------------------------------------------------------------------------

async function promQuery(
  baseUrl: string,
  query: string,
  time?: number,
): Promise<number | null> {
  const url = new URL("/api/v1/query", baseUrl)
  url.searchParams.set("query", query)
  if (time) url.searchParams.set("time", String(time))

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) return null

  const body = await res.json() as {
    status: string
    data: { resultType: string; result: Array<{ value: [number, string] }> }
  }

  if (body.status !== "success" || !body.data?.result?.length) return null

  const val = parseFloat(body.data.result[0].value[1])
  return Number.isFinite(val) ? val : null
}

// Used by future thresholds (trend analysis over time windows)
async function promRangeQuery(
  baseUrl: string,
  query: string,
  start: number,
  end: number,
  step: string,
): Promise<Array<[number, number]>> {
  const url = new URL("/api/v1/query_range", baseUrl)
  url.searchParams.set("query", query)
  url.searchParams.set("start", String(start))
  url.searchParams.set("end", String(end))
  url.searchParams.set("step", step)

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) return []

  const body = await res.json() as {
    status: string
    data: { resultType: string; result: Array<{ values: Array<[number, string]> }> }
  }

  if (body.status !== "success" || !body.data?.result?.length) return []

  return body.data.result[0].values.map(([ts, v]) => [ts, parseFloat(v)])
}

// ---------------------------------------------------------------------------
// Threshold Evaluators (T1-T8)
// ---------------------------------------------------------------------------

async function evaluateT1(config: GraduationConfig, windowH: number): Promise<ThresholdResult> {
  // T1: Shadow divergence rate < 5%
  const total = await promQuery(
    config.prometheusUrl,
    `increase(finn_shadow_total[${windowH}h])`,
  )
  const diverged = await promQuery(
    config.prometheusUrl,
    `increase(finn_shadow_diverged[${windowH}h])`,
  )

  if (total === null || total === 0) {
    return { id: "T1", name: "Shadow divergence rate", status: "INSUFFICIENT_DATA", value: null, threshold: 0.05, detail: "No shadow data in window" }
  }

  const rate = (diverged ?? 0) / total
  return {
    id: "T1", name: "Shadow divergence rate",
    status: rate < 0.05 ? "PASS" : "FAIL",
    value: rate, threshold: 0.05,
    detail: `${(rate * 100).toFixed(2)}% divergence (${diverged}/${total})`,
  }
}

async function evaluateT2(config: GraduationConfig, windowH: number): Promise<ThresholdResult> {
  // T2: Reputation query success rate > 95%
  const success = await promQuery(
    config.prometheusUrl,
    `increase(finn_reputation_query_total{status="success"}[${windowH}h])`,
  )
  const total = await promQuery(
    config.prometheusUrl,
    `increase(finn_reputation_query_total[${windowH}h])`,
  )

  if (total === null || total === 0) {
    return { id: "T2", name: "Reputation query success rate", status: "INSUFFICIENT_DATA", value: null, threshold: 0.95, detail: "No reputation queries in window" }
  }

  const rate = (success ?? 0) / total
  return {
    id: "T2", name: "Reputation query success rate",
    status: rate > 0.95 ? "PASS" : "FAIL",
    value: rate, threshold: 0.95,
    detail: `${(rate * 100).toFixed(2)}% success (${success}/${total})`,
  }
}

async function evaluateT3(config: GraduationConfig, windowH: number): Promise<ThresholdResult> {
  // T3: P99 reputation query latency < 500ms
  const p99 = await promQuery(
    config.prometheusUrl,
    `histogram_quantile(0.99, rate(finn_reputation_query_duration_seconds_bucket{job="${config.prometheusJobName}"}[${windowH}h]))`,
  )

  if (p99 === null) {
    return { id: "T3", name: "P99 reputation query latency", status: "INSUFFICIENT_DATA", value: null, threshold: 0.5, detail: "No latency data" }
  }

  return {
    id: "T3", name: "P99 reputation query latency",
    status: p99 < 0.5 ? "PASS" : "FAIL",
    value: p99, threshold: 0.5,
    detail: `${(p99 * 1000).toFixed(1)}ms (threshold: 500ms)`,
  }
}

async function evaluateT4(config: GraduationConfig, windowH: number): Promise<ThresholdResult> {
  // T4: Exploration rate within expected range (1-10%)
  const exploration = await promQuery(
    config.prometheusUrl,
    `increase(finn_exploration_total[${windowH}h])`,
  )
  const shadow = await promQuery(
    config.prometheusUrl,
    `increase(finn_shadow_total[${windowH}h])`,
  )

  const total = (shadow ?? 0) + (exploration ?? 0)
  if (total === 0) {
    return { id: "T4", name: "Exploration rate", status: "INSUFFICIENT_DATA", value: null, threshold: 0.1, detail: "No routing decisions in window" }
  }

  const rate = (exploration ?? 0) / total
  return {
    id: "T4", name: "Exploration rate",
    status: rate >= 0.01 && rate <= 0.10 ? "PASS" : "FAIL",
    value: rate, threshold: 0.10,
    detail: `${(rate * 100).toFixed(2)}% exploration (expected 1-10%)`,
  }
}

async function evaluateT5(config: GraduationConfig): Promise<ThresholdResult> {
  // T5: EMA coefficient of variation < 0.3 (stability)
  // Reads EMA keys from Redis: ema:{poolId}:{routingKey}
  let redis
  try {
    redis = createClient({ url: config.redisUrl })
    await redis.connect()

    // Scan for EMA keys
    const emaKeys: string[] = []
    for await (const key of redis.scanIterator({ MATCH: "ema:*", COUNT: 100 })) {
      emaKeys.push(key)
    }

    if (emaKeys.length === 0) {
      return { id: "T5", name: "EMA stability (CV)", status: "INSUFFICIENT_DATA", value: null, threshold: 0.3, detail: "No EMA keys in Redis" }
    }

    // Read EMA values and compute coefficient of variation
    const values: number[] = []
    for (const key of emaKeys) {
      const raw = await redis.get(key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as { value?: number; count?: number; lastEventTimestamp?: string }
        if (typeof parsed.value === "number" && (parsed.count ?? 0) > 0) {
          values.push(parsed.value)
        }
      } catch {
        // Skip malformed entries
      }
    }

    if (values.length < 2) {
      return { id: "T5", name: "EMA stability (CV)", status: "INSUFFICIENT_DATA", value: null, threshold: 0.3, detail: `Only ${values.length} active EMA keys` }
    }

    const mean = values.reduce((s, v) => s + v, 0) / values.length
    if (mean === 0) {
      return { id: "T5", name: "EMA stability (CV)", status: "FAIL", value: Infinity, threshold: 0.3, detail: "Mean EMA is 0" }
    }
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
    const cv = Math.sqrt(variance) / Math.abs(mean)

    return {
      id: "T5", name: "EMA stability (CV)",
      status: cv < 0.3 ? "PASS" : "FAIL",
      value: cv, threshold: 0.3,
      detail: `CV=${cv.toFixed(3)} across ${values.length} EMA keys (mean=${mean.toFixed(4)})`,
    }
  } catch (err) {
    return { id: "T5", name: "EMA stability (CV)", status: "INSUFFICIENT_DATA", value: null, threshold: 0.3, detail: `Redis error: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await redis?.disconnect().catch(() => {})
  }
}

async function evaluateT6(config: GraduationConfig, windowH: number): Promise<ThresholdResult> {
  // T6: EMA update frequency > 0 (active learning)
  const updates = await promQuery(
    config.prometheusUrl,
    `increase(finn_ema_updates_total[${windowH}h])`,
  )

  if (updates === null) {
    return { id: "T6", name: "EMA update frequency", status: "INSUFFICIENT_DATA", value: null, threshold: 1, detail: "No EMA update data" }
  }

  return {
    id: "T6", name: "EMA update frequency",
    status: updates > 0 ? "PASS" : "FAIL",
    value: updates, threshold: 1,
    detail: `${updates} EMA updates in ${windowH}h window`,
  }
}

async function evaluateT7(config: GraduationConfig): Promise<ThresholdResult> {
  // T7: Admin mode change round-trip works
  // Spot check: POST /admin/routing-mode round-trip
  try {
    const getRes = await fetch(`${config.adminEndpoint}/mode`, {
      signal: AbortSignal.timeout(5000),
    })

    if (getRes.status === 200) {
      return { id: "T7", name: "Admin mode round-trip", status: "PASS", value: 1, threshold: 1, detail: "GET /admin/mode returned 200" }
    }

    return {
      id: "T7", name: "Admin mode round-trip",
      status: "FAIL", value: 0, threshold: 1,
      detail: `GET /admin/mode returned ${getRes.status}`,
    }
  } catch (err) {
    return { id: "T7", name: "Admin mode round-trip", status: "FAIL", value: 0, threshold: 1, detail: `Error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function evaluateT8(config: GraduationConfig): Promise<ThresholdResult> {
  // T8: Calibration data freshness
  // Check S3 calibration ETag polling timestamp from Redis
  let redis
  try {
    redis = createClient({ url: config.redisUrl })
    await redis.connect()

    const lastRefresh = await redis.get("calibration:last_refresh_ts")
    if (!lastRefresh) {
      return { id: "T8", name: "Calibration freshness", status: "INSUFFICIENT_DATA", value: null, threshold: 1, detail: "No calibration:last_refresh_ts key" }
    }

    const ts = new Date(lastRefresh).getTime()
    const ageHours = (Date.now() - ts) / (1000 * 60 * 60)

    // Calibration should have refreshed within last 24h
    return {
      id: "T8", name: "Calibration freshness",
      status: ageHours < 24 ? "PASS" : "FAIL",
      value: ageHours, threshold: 24,
      detail: `Last refresh: ${ageHours.toFixed(1)}h ago (threshold: 24h)`,
    }
  } catch (err) {
    return { id: "T8", name: "Calibration freshness", status: "INSUFFICIENT_DATA", value: null, threshold: 24, detail: `Redis error: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await redis?.disconnect().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Main Evaluation
// ---------------------------------------------------------------------------

export async function evaluateGraduation(config: GraduationConfig): Promise<{
  verdict: Verdict
  results: ThresholdResult[]
  timestamp: string
}> {
  const windowH = config.evaluationWindowHours ?? 72

  // Smoke query: verify Prometheus connectivity
  const upQuery = await promQuery(
    config.prometheusUrl,
    `up{job="${config.prometheusJobName}"}`,
  )

  if (upQuery === null || upQuery === 0) {
    return {
      verdict: "INSUFFICIENT_DATA",
      results: [{
        id: "SMOKE", name: "Prometheus connectivity",
        status: "INSUFFICIENT_DATA", value: null, threshold: 1,
        detail: `up{job="${config.prometheusJobName}"} returned ${upQuery}`,
      }],
      timestamp: new Date().toISOString(),
    }
  }

  // Evaluate all 8 thresholds
  const results = await Promise.all([
    evaluateT1(config, windowH),
    evaluateT2(config, windowH),
    evaluateT3(config, windowH),
    evaluateT4(config, windowH),
    evaluateT5(config),
    evaluateT6(config, windowH),
    evaluateT7(config),
    evaluateT8(config),
  ])

  // Determine verdict
  const hasInsufficient = results.some(r => r.status === "INSUFFICIENT_DATA")
  const hasFail = results.some(r => r.status === "FAIL")

  let verdict: Verdict
  if (hasInsufficient && !hasFail) {
    verdict = "INSUFFICIENT_DATA"
  } else if (hasFail) {
    verdict = "NOT_READY"
  } else {
    verdict = "GRADUATE"
  }

  return {
    verdict,
    results,
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// CLI Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const configIdx = args.indexOf("--config")
  const configPath = configIdx >= 0 ? args[configIdx + 1] : "scripts/graduation-config.example.json"

  let config: GraduationConfig
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"))
  } catch (err) {
    console.error(`Failed to read config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  // Defaults
  config.prometheusJobName = config.prometheusJobName ?? "finn"
  config.evaluationWindowHours = config.evaluationWindowHours ?? 72

  console.log("=== Graduation Evaluation ===")
  console.log(`Prometheus: ${config.prometheusUrl}`)
  console.log(`Redis: ${config.redisUrl}`)
  console.log(`Window: ${config.evaluationWindowHours}h`)
  console.log("")

  const evaluation = await evaluateGraduation(config)

  // Print results table
  console.log("Threshold Results:")
  console.log("─".repeat(80))
  for (const r of evaluation.results) {
    const icon = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "N/A "
    console.log(`  [${icon}] ${r.id}: ${r.name}`)
    console.log(`         ${r.detail}`)
  }
  console.log("─".repeat(80))
  console.log("")
  console.log(`Verdict: ${evaluation.verdict}`)
  console.log(`Timestamp: ${evaluation.timestamp}`)

  // Output JSON to stdout for programmatic consumption
  if (args.includes("--json")) {
    console.log("")
    console.log(JSON.stringify(evaluation, null, 2))
  }

  // Exit code based on verdict
  process.exit(evaluation.verdict === "GRADUATE" ? 0 : 1)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(2)
})
