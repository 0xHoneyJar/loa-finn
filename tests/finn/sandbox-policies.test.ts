// tests/finn/sandbox-policies.test.ts — Sandbox policy tests (SDD §4.2)

import assert from "node:assert/strict"
import {
  checkBashCommand,
  checkNetworkAccess,
  CRON_BASH_POLICIES,
  CRON_NETWORK_POLICY,
} from "../../src/cron/sandbox-policies.js"

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
  console.log("Sandbox Policies Tests")
  console.log("======================")

  // ── Bash Policy Tests ───────────────────────────────────────

  console.log("\n--- Bash Policies ---")

  await test("1. gh command is not in policies → denied", () => {
    const result = checkBashCommand("gh", ["pr", "list"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("not in cron bash allowlist"))
  })

  await test("2. git log is allowed", () => {
    const result = checkBashCommand("git", ["log"])
    assert.equal(result.allowed, true)
    assert.equal(result.reason, undefined)
  })

  await test("3. git push is denied", () => {
    const result = checkBashCommand("git", ["push", "origin", "main"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("denied"))
  })

  await test("4. git checkout is denied", () => {
    const result = checkBashCommand("git", ["checkout", "feature-branch"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("denied"))
  })

  await test("5. git status is allowed", () => {
    const result = checkBashCommand("git", ["status"])
    assert.equal(result.allowed, true)
  })

  await test("6. npm install is allowed", () => {
    const result = checkBashCommand("npm", ["install"])
    assert.equal(result.allowed, true)
  })

  await test("7. npm -g is denied", () => {
    const result = checkBashCommand("npm", ["install", "-g", "something"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("denied"))
  })

  await test("8. ls with no args is allowed", () => {
    const result = checkBashCommand("ls", [])
    assert.equal(result.allowed, true)
  })

  await test("9. unknown command (python) is denied", () => {
    const result = checkBashCommand("python", ["script.py"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("not in cron bash allowlist"))
  })

  // ── Network Policy Tests ────────────────────────────────────

  console.log("\n--- Network Policies ---")

  await test("10. curl is blocked (network policy)", () => {
    const result = checkNetworkAccess("curl", "example.com")
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("blocked"))
  })

  await test("11. wget is blocked (network policy)", () => {
    const result = checkNetworkAccess("wget", "example.com")
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("blocked"))
  })

  await test("12. api.github.com is blocked", () => {
    const result = checkNetworkAccess("node", "api.github.com")
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("blocked"))
  })

  await test("13. github.com is blocked", () => {
    const result = checkNetworkAccess("node", "github.com")
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("blocked"))
  })

  await test("14. *.github.com wildcard blocks subdomain", () => {
    const result = checkNetworkAccess("node", "raw.github.com")
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("blocked"))
  })

  await test("15. registry.npmjs.org is allowed (not in blocked list)", () => {
    const result = checkNetworkAccess("node", "registry.npmjs.org")
    assert.equal(result.allowed, true)
  })

  // ── C-2: executionMode Enforcement ─────────────────────────

  console.log("\n--- C-2: executionMode Enforcement ---")

  await test("16. all CRON_BASH_POLICIES have executionMode: 'execFile'", () => {
    for (const policy of CRON_BASH_POLICIES) {
      assert.equal(
        policy.executionMode,
        "execFile",
        `Policy for "${policy.command}" missing executionMode: "execFile"`,
      )
    }
  })

  await test("17. BashPolicy type requires executionMode field", () => {
    // Compile-time check: if executionMode were optional, this test
    // wouldn't catch it at runtime, so we verify all actual policies
    // have it set to the only valid value
    const modes = CRON_BASH_POLICIES.map(p => p.executionMode)
    const unique = [...new Set(modes)]
    assert.deepEqual(unique, ["execFile"])
  })

  await test("18. git push is denied via deniedArgs (not deniedSubcommands)", () => {
    // Verify the renamed field works correctly
    const result = checkBashCommand("git", ["push", "origin", "main"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("denied"))
    assert.ok(result.reason?.includes("push"))
  })

  await test("19. npm -g is denied via deniedArgs", () => {
    const result = checkBashCommand("npm", ["install", "-g", "evil-pkg"])
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes("denied"))
    assert.ok(result.reason?.includes("-g"))
  })

  console.log("\nDone.")
}

main()
