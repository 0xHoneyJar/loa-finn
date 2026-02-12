// tests/finn/budget-migration.test.ts — Budget migration v1→v2 tests (Task 2.3)
import { describe, it, expect, beforeEach } from "vitest"
import {
  convertV1ToV2,
  verifyMigration,
  migrateV1ToV2,
  dualWriteV2,
} from "../../src/hounfour/budget-migration.js"
import { LedgerV2 } from "../../src/hounfour/ledger-v2.js"
import type { LedgerEntry } from "../../src/hounfour/types.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// --- Helpers ---

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "budget-migration-test-"))
}

function makeV1Entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: "2026-02-10T12:00:00Z",
    trace_id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    agent: "test-agent",
    provider: "openai",
    model: "gpt-4o",
    project_id: "proj-1",
    phase_id: "phase-1",
    sprint_id: "sprint-1",
    tenant_id: "tenant-abc",
    prompt_tokens: 100,
    completion_tokens: 50,
    reasoning_tokens: 0,
    input_cost_usd: 0.0003,
    output_cost_usd: 0.0006,
    total_cost_usd: 0.0009,
    latency_ms: 500,
    ...overrides,
  }
}

function writeV1Ledger(dir: string, entries: LedgerEntry[]): string {
  const filePath = join(dir, "cost-ledger.jsonl")
  const content = entries.map(e => JSON.stringify(e)).join("\n") + "\n"
  writeFileSync(filePath, content, "utf8")
  return filePath
}

class MockRedisStore {
  store = new Map<string, string>()
  async get(key: string) { return this.store.get(key) ?? null }
  async set(key: string, value: string, ...args: (string | number)[]) {
    this.store.set(key, value)
    return "OK"
  }
  async del(...keys: string[]) { return keys.filter(k => this.store.delete(k)).length }
  async incrby(key: string, inc: number) {
    const cur = parseInt(this.store.get(key) ?? "0", 10)
    const newVal = cur + inc
    this.store.set(key, String(newVal))
    return newVal
  }
  async incrbyfloat(key: string, inc: number) { return "0" }
  async expire() { return 1 }
  async exists(...keys: string[]) { return keys.filter(k => this.store.has(k)).length }
  async ping() { return "PONG" }
  async eval() { return null }
  async hgetall() { return {} }
  async hincrby() { return 0 }
  async zadd() { return 0 }
  async zpopmin() { return [] as string[] }
  async zremrangebyscore() { return 0 }
  async zcard() { return 0 }
  async publish() { return 0 }
  async quit() { return "OK" }
}

function makeMockRedis(): { backend: RedisStateBackend; store: MockRedisStore } {
  const store = new MockRedisStore()
  const backend = {
    isConnected: () => true,
    getClient: () => store,
    key: (component: string, ...parts: string[]) =>
      `finn:hounfour:${component}:${parts.join(":")}`,
  } as unknown as RedisStateBackend
  return { backend, store }
}

// --- Tests ---

describe("convertV1ToV2", () => {
  it("converts basic entry with correct micro-USD values", () => {
    const v1 = makeV1Entry({
      input_cost_usd: 0.0003,
      output_cost_usd: 0.0006,
      total_cost_usd: 0.0009,
    })

    const result = convertV1ToV2(v1)

    expect(result.v2Entry.schema_version).toBe(2)
    expect(result.v2Entry.input_cost_micro).toBe("300")
    expect(result.v2Entry.output_cost_micro).toBe("600")
    expect(result.v2Entry.total_cost_micro).toBe("900")
    expect(result.v2Entry.reasoning_cost_micro).toBe("0")
  })

  it("preserves all metadata fields", () => {
    const v1 = makeV1Entry({
      trace_id: "trace-123",
      agent: "code-agent",
      nft_id: "nft-42",
      pool_id: "fast-code",
      ensemble_id: "ens-1",
    })

    const result = convertV1ToV2(v1)

    expect(result.v2Entry.trace_id).toBe("trace-123")
    expect(result.v2Entry.agent).toBe("code-agent")
    expect(result.v2Entry.nft_id).toBe("nft-42")
    expect(result.v2Entry.pool_id).toBe("fast-code")
    expect(result.v2Entry.ensemble_id).toBe("ens-1")
  })

  it("rounds to nearest micro-USD", () => {
    // 0.0000005 USD = 0.5 micro-USD → rounds to 1 (Math.round)
    const v1 = makeV1Entry({ total_cost_usd: 0.0000005 })
    const result = convertV1ToV2(v1)
    expect(result.v2Entry.total_cost_micro).toBe("1")
  })

  it("handles zero cost correctly", () => {
    const v1 = makeV1Entry({
      input_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: 0,
    })

    const result = convertV1ToV2(v1)

    expect(result.v2Entry.total_cost_micro).toBe("0")
    expect(result.roundingErrorMicro).toBe(0)
  })

  it("handles large cost values ($100)", () => {
    const v1 = makeV1Entry({ total_cost_usd: 100.0 })
    const result = convertV1ToV2(v1)
    expect(result.v2Entry.total_cost_micro).toBe("100000000")
    expect(result.convertedMicro).toBe(100_000_000n)
  })

  it("rounding error is at most 0.5 micro-USD per entry", () => {
    // Use a value that causes floating-point imprecision
    const v1 = makeV1Entry({ total_cost_usd: 0.1 + 0.2 }) // ≈ 0.30000000000000004
    const result = convertV1ToV2(v1)
    expect(result.roundingErrorMicro).toBeLessThanOrEqual(0.5)
  })

  it("sets billing_method to reconciled", () => {
    const result = convertV1ToV2(makeV1Entry())
    expect(result.v2Entry.billing_method).toBe("reconciled")
  })

  it("sets price_table_version to 1", () => {
    const result = convertV1ToV2(makeV1Entry())
    expect(result.v2Entry.price_table_version).toBe(1)
  })
})

