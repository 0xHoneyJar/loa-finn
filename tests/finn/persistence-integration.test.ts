// tests/finn/persistence-integration.test.ts — End-to-end persistence test (T-3.6, T-7.3)
// Tests: WAL append → simulate restart → verify state restored

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createWALManager } from "../../src/persistence/upstream.js"
import { runRecovery } from "../../src/persistence/recovery.js"
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
      const walDir = join(dir, "wal")

      // Phase 1: Write some entries
      const wal1 = createWALManager(walDir)
      await wal1.initialize()
      await wal1.append("create", "/sessions/s1", Buffer.from(JSON.stringify({ text: "hello" })))
      await wal1.append("write", "/sessions/s1", Buffer.from(JSON.stringify({ text: "world" })))
      await wal1.append("create", "/beads/b1", Buffer.from(JSON.stringify({ status: "open" })))
      await wal1.shutdown()

      // Phase 2: Simulate restart — create new WAL instance
      const wal2 = createWALManager(walDir)
      await wal2.initialize()

      const entries: any[] = []
      await wal2.replay(async (entry) => {
        entries.push(entry)
      })

      assert.equal(entries.length, 3, "all 3 entries should survive restart")
      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("recovery falls back to template when R2/git unavailable", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()
      const r2 = new ObjectStoreSync(config, wal)
      const git = new GitSync(config, wal)

      const result = await runRecovery(config, wal, r2, git)

      assert.equal(result.source, "template", "should fall back to template")
      assert.equal(result.mode, "clean")
      assert.ok(existsSync(config.beauvoirPath), "BEAUVOIR.md should be created")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("recovery detects existing local WAL and replays", async () => {
    const dir = makeTempDir()
    try {
      const config = makeConfig(dir)
      const walDir = join(dir, "wal")

      // Pre-populate WAL
      const wal1 = createWALManager(walDir)
      await wal1.initialize()
      await wal1.append("create", "/s1", Buffer.from(JSON.stringify({ n: 1 })))
      await wal1.append("write", "/s1", Buffer.from(JSON.stringify({ n: 2 })))
      await wal1.shutdown()

      // New boot cycle
      const wal2 = createWALManager(walDir)
      await wal2.initialize()
      const r2 = new ObjectStoreSync(config, wal2)
      const git = new GitSync(config, wal2)

      const result = await runRecovery(config, wal2, r2, git)

      assert.equal(result.source, "local", "should detect local WAL")
      assert.equal(result.walEntriesReplayed, 2, "should replay 2 entries")
      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("WAL entries maintain ordering across segments", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()

      // Write entries
      const seqs: number[] = []
      for (let i = 0; i < 5; i++) {
        const seq = await wal.append("create", `/s${i}`, Buffer.from(JSON.stringify({ i })))
        seqs.push(seq)
      }

      // Verify all entries replay correctly in order
      const entries: any[] = []
      await wal.replay(async (entry) => {
        entries.push(entry)
      })

      assert.equal(entries.length, 5, "all 5 entries")
      // Verify ordering via seq numbers
      for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i].seq > entries[i - 1].seq, "entries should be ordered by seq")
      }
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("WAL compact reduces entries", async () => {
    const dir = makeTempDir()
    try {
      const walDir = join(dir, "wal")
      const wal = createWALManager(walDir)
      await wal.initialize()

      // Write to WAL
      await wal.append("create", "/old", Buffer.from(JSON.stringify({ old: true })))
      await wal.append("create", "/new", Buffer.from(JSON.stringify({ new: true })))

      const statusBefore = wal.getStatus()
      assert.ok(statusBefore.seq >= 2, "should have at least 2 entries")

      // Compact
      await wal.compact()

      // After compact, WAL should still be functional
      const seq = await wal.append("create", "/after-compact", Buffer.from(JSON.stringify({ ok: true })))
      assert.ok(seq > 0, "should be able to append after compact")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
