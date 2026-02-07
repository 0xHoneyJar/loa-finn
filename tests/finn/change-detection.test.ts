// tests/finn/change-detection.test.ts — Change Detection tests (TASK-5.6)
// Self-contained: all types and ChangeDetector inlined.

import assert from "node:assert/strict"

// ── Inlined types ──────────────────────────────────────────

interface ChangeDetectionConfig {
  reReviewAfterHours?: number
}

interface ProcessedItemRecord {
  key: string
  lastHash: string
  lastProcessedAt: string
  result: string
}

interface ChangeCheckResult {
  changed: boolean
  reason: "new" | "hash_changed" | "timer_expired" | "unchanged"
  previousHash?: string
  currentHash: string
}

// ── Inlined ChangeDetector ─────────────────────────────────

class ChangeDetector {
  private reReviewAfterHours: number
  private now: () => number

  constructor(config?: ChangeDetectionConfig & { now?: () => number }) {
    this.reReviewAfterHours = config?.reReviewAfterHours ?? 24
    this.now = config?.now ?? (() => Date.now())
  }

  check(
    key: string,
    currentHash: string,
    processedItems: ProcessedItemRecord[],
  ): ChangeCheckResult {
    const prev = processedItems.find((item) => item.key === key)
    if (!prev) {
      return { changed: true, reason: "new", currentHash }
    }
    if (prev.lastHash !== currentHash) {
      return { changed: true, reason: "hash_changed", previousHash: prev.lastHash, currentHash }
    }
    const elapsedMs = this.now() - new Date(prev.lastProcessedAt).getTime()
    const thresholdMs = this.reReviewAfterHours * 60 * 60 * 1000
    if (elapsedMs >= thresholdMs) {
      return { changed: true, reason: "timer_expired", previousHash: prev.lastHash, currentHash }
    }
    return { changed: false, reason: "unchanged", previousHash: prev.lastHash, currentHash }
  }

  filterChanged(
    items: Array<{ key: string; hash: string }>,
    processedItems: ProcessedItemRecord[],
  ): Array<{ key: string; hash: string; reason: string }> {
    const results: Array<{ key: string; hash: string; reason: string }> = []
    for (const item of items) {
      const result = this.check(item.key, item.hash, processedItems)
      if (result.changed) {
        results.push({ key: item.key, hash: item.hash, reason: result.reason })
      }
    }
    return results
  }
}

// ── Test harness ───────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────

