// tests/finn/kill-switch-cron.test.ts — Kill switch (file + memory + registry) tests (TASK-2.7)

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { KillSwitch } from "../../src/cron/kill-switch.js"
import type { CronJob } from "../../src/cron/types.js"

// Minimal mock for JobRegistry
class MockJobRegistry {
  private jobs: CronJob[] = []
  private killSwitch = false

  addMockJob(job: CronJob) { this.jobs.push(job) }
  getJobs() { return this.jobs }
  getJob(id: string) { return this.jobs.find(j => j.id === id) }
  async updateJob(id: string, updates: Partial<CronJob>) {
    const idx = this.jobs.findIndex(j => j.id === id)
    if (idx === -1) return false
    this.jobs[idx] = { ...this.jobs[idx], ...updates } as CronJob
    return true
  }
  async releaseRun(jobId: string, _runUlid: string) {
    const job = this.getJob(jobId)
    if (!job) return false
    return this.updateJob(jobId, { currentRunUlid: undefined })
  }
  isKillSwitchActive() { return this.killSwitch }
  async setKillSwitch(active: boolean) { this.killSwitch = active }
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "finn-kill-switch-"))
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

function makeJob(id: string, status: CronJob["status"], runUlid?: string): CronJob {
  return {
    id, name: id, templateId: "t1",
    schedule: { kind: "every", expression: "5m" },
    status, concurrencyPolicy: "skip", enabled: status !== "disabled",
    oneShot: false, config: {},
    currentRunUlid: runUlid,
    circuitBreaker: { state: "closed", failures: 0, successes: 0 },
    createdAt: Date.now(), updatedAt: Date.now(),
  }
}

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

async function main() {
  console.log("Kill Switch (Cron) Tests")
  console.log("========================")

  await test("activate() sets file + memory + registry", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      await ks.activate()
      assert.equal(await ks.isActive(), true)
      assert.equal(existsSync(join(dir, ".kill-switch")), true)
      assert.equal(reg.isKillSwitchActive(), true)
    } finally { cleanup(dir) }
  })

  await test("activate() stops running jobs and returns their IDs", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      reg.addMockJob(makeJob("j1", "running", "run-001"))
      reg.addMockJob(makeJob("j2", "enabled"))
      reg.addMockJob(makeJob("j3", "running", "run-002"))
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      const stopped = await ks.activate()
      assert.deepEqual(stopped.sort(), ["j1", "j3"])
      assert.equal(reg.getJob("j1")!.status, "disabled")
      assert.equal(reg.getJob("j1")!.currentRunUlid, undefined)
      assert.equal(reg.getJob("j2")!.status, "enabled")
      assert.equal(reg.getJob("j3")!.status, "disabled")
    } finally { cleanup(dir) }
  })

  await test("deactivate() clears file + memory + registry", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      await ks.activate()
      await ks.deactivate()
      assert.equal(await ks.isActive(), false)
      assert.equal(existsSync(join(dir, ".kill-switch")), false)
      assert.equal(reg.isKillSwitchActive(), false)
    } finally { cleanup(dir) }
  })

  await test("isActive() returns true when memory is active", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      await ks.activate()
      assert.equal(await ks.isActive(), true)
    } finally { cleanup(dir) }
  })

  await test("isActive() detects file even if memory is false (recovery)", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      // First instance activates
      const ks1 = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      await ks1.activate()
      // Second instance — memory is fresh (false), but file exists
      const ks2 = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      assert.equal(await ks2.isActive(), true)
    } finally { cleanup(dir) }
  })

  await test("isActive() returns false when both file and memory are inactive", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      assert.equal(await ks.isActive(), false)
    } finally { cleanup(dir) }
  })

  await test("getStoppedJobs() returns empty after deactivation", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      reg.addMockJob(makeJob("j1", "running", "run-001"))
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      await ks.activate()
      assert.equal(ks.getStoppedJobs().length, 1)
      await ks.deactivate()
      assert.deepEqual(ks.getStoppedJobs(), [])
    } finally { cleanup(dir) }
  })

  await test("deactivate() is idempotent", async () => {
    const dir = makeTempDir()
    try {
      const reg = new MockJobRegistry()
      const ks = new KillSwitch({ filePath: join(dir, ".kill-switch"), registry: reg as any })
      // Deactivate without ever activating — should not throw
      await ks.deactivate()
      await ks.deactivate()
      assert.equal(await ks.isActive(), false)
      assert.equal(reg.isKillSwitchActive(), false)
    } finally { cleanup(dir) }
  })

  console.log("\nDone.")
}

main()
