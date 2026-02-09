// tests/finn/hounfour-phase3-sprint3.test.ts — Phase 3 Sprint 3 (global-21) tests
// Tests for: LedgerExporter, NativeRuntimeMeter, DataRedactor, VllmRouting, ActiveHealth

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { gunzipSync } from "node:zlib"

// --- Test harness ---

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-p3s3-test-"))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

// =============================================
// T-3.4: Ledger Exporter Tests
// =============================================

console.log("\n--- LedgerExporter Tests (T-3.4) ---")

import {
  LedgerExporter,
  DEFAULT_EXPORTER_CONFIG,
  type ObjectStorePort,
  type LedgerExporterConfig,
} from "../../src/hounfour/ledger-exporter.js"

// Mock BudgetEnforcer
function makeMockBudget(ledgerDir: string) {
  const ledgerPath = join(ledgerDir, "cost-ledger.jsonl")
  return {
    rotateLedgerIfNeeded: async () => {
      if (existsSync(ledgerPath)) return ledgerPath
      return null
    },
    listAllLedgerFiles: async () => {
      return existsSync(ledgerPath) ? [ledgerPath] : []
    },
    recordCost: async () => {},
    isExceeded: () => false,
    getBudgetSnapshot: () => ({ scope: "test", spent_usd: 0, limit_usd: 100, percent_used: 0, warning: false, exceeded: false }),
  }
}

// Mock ObjectStore
function makeMockObjectStore() {
  const uploads = new Map<string, { body: Buffer; metadata?: Record<string, string> }>()
  const store: ObjectStorePort = {
    upload: async (key, body, metadata) => {
      uploads.set(key, { body, metadata })
    },
    download: async (key) => {
      const entry = uploads.get(key)
      return entry ? entry.body : null
    },
  }
  return { store, uploads }
}

await test("LedgerExporter: returns null when disabled", async () => {
  const dir = makeTempDir()
  try {
    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: false }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any)
    const result = await exporter.checkAndRotate()
    assert.equal(result, null)
  } finally {
    cleanup(dir)
  }
})

await test("LedgerExporter: returns null when no rotation needed", async () => {
  const dir = makeTempDir()
  try {
    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: true }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any)
    const result = await exporter.checkAndRotate()
    assert.equal(result, null)
  } finally {
    cleanup(dir)
  }
})

await test("LedgerExporter: compresses and checksums archive", async () => {
  const dir = makeTempDir()
  try {
    const ledgerPath = join(dir, "cost-ledger.jsonl")
    const entries = [
      JSON.stringify({ timestamp: "2026-01-15T10:00:00Z", cost: 0.05, model: "gpt-4o" }),
      JSON.stringify({ timestamp: "2026-01-16T10:00:00Z", cost: 0.10, model: "gpt-4o" }),
    ]
    writeFileSync(ledgerPath, entries.join("\n") + "\n")

    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: true }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any)
    const result = await exporter.checkAndRotate()

    assert.ok(result)
    assert.equal(result.entriesCount, 2)
    assert.ok(result.checksum.length === 64, "SHA-256 hex should be 64 chars")
    assert.ok(result.compressedBytes > 0)
    assert.ok(result.compressedBytes < result.sizeBytes, "Compressed should be smaller")

    // Verify local .gz was written
    assert.ok(existsSync(`${ledgerPath}.gz`))

    // Verify it decompresses to original content
    const compressed = readFileSync(`${ledgerPath}.gz`)
    const decompressed = gunzipSync(compressed).toString("utf8")
    assert.ok(decompressed.includes("gpt-4o"))
  } finally {
    cleanup(dir)
  }
})

await test("LedgerExporter: uploads to object store with index", async () => {
  const dir = makeTempDir()
  try {
    const ledgerPath = join(dir, "cost-ledger.jsonl")
    writeFileSync(ledgerPath, JSON.stringify({ timestamp: "2026-02-01T00:00:00Z", cost: 0.01 }) + "\n")

    const { store, uploads } = makeMockObjectStore()
    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: true, destination: "r2" }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any, store)
    const result = await exporter.checkAndRotate()

    assert.ok(result)
    assert.ok(result.remotePath.includes("hounfour/ledger/"))
    assert.ok(result.remotePath.endsWith(".jsonl.gz"))

    // Verify index was updated
    const indexKey = "hounfour/ledger/index.json"
    assert.ok(uploads.has(indexKey))
    const index = JSON.parse(uploads.get(indexKey)!.body.toString("utf8"))
    assert.equal(index.schema_version, 1)
    assert.equal(index.archives.length, 1)
    assert.equal(index.archives[0].entries_count, 1)
  } finally {
    cleanup(dir)
  }
})

