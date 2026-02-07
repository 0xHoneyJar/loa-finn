// src/__tests__/integration/cron-integration.test.ts — CronService integration tests (TASK-2.8)
//
// Wires REAL components (CronService, JobRegistry, CircuitBreaker, KillSwitch,
// JobRunner) together. Only external boundaries (session factory, audit context,
// template resolver) are mocked.

import assert from "node:assert/strict"
import { mkdir, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { JobRegistry } from "../../../src/cron/job-registry.js"
import { CronService } from "../../../src/cron/service.js"
import { JobRunner } from "../../../src/cron/runner.js"
import type {
  Template,
  TemplateItem,
  JobContext,
  SessionFactory,
  SessionResult,
  AuditContextManager,
  SessionOptions,
} from "../../../src/cron/runner.js"
import { KillSwitch } from "../../../src/cron/kill-switch.js"
import type { CronJob } from "../../../src/cron/types.js"

// ── Test harness (Finn pattern) ──────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `cron-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    templateId: overrides.templateId ?? "tpl-1",
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

function makeTemplate(items: TemplateItem[] = []): Template {
  return {
    id: "tpl-1",
    resolveItems: async () => items,
  }
}

function makeItems(count: number): TemplateItem[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `item-${i}`,
    hash: `hash-${i}`,
    data: { index: i },
  }))
}

function makeContext(): JobContext {
  const seen = new Map<string, string>()
  return {
    hasChanged(key: string, hash: string) { return seen.get(key) !== hash },
    update(key: string, hash: string) { seen.set(key, hash) },
    async save() {},
    async load() {},
  }
}

function makeSessionFactory(result: Partial<SessionResult> = {}): SessionFactory & { calls: SessionOptions[] } {
  const calls: SessionOptions[] = []
  return {
    calls,
    async createSession(opts: SessionOptions) {
      calls.push(opts)
      return { toolCalls: 1, success: true, ...result }
    },
  }
}

function makeAuditContext(): AuditContextManager & {
  contexts: Array<{ jobId: string; runUlid: string; templateId: string }>
  clearCount: number
} {
  return {
    contexts: [],
    clearCount: 0,
    setRunContext(ctx: { jobId: string; runUlid: string; templateId: string }) {
      this.contexts.push(ctx)
    },
    clearRunContext() {
      this.clearCount++
    },
  }
}

// ── Tests ────────────────────────────────────────────────────