async function main() {
  console.log("Change Detection Tests")
  console.log("======================")

  const HOUR = 60 * 60 * 1000

  // ── 1. check: new item returns changed=true, reason=new ──

  await test("check: new item returns changed=true, reason=new", () => {
    const cd = new ChangeDetector()
    const result = cd.check("pr-42", "abc123", [])
    assert.equal(result.changed, true)
    assert.equal(result.reason, "new")
    assert.equal(result.currentHash, "abc123")
    assert.equal(result.previousHash, undefined)
  })

  // ── 2. check: same hash returns changed=false, reason=unchanged ──

  await test("check: same hash returns changed=false, reason=unchanged", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ now: () => now })
    const processed: ProcessedItemRecord[] = [{
      key: "pr-42",
      lastHash: "abc123",
      lastProcessedAt: new Date(now - 1 * HOUR).toISOString(),
      result: "success",
    }]
    const result = cd.check("pr-42", "abc123", processed)
    assert.equal(result.changed, false)
    assert.equal(result.reason, "unchanged")
    assert.equal(result.previousHash, "abc123")
  })

  // ── 3. check: different hash returns changed=true, reason=hash_changed ──

  await test("check: different hash returns changed=true, reason=hash_changed", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ now: () => now })
    const processed: ProcessedItemRecord[] = [{
      key: "pr-42",
      lastHash: "abc123",
      lastProcessedAt: new Date(now - 1 * HOUR).toISOString(),
      result: "success",
    }]
    const result = cd.check("pr-42", "def456", processed)
    assert.equal(result.changed, true)
    assert.equal(result.reason, "hash_changed")
    assert.equal(result.previousHash, "abc123")
    assert.equal(result.currentHash, "def456")
  })

  // ── 4. check: timer expired returns changed=true, reason=timer_expired ──

  await test("check: timer expired returns changed=true, reason=timer_expired", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ reReviewAfterHours: 24, now: () => now })
    const processed: ProcessedItemRecord[] = [{
      key: "pr-42",
      lastHash: "abc123",
      lastProcessedAt: new Date(now - 25 * HOUR).toISOString(),
      result: "success",
    }]
    const result = cd.check("pr-42", "abc123", processed)
    assert.equal(result.changed, true)
    assert.equal(result.reason, "timer_expired")
  })

  // ── 5. check: timer not expired returns changed=false ──

  await test("check: timer not expired returns changed=false", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ reReviewAfterHours: 24, now: () => now })
    const processed: ProcessedItemRecord[] = [{
      key: "pr-42",
      lastHash: "abc123",
      lastProcessedAt: new Date(now - 23 * HOUR).toISOString(),
      result: "success",
    }]
    const result = cd.check("pr-42", "abc123", processed)
    assert.equal(result.changed, false)
    assert.equal(result.reason, "unchanged")
  })

  // ── 6. check: volatile fields (updated_at) not in hash don't trigger change ──

  await test("check: volatile fields (updated_at) not in hash don't trigger change", () => {
    // Simulate: two objects differ only in updated_at, but produce the same canonical hash
    // because the hash is computed over stable fields only.
    const now = Date.now()
    const cd = new ChangeDetector({ now: () => now })
    const stableHash = "stable-hash-999"
    const processed: ProcessedItemRecord[] = [{
      key: "pr-77",
      lastHash: stableHash,
      lastProcessedAt: new Date(now - 1 * HOUR).toISOString(),
      result: "success",
    }]
    // Same canonical hash even though the underlying object's updated_at changed
    const result = cd.check("pr-77", stableHash, processed)
    assert.equal(result.changed, false)
    assert.equal(result.reason, "unchanged")
  })

  // ── 7. filterChanged: returns only changed items ──

  await test("filterChanged: returns only changed items", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ now: () => now })
    const processed: ProcessedItemRecord[] = [
      { key: "pr-1", lastHash: "h1", lastProcessedAt: new Date(now - 1 * HOUR).toISOString(), result: "success" },
      { key: "pr-2", lastHash: "h2", lastProcessedAt: new Date(now - 1 * HOUR).toISOString(), result: "success" },
      { key: "pr-3", lastHash: "h3", lastProcessedAt: new Date(now - 1 * HOUR).toISOString(), result: "success" },
    ]
    const items = [
      { key: "pr-1", hash: "h1" },       // unchanged
      { key: "pr-2", hash: "h2-new" },   // hash_changed
      { key: "pr-3", hash: "h3" },       // unchanged
      { key: "pr-4", hash: "h4" },       // new
    ]
    const changed = cd.filterChanged(items, processed)
    assert.equal(changed.length, 2)
    assert.equal(changed[0].key, "pr-2")
    assert.equal(changed[0].reason, "hash_changed")
    assert.equal(changed[1].key, "pr-4")
    assert.equal(changed[1].reason, "new")
  })

  // ── 8. filterChanged: empty processed items means all are new ──

  await test("filterChanged: empty processed items means all are new", () => {
    const cd = new ChangeDetector()
    const items = [
      { key: "pr-1", hash: "h1" },
      { key: "pr-2", hash: "h2" },
    ]
    const changed = cd.filterChanged(items, [])
    assert.equal(changed.length, 2)
    assert.equal(changed[0].reason, "new")
    assert.equal(changed[1].reason, "new")
  })

  // ── 9. filterChanged: all unchanged returns empty array ──

  await test("filterChanged: all unchanged returns empty array", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ now: () => now })
    const processed: ProcessedItemRecord[] = [
      { key: "pr-1", lastHash: "h1", lastProcessedAt: new Date(now - 1 * HOUR).toISOString(), result: "success" },
      { key: "pr-2", lastHash: "h2", lastProcessedAt: new Date(now - 1 * HOUR).toISOString(), result: "success" },
    ]
    const items = [
      { key: "pr-1", hash: "h1" },
      { key: "pr-2", hash: "h2" },
    ]
    const changed = cd.filterChanged(items, processed)
    assert.equal(changed.length, 0)
  })

  // ── 10. config: default reReviewAfterHours is 24 ──

  await test("config: default reReviewAfterHours is 24", () => {
    const now = Date.now()
    const cd = new ChangeDetector({ now: () => now })
    // 23h59m ago — should NOT trigger timer
    const processed23h: ProcessedItemRecord[] = [{
      key: "pr-1",
      lastHash: "h1",
      lastProcessedAt: new Date(now - (24 * HOUR - 60_000)).toISOString(),
      result: "success",
    }]
    const result1 = cd.check("pr-1", "h1", processed23h)
    assert.equal(result1.changed, false)
    assert.equal(result1.reason, "unchanged")

    // Exactly 24h ago — should trigger timer
    const processed24h: ProcessedItemRecord[] = [{
      key: "pr-1",
      lastHash: "h1",
      lastProcessedAt: new Date(now - 24 * HOUR).toISOString(),
      result: "success",
    }]
    const result2 = cd.check("pr-1", "h1", processed24h)
    assert.equal(result2.changed, true)
    assert.equal(result2.reason, "timer_expired")
  })

  console.log("\nDone.")
}

main()
