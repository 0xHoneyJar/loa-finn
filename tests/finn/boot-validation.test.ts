// tests/finn/boot-validation.test.ts — Boot-time safety validation tests (SDD §7.2, §9.1)

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  BootErrorCode,
  BootValidationError,
  detectTokenType,
  validateBootSafety,
  validateFilesystem,
} from "../../src/safety/boot-validation.js"

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
  console.log("Boot Validation Tests")
  console.log("=====================")

  // ── Token Detection ───────────────────────────────────────

  console.log("\n--- Token Type Detection ---")

  await test("ghs_ prefix detected as app token", () => {
    assert.equal(detectTokenType("ghs_abc123"), "app")
  })

  await test("ghp_ prefix detected as pat token", () => {
    assert.equal(detectTokenType("ghp_xyz789"), "pat")
  })

  await test("github_pat_ prefix detected as pat token", () => {
    assert.equal(detectTokenType("github_pat_longtoken"), "pat")
  })

  await test("random string detected as unknown token", () => {
    assert.equal(detectTokenType("some_random_token"), "unknown")
  })

  // ── Step 1: Token Presence ────────────────────────────────

  console.log("\n--- Token Presence ---")

  await test("missing token throws E_TOKEN_MISSING", async () => {
    try {
      await validateBootSafety({})
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_TOKEN_MISSING)
      assert.equal(err.step, 1)
    }
  })

  // ── Step 2: Token Type ────────────────────────────────────

  console.log("\n--- Token Type ---")

  await test("PAT in autonomous mode throws E_TOKEN_TYPE", async () => {
    try {
      await validateBootSafety({ token: "ghp_abc", autonomous: true })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_TOKEN_TYPE)
      assert.equal(err.step, 2)
    }
  })

  await test("app token in autonomous mode passes step 2", async () => {
    // Will fail at step 3 (no permissions), proving step 2 passed
    try {
      await validateBootSafety({
        token: "ghs_abc",
        autonomous: true,
        permissions: {},
      })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_PERM_MISSING)
    }
  })

  // ── Step 3: Permissions ───────────────────────────────────

  console.log("\n--- Permission Validation ---")

  await test("missing required permission throws E_PERM_MISSING", async () => {
    try {
      await validateBootSafety({
        token: "ghs_abc",
        permissions: { issues: "write" },
      })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_PERM_MISSING)
      assert.equal(err.step, 3)
    }
  })

  await test("excluded permission throws E_PERM_EXCLUDED", async () => {
    try {
      await validateBootSafety({
        token: "ghs_abc",
        permissions: {
          issues: "write",
          pull_requests: "write",
          contents: "write",
          metadata: "read",
          administration: "write",
        },
      })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_PERM_EXCLUDED)
      assert.equal(err.step, 3)
    }
  })

  // ── Step 4: Repo Access ───────────────────────────────────

  console.log("\n--- Repo Access ---")

  await test("repo access failure throws E_REPO_ACCESS", async () => {
    try {
      await validateBootSafety({
        token: "ghs_abc",
        permissions: { issues: "write", pull_requests: "write", contents: "write", metadata: "read" },
        repoAccessCheck: async () => false,
      })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_REPO_ACCESS)
      assert.equal(err.step, 4)
    }
  })

  // ── Step 6: PID File ──────────────────────────────────────

  console.log("\n--- PID File ---")

  await test("active PID conflict throws E_PID_CONFLICT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-pid-"))
    const pidFile = join(dir, "finn.pid")
    // Write current process PID — it is alive
    await writeFile(pidFile, String(process.pid), "utf-8")
    try {
      await validateBootSafety({
        token: "ghs_abc",
        permissions: { issues: "write", pull_requests: "write", contents: "write", metadata: "read" },
        pidFilePath: pidFile,
      })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_PID_CONFLICT)
      assert.equal(err.step, 6)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  await test("stale PID file warns but passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-pid-"))
    const pidFile = join(dir, "finn.pid")
    // Write a PID that almost certainly does not exist
    await writeFile(pidFile, "999999999", "utf-8")
    try {
      const result = await validateBootSafety({
        token: "ghs_abc",
        permissions: { issues: "write", pull_requests: "write", contents: "write", metadata: "read" },
        pidFilePath: pidFile,
      })
      assert.ok(result.warnings.some((w) => w.includes("Stale PID")))
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // ── Step 7: Firewall Self-Test ────────────────────────────

  console.log("\n--- Firewall Self-Test ---")

  await test("firewall self-test failure throws E_SELF_TEST", async () => {
    try {
      await validateBootSafety({
        token: "ghs_abc",
        permissions: { issues: "write", pull_requests: "write", contents: "write", metadata: "read" },
        firewallSelfTest: async () => false,
      })
      assert.fail("Expected error")
    } catch (err) {
      assert.ok(err instanceof BootValidationError)
      assert.equal(err.code, BootErrorCode.E_SELF_TEST)
      assert.equal(err.step, 7)
    }
  })

  // ── Successful Boot ───────────────────────────────────────

  console.log("\n--- Successful Boot ---")

  await test("full boot succeeds with valid config", async () => {
    const result = await validateBootSafety({
      token: "ghs_valid_token",
      autonomous: true,
      permissions: { issues: "write", pull_requests: "write", contents: "write", metadata: "read" },
      repoAccessCheck: async () => true,
      firewallSelfTest: async () => true,
    })
    assert.equal(result.tokenType, "app")
    assert.ok(Array.isArray(result.warnings))
  })

  // ── Filesystem Validation ─────────────────────────────────

  console.log("\n--- Filesystem Validation ---")

  await test("validateFilesystem succeeds with real temp dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boot-fs-"))
    try {
      const result = await validateFilesystem(dir)
      assert.ok(Array.isArray(result.warnings))
      // On Linux, fsType should be detected; on macOS it may be undefined
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  console.log("\nDone.")
}

main()
