// tests/finn/store-quarantine.test.ts — QuarantineRecord sidecar tests (Sprint 6 T-6.4)

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Value } from "@sinclair/typebox/value"
import "../../src/hounfour/typebox-formats.js"
import { AtomicJsonStore } from "../../src/cron/store.js"
import { QuarantineRecordSchema } from "../../src/hounfour/protocol-types.js"

let testDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `store-quarantine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("AtomicJsonStore quarantine sidecar (T-6.4)", () => {
  it("writes QuarantineRecord to .quarantine.jsonl when file is corrupt", async () => {
    const filePath = join(testDir, "data.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    // Write valid data first
    await store.write({ v: 1 })

    // Corrupt the primary file
    await writeFile(filePath, "NOT VALID JSON {{{", "utf-8")

    // Read triggers quarantine (primary corrupt, no backup since .bak was renamed away)
    // Also corrupt the .bak file to force full quarantine
    await writeFile(filePath + ".bak", "ALSO CORRUPT", "utf-8")

    try {
      await store.read()
    } catch {
      // Expected: StoreCorruptionError
    }

    // Verify quarantine sidecar was written
    const quarantinePath = filePath + ".quarantine.jsonl"
    const raw = await readFile(quarantinePath, "utf-8")
    const lines = raw.trim().split("\n").filter(Boolean)

    // At least one quarantine record should exist
    expect(lines.length).toBeGreaterThanOrEqual(1)

    // Each record should validate against QuarantineRecordSchema
    for (const line of lines) {
      const record = JSON.parse(line)
      expect(Value.Check(QuarantineRecordSchema, record)).toBe(true)
      expect(record.resource_type).toBe("json_store")
      expect(record.resource_id).toBe(filePath)
      expect(record.status).toBe("active")
      expect(record.resolution_notes).toMatch(/Corrupt file moved to/)
    }
  })

  it("does not create .quarantine.jsonl when no corruption occurs", async () => {
    const filePath = join(testDir, "clean.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    await store.write({ v: 1 })
    const data = await store.read()
    expect(data).toEqual({ v: 1 })

    // No quarantine sidecar should exist
    const quarantinePath = filePath + ".quarantine.jsonl"
    await expect(readFile(quarantinePath, "utf-8")).rejects.toThrow()
  })

  it("existing store corruption tests still pass (read falls back to .bak)", async () => {
    const filePath = join(testDir, "fallback.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    await store.write({ v: 1 })
    await store.write({ v: 2 }) // Creates .bak of v:1

    // Corrupt primary, .bak should still have v:1
    await writeFile(filePath, "CORRUPT", "utf-8")

    const data = await store.read()
    expect(data).toEqual({ v: 1 })
  })
})