await test("LedgerExporter: sizeBytes uses stat not string length", async () => {
  const dir = makeTempDir()
  try {
    const ledgerPath = join(dir, "cost-ledger.jsonl")
    // Write a line with multi-byte UTF-8 chars
    const entry = JSON.stringify({ timestamp: "2026-01-15T00:00:00Z", note: "café résumé" })
    writeFileSync(ledgerPath, entry + "\n")

    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: true }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any)
    const result = await exporter.checkAndRotate()

    assert.ok(result)
    // stat().size should be byte count, not char count
    const { statSync } = await import("node:fs")
    const actualSize = statSync(ledgerPath).size
    assert.equal(result.sizeBytes, actualSize)
  } finally {
    cleanup(dir)
  }
})

await test("LedgerExporter: exportRange filters by date", async () => {
  const dir = makeTempDir()
  try {
    const ledgerPath = join(dir, "cost-ledger.jsonl")
    const entries = [
      JSON.stringify({ timestamp: "2026-01-10T00:00:00Z", cost: 0.01 }),
      JSON.stringify({ timestamp: "2026-01-20T00:00:00Z", cost: 0.02 }),
      JSON.stringify({ timestamp: "2026-02-05T00:00:00Z", cost: 0.03 }),
    ]
    writeFileSync(ledgerPath, entries.join("\n") + "\n")

    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: true }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any)
    const result = await exporter.exportRange("2026-01-15", "2026-01-25")

    assert.ok(result)
    assert.equal(result.entriesCount, 1, "Only one entry in date range")
  } finally {
    cleanup(dir)
  }
})

await test("LedgerExporter: sanitizes date inputs in exportRange paths", async () => {
  const dir = makeTempDir()
  try {
    const ledgerPath = join(dir, "cost-ledger.jsonl")
    writeFileSync(ledgerPath, JSON.stringify({ timestamp: "2026-01-15T00:00:00Z", cost: 0.01 }) + "\n")

    const config: LedgerExporterConfig = { ...DEFAULT_EXPORTER_CONFIG, enabled: true }
    const exporter = new LedgerExporter(config, makeMockBudget(dir) as any)
    const result = await exporter.exportRange("2026-01-01", "../../etc/passwd")

    // If it produces a result, path should be sanitized
    if (result) {
      assert.ok(!result.remotePath.includes(".."), "Path traversal should be stripped")
      assert.ok(!result.remotePath.includes("/etc/"), "Path injection should be stripped")
    }
  } finally {
    cleanup(dir)
  }
})

// =============================================
// T-3.5: Native Runtime Metering Tests
// =============================================

console.log("\n--- NativeRuntimeMeter Tests (T-3.5) ---")

import {
  NativeRuntimeMeter,
  SENTINEL_TOKENS,
  getAnthropicPricing,
} from "../../src/hounfour/native-metering.js"
import type { ScopeMeta, PricingEntry, UsageInfo } from "../../src/hounfour/types.js"

const testScope: ScopeMeta = {
  project_id: "loa-finn",
  phase_id: "phase-3",
  sprint_id: "sprint-21",
}

const testPricing: PricingEntry = {
  provider: "claude-code",
  model: "session",
  input_per_1m: 3.0,
  output_per_1m: 15.0,
}

await test("NativeRuntimeMeter: skips sentinel values", async () => {
  let recorded = false
  const mockBudget = { recordCost: async () => { recorded = true } }
  const meter = new NativeRuntimeMeter(mockBudget as any, testPricing, testScope)
  await meter.recordTurn({ prompt_tokens: SENTINEL_TOKENS, completion_tokens: SENTINEL_TOKENS, reasoning_tokens: 0 })
  assert.equal(recorded, false, "Should not record with sentinel prompt_tokens")
})

