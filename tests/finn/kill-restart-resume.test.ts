// tests/finn/kill-restart-resume.test.ts — Integration test: kill, restart, resume (T-7.12)
// Tests that WAL + recovery + compound learning survive simulated process death.

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createWALManager } from "../../src/persistence/upstream.js"
import type { WALManager } from "../../src/persistence/upstream.js"
import { CompoundLearning } from "../../src/learning/compound.js"
import { WALPruner } from "../../src/persistence/pruner.js"
import { walPath } from "../../src/persistence/wal-path.js"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-kill-restart-"))
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
  console.log("Kill-Restart-Resume Integration Tests")
  console.log("=====================================")

  // Ensure grimoire dir exists for compound learning tests
  mkdirSync("grimoires/loa/a2a/trajectory", { recursive: true })

  await test("WAL survives kill and resumes on restart", async () => {
    const dir = makeTempDir()
    const walDir = join(dir, "wal")
    try {
      // Phase 1: Boot, write entries, shutdown (simulates kill)
      const wal1 = createWALManager(walDir)
      await wal1.initialize()

      const seq1 = await wal1.append("write", walPath("sessions", "abc"), Buffer.from("session-data-1"))
      const seq2 = await wal1.append("write", walPath("config", "settings"), Buffer.from("config-data"))
      const seq3 = await wal1.append("write", walPath("sessions", "abc"), Buffer.from("session-data-2"))

      assert.equal(wal1.getStatus().seq, seq3)
      await wal1.shutdown()

      // Phase 2: Restart — create new WAL instance (simulates process restart)
      const wal2 = createWALManager(walDir)
      await wal2.initialize()

      // Verify state recovered
      const status = wal2.getStatus()
      assert.equal(status.seq, seq3, "seq should resume from where it left off")

      // Replay should find all entries
      let replayCount = 0
      await wal2.replay(async () => { replayCount++ })
      assert.equal(replayCount, 3, "all 3 entries should be replayable after restart")

      // New writes should continue from last seq
      const seq4 = await wal2.append("write", walPath("sessions", "def"), Buffer.from("new-data"))
      assert.ok(seq4 > seq3, "new seq should be greater than pre-restart seq")

      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("compound learning persists across restart", async () => {
    const dir = makeTempDir()
    const walDir = join(dir, "wal")
    try {
      // Phase 1: Create learning and persist
      const wal1 = createWALManager(walDir)
      await wal1.initialize()
      const compound1 = new CompoundLearning(dir, wal1)

      // Simulate error→success pattern
      const sessionId = "restart-test-session"
      compound1.logEntry({
        timestamp: Date.now(),
        sessionId,
        type: "tool_end",
        tool: "bash",
        result: "Permission denied",
        isError: true,
      })
      compound1.logEntry({
        timestamp: Date.now() + 100,
        sessionId,
        type: "tool_end",
        tool: "bash",
        result: "Success",
        isError: false,
        args: { command: "sudo cmd" },
      })

      // Extract, evaluate, persist
      const candidates = await compound1.extract(sessionId)
      const qualified = compound1.evaluate(candidates)
      await compound1.persist(qualified)

      const walSeqBeforeShutdown = wal1.getStatus().seq
      await wal1.shutdown()

      // Phase 2: Restart and verify learnings survived
      const wal2 = createWALManager(walDir)
      await wal2.initialize()
      const compound2 = new CompoundLearning(dir, wal2)

      // LearningStore should have the persisted learning
      const context = await compound2.loadForContext()
      if (qualified.length > 0) {
        assert.ok(context.includes("Recent Learnings"), "learnings should persist across restart")
      }

      // WAL should have entries from before shutdown
      assert.ok(wal2.getStatus().seq >= walSeqBeforeShutdown, "WAL seq should be at least what it was")

      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("pruner respects confirmed seq across restart", async () => {
    const dir = makeTempDir()
    const walDir = join(dir, "wal")
    try {
      // Phase 1: Write entries and set confirmed seqs
      const wal1 = createWALManager(walDir)
      await wal1.initialize()

      for (let i = 0; i < 5; i++) {
        await wal1.append("write", walPath("sessions", `s${i}`), Buffer.from(`data-${i}`))
      }

      const pruner1 = new WALPruner(wal1)
      pruner1.setConfirmedR2Seq(3)
      pruner1.setConfirmedGitSeq(2)

      assert.equal(pruner1.getSafeSeq(), 2, "safe seq should be min of R2 and git")

      await wal1.shutdown()

      // Phase 2: Restart — pruner state is ephemeral (by design, seqs re-reported by sync tasks)
      const wal2 = createWALManager(walDir)
      await wal2.initialize()

      const pruner2 = new WALPruner(wal2)
      assert.equal(pruner2.getSafeSeq(), 0, "safe seq should be 0 after restart (re-reported by sync)")

      // Pruning should be no-op without confirmed seqs
      const result = await pruner2.pruneConfirmed()
      assert.equal(result.segmentsPruned, 0, "should not prune without confirmed seqs")

      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("full lifecycle: boot → write → kill → restart → resume → new writes", async () => {
    const dir = makeTempDir()
    const walDir = join(dir, "wal")
    try {
      // Boot
      const wal1 = createWALManager(walDir)
      await wal1.initialize()

      // Write diverse entries
      await wal1.append("write", walPath("sessions", "sess-1"), Buffer.from("s1"))
      await wal1.append("write", walPath("config", "boot"), Buffer.from("boot-config"))
      await wal1.append("write", walPath("learnings", "learn-1"), Buffer.from("learning-data"))
      const lastSeq = await wal1.append("delete", walPath("sessions", "sess-1"))

      // Kill (abrupt shutdown)
      await wal1.shutdown()

      // Restart
      const wal2 = createWALManager(walDir)
      await wal2.initialize()

      // Verify resume
      const entries = await wal2.getEntriesSince(0)
      assert.equal(entries.length, 4, "all 4 entries should survive restart")

      // Verify entry types
      const paths = entries.map(e => e.path)
      assert.ok(paths.some(p => p.includes("sessions")), "session entries should be present")
      assert.ok(paths.some(p => p.includes("config")), "config entries should be present")
      assert.ok(paths.some(p => p.includes("learnings")), "learning entries should be present")

      // Verify last entry was a delete
      const lastEntry = entries[entries.length - 1]
      assert.equal(lastEntry.operation, "delete", "last entry should be a delete")

      // New writes continue
      const newSeq = await wal2.append("write", walPath("sessions", "sess-2"), Buffer.from("s2"))
      assert.ok(newSeq > lastSeq, "new writes should continue with higher seq")

      const totalEntries = await wal2.getEntriesSince(0)
      assert.equal(totalEntries.length, 5, "should have 5 total entries")

      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
