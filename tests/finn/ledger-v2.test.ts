// tests/finn/ledger-v2.test.ts — JSONL Ledger V2 tests (Task 2.2a)
//
// BB-PR63-F004: Multi-process limitation — these tests validate the single-writer
// mutex (per-tenant Promise chain) and O_APPEND atomicity within a single Node
// process. They do NOT test multi-process concurrent appends, which would require
// spawning multiple workers writing to the same file. The POSIX O_APPEND guarantee
// (atomic writes < PIPE_BUF = 4096 bytes) is the safety net for multi-process
// scenarios, and the maxEntryBytes config enforces this limit.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import {
  LedgerV2,
  crc32,
  verifyCrc32,
  stampCrc32,
  type LedgerV2Config,
} from "../../src/hounfour/ledger-v2.js"
import type { LedgerEntryV2 } from "../../src/hounfour/types.js"

// --- Test Helpers ---

function testDir(): string {
  return join(tmpdir(), `ledger-v2-test-${randomUUID()}`)
}

function makeEntry(overrides: Partial<LedgerEntryV2> = {}): LedgerEntryV2 {
  return {
    schema_version: 2,
    timestamp: new Date().toISOString(),
    trace_id: randomUUID(),
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
    input_cost_micro: "250",
    output_cost_micro: "500",
    reasoning_cost_micro: "0",
    total_cost_micro: "750",
    price_table_version: 1,
    billing_method: "provider_reported",
    latency_ms: 150,
    ...overrides,
  }
}

function makeLedger(baseDir: string, overrides: Partial<LedgerV2Config> = {}): LedgerV2 {
  return new LedgerV2({ baseDir, fsync: false, ...overrides })
}

// --- CRC32 ---