await test("NativeRuntimeMeter: skips negative completion_tokens", async () => {
  let recorded = false
  const mockBudget = { recordCost: async () => { recorded = true } }
  const meter = new NativeRuntimeMeter(mockBudget as any, testPricing, testScope)
  await meter.recordTurn({ prompt_tokens: 100, completion_tokens: -1, reasoning_tokens: 0 })
  assert.equal(recorded, false, "Should not record with negative completion_tokens")
})

await test("NativeRuntimeMeter: skips NaN values", async () => {
  let recorded = false
  const mockBudget = { recordCost: async () => { recorded = true } }
  const meter = new NativeRuntimeMeter(mockBudget as any, testPricing, testScope)
  await meter.recordTurn({ prompt_tokens: NaN, completion_tokens: 100, reasoning_tokens: 0 })
  assert.equal(recorded, false, "Should not record with NaN prompt_tokens")
})

await test("NativeRuntimeMeter: records valid usage", async () => {
  let recordedScope: ScopeMeta | undefined
  let recordedUsage: UsageInfo | undefined
  const mockBudget = {
    recordCost: async (scope: ScopeMeta, usage: UsageInfo) => {
      recordedScope = scope
      recordedUsage = usage
    },
  }
  const meter = new NativeRuntimeMeter(mockBudget as any, testPricing, testScope)
  await meter.recordTurn({ prompt_tokens: 500, completion_tokens: 200, reasoning_tokens: 0 })
  assert.ok(recordedScope)
  assert.equal(recordedScope.sprint_id, "sprint-21")
  assert.ok(recordedUsage)
  assert.equal(recordedUsage.prompt_tokens, 500)
})

await test("NativeRuntimeMeter: extractUsage handles valid session data", () => {
  const result = NativeRuntimeMeter.extractUsage({
    usage: { prompt_tokens: 1000, completion_tokens: 500, reasoning_tokens: 100 },
  })
  assert.equal(result.prompt_tokens, 1000)
  assert.equal(result.completion_tokens, 500)
  assert.equal(result.reasoning_tokens, 100)
})

await test("NativeRuntimeMeter: extractUsage returns sentinels for null data", () => {
  const result = NativeRuntimeMeter.extractUsage(null)
  assert.equal(result.prompt_tokens, SENTINEL_TOKENS)
  assert.equal(result.completion_tokens, SENTINEL_TOKENS)
})

await test("NativeRuntimeMeter: extractUsage handles input/output format", () => {
  const result = NativeRuntimeMeter.extractUsage({ input_tokens: 800, output_tokens: 300 })
  assert.equal(result.prompt_tokens, 800)
  assert.equal(result.completion_tokens, 300)
})

await test("getAnthropicPricing: returns exact match", () => {
  const pricing = getAnthropicPricing("claude-opus-4-6")
  assert.equal(pricing.input_per_1m, 15.0)
})

await test("getAnthropicPricing: defaults to sonnet", () => {
  const pricing = getAnthropicPricing("unknown-model")
  assert.equal(pricing.input_per_1m, 3.0)
})

// =============================================
// T-3.7: Data Retention/Redaction Tests
// =============================================

console.log("\n--- DataRedactor Tests (T-3.7) ---")

import {
  DataRedactor,
  resolveRetentionConfig,
  DEFAULT_RETENTION_CONFIG,
  type RetentionConfig,
  type RetentionOverride,
} from "../../src/hounfour/data-retention.js"

await test("DataRedactor: no-op with empty patterns", () => {
  const redactor = new DataRedactor({ ...DEFAULT_RETENTION_CONFIG })
  assert.equal(redactor.redact("hello world"), "hello world")
})

await test("DataRedactor: redacts matching patterns", () => {
  const config: RetentionConfig = {
    ...DEFAULT_RETENTION_CONFIG,
    redaction_patterns: ["\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b"],
  }
  const redactor = new DataRedactor(config)
  const result = redactor.redact("Contact me at user@example.com please")
  assert.equal(result, "Contact me at [REDACTED] please")
})

await test("DataRedactor: handles invalid regex gracefully", () => {
  const config: RetentionConfig = { ...DEFAULT_RETENTION_CONFIG, redaction_patterns: ["[invalid(regex"] }
  const redactor = new DataRedactor(config)
  assert.equal(redactor.redact("hello"), "hello")
})

