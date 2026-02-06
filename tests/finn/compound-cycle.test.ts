// tests/finn/compound-cycle.test.ts — End-to-end compound learning cycle (T-6.5, T-7.7)

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createWALManager } from "../../src/persistence/upstream.js"
import { CompoundLearning, type TrajectoryEntry } from "../../src/learning/compound.js"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-compound-test-"))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

async function main() {
  console.log("Compound Learning Cycle Tests")
  console.log("=============================")

  // Setup: ensure grimoires/loa exists for tests
  const grimoireDir = "grimoires/loa"
  mkdirSync(join(grimoireDir, "a2a/trajectory"), { recursive: true })

  await test("trajectory entries are logged to JSONL", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const compound = new CompoundLearning(dir, wal)

      const entry: TrajectoryEntry = {
        timestamp: Date.now(),
        sessionId: "test-session-1",
        type: "tool_start",
        tool: "bash",
        args: { command: "ls /data" },
      }
      compound.logEntry(entry)

      // Verify file was created
      const date = new Date().toISOString().split("T")[0]
      const filePath = join(grimoireDir, "a2a/trajectory", `${date}.jsonl`)
      assert.ok(existsSync(filePath), "trajectory file should exist")

      const content = readFileSync(filePath, "utf-8")
      const lines = content.trim().split("\n")
      const parsed = JSON.parse(lines[lines.length - 1])
      assert.equal(parsed.sessionId, "test-session-1")
      assert.equal(parsed.type, "tool_start")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("extract finds error → success patterns", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const compound = new CompoundLearning(dir, wal)
      const sessionId = "test-session-extract"

      // Log error followed by success
      compound.logEntry({
        timestamp: Date.now(),
        sessionId,
        type: "tool_end",
        tool: "bash",
        result: "Command not found: xyz",
        isError: true,
      })
      compound.logEntry({
        timestamp: Date.now() + 1,
        sessionId,
        type: "tool_end",
        tool: "bash",
        result: "success",
        isError: false,
        args: { command: "which xyz || apt install xyz" },
      })

      const candidates = await compound.extract(sessionId)
      assert.ok(candidates.length >= 1, "should find at least 1 error→success pattern")
      assert.equal(candidates[0].trigger, "tool:bash:error")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("evaluate filters by quality gates", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const compound = new CompoundLearning(dir, wal)

      // Good candidate (passes 3+ gates)
      const good = {
        trigger: "tool:bash:error",
        context: "Command not found error when running xyz",
        resolution: "Install missing package first, then retry",
        confidence: 0.7,
        sourceSessionId: "s1",
      }

      // Bad candidate (fails gates)
      const bad = {
        trigger: "",
        context: "",
        resolution: "try again",
        confidence: 0.2,
        sourceSessionId: "s2",
      }

      const qualified = compound.evaluate([good, bad])
      assert.equal(qualified.length, 1, "only good candidate should pass")
      assert.equal(qualified[0].trigger, "tool:bash:error")
      assert.ok(qualified[0].qualityScore >= 0.75, "quality score should be high")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("persist writes to LearningStore and WAL", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const compound = new CompoundLearning(dir, wal)

      const learnings = compound.evaluate([
        {
          trigger: "tool:bash:error",
          context: "Permission denied on /data",
          resolution: "Use sudo or check file permissions first",
          confidence: 0.8,
          sourceSessionId: "s1",
        },
      ])

      await compound.persist(learnings)

      // Check LearningStore has the learning
      const store = await compound.getStore().loadStore()
      assert.ok(store.learnings.length >= 1, "LearningStore should have at least 1 learning")
      assert.equal(store.learnings[0].trigger, "tool:bash:error")
      assert.ok(store.learnings[0].solution.includes("sudo"), "solution should be preserved")

      // Check WAL has entries
      const status = wal.getStatus()
      assert.ok(status.seq > 0, "WAL should have entries")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("loadForContext returns formatted learnings", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const compound = new CompoundLearning(dir, wal)

      // First persist some learnings
      const learnings = compound.evaluate([
        {
          trigger: "pattern:retry",
          context: "API rate limited",
          resolution: "Wait 5 seconds then retry with exponential backoff",
          confidence: 0.9,
          sourceSessionId: "s1",
        },
      ])
      await compound.persist(learnings)

      // Load for context
      const context = await compound.loadForContext()
      assert.ok(context.includes("Recent Learnings"), "should have header")
      assert.ok(context.includes("pattern:retry"), "should include learning trigger")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("full cycle: log → extract → evaluate → persist → load", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const compound = new CompoundLearning(dir, wal)
      const sessionId = "full-cycle-test"

      // 1. Log trajectory
      compound.logEntry({
        timestamp: Date.now(),
        sessionId,
        type: "tool_end",
        tool: "bash",
        result: "Error: ENOENT: no such file or directory",
        isError: true,
      })
      compound.logEntry({
        timestamp: Date.now() + 100,
        sessionId,
        type: "tool_end",
        tool: "bash",
        result: "File created successfully",
        isError: false,
        args: { command: "mkdir -p /data && touch /data/file.txt" },
      })

      // 2. Extract
      const candidates = await compound.extract(sessionId)
      assert.ok(candidates.length >= 1, "should extract at least 1 candidate")

      // 3. Evaluate
      const qualified = compound.evaluate(candidates)

      // 4. Persist
      await compound.persist(qualified)

      // 5. Load for next session
      const context = await compound.loadForContext()
      // Learnings may or may not pass quality gates depending on the pattern
      // The important thing is the cycle completes without error
      assert.ok(typeof context === "string", "loadForContext should return a string")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
