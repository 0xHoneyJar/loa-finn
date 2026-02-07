// tests/finn/job-registry.test.ts — JobRegistry tests (SDD §5.2)

import assert from "node:assert/strict"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { JobRegistry } from "../../src/cron/job-registry.js"
import type { CronJob, CronRunRecord } from "../../src/cron/types.js"

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

// Unique temp dir per test run
async function setup(): Promise<string> {
  const dir = join(tmpdir(), `job-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Helper: create a minimal valid CronJob for testing. */
function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now()
  return {
    id: overrides.id ?? "job-1",
    name: overrides.name ?? "Test Job",
    templateId: overrides.templateId ?? "tmpl-1",
    schedule: overrides.schedule ?? { kind: "every", expression: "5m" },
    status: overrides.status ?? "enabled",
    concurrencyPolicy: overrides.concurrencyPolicy ?? "skip",
    enabled: overrides.enabled ?? true,
    oneShot: overrides.oneShot ?? false,
    config: overrides.config ?? {},
    circuitBreaker: overrides.circuitBreaker ?? { state: "closed", failures: 0, successes: 0 },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  }
}

async function main() {
  console.log("Job Registry Tests")
  console.log("==================")

  // ── 1. Init ────────────────────────────────────────────────

  console.log("\n--- Init ---")

  await test("init creates empty registry when no file exists", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()
    assert.deepEqual(registry.getJobs(), [])
    assert.equal(registry.isKillSwitchActive(), false)
    await cleanup(dir)
  })

  // ── 2. CRUD ────────────────────────────────────────────────

  console.log("\n--- CRUD ---")

  await test("addJob + getJob returns the job", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    const job = makeJob({ id: "j-abc" })
    await registry.addJob(job)

    const found = registry.getJob("j-abc")
    assert.ok(found)
    assert.equal(found.id, "j-abc")
    assert.equal(found.name, "Test Job")
    await cleanup(dir)
  })

  await test("addJob + getJobs returns all jobs", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    await registry.addJob(makeJob({ id: "j-1", name: "First" }))
    await registry.addJob(makeJob({ id: "j-2", name: "Second" }))
    await registry.addJob(makeJob({ id: "j-3", name: "Third" }))

    const jobs = registry.getJobs()
    assert.equal(jobs.length, 3)
    assert.deepEqual(jobs.map(j => j.id), ["j-1", "j-2", "j-3"])
    await cleanup(dir)
  })

  await test("updateJob modifies fields", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    await registry.addJob(makeJob({ id: "j-upd", name: "Original" }))
    const updated = await registry.updateJob("j-upd", { name: "Renamed", status: "disabled" })
    assert.equal(updated, true)

    const job = registry.getJob("j-upd")
    assert.ok(job)
    assert.equal(job.name, "Renamed")
    assert.equal(job.status, "disabled")
    // updatedAt should have been refreshed
    assert.ok(job.updatedAt > 0)
    await cleanup(dir)
  })

  await test("deleteJob removes job", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    await registry.addJob(makeJob({ id: "j-del" }))
    assert.equal(registry.getJobs().length, 1)

    const deleted = await registry.deleteJob("j-del")
    assert.equal(deleted, true)
    assert.equal(registry.getJobs().length, 0)
    assert.equal(registry.getJob("j-del"), undefined)
    await cleanup(dir)
  })

  await test("deleteJob returns false for nonexistent", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    const deleted = await registry.deleteJob("no-such-job")
    assert.equal(deleted, false)
    await cleanup(dir)
  })

  // ── 3. CAS (Compare-and-Swap) ─────────────────────────────

  console.log("\n--- CAS (Compare-and-Swap) ---")

  await test("tryClaimRun succeeds for idle job, fails if already claimed", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    await registry.addJob(makeJob({ id: "j-cas" }))

    // First claim should succeed
    const claimed = await registry.tryClaimRun("j-cas", "ULID-001")
    assert.equal(claimed, true)

    const job = registry.getJob("j-cas")
    assert.ok(job)
    assert.equal(job.currentRunUlid, "ULID-001")
    assert.equal(job.status, "running")

    // Second claim should fail (already running)
    const claimedAgain = await registry.tryClaimRun("j-cas", "ULID-002")
    assert.equal(claimedAgain, false)

    // Original ULID still in place
    assert.equal(registry.getJob("j-cas")?.currentRunUlid, "ULID-001")
    await cleanup(dir)
  })

  await test("releaseRun succeeds with matching ULID, fails with wrong ULID", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    await registry.addJob(makeJob({ id: "j-rel" }))
    await registry.tryClaimRun("j-rel", "ULID-AAA")

    // Wrong ULID should fail
    const wrongRelease = await registry.releaseRun("j-rel", "ULID-BBB")
    assert.equal(wrongRelease, false)
    assert.equal(registry.getJob("j-rel")?.currentRunUlid, "ULID-AAA")

    // Correct ULID should succeed
    const released = await registry.releaseRun("j-rel", "ULID-AAA")
    assert.equal(released, true)
    assert.equal(registry.getJob("j-rel")?.currentRunUlid, undefined)
    await cleanup(dir)
  })

  // ── 4. Recovery ────────────────────────────────────────────

  console.log("\n--- Recovery ---")

  await test("recoverStuckJobs clears runs older than maxAge", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    const oldTime = Date.now() - 3 * 60 * 60 * 1000  // 3 hours ago
    const recentTime = Date.now() - 30 * 60 * 1000    // 30 minutes ago

    // Stuck job (old run)
    await registry.addJob(makeJob({
      id: "j-stuck",
      currentRunUlid: "ULID-STUCK",
      lastRunAtMs: oldTime,
      status: "running",
    }))

    // Recent job (should NOT be recovered)
    await registry.addJob(makeJob({
      id: "j-recent",
      currentRunUlid: "ULID-RECENT",
      lastRunAtMs: recentTime,
      status: "running",
    }))

    // Idle job (no currentRunUlid, should be untouched)
    await registry.addJob(makeJob({ id: "j-idle" }))

    // Default maxAge is 2 hours
    const recovered = await registry.recoverStuckJobs()

    assert.deepEqual(recovered, ["j-stuck"])

    // Stuck job should be cleared
    const stuck = registry.getJob("j-stuck")
    assert.ok(stuck)
    assert.equal(stuck.currentRunUlid, undefined)
    assert.equal(stuck.status, "enabled")
    assert.equal(stuck.lastStatus, "timeout")

    // Recent job should still be running
    const recent = registry.getJob("j-recent")
    assert.ok(recent)
    assert.equal(recent.currentRunUlid, "ULID-RECENT")
    assert.equal(recent.status, "running")

    // Idle job untouched
    const idle = registry.getJob("j-idle")
    assert.ok(idle)
    assert.equal(idle.currentRunUlid, undefined)
    await cleanup(dir)
  })

  // ── 5. Kill Switch ─────────────────────────────────────────

  console.log("\n--- Kill Switch ---")

  await test("kill switch toggle", async () => {
    const dir = await setup()
    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()

    assert.equal(registry.isKillSwitchActive(), false)

    await registry.setKillSwitch(true)
    assert.equal(registry.isKillSwitchActive(), true)

    await registry.setKillSwitch(false)
    assert.equal(registry.isKillSwitchActive(), false)
    await cleanup(dir)
  })

  // ── 6. Run Record Append ───────────────────────────────────

  console.log("\n--- Run Record Append ---")

  await test("run record append to JSONL", async () => {
    const dir = await setup()
    const runsDir = join(dir, "runs")
    const registry = new JobRegistry(join(dir, "registry.json"), runsDir)
    await registry.init()

    const record1: CronRunRecord = {
      jobId: "j-log",
      runUlid: "ULID-R1",
      startedAt: "2026-02-07T10:00:00Z",
      status: "success",
      itemsProcessed: 5,
      toolCalls: 3,
      durationMs: 1200,
    }

    const record2: CronRunRecord = {
      jobId: "j-log",
      runUlid: "ULID-R2",
      startedAt: "2026-02-07T10:05:00Z",
      status: "failure",
      itemsProcessed: 0,
      toolCalls: 1,
      error: "timeout",
    }

    await registry.appendRunRecord(record1)
    await registry.appendRunRecord(record2)

    const logPath = join(runsDir, "j-log.jsonl")
    const content = await readFile(logPath, "utf-8")
    const lines = content.trim().split("\n")
    assert.equal(lines.length, 2)

    const parsed1 = JSON.parse(lines[0])
    assert.equal(parsed1.runUlid, "ULID-R1")
    assert.equal(parsed1.status, "success")

    const parsed2 = JSON.parse(lines[1])
    assert.equal(parsed2.runUlid, "ULID-R2")
    assert.equal(parsed2.status, "failure")
    assert.equal(parsed2.error, "timeout")
    await cleanup(dir)
  })

  // ── 7. Persistence ─────────────────────────────────────────

  console.log("\n--- Persistence ---")

  await test("persistence: write then create new instance + init reads back", async () => {
    const dir = await setup()
    const filePath = join(dir, "registry.json")
    const runsDir = join(dir, "runs")

    // First instance: add jobs and set kill switch
    const reg1 = new JobRegistry(filePath, runsDir)
    await reg1.init()
    await reg1.addJob(makeJob({ id: "j-persist-1", name: "Persistent A" }))
    await reg1.addJob(makeJob({ id: "j-persist-2", name: "Persistent B" }))
    await reg1.setKillSwitch(true)

    // Second instance: reads from disk
    const reg2 = new JobRegistry(filePath, runsDir)
    await reg2.init()

    const jobs = reg2.getJobs()
    assert.equal(jobs.length, 2)
    assert.equal(jobs[0].id, "j-persist-1")
    assert.equal(jobs[0].name, "Persistent A")
    assert.equal(jobs[1].id, "j-persist-2")
    assert.equal(jobs[1].name, "Persistent B")
    assert.equal(reg2.isKillSwitchActive(), true)
    await cleanup(dir)
  })

  console.log("\nDone.")
}

main()