await test("DataRedactor: filterLedgerEntry strips non-retained fields", () => {
  const redactor = new DataRedactor({ ...DEFAULT_RETENTION_CONFIG })
  const entry = {
    timestamp: "2026-01-01T00:00:00Z",
    prompt_content: "What is the weather?",
    response_content: "It's sunny",
    thinking: "Let me think...",
    total_cost_usd: 0.05,
  }
  const filtered = redactor.filterLedgerEntry(entry)
  assert.equal(filtered.timestamp, "2026-01-01T00:00:00Z")
  assert.equal(filtered.total_cost_usd, 0.05)
  assert.equal(filtered.prompt_content, undefined)
  assert.equal(filtered.response_content, undefined)
  assert.equal(filtered.thinking, undefined)
})

await test("DataRedactor: filterLedgerEntry retains prompts when configured", () => {
  const config: RetentionConfig = { ...DEFAULT_RETENTION_CONFIG, prompts: true }
  const redactor = new DataRedactor(config)
  const entry = { prompt_content: "hello", response_content: "world" }
  const filtered = redactor.filterLedgerEntry(entry)
  assert.equal(filtered.prompt_content, "hello")
  assert.equal(filtered.response_content, undefined)
})

await test("DataRedactor: deep redaction on nested objects", () => {
  const config: RetentionConfig = {
    ...DEFAULT_RETENTION_CONFIG,
    prompts: true,
    redaction_patterns: ["secret-key-\\w+"],
  }
  const redactor = new DataRedactor(config)
  const entry = {
    prompt_content: "Use secret-key-abc123",
    messages: [{ role: "user", content: "My secret-key-def456 is here" }],
    metadata: { note: "Has secret-key-ghi789 inside" },
  }
  const filtered = redactor.filterLedgerEntry(entry)
  assert.equal(filtered.prompt_content, "Use [REDACTED]")
  const msgs = filtered.messages as any[]
  assert.equal(msgs[0].content, "My [REDACTED] is here")
  const meta = filtered.metadata as Record<string, string>
  assert.equal(meta.note, "Has [REDACTED] inside")
})

await test("DataRedactor: deep redaction on arrays of strings", () => {
  const config: RetentionConfig = {
    ...DEFAULT_RETENTION_CONFIG,
    prompts: true,
    redaction_patterns: ["api-key-\\w+"],
  }
  const redactor = new DataRedactor(config)
  const entry = {
    prompt_content: "test",
    tags: ["safe", "api-key-secret", "clean"],
  }
  const filtered = redactor.filterLedgerEntry(entry)
  const tags = filtered.tags as string[]
  assert.equal(tags[0], "safe")
  assert.equal(tags[1], "[REDACTED]")
  assert.equal(tags[2], "clean")
})

await test("resolveRetentionConfig: applies provider override", () => {
  const overrides: RetentionOverride[] = [{ provider: "openai", config: { prompts: true } }]
  const result = resolveRetentionConfig(DEFAULT_RETENTION_CONFIG, overrides, "openai")
  assert.equal(result.prompts, true)
  assert.equal(result.responses, false)
})

await test("resolveRetentionConfig: agent+provider override preferred", () => {
  const overrides: RetentionOverride[] = [
    { agent: "my-agent", config: { prompts: true, responses: false } },
    { agent: "my-agent", provider: "openai", config: { prompts: true, responses: true } },
  ]
  const result = resolveRetentionConfig(DEFAULT_RETENTION_CONFIG, overrides, "openai", "my-agent")
  assert.equal(result.responses, true, "Agent+provider override should win")
})

await test("resolveRetentionConfig: agent-only override works when no provider match", () => {
  const overrides: RetentionOverride[] = [
    { agent: "my-agent", config: { thinking_traces: true } },
  ]
  const result = resolveRetentionConfig(DEFAULT_RETENTION_CONFIG, overrides, "unknown", "my-agent")
  assert.equal(result.thinking_traces, true)
})

await test("DataRedactor: retainsContent reflects config", () => {
  const r1 = new DataRedactor(DEFAULT_RETENTION_CONFIG)
  assert.equal(r1.retainsContent(), false)
  const r2 = new DataRedactor({ ...DEFAULT_RETENTION_CONFIG, thinking_traces: true })
  assert.equal(r2.retainsContent(), true)
})

