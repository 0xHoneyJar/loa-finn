// tests/finn/persistence-integration.test.ts — End-to-end persistence test (T-3.6)
// Tests: WAL append → simulate restart → verify state restored

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WAL } from "../../src/persistence/wal.js"
import { RecoveryCascade } from "../../src/persistence/recovery.js"
import { ObjectStoreSync } from "../../src/persistence/r2-sync.js"
import { GitSync } from "../../src/persistence/git-sync.js"
import type { FinnConfig } from "../../src/config.js"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-persist-test-"))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

function makeConfig(dataDir: string): FinnConfig {
  return {
    model: "test",
    thinkingLevel: "none" as any,
    beauvoirPath: join(dataDir, "BEAUVOIR.md"),
    port: 3000,
    host: "localhost",
    dataDir,
    sessionDir: join(dataDir, "sessions"),
    r2: { endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" },
    git: { remote: "", branch: "", archiveBranch: "", token: "" },
    auth: {
      bearerToken: "",
      corsOrigins: ["*"],
      csrfEnabled: false,
      rateLimiting: { windowMs: 60000, maxRequestsPerWindow: 60 },
    },
    syncIntervalMs: 30000,
    gitSyncIntervalMs: 3600000,
    healthIntervalMs: 300000,
    allowBash: false,
  }
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
  console.log("Persistence Integration Tests")
  console.log("=============================")

  await test("WAL entries survive simulated restart", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)

      // Phase 1: Write some entries
      const wal1 = new WAL(dir)
      const id1 = wal1.append("session", "create", "/sessions/s1", { text: "hello" })
      const id2 = wal1.append("session", "update", "/sessions/s1", { text: "world" })
      const id3 = wal1.append("bead", "create", "/beads/b1", { status: "open" })

      // Phase 2: Simulate restart — create new WAL instance
      const wal2 = new WAL(dir)

      // All 3 entries should be replayable
      const entries: any[] = []
      for await (const entry of wal2.replay()) {
        entries.push(entry)
      }

      assert.equal(entries.length, 3, "all 3 entries should survive restart")
      assert.equal(entries[0].id, id1)
      assert.equal(entries[1].id, id2)
      assert.equal(entries[2].id, id3)
      assert.deepEqual(entries[0].data, { text: "hello" })
      assert.deepEqual(entries[1].data, { text: "world" })
      assert.deepEqual(entries[2].data, { status: "open" })
    } finally {
      cleanup(dir)
    }
  })

  await test("recovery cascade falls back to template when R2/git unavailable", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const wal = new WAL(dir)
      const r2 = new ObjectStoreSync(config, wal)
      const git = new GitSync(config, wal)

      const cascade = new RecoveryCascade(config, wal, r2, git)
      const result = await cascade.recover("clean")

      assert.equal(result.source, "template", "should fall back to template")
      assert.equal(result.mode, "clean")
      assert.ok(existsSync(config.beauvoirPath), "BEAUVOIR.md should be created")
    } finally {
      cleanup(dir)
    }
  })

  await test("recovery detects existing local WAL and replays", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)

      // Pre-populate WAL
      const wal1 = new WAL(dir)
      wal1.append("session", "create", "/s1", { n: 1 })
      wal1.append("session", "update", "/s1", { n: 2 })

      // New boot cycle
      const wal2 = new WAL(dir)
      const r2 = new ObjectStoreSync(config, wal2)
      const git = new GitSync(config, wal2)

      const cascade = new RecoveryCascade(config, wal2, r2, git)
      const result = await cascade.recover("strict")

      assert.equal(result.source, "local", "should detect local WAL")
      assert.equal(result.walEntriesReplayed, 2, "should replay 2 entries")
    } finally {
      cleanup(dir)
    }
  })

  await test("WAL rotation preserves all entries across segments", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)

      // Write entries across multiple segments
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        ids.push(wal.append("session", "create", `/s${i}`, { i }))
        if (i === 2) wal.rotate() // Force rotation mid-stream
      }

      // Verify all entries replay correctly across segments
      const entries: any[] = []
      for await (const entry of wal.replay()) {
        entries.push(entry)
      }

      assert.equal(entries.length, 5, "all 5 entries across segments")
      for (let i = 0; i < 5; i++) {
        assert.equal(entries[i].id, ids[i])
        assert.deepEqual(entries[i].data, { i })
      }
    } finally {
      cleanup(dir)
    }
  })

  await test("full lifecycle: write → prune → restart → verify remaining", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)

      // Write to first segment
      wal.append("session", "create", "/old", { old: true })
      const oldSegments = [...wal.getSegments()]

      // Rotate and write to second segment
      wal.rotate()
      const keepId = wal.append("session", "create", "/new", { new: true })

      // Mark old segments as prunable and prune
      wal.markPrunable(oldSegments)
      const pruned = wal.prune()

      // Restart
      const wal2 = new WAL(dir)
      const entries: any[] = []
      for await (const entry of wal2.replay()) {
        entries.push(entry)
      }

      // Only the entry in the current segment should remain
      assert.equal(entries.length, 1, "only current segment data survives pruning")
      assert.equal(entries[0].id, keepId)
      assert.deepEqual(entries[0].data, { new: true })
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
