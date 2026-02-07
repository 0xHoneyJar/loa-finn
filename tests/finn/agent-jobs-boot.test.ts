// tests/finn/agent-jobs-boot.test.ts — Agent-jobs boot sequence tests (SDD §8.1)

import assert from "node:assert/strict"
import { bootAgentJobs } from "../../src/boot/agent-jobs-boot.js"
import type { AgentJobsBootConfig, AgentJobsBootDeps } from "../../src/boot/agent-jobs-boot.js"

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Helper: all-passing deps ─────────────────────────────

function passingDeps(): AgentJobsBootDeps {
  return {
    validateBoot: async () => ({ tokenType: "app", warnings: [] }),
    validateFs: async () => ({ warnings: [] }),
    initAuditTrail: async () => true,
    initAlertService: async () => true,
    initFirewall: async () => true,
    firewallSelfTest: async () => true,
    reconcileOrphanedIntents: async () => 0,
    recoverStaleLocks: async () => [],
    initCronService: async () => true,
  }
}

function baseConfig(): AgentJobsBootConfig {
  return { token: "ghs_test123", autonomous: true, dataDir: "/tmp/test", enabled: true }
}

// ── Tests ────────────────────────────────────────────────

test("boot succeeds with all deps passing", async () => {
  const result = await bootAgentJobs(baseConfig(), passingDeps())
  assert.equal(result.success, true)
  assert.equal(result.error, undefined)
  assert.ok(result.subsystems)
  assert.equal(result.subsystems.auditTrail, true)
  assert.equal(result.subsystems.alertService, true)
  assert.equal(result.subsystems.firewall, true)
  assert.equal(result.subsystems.cronService, true)
})

test("boot returns disabled when config.enabled = false", async () => {
  const result = await bootAgentJobs({ enabled: false }, passingDeps())
  assert.equal(result.success, false)
  assert.ok(result.error?.includes("disabled"))
})

test("boot fails gracefully when token missing for autonomous mode", async () => {
  const result = await bootAgentJobs({ autonomous: true, enabled: true }, passingDeps())
  assert.equal(result.success, false)
  assert.ok(result.error?.includes("token"))
})

test("boot fails gracefully when filesystem validation fails", async () => {
  const deps = passingDeps()
  deps.validateFs = async () => { throw new Error("FS check failed") }
  const result = await bootAgentJobs(baseConfig(), deps)
  assert.equal(result.success, false)
  assert.ok(result.error?.includes("FS check failed"))
})

test("boot fails gracefully when audit trail init fails", async () => {
  const deps = passingDeps()
  deps.initAuditTrail = async () => false
  const result = await bootAgentJobs(baseConfig(), deps)
  assert.equal(result.success, false)
  assert.ok(result.error?.includes("Audit trail"))
  assert.equal(result.subsystems?.auditTrail, false)
})

test("boot fails gracefully when firewall self-test fails", async () => {
  const deps = passingDeps()
  deps.firewallSelfTest = async () => false
  const result = await bootAgentJobs(baseConfig(), deps)
  assert.equal(result.success, false)
  assert.ok(result.error?.includes("self-test"))
})

test("boot reports orphaned intent count", async () => {
  const deps = passingDeps()
  deps.reconcileOrphanedIntents = async () => 3
  const result = await bootAgentJobs(baseConfig(), deps)
  assert.equal(result.success, true)
  assert.equal(result.orphanedIntents, 3)
  assert.ok(result.warnings.some((w) => w.includes("3 orphaned")))
})

test("boot reports stale locks recovered", async () => {
  const deps = passingDeps()
  deps.recoverStaleLocks = async () => ["job-a", "job-b"]
  const result = await bootAgentJobs(baseConfig(), deps)
  assert.equal(result.success, true)
  assert.deepEqual(result.staleLocks, ["job-a", "job-b"])
  assert.ok(result.warnings.some((w) => w.includes("2 stale lock")))
})

test("boot sequence runs steps in order", async () => {
  const callOrder: string[] = []
  const deps: AgentJobsBootDeps = {
    validateBoot: async () => { callOrder.push("validateBoot"); return { tokenType: "app", warnings: [] } },
    validateFs: async () => { callOrder.push("validateFs"); return { warnings: [] } },
    initAuditTrail: async () => { callOrder.push("initAuditTrail"); return true },
    initAlertService: async () => { callOrder.push("initAlertService"); return true },
    initFirewall: async () => { callOrder.push("initFirewall"); return true },
    firewallSelfTest: async () => { callOrder.push("firewallSelfTest"); return true },
    reconcileOrphanedIntents: async () => { callOrder.push("reconcileOrphanedIntents"); return 0 },
    recoverStaleLocks: async () => { callOrder.push("recoverStaleLocks"); return [] },
    initCronService: async () => { callOrder.push("initCronService"); return true },
  }
  await bootAgentJobs(baseConfig(), deps)
  assert.deepEqual(callOrder, [
    "validateBoot",
    "validateFs",
    "initAuditTrail",
    "initAlertService",
    "initFirewall",
    "firewallSelfTest",
    "reconcileOrphanedIntents",
    "recoverStaleLocks",
    "initCronService",
  ])
})

test("subsystem status reported correctly in result", async () => {
  const deps = passingDeps()
  // Alert service fails but boot continues (non-critical)
  deps.initAlertService = async () => false
  const result = await bootAgentJobs(baseConfig(), deps)
  assert.equal(result.success, true)
  assert.ok(result.subsystems)
  assert.equal(result.subsystems.auditTrail, true)
  assert.equal(result.subsystems.alertService, false)
  assert.equal(result.subsystems.firewall, true)
  assert.equal(result.subsystems.cronService, true)
  assert.ok(result.warnings.some((w) => w.includes("Alert service")))
})

// ── Runner ───────────────────────────────────────────────

async function main() {
  console.log("Agent Jobs Boot Tests")
  console.log("=====================\n")

  let passed = 0, failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      console.log(`  PASS  ${t.name}`)
    } catch (err: unknown) {
      failed++
      console.error(`  FAIL  ${t.name}`)
      console.error(`    ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
main()