// =============================================
// T-3.2: vLLM Fallback Routing Tests
// =============================================

console.log("\n--- VllmFallbackRouter Tests (T-3.2) ---")

import {
  VllmFallbackRouter,
  buildVllmProviderEntry,
  VLLM_PROVIDER_NAME,
  DEFAULT_VLLM_CONFIG,
} from "../../src/hounfour/vllm-routing.js"
import { FullHealthProber } from "../../src/hounfour/health.js"

await test("VllmFallbackRouter: routes to primary when healthy", () => {
  const health = new FullHealthProber({ unhealthy_threshold: 3 })
  const router = new VllmFallbackRouter(DEFAULT_VLLM_CONFIG, health)
  const result = router.resolve()
  assert.ok(result)
  assert.equal(result.resolved.modelId, "qwen-7b")
  assert.equal(result.baseUrl, DEFAULT_VLLM_CONFIG.primaryEndpoint)
})

await test("VllmFallbackRouter: falls back to 1.5B when 7B unhealthy", () => {
  const health = new FullHealthProber({ unhealthy_threshold: 2 })
  const err = new Error("connection refused")
  ;(err as any).statusCode = 503
  health.recordFailure(VLLM_PROVIDER_NAME, "qwen-7b", err)
  health.recordFailure(VLLM_PROVIDER_NAME, "qwen-7b", err)

  const router = new VllmFallbackRouter(DEFAULT_VLLM_CONFIG, health)
  const result = router.resolve()
  assert.ok(result)
  assert.equal(result.resolved.modelId, "qwen-1.5b")
  assert.equal(result.baseUrl, DEFAULT_VLLM_CONFIG.fallbackEndpoint)
})

await test("VllmFallbackRouter: returns null when all unhealthy", () => {
  const health = new FullHealthProber({ unhealthy_threshold: 1 })
  const err = new Error("down")
  ;(err as any).statusCode = 503
  health.recordFailure(VLLM_PROVIDER_NAME, "qwen-7b", err)
  health.recordFailure(VLLM_PROVIDER_NAME, "qwen-1.5b", err)

  const router = new VllmFallbackRouter(DEFAULT_VLLM_CONFIG, health)
  const result = router.resolve()
  assert.equal(result, null)
})

await test("VllmFallbackRouter: recovery routes back to primary", () => {
  const health = new FullHealthProber({ unhealthy_threshold: 2, recovery_threshold: 1, recovery_interval_ms: 0 })
  const err = new Error("timeout")
  ;(err as any).statusCode = 503
  health.recordFailure(VLLM_PROVIDER_NAME, "qwen-7b", err)
  health.recordFailure(VLLM_PROVIDER_NAME, "qwen-7b", err)
  health.recordSuccess(VLLM_PROVIDER_NAME, "qwen-7b")

  const router = new VllmFallbackRouter(DEFAULT_VLLM_CONFIG, health)
  const result = router.resolve()
  assert.ok(result)
  assert.equal(result.resolved.modelId, "qwen-7b")
})

await test("buildVllmProviderEntry: creates valid provider entry", () => {
  const entry = buildVllmProviderEntry(DEFAULT_VLLM_CONFIG)
  assert.equal(entry.name, VLLM_PROVIDER_NAME)
  assert.equal(entry.type, "openai-compatible")
  assert.ok(entry.models.has("qwen-7b"))
  assert.ok(entry.models.has("qwen-1.5b"))
  assert.equal(entry.models.get("qwen-7b")!.capabilities.streaming, true)
})

await test("VllmFallbackRouter: getApiModelId returns full model names", () => {
  const health = new FullHealthProber()
  const router = new VllmFallbackRouter(DEFAULT_VLLM_CONFIG, health)
  assert.equal(router.getApiModelId("qwen-7b"), "Qwen/Qwen2.5-Coder-7B-Instruct")
  assert.equal(router.getApiModelId("qwen-1.5b"), "Qwen/Qwen2.5-Coder-1.5B-Instruct")
})

// =============================================
// T-3.6: Active Health Probes Tests
// =============================================

console.log("\n--- ActiveHealthProber Tests (T-3.6) ---")

import {
  ActiveHealthProber,
  DEFAULT_ACTIVE_HEALTH_CONFIG,
  type ActiveHealthConfig,
} from "../../src/hounfour/active-health.js"

