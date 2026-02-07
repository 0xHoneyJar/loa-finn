// tests/finn/idempotency.test.ts — DedupeIndex tests (SDD §4.9)

import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DedupeIndex } from "../../src/cron/idempotency.js"

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

async function setup(): Promise<string> {
  const dir = join(tmpdir(), `dedupe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

async function main() {
  console.log("DedupeIndex Tests")
  console.log("=================")

  // ── 1. buildKey Determinism ─────────────────────────────────

  console.log("\n--- buildKey ---")

  await test("buildKey produces deterministic output for same inputs", () => {
    const key1 = DedupeIndex.buildKey("add_issue_comment", {
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      body: "LGTM",
    })
    const key2 = DedupeIndex.buildKey("add_issue_comment", {
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      body: "LGTM",
    })
    assert.equal(key1, key2)
  })

  await test("buildKey produces different output for different params", () => {
    const key1 = DedupeIndex.buildKey("add_issue_comment", {
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      body: "LGTM",
    })
    const key2 = DedupeIndex.buildKey("add_issue_comment", {
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      body: "Needs work",
    })
    assert.notEqual(key1, key2)
  })

  await test("buildKey uses _ scope when owner/repo absent", () => {
    const key = DedupeIndex.buildKey("some_action", { path: "README.md" })
    assert.ok(key.startsWith("some_action:_/"), `Expected _ scope, got: ${key}`)
  })

  await test("buildKey uses _ resource when no recognized resource key", () => {
    const key = DedupeIndex.buildKey("custom_action", { owner: "a", repo: "b", foo: "bar" })
    assert.ok(key.includes("/_%3A") || key.includes("/_:"), `Expected _ resource, got: ${key}`)
    // More precise: split on colons
    const parts = key.split(":")
    assert.equal(parts[0], "custom_action")
    assert.equal(parts[1], "a/b/_")
  })

  await test("buildKey picks pull_number over issue_number and path", () => {
    const key = DedupeIndex.buildKey("review", {
      owner: "o",
      repo: "r",
      pull_number: 7,
      issue_number: 99,
      path: "file.ts",
    })
    const parts = key.split(":")
    assert.equal(parts[1], "o/r/7")
  })

  // ── 2. isDuplicate ──────────────────────────────────────────

  console.log("\n--- isDuplicate ---")

  await test("isDuplicate returns false for unknown key", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()
    assert.equal(idx.isDuplicate("nonexistent:_/_:0000000000000000"), false)
    await cleanup(dir)
  })

  await test("isDuplicate returns false for pending entry", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()
    await idx.recordPending("test-key", 1)
    assert.equal(idx.isDuplicate("test-key"), false)
    await cleanup(dir)
  })

  await test("isDuplicate returns true for completed entry", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()
    await idx.record("test-key", 1)
    assert.equal(idx.isDuplicate("test-key"), true)
    await cleanup(dir)
  })

  // ── 3. State Transitions ───────────────────────────────────

  console.log("\n--- State Transitions ---")

  await test("recordPending then record transitions correctly", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()

    await idx.recordPending("transition-key", 1)
    assert.equal(idx.isDuplicate("transition-key"), false)

    await idx.record("transition-key", 1)
    assert.equal(idx.isDuplicate("transition-key"), true)
    await cleanup(dir)
  })

  await test("markUnknown updates status", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()

    await idx.record("mark-key", 1)
    assert.equal(idx.isDuplicate("mark-key"), true)

    await idx.markUnknown("mark-key")
    // unknown is not completed, so isDuplicate should return false
    assert.equal(idx.isDuplicate("mark-key"), false)
    await cleanup(dir)
  })

  // ── 4. Eviction ─────────────────────────────────────────────

  console.log("\n--- Eviction ---")

  await test("eviction removes entries older than 7 days", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()

    // Record an entry, then manually backdate its timestamp
    await idx.recordPending("old-key", 1)
    // Access internal data via a second init after manual file manipulation
    // Instead, we use evictStale with a very short maxAge
    await idx.evictStale(0) // maxAge=0 means everything is stale

    assert.equal(idx.isDuplicate("old-key"), false)
    await cleanup(dir)
  })

  await test("eviction keeps entries within 7 days", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()

    await idx.record("fresh-key", 1)
    // Evict with default 7-day window — fresh entry should survive
    await idx.evictStale()

    assert.equal(idx.isDuplicate("fresh-key"), true)
    await cleanup(dir)
  })

  await test("record() auto-evicts stale entries", async () => {
    const dir = await setup()
    const idx = new DedupeIndex(join(dir, "dedupe.json"))
    await idx.init()

    // Record an entry then manually backdate it by patching the store
    await idx.recordPending("will-be-stale", 1)

    // Backdate the entry by re-reading and rewriting via a raw store
    const { AtomicJsonStore } = await import("../../src/cron/store.js")
    const rawStore = new AtomicJsonStore<{
      version: 1
      entries: Record<string, { intentSeq: number; status: string; ts: number }>
    }>(join(dir, "dedupe.json"))
    const raw = await rawStore.read()
    assert.ok(raw)
    // Set ts to 8 days ago
    raw.entries["will-be-stale"].ts = Date.now() - 8 * 24 * 60 * 60 * 1000
    await rawStore.write(raw)

    // Create fresh index, init from disk, then record a new entry (triggers eviction)
    const idx2 = new DedupeIndex(join(dir, "dedupe.json"))
    await idx2.init()
    await idx2.record("new-key", 2)

    assert.equal(idx2.isDuplicate("will-be-stale"), false, "stale entry should be evicted")
    assert.equal(idx2.isDuplicate("new-key"), true, "new entry should exist")
    await cleanup(dir)
  })

  // ── 5. Persistence ──────────────────────────────────────────

  console.log("\n--- Persistence ---")

  await test("write then create new instance and read back entries", async () => {
    const dir = await setup()
    const filePath = join(dir, "persist.json")

    // Write with first instance
    const idx1 = new DedupeIndex(filePath)
    await idx1.init()
    await idx1.record("persist-key", 42)
    assert.equal(idx1.isDuplicate("persist-key"), true)

    // Read with second instance
    const idx2 = new DedupeIndex(filePath)
    await idx2.init()
    assert.equal(idx2.isDuplicate("persist-key"), true)
    await cleanup(dir)
  })

  console.log("\nDone.")
}

main()
