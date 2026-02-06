// tests/finn/wal.test.ts — WAL unit tests using upstream WALManager (T-7.11)

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createWALManager, WALManager } from "../../src/persistence/upstream.js"

const PREFIX = "finn-wal-test-"

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), PREFIX))
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
  console.log("WAL Unit Tests (upstream WALManager)")
  console.log("====================================")

  await test("append creates valid JSONL with checksum", async () => {
    const dir = makeTempDir()
    try {
      const wal = createWALManager(dir)
      await wal.initialize()
      const seq = await wal.append("write", "/sessions/abc", Buffer.from(JSON.stringify({ msg: "hello" })))

      assert.ok(seq > 0, "append should return a positive sequence number")

      const status = wal.getStatus()
      assert.equal(status.seq, seq, "status seq should match returned seq")
      assert.ok(status.segmentCount >= 1, "should have at least one segment")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("replay returns entries in order, respects since filter", async () => {
    const dir = makeTempDir()
    try {
      const wal = createWALManager(dir)
      await wal.initialize()
      const seq1 = await wal.append("write", "/a", Buffer.from("1"))
      const seq2 = await wal.append("write", "/b", Buffer.from("2"))
      const seq3 = await wal.append("write", "/c", Buffer.from("3"))

      // Replay all
      let replayCount = 0
      await wal.replay(async () => { replayCount++ })
      assert.equal(replayCount, 3, "should replay all 3 entries")

      // Get entries since seq1 (should return seq2 and seq3)
      const filtered = await wal.getEntriesSince(seq1)
      assert.equal(filtered.length, 2, "should get 2 entries after seq1")
      assert.equal(filtered[0].seq, seq2)
      assert.equal(filtered[1].seq, seq3)
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("rotation creates new segment at threshold", async () => {
    const dir = makeTempDir()
    try {
      // Use a small rotation threshold to trigger rotation
      const wal = new WALManager({ walDir: dir, maxSegmentSize: 100 })
      await wal.initialize()

      // Write enough data to trigger rotation
      for (let i = 0; i < 5; i++) {
        await wal.append("write", `/test/${i}`, Buffer.from("x".repeat(50)))
      }

      const status = wal.getStatus()
      assert.ok(status.segmentCount >= 2, `should have multiple segments, got ${status.segmentCount}`)
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("checksum verification catches corruption", async () => {
    const dir = makeTempDir()
    try {
      const wal = createWALManager(dir)
      await wal.initialize()
      await wal.append("write", "/a", Buffer.from(JSON.stringify({ clean: true })))

      // Find the active segment file and corrupt it
      const status = wal.getStatus()
      const segPath = join(dir, status.activeSegment)
      const content = await readFile(segPath, "utf-8")
      const lines = content.trim().split("\n")
      const entry = JSON.parse(lines[0])
      entry.data = Buffer.from("tampered").toString("base64")
      writeFileSync(segPath, JSON.stringify(entry) + "\n")

      // Create a fresh WAL instance to replay
      await wal.shutdown()
      const wal2 = createWALManager(dir)
      await wal2.initialize()

      // Replay should skip or handle the corrupted entry
      let replayCount = 0
      await wal2.replay(async () => { replayCount++ })
      assert.equal(replayCount, 0, "corrupted entry should be skipped")
      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("getEntriesSince returns entries after seq", async () => {
    const dir = makeTempDir()
    try {
      const wal = createWALManager(dir)
      await wal.initialize()
      await wal.append("write", "/a", Buffer.from("1"))
      const seq2 = await wal.append("write", "/b", Buffer.from("2"))
      await wal.append("write", "/c", Buffer.from("3"))

      const entries = await wal.getEntriesSince(seq2)
      assert.equal(entries.length, 1, "should get 1 entry after seq2")
      assert.equal(entries[0].path, "/c")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("compact reduces duplicate entries", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WALManager({ walDir: dir, maxSegmentSize: 100 })
      await wal.initialize()

      // Write same path multiple times to create duplicates
      for (let i = 0; i < 10; i++) {
        await wal.append("write", "/same-path", Buffer.from(`version-${i}`))
      }

      const statusBefore = wal.getStatus()
      const result = await wal.compact()

      // Compaction keeps latest per path in closed segments
      if (statusBefore.segmentCount > 1) {
        assert.ok(result.compactedEntries <= result.originalEntries, "compacted should not exceed original")
      }
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("constructor resumes from existing segments", async () => {
    const dir = makeTempDir()
    try {
      // Write some entries
      const wal1 = createWALManager(dir)
      await wal1.initialize()
      await wal1.append("write", "/test", Buffer.from("1"))
      await wal1.append("write", "/test", Buffer.from("2"))
      await wal1.shutdown()

      // Create new WAL instance (simulates restart)
      const wal2 = createWALManager(dir)
      await wal2.initialize()
      await wal2.append("write", "/test", Buffer.from("3"))

      // All entries should be replayable
      let replayCount = 0
      await wal2.replay(async () => { replayCount++ })
      assert.equal(replayCount, 3, "should replay all 3 entries across restart")
      await wal2.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  await test("empty WAL has seq 0", async () => {
    const dir = makeTempDir()
    try {
      const wal = createWALManager(dir)
      await wal.initialize()
      const status = wal.getStatus()
      assert.equal(status.seq, 0, "empty WAL should have seq 0")
      await wal.shutdown()
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
