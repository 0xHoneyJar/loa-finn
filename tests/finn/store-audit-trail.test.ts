// tests/finn/store-audit-trail.test.ts — Audit trail hash chain tests (Sprint 5 T-5.6)

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AtomicJsonStore } from "../../src/cron/store.js"

let testDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `store-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("AtomicJsonStore audit trail (T-5.6)", () => {
  it("writes audit entries to .audit.jsonl sidecar on each write()", async () => {
    const filePath = join(testDir, "data.json")
    const store = new AtomicJsonStore<{ count: number }>(filePath, { auditTrail: true })

    await store.write({ count: 1 })
    await store.write({ count: 2 })
    await store.write({ count: 3 })

    const auditPath = filePath + ".audit.jsonl"
    const raw = await readFile(auditPath, "utf-8")
    const lines = raw.trim().split("\n").filter(Boolean)

    expect(lines).toHaveLength(3)

    // Each line should be valid JSON with expected fields
    for (const line of lines) {
      const entry = JSON.parse(line)
      expect(entry).toHaveProperty("entry_id")
      expect(entry).toHaveProperty("timestamp")
      expect(entry).toHaveProperty("event_type", "store.data.write")
      expect(entry).toHaveProperty("entry_hash")
      expect(entry).toHaveProperty("previous_hash")
      expect(entry).toHaveProperty("hash_domain_tag")
    }
  })

  it("chains previous_hash from AUDIT_TRAIL_GENESIS_HASH through entries", async () => {
    const filePath = join(testDir, "chain.json")
    const store = new AtomicJsonStore<{ n: number }>(filePath, { auditTrail: true })

    for (let i = 0; i < 5; i++) {
      await store.write({ n: i })
    }

    const raw = await readFile(filePath + ".audit.jsonl", "utf-8")
    const entries = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))

    expect(entries).toHaveLength(5)

    // First entry chains from genesis
    expect(entries[0].previous_hash).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )

    // Subsequent entries chain from the previous entry's hash
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].previous_hash).toBe(entries[i - 1].entry_hash)
    }
  })

  it("verifyIntegrity() passes for a valid 5-entry chain", async () => {
    const filePath = join(testDir, "verify.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath, { auditTrail: true })

    for (let i = 0; i < 5; i++) {
      await store.write({ v: i })
    }

    const result = await store.verifyIntegrity()
    expect(result.valid).toBe(true)
  })

  it("verifyIntegrity() fails when an entry hash is tampered", async () => {
    const filePath = join(testDir, "tamper.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath, { auditTrail: true })

    for (let i = 0; i < 5; i++) {
      await store.write({ v: i })
    }

    // Tamper with the third entry's hash
    const auditPath = filePath + ".audit.jsonl"
    const raw = await readFile(auditPath, "utf-8")
    const lines = raw.trim().split("\n").filter(Boolean)
    const entry = JSON.parse(lines[2])
    entry.entry_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    lines[2] = JSON.stringify(entry)
    await writeFile(auditPath, lines.join("\n") + "\n", "utf-8")

    const result = await store.verifyIntegrity()
    expect(result.valid).toBe(false)
  })

  it("verifyIntegrity() throws when audit trail is not enabled", async () => {
    const filePath = join(testDir, "noaudit.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    await expect(store.verifyIntegrity()).rejects.toThrow("Audit trail is not enabled")
  })

  it("does not create .audit.jsonl when auditTrail is false (default)", async () => {
    const filePath = join(testDir, "noaudit2.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    await store.write({ v: 1 })

    const auditPath = filePath + ".audit.jsonl"
    await expect(readFile(auditPath, "utf-8")).rejects.toThrow()
  })

  it("resumes hash chain after constructing a new store instance", async () => {
    const filePath = join(testDir, "resume.json")

    // Write 3 entries with first instance
    const store1 = new AtomicJsonStore<{ v: number }>(filePath, { auditTrail: true })
    for (let i = 0; i < 3; i++) {
      await store1.write({ v: i })
    }

    // Construct new instance (simulates process restart)
    const store2 = new AtomicJsonStore<{ v: number }>(filePath, { auditTrail: true })
    await store2.write({ v: 100 })
    await store2.write({ v: 200 })

    // Verify entire 5-entry chain is valid
    const result = await store2.verifyIntegrity()
    expect(result.valid).toBe(true)

    const raw = await readFile(filePath + ".audit.jsonl", "utf-8")
    const entries = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    expect(entries).toHaveLength(5)

    // Entry 4 (first from store2) should chain from entry 3's hash
    expect(entries[3].previous_hash).toBe(entries[2].entry_hash)
  })

  it("audit append failure does not roll back store write", async () => {
    const filePath = join(testDir, "resilient.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath, { auditTrail: true })

    // Write first entry successfully
    await store.write({ v: 1 })

    // Make audit path unwritable by replacing it with a directory
    const auditPath = filePath + ".audit.jsonl"
    const { rm: rmFs, mkdir: mkdirFs } = await import("node:fs/promises")
    await rmFs(auditPath)
    await mkdirFs(auditPath) // directory where file expected — appendFile will fail

    // Store write should succeed even though audit append fails
    await store.write({ v: 2 })

    // Verify the store data is correct
    const data = await store.read()
    expect(data).toEqual({ v: 2 })
  })
})