async function main() {
  console.log("CronService Integration Tests (TASK-2.8)")
  console.log("==========================================")

  // ── TEST 1: Full Pipeline — cron tick -> runner -> audit ───

  console.log("\n--- 1. Full Pipeline: cron tick -> runner -> audit ---")

  await test("1a. triggerJob -> executor -> run record + audit context set/cleared", async () => {
    const dir = await makeTempDir()
    try {
      let now = 1_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      // Wire a real JobRunner as the executor
      const sessionFactory = makeSessionFactory({ toolCalls: 3, success: true })
      const auditCtx = makeAuditContext()
      const template = makeTemplate(makeItems(2))

      const runner = new JobRunner({
        resolveTemplate: async (id) => id === "tpl-1" ? template : null,
        createContext: () => makeContext(),
        sessionFactory,
        auditContext: auditCtx,
        now: () => now,
      })

      // Connect the runner as the executor
      service.setExecutor(async (job, runUlid) => {
        await runner.run(job, runUlid)
      })

      // Create job and trigger
      await service.createJob(makeJob({ id: "pipeline-1" }))

      const events: string[] = []
      service.on("job:started", (e) => events.push(`started:${e.jobId}`))
      service.on("job:completed", (e) => events.push(`completed:${e.jobId}:${e.success}`))

      await service.triggerJob("pipeline-1")

      // Verify events
      assert.ok(events.includes("started:pipeline-1"), "should emit job:started")
      assert.ok(events.includes("completed:pipeline-1:true"), "should emit job:completed")

      // Verify session factory was called for each item
      assert.equal(sessionFactory.calls.length, 2, "session factory called once per item")

      // Verify audit context was set and cleared
      assert.equal(auditCtx.contexts.length, 1, "audit context set once")
      assert.equal(auditCtx.contexts[0].jobId, "pipeline-1")
      assert.equal(auditCtx.contexts[0].templateId, "tpl-1")
      assert.equal(auditCtx.clearCount, 1, "audit context cleared once")

      // Verify run record persisted (JSONL in runs dir)
      const logPath = join(dir, "runs", "pipeline-1.jsonl")
      const logContent = await readFile(logPath, "utf-8")
      const lines = logContent.trim().split("\n")
      assert.equal(lines.length, 1, "one run record in log")
      const record = JSON.parse(lines[0])
      assert.equal(record.jobId, "pipeline-1")
      assert.equal(record.status, "success")

      // Verify job state updated in registry
      const job = registry.getJob("pipeline-1")
      assert.ok(job)
      assert.equal(job.lastStatus, "success")
      assert.equal(job.currentRunUlid, undefined, "CAS released after run")
    } finally {
      await cleanup(dir)
    }
  })

  await test("1b. runDueJobs fires due job through full pipeline", async () => {
    const dir = await makeTempDir()
    try {
      let now = 2_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      const sessionFactory = makeSessionFactory()
      const auditCtx = makeAuditContext()
      const template = makeTemplate(makeItems(1))

      const runner = new JobRunner({
        resolveTemplate: async () => template,
        createContext: () => makeContext(),
        sessionFactory,
        auditContext: auditCtx,
        now: () => now,
      })

      service.setExecutor(async (job, runUlid) => {
        await runner.run(job, runUlid)
      })

      // Create job via service (which arms the timer)
      await service.createJob(makeJob({ id: "due-1" }))
      // Backdate nextRunAtMs so it is due
      await registry.updateJob("due-1", { nextRunAtMs: now - 1000, status: "armed" })

      const completed: string[] = []
      service.on("job:completed", (e) => completed.push(e.jobId))

      await service.runDueJobs()

      assert.ok(completed.includes("due-1"), "due job should fire through runDueJobs")
      assert.equal(sessionFactory.calls.length, 1, "session created for the item")
      assert.equal(auditCtx.contexts.length, 1, "audit context set")
    } finally {
      await cleanup(dir)
    }
  })

  // ── TEST 2: Concurrent Job Policies ────────────────────────

  console.log("\n--- 2. Concurrent Job Policies ---")

  await test("2a. concurrencyPolicy=skip: running job is skipped by runDueJobs", async () => {
    const dir = await makeTempDir()
    try {
      let now = 2_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      const executed: string[] = []
      service.setExecutor(async (job) => { executed.push(job.id) })

      // Create job and set it to "running" with an active CAS token
      await service.createJob(makeJob({ id: "skip-1", concurrencyPolicy: "skip" }))
      // Simulate an in-progress run by claiming CAS
      await registry.tryClaimRun("skip-1", "existing-run-ulid")
      // Backdate nextRunAtMs so it would be due
      await registry.updateJob("skip-1", { nextRunAtMs: now - 1000 })

      await service.runDueJobs()

      // The running status should cause runDueJobs to skip it
      assert.equal(executed.length, 0, "running job with skip policy should not execute again")
    } finally {
      await cleanup(dir)
    }
  })

  await test("2b. concurrencyPolicy=skip: triggerJob skips when CAS already held", async () => {
    const dir = await makeTempDir()
    try {
      let now = 2_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      const executed: string[] = []
      service.setExecutor(async (job) => { executed.push(job.id) })

      await service.createJob(makeJob({ id: "skip-2", concurrencyPolicy: "skip" }))
      // Claim CAS to simulate running job
      await registry.tryClaimRun("skip-2", "prev-run-ulid")

      await service.triggerJob("skip-2")

      // Should be skipped due to existing CAS token
      assert.equal(executed.length, 0, "triggerJob should skip when CAS held")
    } finally {
      await cleanup(dir)
    }
  })

  await test("2c. second trigger succeeds after first completes (CAS released)", async () => {
    const dir = await makeTempDir()
    try {
      let now = 2_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      const executed: string[] = []
      service.setExecutor(async (job) => { executed.push(job.id) })

      await service.createJob(makeJob({ id: "seq-1", concurrencyPolicy: "skip" }))

      // First trigger succeeds
      await service.triggerJob("seq-1")
      assert.equal(executed.length, 1, "first trigger executes")

      // CAS should be released — second trigger should also succeed
      const job = registry.getJob("seq-1")
      assert.equal(job?.currentRunUlid, undefined, "CAS released after first run")

      await service.triggerJob("seq-1")
      assert.equal(executed.length, 2, "second trigger executes after CAS released")
    } finally {
      await cleanup(dir)
    }
  })

  // ── TEST 3: Circuit Breaker End-to-End ─────────────────────

  console.log("\n--- 3. Circuit Breaker End-to-End ---")

  await test("3a. closed -> open after N failures (default threshold=5)", async () => {
    const dir = await makeTempDir()
    try {
      let now = 1_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      // Executor always fails
      service.setExecutor(async () => { throw new Error("always-fail") })

      await service.createJob(makeJob({ id: "cb-1" }))

      // Verify initially closed
      const breaker = service.getBreaker("cb-1")
      assert.ok(breaker)
      assert.equal(breaker.state.state, "closed")

      // Trigger 5 times (default failureThreshold=5)
      for (let i = 0; i < 5; i++) {
        await service.triggerJob("cb-1")
      }

      assert.equal(breaker.state.state, "open", "breaker should open after 5 failures")
      assert.equal(breaker.state.failures, 5)

      // 6th trigger should be blocked by the breaker
      const executed: string[] = []
      const oldExecutor = service["executor"]
      service.setExecutor(async (job) => { executed.push(job.id) })
      await service.triggerJob("cb-1")
      assert.equal(executed.length, 0, "execution blocked when breaker open")

      // Restore failing executor for later tests
      service.setExecutor(oldExecutor!)
    } finally {
      await cleanup(dir)
    }
  })

  await test("3b. open -> half_open after openDurationMs -> close on successes", async () => {
    const dir = await makeTempDir()
    try {
      let now = 1_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      // Start with failing executor
      let shouldFail = true
      service.setExecutor(async () => {
        if (shouldFail) throw new Error("fail")
      })

      await service.createJob(makeJob({ id: "cb-2" }))
      const breaker = service.getBreaker("cb-2")!

      // Fail 5 times to open the breaker
      for (let i = 0; i < 5; i++) {
        await service.triggerJob("cb-2")
      }
      assert.equal(breaker.state.state, "open")

      // Advance clock past openDurationMs (default 30 minutes)
      now += 30 * 60 * 1000 + 1

      // Verify canExecute transitions to half_open
      assert.equal(breaker.canExecute(), true, "should allow probe after openDurationMs")
      assert.equal(breaker.state.state, "half_open")

      // Now switch to succeeding executor
      shouldFail = false

      // Trigger twice (default halfOpenProbeCount=2) for half_open -> closed
      await service.triggerJob("cb-2")
      await service.triggerJob("cb-2")

      assert.equal(breaker.state.state, "closed", "breaker should close after 2 successes in half_open")
      assert.equal(breaker.state.failures, 0, "failures reset on close")
    } finally {
      await cleanup(dir)
    }
  })

  await test("3c. half_open -> back to open on failure during probe", async () => {
    const dir = await makeTempDir()
    try {
      let now = 1_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      service.setExecutor(async () => { throw new Error("fail") })

      await service.createJob(makeJob({ id: "cb-3" }))
      const breaker = service.getBreaker("cb-3")!

      // Open the breaker
      for (let i = 0; i < 5; i++) {
        await service.triggerJob("cb-3")
      }
      assert.equal(breaker.state.state, "open")

      // Advance past openDurationMs to enable half_open transition
      now += 30 * 60 * 1000 + 1
      breaker.canExecute() // triggers transition
      assert.equal(breaker.state.state, "half_open")

      // Trigger with failing executor — should go back to open
      await service.triggerJob("cb-3")
      assert.equal(breaker.state.state, "open", "failure in half_open reverts to open")
    } finally {
      await cleanup(dir)
    }
  })

  // ── TEST 4: Kill Switch Mid-Execution ──────────────────────

  console.log("\n--- 4. Kill Switch Mid-Execution ---")

  await test("4a. kill switch stops running jobs and blocks new runs", async () => {
    const dir = await makeTempDir()
    try {
      let now = 2_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      // Create two jobs: one already running, one armed
      await service.createJob(makeJob({ id: "ks-run", status: "enabled" }))
      await service.createJob(makeJob({ id: "ks-armed", status: "enabled" }))

      // Simulate ks-run as actively running
      await registry.tryClaimRun("ks-run", "active-run-ulid")
      await registry.updateJob("ks-run", { status: "running" })

      const killSwitch = new KillSwitch({
        filePath: join(dir, ".kill-switch"),
        registry,
      })

      // Activate kill switch
      const stopped = await killSwitch.activate()

      // Verify running job was stopped
      assert.ok(stopped.includes("ks-run"), "running job should be in stopped list")
      const runJob = registry.getJob("ks-run")
      assert.equal(runJob?.status, "disabled", "running job disabled")
      assert.equal(runJob?.enabled, false, "running job marked not enabled")
      assert.equal(runJob?.currentRunUlid, undefined, "CAS released")

      // Verify kill switch blocks new runs via runDueJobs
      assert.equal(registry.isKillSwitchActive(), true)

      const executed: string[] = []
      service.setExecutor(async (job) => { executed.push(job.id) })

      await registry.updateJob("ks-armed", { nextRunAtMs: now - 1000, status: "armed" })
      await service.runDueJobs()
      assert.equal(executed.length, 0, "no jobs should run when kill switch active")
    } finally {
      await cleanup(dir)
    }
  })

  await test("4b. deactivating kill switch re-enables execution", async () => {
    const dir = await makeTempDir()
    try {
      let now = 2_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      const executed: string[] = []
      service.setExecutor(async (job) => { executed.push(job.id) })

      await service.createJob(makeJob({ id: "ks-resume" }))

      const killSwitch = new KillSwitch({
        filePath: join(dir, ".kill-switch"),
        registry,
      })

      // Activate then deactivate
      await killSwitch.activate()
      assert.equal(registry.isKillSwitchActive(), true)

      await killSwitch.deactivate()
      assert.equal(registry.isKillSwitchActive(), false)

      // Re-enable the job and set it as due
      await registry.updateJob("ks-resume", { enabled: true, nextRunAtMs: now - 1000, status: "armed" })

      await service.runDueJobs()
      assert.ok(executed.includes("ks-resume"), "job can run after kill switch deactivated")
    } finally {
      await cleanup(dir)
    }
  })

  // ── TEST 5: Crash Recovery ─────────────────────────────────

  console.log("\n--- 5. Crash Recovery ---")

  await test("5a. detectStuckJobs reconciles orphaned running jobs", async () => {
    const dir = await makeTempDir()
    try {
      let now = 10_000_000
      const stuckTimeout = 2 * 60 * 60 * 1000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      // Simulate crash: job left in "running" with stale lastRunAtMs
      const orphanedJob = makeJob({
        id: "orphan-1",
        status: "running",
        currentRunUlid: "CRASH-ULID-001",
        lastRunAtMs: now - stuckTimeout - 5000, // Just past the stuck timeout
      })
      await registry.addJob(orphanedJob)

      // Also add a healthy running job (recent) that should NOT be touched
      const healthyJob = makeJob({
        id: "healthy-1",
        status: "running",
        currentRunUlid: "HEALTHY-ULID",
        lastRunAtMs: now - 30 * 60 * 1000, // Only 30 min ago
      })
      await registry.addJob(healthyJob)

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: stuckTimeout },
      })

      const stuckEvents: string[] = []
      service.on("job:stuck", (e) => stuckEvents.push(e.jobId))

      await service.detectStuckJobs()

      // Orphaned job should be detected as stuck
      assert.ok(stuckEvents.includes("orphan-1"), "orphaned job detected as stuck")
      const orphan = registry.getJob("orphan-1")
      assert.equal(orphan?.status, "stuck", "orphan status set to stuck")
      assert.equal(orphan?.lastStatus, "timeout", "orphan lastStatus set to timeout")
      assert.equal(orphan?.currentRunUlid, undefined, "orphan CAS released")

      // Healthy job should be untouched
      assert.ok(!stuckEvents.includes("healthy-1"), "healthy job not flagged")
      const healthy = registry.getJob("healthy-1")
      assert.equal(healthy?.status, "running", "healthy job still running")
      assert.equal(healthy?.currentRunUlid, "HEALTHY-ULID", "healthy CAS intact")
    } finally {
      await cleanup(dir)
    }
  })

  await test("5b. recoverStuckJobs clears orphaned intents at registry level", async () => {
    const dir = await makeTempDir()
    try {
      const now = Date.now()
      const twoHoursMs = 2 * 60 * 60 * 1000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      // Add a job stuck for over 2 hours
      await registry.addJob(makeJob({
        id: "stuck-reg-1",
        status: "running",
        currentRunUlid: "STALE-ULID",
        lastRunAtMs: now - twoHoursMs - 10_000,
      }))

      // Add a recent running job (should NOT be recovered)
      await registry.addJob(makeJob({
        id: "recent-run-1",
        status: "running",
        currentRunUlid: "RECENT-ULID",
        lastRunAtMs: now - 60_000, // 1 minute ago
      }))

      const recovered = await registry.recoverStuckJobs()

      assert.ok(recovered.includes("stuck-reg-1"), "stale job recovered")
      assert.ok(!recovered.includes("recent-run-1"), "recent job not recovered")

      const stuckJob = registry.getJob("stuck-reg-1")
      assert.equal(stuckJob?.currentRunUlid, undefined, "CAS cleared")
      assert.equal(stuckJob?.status, "enabled", "status reset to enabled")
      assert.equal(stuckJob?.lastStatus, "timeout", "lastStatus set to timeout")
    } finally {
      await cleanup(dir)
    }
  })

  await test("5c. CronService.start() arms recovered jobs after init", async () => {
    const dir = await makeTempDir()
    try {
      let now = 5_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      // Pre-populate with an enabled job that has no nextRunAtMs (simulating post-crash)
      await registry.addJob(makeJob({
        id: "recover-arm-1",
        status: "enabled",
        enabled: true,
        schedule: { kind: "every", expression: "10m" },
      }))

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      const armedEvents: string[] = []
      service.on("job:armed", (e) => armedEvents.push(e.jobId))

      await service.start()

      // Job should be armed during start
      assert.ok(armedEvents.includes("recover-arm-1"), "recovered job armed during start")
      const job = registry.getJob("recover-arm-1")
      assert.equal(job?.status, "armed", "status updated to armed")
      assert.ok(job?.nextRunAtMs, "nextRunAtMs set")

      await service.stop()
    } finally {
      await cleanup(dir)
    }
  })

  await test("5d. start() restores circuit breaker state from persisted data", async () => {
    const dir = await makeTempDir()
    try {
      let now = 5_000_000
      const registry = new JobRegistry(join(dir, "registry.json"), join(dir, "runs"))
      await registry.init()

      // Pre-populate with a job that had 3 failures persisted
      await registry.addJob(makeJob({
        id: "cb-restore-1",
        status: "enabled",
        enabled: true,
        circuitBreaker: {
          state: "closed",
          failures: 3,
          successes: 0,
          lastFailureAt: now - 60_000,
        },
      }))

      const service = new CronService(registry, {
        now: () => now,
        config: { tickIntervalMs: 60_000, stuckJobTimeoutMs: 2 * 60 * 60 * 1000 },
      })

      await service.start()

      const breaker = service.getBreaker("cb-restore-1")
      assert.ok(breaker, "breaker created during start")
      assert.equal(breaker.state.state, "closed")
      assert.equal(breaker.state.failures, 3, "persisted failure count restored")

      await service.stop()
    } finally {
      await cleanup(dir)
    }
  })

  console.log("\nDone.")
}

main()