describe("CRC32", () => {
  it("produces consistent 8-char hex output", () => {
    const hash = crc32("hello world")
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
    expect(hash).toBe(crc32("hello world")) // deterministic
  })

  it("different inputs produce different hashes", () => {
    expect(crc32("hello")).not.toBe(crc32("world"))
  })

  it("empty string produces valid hash", () => {
    const hash = crc32("")
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it("matches known CRC32 value for 'hello'", () => {
    // CRC32 of "hello" = 0x3610a686
    expect(crc32("hello")).toBe("3610a686")
  })
})

describe("stampCrc32 / verifyCrc32", () => {
  it("stamps CRC32 on entry", () => {
    const entry = makeEntry()
    expect(entry.crc32).toBeUndefined()
    const stamped = stampCrc32(entry)
    expect(stamped.crc32).toMatch(/^[0-9a-f]{8}$/)
  })

  it("stamped entry passes verification", () => {
    const entry = makeEntry()
    const stamped = stampCrc32(entry)
    expect(verifyCrc32(stamped)).toBe(true)
  })

  it("tampered entry fails verification", () => {
    const entry = makeEntry()
    const stamped = stampCrc32(entry)
    stamped.total_cost_micro = "9999999"
    expect(verifyCrc32(stamped)).toBe(false)
  })

  it("entry without CRC32 fails verification", () => {
    const entry = makeEntry()
    expect(verifyCrc32(entry)).toBe(false)
  })

  it("does not mutate original entry", () => {
    const entry = makeEntry()
    const stamped = stampCrc32(entry)
    expect(entry.crc32).toBeUndefined()
    expect(stamped.crc32).toBeDefined()
  })
})

// --- LedgerV2 Core ---

describe("LedgerV2", () => {
  let dir: string
  let ledger: LedgerV2

  beforeEach(() => {
    dir = testDir()
    ledger = makeLedger(dir)
  })

  afterEach(() => {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // --- Append ---

  describe("append", () => {
    it("creates tenant directory and usage.jsonl", async () => {
      const entry = makeEntry()
      await ledger.append("tenant-abc", entry)

      const filePath = join(dir, "tenant-abc", "usage.jsonl")
      expect(existsSync(filePath)).toBe(true)
    })

    it("writes valid JSONL with CRC32", async () => {
      const entry = makeEntry()
      await ledger.append("tenant-abc", entry)

      const filePath = join(dir, "tenant-abc", "usage.jsonl")
      const content = readFileSync(filePath, "utf8")
      const lines = content.split("\n").filter(l => l.trim())
      expect(lines).toHaveLength(1)

      const parsed = JSON.parse(lines[0]) as LedgerEntryV2
      expect(parsed.schema_version).toBe(2)
      expect(parsed.crc32).toMatch(/^[0-9a-f]{8}$/)
      expect(verifyCrc32(parsed)).toBe(true)
    })

    it("appends multiple entries sequentially", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t2" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t3" }))

      const count = await ledger.countEntries("tenant-abc")
      expect(count).toBe(3)
    })

    it("isolates entries per tenant", async () => {
      await ledger.append("tenant-a", makeEntry())
      await ledger.append("tenant-b", makeEntry())
      await ledger.append("tenant-a", makeEntry())

      expect(await ledger.countEntries("tenant-a")).toBe(2)
      expect(await ledger.countEntries("tenant-b")).toBe(1)
    })

    it("rejects oversized entries", async () => {
      const bigEntry = makeEntry({
        agent: "x".repeat(5000),
      })
      await expect(ledger.append("tenant-abc", bigEntry))
        .rejects.toThrow("LEDGER_ENTRY_TOO_LARGE")
    })

    it("preserves string micro-USD values exactly", async () => {
      const entry = makeEntry({
        input_cost_micro: "123456789012345",
        output_cost_micro: "987654321098765",
        total_cost_micro: "1111111110111110",
      })
      await ledger.append("tenant-abc", entry)

      const entries: LedgerEntryV2[] = []
      for await (const e of ledger.scanEntries("tenant-abc")) {
        entries.push(e)
      }
      expect(entries[0].input_cost_micro).toBe("123456789012345")
      expect(entries[0].output_cost_micro).toBe("987654321098765")
      expect(entries[0].total_cost_micro).toBe("1111111110111110")
    })

    it("handles concurrent appends for same tenant (serialized)", async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        ledger.append("tenant-abc", makeEntry({ trace_id: `concurrent-${i}` }))
      )
      await Promise.all(promises)

      const count = await ledger.countEntries("tenant-abc")
      expect(count).toBe(20)

      // Verify all entries are valid JSONL
      const filePath = join(dir, "tenant-abc", "usage.jsonl")
      const content = readFileSync(filePath, "utf8")
      const lines = content.split("\n").filter(l => l.trim())
      for (const line of lines) {
        const parsed = JSON.parse(line) as LedgerEntryV2
        expect(parsed.schema_version).toBe(2)
        expect(verifyCrc32(parsed)).toBe(true)
      }
    })

    it("handles concurrent appends for different tenants in parallel", async () => {
      const promises = [
        ledger.append("tenant-a", makeEntry({ trace_id: "a-1" })),
        ledger.append("tenant-b", makeEntry({ trace_id: "b-1" })),
        ledger.append("tenant-c", makeEntry({ trace_id: "c-1" })),
        ledger.append("tenant-a", makeEntry({ trace_id: "a-2" })),
        ledger.append("tenant-b", makeEntry({ trace_id: "b-2" })),
      ]
      await Promise.all(promises)

      expect(await ledger.countEntries("tenant-a")).toBe(2)
      expect(await ledger.countEntries("tenant-b")).toBe(2)
      expect(await ledger.countEntries("tenant-c")).toBe(1)
    })
  })

  // --- Tenant ID Validation ---

  describe("tenant ID validation", () => {
    it("rejects empty tenant ID", async () => {
      await expect(ledger.append("", makeEntry()))
        .rejects.toThrow("LEDGER_INVALID_TENANT")
    })

    it("rejects path traversal", async () => {
      await expect(ledger.append("../etc", makeEntry()))
        .rejects.toThrow("LEDGER_INVALID_TENANT")
    })

    it("rejects slashes", async () => {
      await expect(ledger.append("tenant/sub", makeEntry()))
        .rejects.toThrow("LEDGER_INVALID_TENANT")
    })

    it("rejects special characters", async () => {
      await expect(ledger.append("tenant@foo", makeEntry()))
        .rejects.toThrow("LEDGER_INVALID_TENANT")
    })

    it("accepts alphanumeric with hyphens and underscores", async () => {
      await expect(ledger.append("tenant-abc_123", makeEntry()))
        .resolves.toBeUndefined()
    })
  })

  // --- Recovery ---

  describe("recover", () => {
    it("returns zeros for nonexistent file", async () => {
      const result = await ledger.recover("nonexistent")
      expect(result).toEqual({
        entriesRecovered: 0,
        linesTruncated: 0,
        corruptedEntries: 0,
      })
    })

    it("recovers valid entries unchanged", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t2" }))

      const result = await ledger.recover("tenant-abc")
      expect(result.entriesRecovered).toBe(2)
      expect(result.linesTruncated).toBe(0)
      expect(result.corruptedEntries).toBe(0)
    })

    it("truncates partial last line", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1" }))

      // Simulate crash: append partial JSON
      const filePath = ledger.tenantFilePath("tenant-abc")
      const content = readFileSync(filePath, "utf8")
      writeFileSync(filePath, content + '{"schema_version":2,"trace_id":"partial')

      const result = await ledger.recover("tenant-abc")
      expect(result.entriesRecovered).toBe(1)
      expect(result.linesTruncated).toBe(1)
    })

    it("detects CRC32 corruption", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t2" }))

      // Tamper with second entry's cost
      const filePath = ledger.tenantFilePath("tenant-abc")
      const content = readFileSync(filePath, "utf8")
      const lines = content.split("\n").filter(l => l.trim())
      const entry2 = JSON.parse(lines[1]) as LedgerEntryV2
      entry2.total_cost_micro = "9999999" // tamper without updating CRC
      lines[1] = JSON.stringify(entry2)
      writeFileSync(filePath, lines.join("\n") + "\n")

      const result = await ledger.recover("tenant-abc")
      expect(result.entriesRecovered).toBe(1) // only first entry survives
      expect(result.corruptedEntries).toBe(1)
    })

    it("rejects non-v2 schema entries", async () => {
      const filePath = ledger.tenantFilePath("tenant-abc")
      mkdirSync(dirname(filePath), { recursive: true })

      // Write a v1 entry (schema_version missing or 1)
      const v1Entry = { timestamp: new Date().toISOString(), trace_id: "v1", total_cost_usd: 0.5 }
      writeFileSync(filePath, JSON.stringify(v1Entry) + "\n")

      const result = await ledger.recover("tenant-abc")
      expect(result.entriesRecovered).toBe(0)
      expect(result.corruptedEntries).toBe(1)
    })

    it("handles file with only empty lines", async () => {
      const filePath = ledger.tenantFilePath("tenant-abc")
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, "\n\n\n")

      const result = await ledger.recover("tenant-abc")
      expect(result.entriesRecovered).toBe(0)
    })
  })

  // --- Recompute ---

  describe("recompute", () => {
    it("returns zeros for nonexistent file", async () => {
      const result = await ledger.recompute("nonexistent")
      expect(result).toEqual({
        totalEntries: 0,
        duplicatesRemoved: 0,
        totalCostMicro: 0n,
      })
    })

    it("sums costs correctly", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1", total_cost_micro: "1000" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t2", total_cost_micro: "2000" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t3", total_cost_micro: "3000" }))

      const result = await ledger.recompute("tenant-abc")
      expect(result.totalEntries).toBe(3)
      expect(result.totalCostMicro).toBe(6000n)
      expect(result.duplicatesRemoved).toBe(0)
    })

    it("deduplicates by trace_id", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "dup-1", total_cost_micro: "1000" }))
      // Manually append a duplicate trace_id
      const filePath = ledger.tenantFilePath("tenant-abc")
      const dupEntry = stampCrc32(makeEntry({ trace_id: "dup-1", total_cost_micro: "1000" }))
      const dupLine = JSON.stringify(dupEntry) + "\n"
      writeFileSync(filePath, readFileSync(filePath, "utf8") + dupLine)

      const result = await ledger.recompute("tenant-abc")
      expect(result.totalEntries).toBe(1)
      expect(result.duplicatesRemoved).toBe(1)
      expect(result.totalCostMicro).toBe(1000n) // counted once
    })

    it("handles large micro-USD values", async () => {
      await ledger.append("tenant-abc", makeEntry({
        trace_id: "t1",
        total_cost_micro: "999999999999",
      }))
      await ledger.append("tenant-abc", makeEntry({
        trace_id: "t2",
        total_cost_micro: "1",
      }))

      const result = await ledger.recompute("tenant-abc")
      expect(result.totalCostMicro).toBe(1000000000000n)
    })
  })

  // --- Rotation ---

  describe("rotate", () => {
    it("returns null for nonexistent file", async () => {
      const result = await ledger.rotate("nonexistent")
      expect(result).toBeNull()
    })

    it("returns null when file is fresh", async () => {
      await ledger.append("tenant-abc", makeEntry())
      // File was just created, age < 1 day
      const result = await ledger.rotate("tenant-abc")
      expect(result).toBeNull()
    })

    it("returns null for empty file", async () => {
      const filePath = ledger.tenantFilePath("tenant-abc")
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, "")

      const result = await ledger.rotate("tenant-abc")
      expect(result).toBeNull()
    })

    it("rotates old file to compressed archive", async () => {
      // Use a ledger with 0-day rotation threshold for testing
      const fastLedger = makeLedger(dir, { rotationAgeDays: 0 })
      await fastLedger.append("tenant-abc", makeEntry())

      // Wait a tiny bit so age > 0
      await new Promise(r => setTimeout(r, 10))

      const result = await fastLedger.rotate("tenant-abc")
      expect(result).not.toBeNull()
      expect(result!).toMatch(/usage\.\d{4}-\d{2}-\d{2}\.jsonl\.gz$/)
      expect(existsSync(result!)).toBe(true)

      // Original file should be empty (truncated)
      const filePath = fastLedger.tenantFilePath("tenant-abc")
      const content = readFileSync(filePath, "utf8")
      expect(content).toBe("")
    })
  })

  // --- Scan Entries ---

  describe("scanEntries", () => {
    it("yields nothing for nonexistent file", async () => {
      const entries: LedgerEntryV2[] = []
      for await (const e of ledger.scanEntries("nonexistent")) {
        entries.push(e)
      }
      expect(entries).toHaveLength(0)
    })

    it("yields all valid entries", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1" }))
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t2" }))

      const entries: LedgerEntryV2[] = []
      for await (const e of ledger.scanEntries("tenant-abc")) {
        entries.push(e)
      }
      expect(entries).toHaveLength(2)
      expect(entries[0].trace_id).toBe("t1")
      expect(entries[1].trace_id).toBe("t2")
    })

    it("skips malformed lines", async () => {
      await ledger.append("tenant-abc", makeEntry({ trace_id: "t1" }))

      // Inject a malformed line
      const filePath = ledger.tenantFilePath("tenant-abc")
      const content = readFileSync(filePath, "utf8")
      writeFileSync(filePath, content + "not-json\n")

      await ledger.append("tenant-abc", makeEntry({ trace_id: "t2" }))

      const entries: LedgerEntryV2[] = []
      for await (const e of ledger.scanEntries("tenant-abc")) {
        entries.push(e)
      }
      // t1 + t2 = 2 (malformed line skipped)
      expect(entries).toHaveLength(2)
    })
  })

  // --- Get Tenant IDs ---

  describe("getTenantIds", () => {
    it("returns empty for new ledger", async () => {
      const ids = await ledger.getTenantIds()
      expect(ids).toEqual([])
    })

    it("returns all tenant IDs sorted", async () => {
      await ledger.append("tenant-c", makeEntry())
      await ledger.append("tenant-a", makeEntry())
      await ledger.append("tenant-b", makeEntry())

      const ids = await ledger.getTenantIds()
      expect(ids).toEqual(["tenant-a", "tenant-b", "tenant-c"])
    })
  })

  // --- Entry Format Contract ---

  describe("entry format contract", () => {
    it("all required v2 fields are present after append+scan", async () => {
      const entry = makeEntry({
        nft_id: "nft-123",
        pool_id: "fast-code",
        ensemble_id: "ens-456",
      })
      await ledger.append("tenant-abc", entry)

      const entries: LedgerEntryV2[] = []
      for await (const e of ledger.scanEntries("tenant-abc")) {
        entries.push(e)
      }

      const e = entries[0]
      expect(e.schema_version).toBe(2)
      expect(e.timestamp).toBeTruthy()
      expect(e.trace_id).toBeTruthy()
      expect(e.agent).toBe("test-agent")
      expect(e.provider).toBe("openai")
      expect(e.model).toBe("gpt-4o")
      expect(e.project_id).toBe("proj-1")
      expect(e.phase_id).toBe("phase-1")
      expect(e.sprint_id).toBe("sprint-1")
      expect(e.tenant_id).toBe("tenant-abc")
      expect(e.nft_id).toBe("nft-123")
      expect(e.pool_id).toBe("fast-code")
      expect(e.ensemble_id).toBe("ens-456")
      expect(e.prompt_tokens).toBe(100)
      expect(e.completion_tokens).toBe(50)
      expect(e.reasoning_tokens).toBe(0)
      expect(e.input_cost_micro).toBe("250")
      expect(e.output_cost_micro).toBe("500")
      expect(e.reasoning_cost_micro).toBe("0")
      expect(e.total_cost_micro).toBe("750")
      expect(e.price_table_version).toBe(1)
      expect(e.billing_method).toBe("provider_reported")
      expect(e.crc32).toMatch(/^[0-9a-f]{8}$/)
      expect(e.latency_ms).toBe(150)
    })

    it("billing_method accepts all valid values", async () => {
      for (const method of ["provider_reported", "byte_estimated", "reconciled"] as const) {
        await ledger.append(`tenant-${method}`, makeEntry({ billing_method: method }))
        const entries: LedgerEntryV2[] = []
        for await (const e of ledger.scanEntries(`tenant-${method}`)) {
          entries.push(e)
        }
        expect(entries[0].billing_method).toBe(method)
      }
    })
  })

  // --- Edge Cases ---

  describe("edge cases", () => {
    it("handles entry with zero tokens", async () => {
      const entry = makeEntry({
        prompt_tokens: 0,
        completion_tokens: 0,
        reasoning_tokens: 0,
        input_cost_micro: "0",
        output_cost_micro: "0",
        reasoning_cost_micro: "0",
        total_cost_micro: "0",
      })
      await ledger.append("tenant-abc", entry)

      const result = await ledger.recompute("tenant-abc")
      expect(result.totalCostMicro).toBe(0n)
    })

    it("handles rapid sequential appends", async () => {
      for (let i = 0; i < 100; i++) {
        await ledger.append("tenant-abc", makeEntry({ trace_id: `rapid-${i}` }))
      }
      expect(await ledger.countEntries("tenant-abc")).toBe(100)
    })
  })
})

function dirname(filePath: string): string {
  return join(filePath, "..")
}
