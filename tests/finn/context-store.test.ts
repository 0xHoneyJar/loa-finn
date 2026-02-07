// tests/finn/context-store.test.ts — Context Store tests (TASK-5.5)
// Self-contained: all types, InMemoryContextPersistence, and JobContext inlined.

import assert from "node:assert/strict"

// ── Inlined types ──────────────────────────────────────────

interface ProcessedItem {
  key: string
  lastProcessedAt: string
  lastStateHash: string
  actionsTaken: string[]
  result: "success" | "failure" | "skipped"
}

interface JobLearning {
  id: string
  pattern: string
  source: string
  confidence: number
  createdAt: string
}

interface JobStats {
  totalRuns: number
  totalItemsProcessed: number
  totalActionsTaken: number
  lastRunAt?: string
  errorRate: number
  consecutiveErrors: number
}

interface JobContextData {
  jobId: string
  processedItems: ProcessedItem[]
  learnings: JobLearning[]
  stats: JobStats
}

interface ContextStorePersistence {
  load(jobId: string): Promise<JobContextData | null>
  save(data: JobContextData): Promise<void>
}

// ── Inlined InMemoryContextPersistence ─────────────────────

class InMemoryContextPersistence implements ContextStorePersistence {
  private store = new Map<string, JobContextData>()
  async load(jobId: string): Promise<JobContextData | null> {
    const data = this.store.get(jobId)
    return data ? structuredClone(data) : null
  }
  async save(data: JobContextData): Promise<void> {
    this.store.set(data.jobId, structuredClone(data))
  }
}

// ── Inlined JobContext ─────────────────────────────────────

const MAX_PROCESSED_ITEMS = 1000
const MAX_LEARNINGS = 100

class JobContext {
  private data: JobContextData
  constructor(data: JobContextData) { this.data = data }

  hasChanged(key: string, currentHash: string, reReviewAfterHours?: number): boolean {
    const existing = this.data.processedItems.find(i => i.key === key)
    if (!existing) return true
    if (existing.lastStateHash !== currentHash) return true
    if (reReviewAfterHours !== undefined) {
      const processedAt = new Date(existing.lastProcessedAt).getTime()
      const cutoff = processedAt + reReviewAfterHours * 60 * 60 * 1000
      if (Date.now() >= cutoff) return true
    }
    return false
  }

  recordProcessed(items: Array<{ key: string; hash: string; actions: string[]; result: "success" | "failure" | "skipped" }>): void {
    const now = new Date().toISOString()
    for (const item of items) {
      const idx = this.data.processedItems.findIndex(p => p.key === item.key)
      const record: ProcessedItem = {
        key: item.key, lastProcessedAt: now, lastStateHash: item.hash,
        actionsTaken: item.actions, result: item.result,
      }
      if (idx >= 0) this.data.processedItems[idx] = record
      else this.data.processedItems.push(record)
    }
    this.enforceItemBounds()
  }

  addLearning(learning: Omit<JobLearning, "id" | "createdAt">): void {
    this.data.learnings.push({
      ...learning,
      id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    })
    this.enforceLearningBounds()
  }

  recordRun(success: boolean, itemCount: number, actionCount: number): void {
    const s = this.data.stats
    s.totalRuns++
    s.totalItemsProcessed += itemCount
    s.totalActionsTaken += actionCount
    s.lastRunAt = new Date().toISOString()
    if (success) s.consecutiveErrors = 0
    else s.consecutiveErrors++
    const errorWeight = success ? 0 : 1
    const alpha = Math.min(1, 2 / (s.totalRuns + 1))
    s.errorRate = s.errorRate * (1 - alpha) + errorWeight * alpha
  }

  getData(): JobContextData { return this.data }

  private enforceItemBounds(): void {
    if (this.data.processedItems.length > MAX_PROCESSED_ITEMS) {
      this.data.processedItems.sort((a, b) =>
        new Date(a.lastProcessedAt).getTime() - new Date(b.lastProcessedAt).getTime())
      this.data.processedItems = this.data.processedItems.slice(
        this.data.processedItems.length - MAX_PROCESSED_ITEMS)
    }
  }

