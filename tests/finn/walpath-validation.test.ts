// tests/finn/walpath-validation.test.ts — walPath() validation + R2 endpoint tests (T-7.11)

import assert from "node:assert/strict"
import { walPath } from "../../src/persistence/wal-path.js"
import { R2CheckpointStorage } from "../../src/persistence/r2-storage.js"

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
  console.log("walPath Validation + R2 Endpoint Tests")
  console.log("=======================================")

  // ── walPath validation ──────────────────────────────────

  await test("walPath builds valid path from prefix + segments", async () => {
    assert.equal(walPath("sessions", "abc", "msg"), "sessions/abc/msg")
    assert.equal(walPath("config", "settings"), "config/settings")
    assert.equal(walPath(".beads", "wal"), ".beads/wal")
    assert.equal(walPath("learnings", "learn-1"), "learnings/learn-1")
  })

  await test("walPath rejects invalid prefixes", async () => {
    assert.throws(
      () => (walPath as any)("invalid", "test"),
      /Invalid WAL prefix/,
    )
    assert.throws(
      () => (walPath as any)("", "test"),
      /Invalid WAL prefix/,
    )
    assert.throws(
      () => (walPath as any)("Sessions", "test"),
      /Invalid WAL prefix/,
    )
  })

  await test("walPath rejects path traversal (..)", async () => {
    assert.throws(
      () => walPath("sessions", ".."),
      /path traversal rejected/,
    )
    assert.throws(
      () => walPath("sessions", "abc", "../etc"),
      /path traversal rejected/,
    )
  })

  await test("walPath rejects double separators (//)", async () => {
    assert.throws(
      () => walPath("sessions", "a//b"),
      /double separator rejected/,
    )
  })

  await test("walPath rejects invalid characters in segments", async () => {
    assert.throws(
      () => walPath("sessions", "abc/def"),
      /invalid characters/,
    )
    assert.throws(
      () => walPath("sessions", "abc def"),
      /invalid characters/,
    )
    assert.throws(
      () => walPath("sessions", "abc;rm -rf"),
      /invalid characters/,
    )
  })

  await test("walPath allows hyphens and underscores in segments", async () => {
    assert.equal(walPath("sessions", "my-session_1"), "sessions/my-session_1")
    assert.equal(walPath("config", "circuit-breaker-r2_sync"), "config/circuit-breaker-r2_sync")
  })

  // ── R2 endpoint validation ──────────────────────────────

  await test("R2CheckpointStorage reports unconfigured when missing credentials", async () => {
    const storage = new R2CheckpointStorage({
      endpoint: "",
      bucket: "test",
      accessKeyId: "",
      secretAccessKey: "",
    })
    assert.equal(storage.isConfigured, false)
  })

  await test("R2CheckpointStorage reports configured with all credentials", async () => {
    const storage = new R2CheckpointStorage({
      endpoint: "https://abc123.r2.cloudflarestorage.com",
      bucket: "test-bucket",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
    })
    assert.equal(storage.isConfigured, true)
  })

  await test("R2CheckpointStorage isAvailable returns false when unconfigured", async () => {
    const storage = new R2CheckpointStorage({
      endpoint: "",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
    })
    const available = await storage.isAvailable()
    assert.equal(available, false)
  })

  console.log("\nDone.")
}

main()
