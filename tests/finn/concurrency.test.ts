// tests/finn/concurrency.test.ts — ConcurrencyManager tests (SDD §4.1)

import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ConcurrencyManager } from "../../src/cron/concurrency.js"
import type { AlertService } from "../../src/safety/alert-service.js"

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

// Create a unique temp dir for each test
async function setup(): Promise<string> {
  const dir = join(tmpdir(), `concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

async function main() {
  console.log("ConcurrencyManager Tests")
  console.log("========================")

  // ── 1. Acquire / Release ───────────────────────────────────

  console.log("\n--- Acquire / Release ---")

  await test("acquire returns LockOwnership on success", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    const lock = await mgr.acquire("job-1")
    assert.ok(lock, "acquire should return a lock")
    assert.equal(typeof lock.ulid, "string")
    assert.equal(lock.pid, process.pid)
    assert.equal(lock.bootId, mgr.getBootId())
    assert.equal(typeof lock.startedAtMs, "number")
    await cleanup(dir)
  })

  await test("acquire creates lock file with correct JSON", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    const lock = await mgr.acquire("job-2")
    assert.ok(lock)

    const raw = await readFile(join(dir, "job-2", ".lock"), "utf-8")
    const parsed = JSON.parse(raw)
    assert.equal(parsed.ulid, lock.ulid)
    assert.equal(parsed.pid, lock.pid)
    assert.equal(parsed.bootId, lock.bootId)
    assert.equal(parsed.startedAtMs, lock.startedAtMs)
    await cleanup(dir)
  })

  await test("release removes lock file and returns true", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    await mgr.acquire("job-3")
    const released = await mgr.release("job-3")
    assert.equal(released, true)

    // Lock file should be gone
    const lock = await mgr.readLock("job-3")
    assert.equal(lock, null)
    await cleanup(dir)
  })

  await test("release returns false when no lock exists", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    const released = await mgr.release("nonexistent")
    assert.equal(released, false)
    await cleanup(dir)
  })

  // ── 2. Double Acquire Fails ────────────────────────────────

  console.log("\n--- Double Acquire ---")

  await test("double acquire on same job returns null", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    const first = await mgr.acquire("job-4")
    assert.ok(first, "first acquire should succeed")

    const second = await mgr.acquire("job-4")
    assert.equal(second, null, "second acquire should fail")
    await cleanup(dir)
  })

  await test("acquire succeeds after release", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    await mgr.acquire("job-5")
    await mgr.release("job-5")

    const reacquired = await mgr.acquire("job-5")
    assert.ok(reacquired, "reacquire after release should succeed")
    await cleanup(dir)
  })

  // ── 3. Ownership Validation on Release ─────────────────────

  console.log("\n--- Ownership Validation ---")

  await test("release fails when bootId does not match", async () => {
    const dir = await setup()
    // Manager A acquires the lock
    const mgrA = new ConcurrencyManager({ baseDir: dir })
    await mgrA.acquire("job-6")

    // Manager B (different bootId) tries to release
    const mgrB = new ConcurrencyManager({ baseDir: dir })
    const released = await mgrB.release("job-6")
    assert.equal(released, false, "release by different bootId should fail")

    // Lock should still be held
    const lock = await mgrA.readLock("job-6")
    assert.ok(lock, "lock should still exist")
    await cleanup(dir)
  })

  // ── 4. Stale Detection — Boot ID Mismatch ─────────────────

  console.log("\n--- Stale Detection ---")

  await test("isStale returns true for different bootId", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })

    const foreignLock = {
      ulid: "some-ulid",
      pid: process.pid,
      bootId: "different-boot-id",
      startedAtMs: Date.now(),
    }
    assert.equal(mgr.isStale(foreignLock), true)
    await cleanup(dir)
  })

  await test("isStale returns false for same bootId within maxAge", async () => {
    const dir = await setup()
    const now = Date.now()
    const mgr = new ConcurrencyManager({ baseDir: dir, now: () => now })

    const ownLock = {
      ulid: "some-ulid",
      pid: process.pid,
      bootId: mgr.getBootId(),
      startedAtMs: now - 1000, // 1 second ago
    }
    assert.equal(mgr.isStale(ownLock), false)
    await cleanup(dir)
  })

  // ── 5. Stale Detection — Age-Based ─────────────────────────

  await test("isStale returns true when age exceeds maxAge (same bootId)", async () => {
    const dir = await setup()
    const maxAgeMs = 5000 // 5 seconds for testing
    let clock = 0
    const mgr = new ConcurrencyManager({
      baseDir: dir,
      maxAgeMs,
      now: () => clock,
    })

    const lock = {
      ulid: "some-ulid",
      pid: process.pid,
      bootId: mgr.getBootId(),
      startedAtMs: 0,
    }

    // At time 0: not stale (age = 0)
    assert.equal(mgr.isStale(lock), false)

    // At time 5001: stale (age > 5000)
    clock = 5001
    assert.equal(mgr.isStale(lock), true)
    await cleanup(dir)
  })

  // ── 6. Break Stale Lock ────────────────────────────────────

  console.log("\n--- Break Stale Lock ---")

  await test("breakStaleLock removes the lock file", async () => {
    const dir = await setup()
    const mgrA = new ConcurrencyManager({ baseDir: dir })
    await mgrA.acquire("job-7")

    // Different manager breaks the lock
    const mgrB = new ConcurrencyManager({ baseDir: dir })
    await mgrB.breakStaleLock("job-7")

    const lock = await mgrB.readLock("job-7")
    assert.equal(lock, null, "lock should be removed")
    await cleanup(dir)
  })

  await test("breakStaleLock fires alert via AlertService", async () => {
    const dir = await setup()
    const alerts: Array<{ severity: string; trigger: string; jobId?: string }> = []

    // Minimal mock AlertService
    const mockAlert = {
      fire: async (severity: string, trigger: string, ctx: { jobId?: string }) => {
        alerts.push({ severity, trigger, jobId: ctx.jobId })
        return true
      },
    } as unknown as AlertService

    const mgrA = new ConcurrencyManager({ baseDir: dir })
    await mgrA.acquire("job-8")

    const mgrB = new ConcurrencyManager({ baseDir: dir, alertService: mockAlert })
    await mgrB.breakStaleLock("job-8")

    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].severity, "warning")
    assert.equal(alerts[0].trigger, "stale_lock_broken")
    assert.equal(alerts[0].jobId, "job-8")
    await cleanup(dir)
  })

  await test("breakStaleLock is safe when lock does not exist", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    // Should not throw
    await mgr.breakStaleLock("nonexistent")
    await cleanup(dir)
  })

  // ── 7. Recovery Scan ───────────────────────────────────────

  console.log("\n--- Recovery Scan ---")

  await test("recoverStaleLocks breaks stale locks from different bootId", async () => {
    const dir = await setup()

    // Create some lock files with a foreign boot ID
    const foreignLock = {
      ulid: "foreign-ulid",
      pid: 99999,
      bootId: "old-boot-id",
      startedAtMs: Date.now(),
    }

    // Manually create job dirs with lock files
    await mkdir(join(dir, "stale-job-A"), { recursive: true })
    await writeFile(join(dir, "stale-job-A", ".lock"), JSON.stringify(foreignLock), "utf-8")

    await mkdir(join(dir, "stale-job-B"), { recursive: true })
    await writeFile(join(dir, "stale-job-B", ".lock"), JSON.stringify(foreignLock), "utf-8")

    const mgr = new ConcurrencyManager({ baseDir: dir })
    const broken = await mgr.recoverStaleLocks()

    assert.equal(broken.length, 2)
    assert.ok(broken.includes("stale-job-A"))
    assert.ok(broken.includes("stale-job-B"))

    // Locks should be gone
    assert.equal(await mgr.readLock("stale-job-A"), null)
    assert.equal(await mgr.readLock("stale-job-B"), null)
    await cleanup(dir)
  })

  await test("recoverStaleLocks skips own non-stale locks", async () => {
    const dir = await setup()
    const now = Date.now()
    const mgr = new ConcurrencyManager({ baseDir: dir, now: () => now })

    // Acquire a lock (own bootId, recent)
    await mgr.acquire("fresh-job")

    const broken = await mgr.recoverStaleLocks()
    assert.equal(broken.length, 0, "should not break own fresh lock")

    // Lock should still be present
    const lock = await mgr.readLock("fresh-job")
    assert.ok(lock, "own lock should remain")
    await cleanup(dir)
  })

  // ── 8. TOCTOU Re-Read on Release (H-5) ──────────────────────

  console.log("\n--- TOCTOU Re-Read on Release (H-5) ---")

  await test("release returns false if lock was broken and re-acquired between reads", async () => {
    const dir = await setup()

    // Manager A acquires the lock
    const mgrA = new ConcurrencyManager({ baseDir: dir })
    await mgrA.acquire("job-toctou")

    // Simulate: someone breaks the lock and a different manager re-acquires it
    // between the first readLock and the re-read in release()
    const mgrC = new ConcurrencyManager({ baseDir: dir })
    await mgrC.breakStaleLock("job-toctou")
    const reacquired = await mgrC.acquire("job-toctou")
    assert.ok(reacquired, "mgrC should re-acquire the lock")

    // Now mgrA tries to release — it should fail because the lock is now owned by mgrC
    const released = await mgrA.release("job-toctou")
    assert.equal(released, false, "release should fail because lock is now owned by different manager")

    // Lock should still be held by mgrC
    const lock = await mgrC.readLock("job-toctou")
    assert.ok(lock, "lock should still exist")
    assert.equal(lock.bootId, mgrC.getBootId())
    await cleanup(dir)
  })

  await test("release returns false if lock disappears between reads", async () => {
    const dir = await setup()
    const mgr = new ConcurrencyManager({ baseDir: dir })
    await mgr.acquire("job-vanish")

    // Another process breaks the lock between reads
    const mgrBreaker = new ConcurrencyManager({ baseDir: dir })
    await mgrBreaker.breakStaleLock("job-vanish")

    // release should detect the lock is gone on first readLock
    const released = await mgr.release("job-vanish")
    assert.equal(released, false)
    await cleanup(dir)
  })

  await test("recoverStaleLocks returns empty when baseDir does not exist", async () => {
    const dir = join(tmpdir(), `nonexistent-${Date.now()}`)
    const mgr = new ConcurrencyManager({ baseDir: dir })
    const broken = await mgr.recoverStaleLocks()
    assert.equal(broken.length, 0)
  })

  await test("recoverStaleLocks breaks age-stale locks with same bootId", async () => {
    const dir = await setup()
    const maxAgeMs = 5000
    let clock = 10000
    const mgr = new ConcurrencyManager({
      baseDir: dir,
      maxAgeMs,
      now: () => clock,
    })

    // Acquire at clock=10000
    await mgr.acquire("aging-job")

    // Advance clock past maxAge
    clock = 20000

    const broken = await mgr.recoverStaleLocks()
    assert.equal(broken.length, 1)
    assert.equal(broken[0], "aging-job")
    await cleanup(dir)
  })

  console.log("\nDone.")
}

main()