await test("ActiveHealthProber: does not start when disabled", () => {
  const health = new FullHealthProber()
  const prober = new ActiveHealthProber({ ...DEFAULT_ACTIVE_HEALTH_CONFIG }, health)
  prober.start()
  prober.stop()
  // Should not throw
})

await test("ActiveHealthProber: getSnapshot defaults unknown to unhealthy", () => {
  const health = new FullHealthProber()
  const config: ActiveHealthConfig = {
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    endpoints: [{ name: "test-ep", provider: "test", modelId: "model", healthUrl: "http://localhost:9999/health" }],
  }
  const prober = new ActiveHealthProber(config, health)
  const snap = prober.getSnapshot()
  assert.equal(snap["test-ep"].healthy, false, "Unknown endpoint should default to unhealthy")
})

await test("ActiveHealthProber: getSnapshot reflects circuit breaker state", () => {
  const health = new FullHealthProber({ unhealthy_threshold: 1 })
  const config: ActiveHealthConfig = {
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    endpoints: [{ name: "test-ep", provider: "test", modelId: "model", healthUrl: "http://localhost:9999/health" }],
  }
  // Record a success so the entry exists
  health.recordSuccess("test", "model")
  const prober = new ActiveHealthProber(config, health)
  const snap = prober.getSnapshot()
  assert.equal(snap["test-ep"].healthy, true, "CLOSED state should be healthy")
})

await test("ActiveHealthProber: parsePrometheusMetrics handles standard format", () => {
  const health = new FullHealthProber()
  const prober = new ActiveHealthProber({ ...DEFAULT_ACTIVE_HEALTH_CONFIG }, health)
  const parser = (prober as any).parsePrometheusMetrics.bind(prober)

  const text = [
    "# HELP vllm:gpu_cache_usage_perc GPU cache usage",
    "# TYPE vllm:gpu_cache_usage_perc gauge",
    "vllm:gpu_cache_usage_perc 0.85",
    "vllm:avg_generation_throughput_toks_per_s 42.5",
    "vllm:num_requests_waiting 3",
    "vllm:num_requests_running 2",
  ].join("\n")

  const metrics = parser(text)
  assert.equal(metrics.gpuUtilization, 0.85)
  assert.equal(metrics.tokensPerSecond, 42.5)
  assert.equal(metrics.pendingRequests, 3)
  assert.equal(metrics.runningRequests, 2)
})

await test("ActiveHealthProber: parsePrometheusMetrics computes avg latency from sum/count", () => {
  const health = new FullHealthProber()
  const prober = new ActiveHealthProber({ ...DEFAULT_ACTIVE_HEALTH_CONFIG }, health)
  const parser = (prober as any).parsePrometheusMetrics.bind(prober)

  const text = [
    "vllm:e2e_request_latency_seconds_sum 10.0",
    "vllm:e2e_request_latency_seconds_count 5",
  ].join("\n")

  const metrics = parser(text)
  assert.equal(metrics.inferenceLatencyMs, 2000, "10s / 5 = 2s = 2000ms")
})

await test("ActiveHealthProber: parsePrometheusMetrics strips labels", () => {
  const health = new FullHealthProber()
  const prober = new ActiveHealthProber({ ...DEFAULT_ACTIVE_HEALTH_CONFIG }, health)
  const parser = (prober as any).parsePrometheusMetrics.bind(prober)

  const text = 'vllm:num_requests_running{model="qwen"} 7'
  const metrics = parser(text)
  assert.equal(metrics.runningRequests, 7)
})

await test("ActiveHealthProber: parsePrometheusMetrics handles empty input", () => {
  const health = new FullHealthProber()
  const prober = new ActiveHealthProber({ ...DEFAULT_ACTIVE_HEALTH_CONFIG }, health)
  const parser = (prober as any).parsePrometheusMetrics.bind(prober)
  const metrics = parser("")
  assert.equal(metrics.gpuUtilization, undefined)
  assert.equal(metrics.inferenceLatencyMs, undefined)
})

// =============================================
// Summary
// =============================================

console.log(`\n--- Phase 3 Sprint 3 Tests: ${passed} passed, ${failed} failed ---`)
if (failed > 0) process.exit(1)
