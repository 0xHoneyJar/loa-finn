// tests/finn/service.test.ts — CronService lifecycle tests (SDD §5.2, TASK-2.1)

import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { JobRegistry } from "../../src/cron/job-registry.js"
import { CronService } from "../../src/cron/service.js"
import type { CronJob } from "../../src/cron/types.js"

// ── Test harness ────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────

async function setup(): Promise<string> {
  const dir = join(tmpdir(), `cron-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

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

/** Create a registry + service pair with injectable clock. */
async function makeService(dir: string, nowFn?: () => number) {
  const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
  await registry.init()
  const service = new CronService(registry, {
    now: nowFn,
    config: { tickIntervalMs: 50, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
  })
  return { registry, service }
}

// ── Tests ───────────────────────────────────────────────────

async function main() {
  console.log("CronService Tests")
  console.log("=================")

  // ── 1. Job CRUD via service ─────────────────────────────────

  console.log("\n--- Job CRUD ---")

  await test("createJob adds job and arms timer", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    const events: string[] = []
    service.on("job:armed", () => events.push("armed"))

    const job = await service.createJob(makeJob({ id: "j-create" }))
    assert.equal(job.id, "j-create")

    const stored = registry.getJob("j-create")
    assert.ok(stored)
    assert.equal(stored.status, "armed")
    assert.ok(stored.nextRunAtMs)
    assert.ok(events.includes("armed"))

    await cleanup(dir)
  })

  await test("updateJob modifies and re-arms", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    await service.createJob(makeJob({ id: "j-upd" }))
    const ok = await service.updateJob("j-upd", { name: "Updated" })
    assert.equal(ok, true)
    assert.equal(registry.getJob("j-upd")?.name, "Updated")

    await cleanup(dir)
  })

  await test("deleteJob removes job and breaker", async () => {
    const dir = await setup()
    const { service, registry } = await makeService(dir)

    await service.createJob(makeJob({ id: "j-del" }))
    assert.ok(service.getBreaker("j-del"))

    const ok = await service.deleteJob("j-del")
    assert.equal(ok, true)
    assert.equal(registry.getJob("j-del"), undefined)
    assert.equal(service.getBreaker("j-del"), undefined)

    await cleanup(dir)
  })

  await test("deleteJob returns false for nonexistent", async () => {
    const dir = await setup()
    const { service } = await makeService(dir)
    const ok = await service.deleteJob("no-such")
    assert.equal(ok, false)
    await cleanup(dir)
  })

  // ── 2. Timer arming ─────────────────────────────────────────

  console.log("\n--- Timer Arming ---")

  await test("armTimer computes nextRunAtMs and sets status to armed", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    // Add job directly to registry so we can test armTimer independently
    await registry.addJob(makeJob({ id: "j-arm", schedule: { kind: "every", expression: "10m" } }))
    // Restore breaker for the job
    await service.createJob(makeJob({ id: "j-arm2", schedule: { kind: "every", expression: "10m" } }))

    await service.armTimer("j-arm")
    const job = registry.getJob("j-arm")
    assert.ok(job)
    assert.equal(job.status, "armed")
    // "every 10m" from now=1_000_000 => 1_000_000 + 600_000 = 1_600_000
    assert.equal(job.nextRunAtMs, 1_000_000 + 600_000)

    await cleanup(dir)
  })

  // ── 3. Job execution + triggerJob ───────────────────────────

  console.log("\n--- Execution ---")

  await test("triggerJob runs executor and emits started+completed", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service } = await makeService(dir, () => now)

    const executed: string[] = []
    service.setExecutor(async (job) => { executed.push(job.id) })

    await service.createJob(makeJob({ id: "j-trig" }))

    const events: string[] = []
    service.on("job:started", (e) => events.push(`started:${e.jobId}`))
    service.on("job:completed", (e) => events.push(`completed:${e.jobId}:${e.success}`))

    const ok = await service.triggerJob("j-trig")
    assert.equal(ok, true)
    assert.deepEqual(executed, ["j-trig"])
    assert.ok(events.includes("started:j-trig"))
    assert.ok(events.includes("completed:j-trig:true"))

    await cleanup(dir)
  })

  await test("triggerJob returns false for nonexistent job", async () => {
    const dir = await setup()
    const { service } = await makeService(dir)
    const ok = await service.triggerJob("no-such")
    assert.equal(ok, false)
    await cleanup(dir)
  })

  await test("execution failure records error and calls recordFailure", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    service.setExecutor(async () => { throw new Error("boom") })

    await service.createJob(makeJob({ id: "j-fail" }))

    const events: Array<{ success: boolean; error?: string }> = []
    service.on("job:completed", (e) => events.push({ success: e.success, error: e.error }))

    await service.triggerJob("j-fail")

    assert.equal(events.length, 1)
    assert.equal(events[0].success, false)
    assert.equal(events[0].error, "boom")

    const job = registry.getJob("j-fail")
    assert.ok(job)
    assert.equal(job.lastStatus, "failure")
    assert.equal(job.lastError, "boom")

    await cleanup(dir)
  })

  // ── 4. One-shot behavior ────────────────────────────────────

  console.log("\n--- One-Shot ---")

  await test("one-shot job auto-disables after success", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    service.setExecutor(async () => {})

    await service.createJob(makeJob({ id: "j-once", oneShot: true }))

    const events: string[] = []
    service.on("job:disabled", (e) => events.push(e.jobId))

    await service.triggerJob("j-once")

    const job = registry.getJob("j-once")
    assert.ok(job)
    assert.equal(job.enabled, false)
    assert.equal(job.status, "disabled")
    assert.ok(events.includes("j-once"))

    await cleanup(dir)
  })

  await test("one-shot job stays enabled after failure", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    service.setExecutor(async () => { throw new Error("fail") })

    await service.createJob(makeJob({ id: "j-once-fail", oneShot: true }))

    await service.triggerJob("j-once-fail")

    const job = registry.getJob("j-once-fail")
    assert.ok(job)
    // oneShot only disables on success — failure should not disable
    assert.equal(job.lastStatus, "failure")
    // enabled should remain true (failure path does not set enabled=false)
    assert.equal(job.enabled, true)

    await cleanup(dir)
  })

  // ── 5. Circuit breaker integration ──────────────────────────

  console.log("\n--- Circuit Breaker ---")

  await test("circuit breaker blocks execution when open", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service } = await makeService(dir, () => now)

    const executed: string[] = []
    service.setExecutor(async (job) => { executed.push(job.id) })

    // Create job with open circuit breaker
    await service.createJob(makeJob({
      id: "j-cb",
      circuitBreaker: { state: "open", failures: 5, successes: 0, openedAt: now },
    }))

    await service.triggerJob("j-cb")
    // Should NOT have executed due to open breaker
    assert.equal(executed.length, 0)

    await cleanup(dir)
  })

  await test("successful execution calls recordSuccess on breaker", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service } = await makeService(dir, () => now)

    service.setExecutor(async () => {})

    await service.createJob(makeJob({ id: "j-cb-ok" }))
    await service.triggerJob("j-cb-ok")

    const breaker = service.getBreaker("j-cb-ok")
    assert.ok(breaker)
    // After success in closed state with resetOnSuccess=true, failures should be 0
    assert.equal(breaker.state.state, "closed")
    assert.equal(breaker.state.failures, 0)

    await cleanup(dir)
  })

  // ── 6. Stuck job detection ──────────────────────────────────

  console.log("\n--- Stuck Detection ---")

  await test("detectStuckJobs marks old running jobs as stuck", async () => {
    const dir = await setup()
    let now = 10_000_000
    const twoHoursAgo = now - (2 * 60 * 60 * 1000 + 1000)  // Just over 2h ago
    const { service, registry } = await makeService(dir, () => now)

    // Simulate a job that started 2+ hours ago and is still running
    await registry.addJob(makeJob({
      id: "j-stuck",
      name: "Stuck Job",
      status: "running",
      currentRunUlid: "ULID-STUCK",
      lastRunAtMs: twoHoursAgo,
    }))

    const events: string[] = []
    service.on("job:stuck", (e) => events.push(e.jobId))

    await service.detectStuckJobs()

    assert.ok(events.includes("j-stuck"))
    const job = registry.getJob("j-stuck")
    assert.ok(job)
    assert.equal(job.status, "stuck")
    assert.equal(job.lastStatus, "timeout")
    assert.equal(job.currentRunUlid, undefined)

    await cleanup(dir)
  })

  await test("detectStuckJobs ignores recent running jobs", async () => {
    const dir = await setup()
    let now = 10_000_000
    const { service, registry } = await makeService(dir, () => now)

    // Job started 30 min ago — should NOT be flagged
    await registry.addJob(makeJob({
      id: "j-recent",
      status: "running",
      currentRunUlid: "ULID-RECENT",
      lastRunAtMs: now - 30 * 60 * 1000,
    }))

    const events: string[] = []
    service.on("job:stuck", (e) => events.push(e.jobId))

    await service.detectStuckJobs()

    assert.equal(events.length, 0)
    assert.equal(registry.getJob("j-recent")?.status, "running")

    await cleanup(dir)
  })

  // ── 7. runDueJobs ───────────────────────────────────────────

  console.log("\n--- runDueJobs ---")

  await test("runDueJobs fires jobs whose nextRunAtMs has passed", async () => {
    const dir = await setup()
    let now = 2_000_000
    const { service, registry } = await makeService(dir, () => now)

    const executed: string[] = []
    service.setExecutor(async (job) => { executed.push(job.id) })

    // Create a due job via createJob (so breaker is registered), then backdate nextRunAtMs
    await service.createJob(makeJob({ id: "j-due" }))
    await registry.updateJob("j-due", { nextRunAtMs: now - 1000, status: "armed" })

    // Create a future job via createJob, leave its nextRunAtMs in the future
    await service.createJob(makeJob({ id: "j-future" }))
    // nextRunAtMs is now + 300_000 (5m) from armTimer — already in the future, no change needed

    await service.runDueJobs()

    // j-due should have been executed (past due)
    assert.ok(executed.includes("j-due"))
    // j-future should NOT have been executed
    assert.ok(!executed.includes("j-future"))

    await cleanup(dir)
  })

  await test("runDueJobs skips when kill switch is active", async () => {
    const dir = await setup()
    let now = 2_000_000
    const { service, registry } = await makeService(dir, () => now)

    const executed: string[] = []
    service.setExecutor(async (job) => { executed.push(job.id) })

    await service.createJob(makeJob({
      id: "j-killed",
      status: "armed",
      nextRunAtMs: now - 1000,
    }))

    await registry.setKillSwitch(true)
    await service.runDueJobs()

    assert.equal(executed.length, 0)
    await cleanup(dir)
  })

  // ── 8. Start/Stop lifecycle ─────────────────────────────────

  console.log("\n--- Start/Stop ---")

  await test("start arms enabled jobs, stop persists breaker state", async () => {
    const dir = await setup()
    let now = 1_000_000
    const { service, registry } = await makeService(dir, () => now)

    // Pre-populate registry with a job
    await registry.addJob(makeJob({ id: "j-start", schedule: { kind: "every", expression: "5m" } }))

    service.setExecutor(async () => {})

    await service.start()

    // Job should be armed after start
    const armed = registry.getJob("j-start")
    assert.ok(armed)
    assert.equal(armed.status, "armed")
    assert.ok(armed.nextRunAtMs)

    await service.stop()
    await cleanup(dir)
  })

  // ── 9. Stuck detection alerts ───────────────────────────────

  console.log("\n--- Alert Integration ---")

  await test("stuck detection fires alert via alertService", async () => {
    const dir = await setup()
    let now = 10_000_000
    const twoHoursAgo = now - (2 * 60 * 60 * 1000 + 1000)

    const alerts: Array<{ severity: string; trigger: string; jobId?: string }> = []
    const alertService = {
      async fire(severity: string, trigger: string, ctx: { jobId?: string; message: string }) {
        alerts.push({ severity, trigger, jobId: ctx.jobId })
        return true
      },
    }

    const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
    await registry.init()
    const service = new CronService(registry, {
      now: () => now,
      alertService,
      config: { tickIntervalMs: 50, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
    })

    await registry.addJob(makeJob({
      id: "j-alert",
      name: "Alerting Job",
      status: "running",
      currentRunUlid: "ULID-ALERT",
      lastRunAtMs: twoHoursAgo,
    }))

    await service.detectStuckJobs()

    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].severity, "error")
    assert.equal(alerts[0].trigger, "stuck_job")
    assert.equal(alerts[0].jobId, "j-alert")

    await cleanup(dir)
  })

  console.log("\nDone.")
}

main()