  private enforceLearningBounds(): void {
    if (this.data.learnings.length > MAX_LEARNINGS) {
      this.data.learnings.sort((a, b) => b.confidence - a.confidence)
      this.data.learnings = this.data.learnings.slice(0, MAX_LEARNINGS)
    }
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

function freshData(jobId = "test-job"): JobContextData {
  return {
    jobId,
    processedItems: [],
    learnings: [],
    stats: { totalRuns: 0, totalItemsProcessed: 0, totalActionsTaken: 0, errorRate: 0, consecutiveErrors: 0 },
  }
}

// ── Tests ──────────────────────────────────────────────────

async function main() {
  console.log("Context Store Tests")
  console.log("===================")

  console.log("\n--- hasChanged ---")

  await test("hasChanged: returns true for new item (never processed)", () => {
    const ctx = new JobContext(freshData())
    assert.equal(ctx.hasChanged("item-1", "abc123"), true)
  })

  await test("hasChanged: returns false for same hash", () => {
    const ctx = new JobContext(freshData())
    ctx.recordProcessed([{ key: "item-1", hash: "abc123", actions: ["review"], result: "success" }])
    assert.equal(ctx.hasChanged("item-1", "abc123"), false)
  })

  await test("hasChanged: returns true for different hash", () => {
    const ctx = new JobContext(freshData())
    ctx.recordProcessed([{ key: "item-1", hash: "abc123", actions: ["review"], result: "success" }])
    assert.equal(ctx.hasChanged("item-1", "def456"), true)
  })

  await test("hasChanged: returns true when re-review timer expired", () => {
    const data = freshData()
    data.processedItems.push({
      key: "item-1", lastProcessedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      lastStateHash: "abc123", actionsTaken: ["review"], result: "success",
    })
    const ctx = new JobContext(data)
    assert.equal(ctx.hasChanged("item-1", "abc123", 2), true) // 3h > 2h
  })

  await test("hasChanged: returns false when re-review timer not expired", () => {
    const data = freshData()
    data.processedItems.push({
      key: "item-1", lastProcessedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
      lastStateHash: "abc123", actionsTaken: ["review"], result: "success",
    })
    const ctx = new JobContext(data)
    assert.equal(ctx.hasChanged("item-1", "abc123", 4), false) // 1h < 4h
  })

  console.log("\n--- recordProcessed ---")

  await test("recordProcessed: adds new items", () => {
    const ctx = new JobContext(freshData())
    ctx.recordProcessed([
      { key: "a", hash: "h1", actions: ["lint"], result: "success" },
      { key: "b", hash: "h2", actions: ["test"], result: "failure" },
    ])
    const items = ctx.getData().processedItems
    assert.equal(items.length, 2)
    assert.equal(items[0].key, "a")
    assert.equal(items[1].key, "b")
  })

  await test("recordProcessed: updates existing items", () => {
    const ctx = new JobContext(freshData())
    ctx.recordProcessed([{ key: "a", hash: "h1", actions: ["lint"], result: "success" }])
    ctx.recordProcessed([{ key: "a", hash: "h2", actions: ["lint", "fix"], result: "failure" }])
    const items = ctx.getData().processedItems
    assert.equal(items.length, 1)
    assert.equal(items[0].lastStateHash, "h2")
    assert.deepEqual(items[0].actionsTaken, ["lint", "fix"])
  })

  console.log("\n--- recordRun ---")

  await test("recordRun: increments stats", () => {
    const ctx = new JobContext(freshData())
    ctx.recordRun(true, 5, 10)
    const s = ctx.getData().stats
    assert.equal(s.totalRuns, 1)
    assert.equal(s.totalItemsProcessed, 5)
    assert.equal(s.totalActionsTaken, 10)
    assert.equal(s.consecutiveErrors, 0)
    assert.ok(s.lastRunAt !== undefined)
  })

  await test("recordRun: tracks error rate", () => {
    const ctx = new JobContext(freshData())
    ctx.recordRun(false, 1, 0)
    assert.equal(ctx.getData().stats.consecutiveErrors, 1)
    assert.ok(ctx.getData().stats.errorRate > 0)
    ctx.recordRun(false, 1, 0)
    assert.equal(ctx.getData().stats.consecutiveErrors, 2)
    ctx.recordRun(true, 1, 1)
    assert.equal(ctx.getData().stats.consecutiveErrors, 0)
    assert.ok(ctx.getData().stats.errorRate > 0, "Error rate should still be > 0")
  })

  console.log("\n--- enforceItemBounds ---")

  await test("enforceItemBounds: FIFO eviction at 1000 items", () => {
    const data = freshData()
    for (let i = 0; i < 999; i++) {
      data.processedItems.push({
        key: `old-${i}`, lastProcessedAt: new Date(1000 + i).toISOString(),
        lastStateHash: `hash-${i}`, actionsTaken: [], result: "success",
      })
    }
    const ctx = new JobContext(data)
    ctx.recordProcessed([
      { key: "new-1", hash: "nh1", actions: [], result: "success" },
      { key: "new-2", hash: "nh2", actions: [], result: "success" },
      { key: "new-3", hash: "nh3", actions: [], result: "success" },
      { key: "new-4", hash: "nh4", actions: [], result: "success" },
      { key: "new-5", hash: "nh5", actions: [], result: "success" },
    ])
    const items = ctx.getData().processedItems
    assert.equal(items.length, 1000)
    assert.equal(items.find(i => i.key === "old-0"), undefined, "old-0 should be evicted")
    assert.equal(items.find(i => i.key === "old-3"), undefined, "old-3 should be evicted")
    assert.ok(items.find(i => i.key === "new-5"), "new-5 should be present")
  })

  console.log("\n--- enforceLearningBounds ---")

  await test("enforceLearningBounds: lowest confidence evicted at 100", () => {
    const ctx = new JobContext(freshData())
    for (let i = 0; i < 100; i++) {
      ctx.addLearning({ pattern: `p-${i}`, source: "test", confidence: i / 100 })
    }
    assert.equal(ctx.getData().learnings.length, 100)
    ctx.addLearning({ pattern: "high-conf", source: "test", confidence: 0.99 })
    const learnings = ctx.getData().learnings
    assert.equal(learnings.length, 100)
    assert.equal(learnings.some(l => l.confidence === 0), false, "Lowest confidence should be evicted")
    assert.ok(learnings.some(l => l.pattern === "high-conf"), "High confidence should be present")
  })

  console.log("\n--- addLearning ---")

  await test("addLearning: generates ID and timestamp", () => {
    const ctx = new JobContext(freshData())
    ctx.addLearning({ pattern: "test-pattern", source: "unit-test", confidence: 0.85 })
    const learnings = ctx.getData().learnings
    assert.equal(learnings.length, 1)
    assert.ok(learnings[0].id.startsWith("learn-"), "ID should start with 'learn-'")
    assert.ok(learnings[0].createdAt)
    const parsed = new Date(learnings[0].createdAt)
    assert.ok(!isNaN(parsed.getTime()), "createdAt should be valid ISO date")
    assert.equal(learnings[0].pattern, "test-pattern")
    assert.equal(learnings[0].confidence, 0.85)
  })

  console.log("\n--- InMemoryContextPersistence ---")

  await test("InMemoryContextPersistence: save/load roundtrip", async () => {
    const persistence = new InMemoryContextPersistence()
    assert.equal(await persistence.load("nope"), null)

    const data = freshData("persist-test")
    data.processedItems.push({
      key: "item-x", lastProcessedAt: new Date().toISOString(),
      lastStateHash: "hash-x", actionsTaken: ["action-1"], result: "success",
    })
    data.stats.totalRuns = 5
    await persistence.save(data)

    const loaded = await persistence.load("persist-test")
    assert.ok(loaded !== null)
    assert.equal(loaded!.jobId, "persist-test")
    assert.equal(loaded!.processedItems.length, 1)
    assert.equal(loaded!.processedItems[0].key, "item-x")
    assert.equal(loaded!.stats.totalRuns, 5)

    // Verify deep copy (mutations don't leak)
    loaded!.processedItems.push({
      key: "leaked", lastProcessedAt: "", lastStateHash: "", actionsTaken: [], result: "skipped",
    })
    const reloaded = await persistence.load("persist-test")
    assert.equal(reloaded!.processedItems.length, 1, "Mutation should not leak")
  })

  console.log("\nDone.")
}

main()
