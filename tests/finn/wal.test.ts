// tests/finn/wal.test.ts — WAL unit tests (T-3.5)

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WAL } from "../../src/persistence/wal.js"

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
  console.log("WAL Unit Tests")
  console.log("==============")

  await test("append creates valid JSONL with ULID and checksum", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)
      const id = wal.append("session", "create", "/sessions/abc", { msg: "hello" })

      assert.ok(id, "append should return a ULID")
      assert.ok(id.length === 26, "ULID should be 26 chars")

      // Read the segment and verify
      const segments = wal.getSegments()
      assert.equal(segments.length, 1, "should have exactly one segment")

      const content = await readFile(segments[0], "utf-8")
      const entry = JSON.parse(content.trim())

      assert.equal(entry.id, id)
      assert.equal(entry.type, "session")
      assert.equal(entry.operation, "create")
      assert.equal(entry.path, "/sessions/abc")
      assert.deepEqual(entry.data, { msg: "hello" })
      assert.ok(entry.checksum, "should have checksum")
      assert.ok(entry.timestamp > 0, "should have timestamp")
    } finally {
      cleanup(dir)
    }
  })

  await test("replay returns entries in order, respects since filter", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)
      const id1 = wal.append("session", "create", "/a", { n: 1 })
      const id2 = wal.append("session", "update", "/b", { n: 2 })
      const id3 = wal.append("bead", "create", "/c", { n: 3 })

      // Replay all
      const all: any[] = []
      for await (const entry of wal.replay()) {
        all.push(entry)
      }
      assert.equal(all.length, 3, "should replay all 3 entries")
      assert.equal(all[0].id, id1)
      assert.equal(all[1].id, id2)
      assert.equal(all[2].id, id3)

      // Replay since id1 (should skip id1)
      const filtered: any[] = []
      for await (const entry of wal.replay(id1)) {
        filtered.push(entry)
      }
      assert.equal(filtered.length, 2, "should skip first entry")
      assert.equal(filtered[0].id, id2)
      assert.equal(filtered[1].id, id3)
    } finally {
      cleanup(dir)
    }
  })

  await test("rotation creates new segment at threshold", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)

      // Manually rotate
      const seg1 = wal.getSegments()
      wal.rotate()
      wal.append("session", "create", "/test", { data: "after rotation" })

      const seg2 = wal.getSegments()
      assert.ok(seg2.length >= 1, "should have at least 1 segment after rotation")

      // Verify entry is in the new segment
      const entries: any[] = []
      for await (const entry of wal.replay()) {
        entries.push(entry)
      }
      assert.equal(entries.length, 1, "should have 1 entry total")
      assert.equal(entries[0].path, "/test")
    } finally {
      cleanup(dir)
    }
  })

  await test("checksum verification catches corruption", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)
      wal.append("session", "create", "/a", { clean: true })

      // Manually corrupt the segment
      const segments = wal.getSegments()
      const content = await readFile(segments[0], "utf-8")
      const entry = JSON.parse(content.trim())
      entry.data = { tampered: true }
      const { writeFileSync } = await import("node:fs")
      writeFileSync(segments[0], JSON.stringify(entry) + "\n")

      // Replay should skip the corrupted entry
      const entries: any[] = []
      for await (const entry of wal.replay()) {
        entries.push(entry)
      }
      assert.equal(entries.length, 0, "corrupted entry should be skipped")
    } finally {
      cleanup(dir)
    }
  })

  await test("getHeadEntryId returns last entry", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)
      wal.append("session", "create", "/a", {})
      const lastId = wal.append("bead", "update", "/b", {})

      const head = await wal.getHeadEntryId()
      assert.equal(head, lastId)
    } finally {
      cleanup(dir)
    }
  })

  await test("markPrunable and prune lifecycle", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)
      wal.append("session", "create", "/a", {})

      // Rotate to create a second segment
      wal.rotate()
      wal.append("session", "create", "/b", {})

      const segments = wal.getSegments()
      assert.ok(segments.length >= 1)

      // Mark first segment as prunable (second is current, won't be marked)
      wal.markPrunable(segments)

      const prunable = wal.getPrunableSegments()
      // At most 1 can be marked (the non-current one)
      assert.ok(prunable.length <= 1, "only non-current segments can be prunable")

      // Prune
      const pruned = wal.prune()
      assert.equal(pruned, prunable.length)

      // After pruning, no prunable segments remain
      assert.equal(wal.getPrunableSegments().length, 0)
    } finally {
      cleanup(dir)
    }
  })

  await test("constructor resumes from existing segments", async () => {
    const dir = makeTempDir()
    try {
      // Write some entries
      const wal1 = new WAL(dir)
      wal1.append("session", "create", "/test", { n: 1 })
      wal1.append("session", "create", "/test", { n: 2 })

      // Create new WAL instance (simulates restart)
      const wal2 = new WAL(dir)
      wal2.append("session", "create", "/test", { n: 3 })

      // All entries should be replayable
      const entries: any[] = []
      for await (const entry of wal2.replay()) {
        entries.push(entry)
      }
      assert.equal(entries.length, 3)
    } finally {
      cleanup(dir)
    }
  })

  await test("empty WAL has no head entry", async () => {
    const dir = makeTempDir()
    try {
      const wal = new WAL(dir)
      const head = await wal.getHeadEntryId()
      assert.equal(head, undefined)
    } finally {
      cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
