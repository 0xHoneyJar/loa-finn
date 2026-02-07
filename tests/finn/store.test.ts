// tests/finn/store.test.ts — AtomicJsonStore tests (SDD §4.1)

import assert from "node:assert/strict"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  AtomicJsonStore,
  StoreCorruptionError,
  WriteSizeLimitError,
} from "../../src/cron/store.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

// Create a unique temp dir for each test run
let testDir: string

async function setup(): Promise<string> {
  const dir = join(tmpdir(), `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

async function main() {
  console.log("AtomicJsonStore Tests")
  console.log("=====================")

  // ── 1. Read/Write Basics ──────────────────────────────────

  console.log("\n--- Read/Write Basics ---")

  await test("read returns null when file does not exist", async () => {
    testDir = await setup()
    const store = new AtomicJsonStore(join(testDir, "missing.json"))
    const result = await store.read()
    assert.equal(result, null)
    await cleanup(testDir)
  })

  await test("write then read round-trips data", async () => {
    testDir = await setup()
    const filePath = join(testDir, "data.json")
    const store = new AtomicJsonStore<{ name: string; count: number }>(filePath)
    await store.write({ name: "test", count: 42 })
    const result = await store.read()
    assert.deepEqual(result, { count: 42, name: "test" }) // keys sorted
    await cleanup(testDir)
  })

  await test("write creates deterministic sorted-key JSON", async () => {
    testDir = await setup()
    const filePath = join(testDir, "sorted.json")
    const store = new AtomicJsonStore(filePath)
    await store.write({ z: 1, a: 2, m: 3 })
    const raw = await readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    const keys = Object.keys(parsed)
    assert.deepEqual(keys, ["a", "m", "z"])
    await cleanup(testDir)
  })

  await test("overwrite replaces previous data", async () => {
    testDir = await setup()
    const filePath = join(testDir, "overwrite.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)
    await store.write({ v: 1 })
    await store.write({ v: 2 })
    const result = await store.read()
    assert.deepEqual(result, { v: 2 })
    await cleanup(testDir)
  })

  // ── 2. Backup Recovery ────────────────────────────────────

  console.log("\n--- Backup Recovery ---")

  await test("read falls back to .bak when primary is corrupt JSON", async () => {
    testDir = await setup()
    const filePath = join(testDir, "fallback.json")
    const store = new AtomicJsonStore<{ ok: boolean }>(filePath)

    // Write valid data (creates .bak on second write)
    await store.write({ ok: true })
    await store.write({ ok: true }) // now .bak has first version

    // Corrupt the primary
    await writeFile(filePath, "NOT JSON {{{{", "utf-8")

    const result = await store.read()
    assert.deepEqual(result, { ok: true })
    await cleanup(testDir)
  })

  await test("read falls back to .bak when primary is missing but .bak exists", async () => {
    testDir = await setup()
    const filePath = join(testDir, "missing-primary.json")
    const bakPath = filePath + ".bak"

    // Manually create only the .bak
    await writeFile(bakPath, JSON.stringify({ recovered: true }), "utf-8")

    const store = new AtomicJsonStore<{ recovered: boolean }>(filePath)
    const result = await store.read()
    assert.deepEqual(result, { recovered: true })
    await cleanup(testDir)
  })

  await test("throws StoreCorruptionError when both primary and .bak are corrupt", async () => {
    testDir = await setup()
    const filePath = join(testDir, "both-corrupt.json")
    const bakPath = filePath + ".bak"

    await writeFile(filePath, "CORRUPT{{{", "utf-8")
    await writeFile(bakPath, "ALSO-CORRUPT", "utf-8")

    const store = new AtomicJsonStore(filePath)
    await assert.rejects(
      () => store.read(),
      (err: Error) => err instanceof StoreCorruptionError,
    )
    await cleanup(testDir)
  })

  await test("quarantines corrupt files (renames to .corrupt.{timestamp})", async () => {
    testDir = await setup()
    const filePath = join(testDir, "quarantine.json")
    const bakPath = filePath + ".bak"

    await writeFile(filePath, "BAD-PRIMARY", "utf-8")
    await writeFile(bakPath, "BAD-BACKUP", "utf-8")

    const store = new AtomicJsonStore(filePath)
    try { await store.read() } catch { /* expected StoreCorruptionError */ }

    // Original files should be gone, quarantine files should exist
    let primaryGone = false
    try { await stat(filePath) } catch { primaryGone = true }
    assert.equal(primaryGone, true, "primary should be quarantined")

    let bakGone = false
    try { await stat(bakPath) } catch { bakGone = true }
    assert.equal(bakGone, true, "backup should be quarantined")

    const files = await readdir(testDir)
    const quarantined = files.filter((f) => f.includes(".corrupt."))
    assert.equal(quarantined.length, 2, "should have 2 quarantined files")
    await cleanup(testDir)
  })

  // ── 3. Atomic Write Safety ────────────────────────────────

  console.log("\n--- Atomic Write Safety ---")

  await test("write creates .bak of previous file", async () => {
    testDir = await setup()
    const filePath = join(testDir, "atomic.json")
    const bakPath = filePath + ".bak"
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    await store.write({ v: 1 })
    // .bak shouldn't exist after first write (no previous to backup)
    let bakExists = false
    try {
      await stat(bakPath)
      bakExists = true
    } catch { /* expected */ }
    assert.equal(bakExists, false)

    // Second write should create .bak
    await store.write({ v: 2 })
    const bakRaw = await readFile(bakPath, "utf-8")
    const bakData = JSON.parse(bakRaw)
    assert.deepEqual(bakData, { v: 1 })
    await cleanup(testDir)
  })

  await test("no .tmp file remains after successful write", async () => {
    testDir = await setup()
    const filePath = join(testDir, "notmp.json")
    const tmpPath = filePath + ".tmp"
    const store = new AtomicJsonStore(filePath)
    await store.write({ clean: true })

    let tmpExists = false
    try {
      await stat(tmpPath)
      tmpExists = true
    } catch { /* expected */ }
    assert.equal(tmpExists, false)
    await cleanup(testDir)
  })

  // ── 4. Size Limit ─────────────────────────────────────────

  console.log("\n--- Size Limit ---")

  await test("write rejects data exceeding size limit", async () => {
    testDir = await setup()
    const filePath = join(testDir, "sizelimit.json")
    const store = new AtomicJsonStore(filePath, { maxSizeBytes: 50 })

    // This will serialize to more than 50 bytes
    const bigData = { key: "a".repeat(100) }
    await assert.rejects(
      () => store.write(bigData),
      (err: Error) => err instanceof WriteSizeLimitError,
    )
    await cleanup(testDir)
  })

  await test("write allows data within size limit", async () => {
    testDir = await setup()
    const filePath = join(testDir, "withinlimit.json")
    const store = new AtomicJsonStore(filePath, { maxSizeBytes: 1024 })
    await store.write({ small: true })
    const result = await store.read()
    assert.deepEqual(result, { small: true })
    await cleanup(testDir)
  })

  // ── 5. Schema Validation ──────────────────────────────────

  console.log("\n--- Schema Validation ---")

  await test("read throws StoreCorruptionError when data fails schema (no .bak)", async () => {
    testDir = await setup()
    const filePath = join(testDir, "schema.json")

    // Write raw data that won't match schema
    await writeFile(filePath, JSON.stringify({ wrong: "shape" }), "utf-8")

    // TypeBox schema requiring { name: string }
    const { Type } = await import("@sinclair/typebox")
    const schema = Type.Object({ name: Type.String() })
    const store = new AtomicJsonStore(filePath, { schema })

    // File exists but fails validation with no .bak — quarantines and throws
    await assert.rejects(
      () => store.read(),
      (err: Error) => err instanceof StoreCorruptionError,
    )
    await cleanup(testDir)
  })

  await test("read accepts data that passes schema validation", async () => {
    testDir = await setup()
    const filePath = join(testDir, "valid-schema.json")

    const { Type } = await import("@sinclair/typebox")
    const schema = Type.Object({ name: Type.String(), value: Type.Number() })
    const store = new AtomicJsonStore(filePath, { schema })

    await store.write({ name: "hello", value: 99 })
    const result = await store.read()
    assert.ok(result)
    assert.equal((result as { name: string }).name, "hello")
    await cleanup(testDir)
  })

  // ── 6. Migrations ─────────────────────────────────────────

  console.log("\n--- Migrations ---")

  await test("applies migration chain on read", async () => {
    testDir = await setup()
    const filePath = join(testDir, "migrate.json")

    // Write v0 data
    await writeFile(filePath, JSON.stringify({ _schemaVersion: 0, oldField: "hi" }), "utf-8")

    const migrations = new Map<number, (data: unknown) => unknown>()
    migrations.set(0, (data: unknown) => {
      const d = data as Record<string, unknown>
      return { _schemaVersion: 1, newField: d.oldField, migrated: true }
    })

    const store = new AtomicJsonStore(filePath, { migrations })
    const result = await store.read() as Record<string, unknown>
    assert.ok(result)
    assert.equal(result._schemaVersion, 1)
    assert.equal(result.newField, "hi")
    assert.equal(result.migrated, true)
    await cleanup(testDir)
  })

  await test("chained migrations apply in sequence (v1 -> v2 -> v3)", async () => {
    testDir = await setup()
    const filePath = join(testDir, "chain.json")

    // Write v1 data
    await writeFile(filePath, JSON.stringify({ _schemaVersion: 1, name: "chain", count: 1 }), "utf-8")

    const migrations = new Map<number, (data: unknown) => unknown>()
    migrations.set(1, (data: unknown) => {
      const d = data as Record<string, unknown>
      return { ...d, _schemaVersion: 2, label: "added-in-v2" }
    })
    migrations.set(2, (data: unknown) => {
      const d = data as Record<string, unknown>
      return { ...d, _schemaVersion: 3, active: true }
    })

    const store = new AtomicJsonStore(filePath, { migrations })
    const result = await store.read() as Record<string, unknown>
    assert.ok(result)
    assert.equal(result._schemaVersion, 3)
    assert.equal(result.label, "added-in-v2")
    assert.equal(result.active, true)
    assert.equal(result.name, "chain")
    await cleanup(testDir)
  })

  await test("data without _schemaVersion gets version 0 for migrations", async () => {
    testDir = await setup()
    const filePath = join(testDir, "nover.json")

    // Write legacy data without _schemaVersion
    await writeFile(filePath, JSON.stringify({ name: "legacy" }), "utf-8")

    const migrations = new Map<number, (data: unknown) => unknown>()
    migrations.set(0, (data: unknown) => {
      const d = data as Record<string, unknown>
      return { ...d, _schemaVersion: 1, upgraded: true }
    })

    const store = new AtomicJsonStore(filePath, { migrations })
    const result = await store.read() as Record<string, unknown>
    assert.ok(result)
    assert.equal(result._schemaVersion, 1)
    assert.equal(result.upgraded, true)
    assert.equal(result.name, "legacy")
    await cleanup(testDir)
  })

  // ── 7. Concurrent Writes ──────────────────────────────────

  console.log("\n--- Concurrent Writes ---")

  await test("concurrent writes are serialized (no data loss)", async () => {
    testDir = await setup()
    const filePath = join(testDir, "concurrent.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    // Fire 10 concurrent writes
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.write({ v: i }),
    )
    await Promise.all(writes)

    // One of them should win — data should be valid
    const result = await store.read()
    assert.ok(result)
    assert.ok(typeof result.v === "number")
    assert.ok(result.v >= 0 && result.v <= 9)
    await cleanup(testDir)
  })

  console.log("\nDone.")
}

main()