describe("verifyMigration", () => {
  it("passes when totals match exactly", () => {
    const result = verifyMigration(1.5, 1_500_000n, 10)
    expect(result.passed).toBe(true)
    expect(result.driftMicro).toBe(0n)
  })

  it("passes when drift is within tolerance (1 micro per entry)", () => {
    // 10 entries, allow 10 micro-USD drift
    const result = verifyMigration(1.5, 1_500_008n, 10)
    expect(result.passed).toBe(true)
  })

  it("fails when drift exceeds tolerance", () => {
    // 10 entries, allow 10 micro-USD drift, actual drift 50
    const result = verifyMigration(1.5, 1_500_050n, 10)
    expect(result.passed).toBe(false)
    expect(result.driftMicro).toBe(50n)
  })

  it("handles zero entries", () => {
    const result = verifyMigration(0, 0n, 0)
    expect(result.passed).toBe(true)
  })

  it("handles v2 total less than expected", () => {
    const result = verifyMigration(1.5, 1_499_995n, 10)
    expect(result.passed).toBe(true) // drift = 5, allowed = 10
  })
})

describe("migrateV1ToV2", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  it("migrates entries from v1 to v2 format", async () => {
    const entries = [
      makeV1Entry({ total_cost_usd: 0.001, trace_id: "t1" }),
      makeV1Entry({ total_cost_usd: 0.002, trace_id: "t2" }),
      makeV1Entry({ total_cost_usd: 0.003, trace_id: "t3" }),
    ]
    const v1Path = writeV1Ledger(tempDir, entries)
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: v1Path,
      v2BaseDir: v2Dir,
    })

    expect(result.status).toBe("success")
    expect(result.entriesConverted).toBe(3)
    expect(result.verificationPassed).toBe(true)
    expect(result.totalV2CostMicro).toBe(6000n) // 1000 + 2000 + 3000
  })

  it("backs up v1 file after successful migration", async () => {
    const v1Path = writeV1Ledger(tempDir, [makeV1Entry()])
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: v1Path,
      v2BaseDir: v2Dir,
    })

    expect(existsSync(result.backupPath)).toBe(true)
    expect(existsSync(v1Path)).toBe(false) // Original renamed
  })

  it("writes v2 entries to per-tenant JSONL files", async () => {
    const entries = [
      makeV1Entry({ tenant_id: "t-A", total_cost_usd: 0.001, trace_id: "a1" }),
      makeV1Entry({ tenant_id: "t-B", total_cost_usd: 0.002, trace_id: "b1" }),
      makeV1Entry({ tenant_id: "t-A", total_cost_usd: 0.003, trace_id: "a2" }),
    ]
    const v1Path = writeV1Ledger(tempDir, entries)
    const v2Dir = join(tempDir, "v2")

    await migrateV1ToV2({ v1LedgerPath: v1Path, v2BaseDir: v2Dir })

    // Check per-tenant files
    const ledger = new LedgerV2({ baseDir: v2Dir, fsync: false })
    expect(await ledger.countEntries("t-A")).toBe(2)
    expect(await ledger.countEntries("t-B")).toBe(1)
  })

  it("skips already-v2 entries (dual-write scenario)", async () => {
    const v1Line = JSON.stringify(makeV1Entry({ trace_id: "v1-entry" }))
    const v2Line = JSON.stringify({
      schema_version: 2,
      timestamp: "2026-02-10T12:00:00Z",
      trace_id: "v2-entry",
      total_cost_micro: "500",
    })
    const filePath = join(tempDir, "mixed-ledger.jsonl")
    writeFileSync(filePath, `${v1Line}\n${v2Line}\n`, "utf8")
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: filePath,
      v2BaseDir: v2Dir,
    })

    expect(result.entriesConverted).toBe(1)
    expect(result.entriesSkipped).toBe(1)
  })

  it("dry run does not write files", async () => {
    const entries = [makeV1Entry({ total_cost_usd: 0.005 })]
    const v1Path = writeV1Ledger(tempDir, entries)
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: v1Path,
      v2BaseDir: v2Dir,
      dryRun: true,
    })

    expect(result.status).toBe("success")
    expect(result.entriesConverted).toBe(1)
    // V1 file should still exist (not renamed)
    expect(existsSync(v1Path)).toBe(true)
    // V2 dir should not exist
    expect(existsSync(v2Dir)).toBe(false)
  })

  it("handles missing v1 file gracefully", async () => {
    const result = await migrateV1ToV2({
      v1LedgerPath: join(tempDir, "nonexistent.jsonl"),
      v2BaseDir: join(tempDir, "v2"),
    })

    expect(result.status).toBe("error")
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("handles malformed v1 entries gracefully", async () => {
    const v1Line = JSON.stringify(makeV1Entry({ trace_id: "good" }))
    const filePath = join(tempDir, "malformed.jsonl")
    writeFileSync(filePath, `${v1Line}\n{broken json\n`, "utf8")
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: filePath,
      v2BaseDir: v2Dir,
    })

    expect(result.entriesConverted).toBe(1)
    expect(result.entriesSkipped).toBe(1)
    expect(result.errors.length).toBe(1)
  })

  it("migrates Redis counters when connected", async () => {
    const entries = [
      makeV1Entry({ tenant_id: "tenant-X", total_cost_usd: 0.01, trace_id: "r1" }),
      makeV1Entry({ tenant_id: "tenant-X", total_cost_usd: 0.02, trace_id: "r2" }),
    ]
    const v1Path = writeV1Ledger(tempDir, entries)
    const v2Dir = join(tempDir, "v2")
    const { backend, store } = makeMockRedis()

    const result = await migrateV1ToV2({
      v1LedgerPath: v1Path,
      v2BaseDir: v2Dir,
      redis: backend,
    })

    expect(result.status).toBe("success")

    // Redis should have tenant-X total: 10000 + 20000 = 30000 micro-USD
    const key = "finn:hounfour:budget:tenant-X:spent_micro"
    expect(store.store.get(key)).toBe("30000")
  })

  it("entries with local tenant (empty tenant_id)", async () => {
    const entries = [
      makeV1Entry({ tenant_id: "", total_cost_usd: 0.005, trace_id: "l1" }),
    ]
    // makeV1Entry({ tenant_id: "" }) already writes empty tenant_id to file.
    // Migration should map empty tenant_id → "local" as fallback.
    const v1Path = writeV1Ledger(tempDir, entries)
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: v1Path,
      v2BaseDir: v2Dir,
    })

    // Should use "local" as tenant_id fallback
    expect(result.status).toBe("success")
    expect(result.entriesConverted).toBe(1)
  })

  it("verification within 1 micro-USD per entry tolerance", async () => {
    // Create entries with values that cause float imprecision
    const entries = Array.from({ length: 100 }, (_, i) =>
      makeV1Entry({
        total_cost_usd: 0.000001 * (i + 1),
        input_cost_usd: 0.000001 * (i + 1) * 0.3,
        output_cost_usd: 0.000001 * (i + 1) * 0.7,
        trace_id: `precision-${i}`,
      })
    )
    const v1Path = writeV1Ledger(tempDir, entries)
    const v2Dir = join(tempDir, "v2")

    const result = await migrateV1ToV2({
      v1LedgerPath: v1Path,
      v2BaseDir: v2Dir,
    })

    expect(result.verificationPassed).toBe(true)
    expect(result.maxRoundingErrorMicro).toBeLessThanOrEqual(0.5)
  })
})

describe("dualWriteV2", () => {
  it("creates v2 entry from v1 entry for dual-write", () => {
    const v1 = makeV1Entry({ total_cost_usd: 0.015 })
    const v2 = dualWriteV2(v1)

    expect(v2.schema_version).toBe(2)
    expect(v2.total_cost_micro).toBe("15000")
    expect(v2.billing_method).toBe("reconciled")
  })

  it("preserves all token counts", () => {
    const v1 = makeV1Entry({
      prompt_tokens: 200,
      completion_tokens: 100,
      reasoning_tokens: 50,
    })
    const v2 = dualWriteV2(v1)

    expect(v2.prompt_tokens).toBe(200)
    expect(v2.completion_tokens).toBe(100)
    expect(v2.reasoning_tokens).toBe(50)
  })
})
