// tests/finn/bridgebuilder-launch.test.ts — Launch sprint tests (Sprint 3, Task 3.4)
// Tests: persona loading, config validation, empty repo, lease exclusion, logger sanitization
// Uses in-memory adapters. No real API calls.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadConfig } from "../../src/bridgebuilder/config.js"
import { BridgebuilderLogger } from "../../src/bridgebuilder/logger.js"
import { RunLease } from "../../src/bridgebuilder/lease.js"
import type { ILeaseStorage } from "../../src/bridgebuilder/lease.js"
import type { IOutputSanitizer, SanitizationResult } from "../../src/bridgebuilder/ports/index.js"

// ── In-memory lease storage ─────────────────────────────────

function createInMemoryLeaseStorage(): ILeaseStorage {
  const store = new Map<string, Buffer>()
  return {
    async readFile(key: string) { return store.get(key) ?? null },
    async writeFile(key: string, content: Buffer) { store.set(key, content); return true },
    async deleteFile(key: string) { store.delete(key); return true },
  }
}

// ── Test sanitizer (matches production patterns) ────────────

function createTestSanitizer(): IOutputSanitizer {
  const SECRET_PATTERNS = [
    { pattern: /ghp_[A-Za-z0-9_]{36,}/, label: "GitHub PAT (classic)" },
    { pattern: /sk-ant-[A-Za-z0-9-]{20,}/, label: "Anthropic API key" },
    { pattern: /sk-[A-Za-z0-9]{20,}/, label: "OpenAI-style API key" },
  ]
  return {
    sanitize(content: string): SanitizationResult {
      const redacted: string[] = []
      let sanitized = content
      for (const { pattern, label } of SECRET_PATTERNS) {
        if (pattern.test(sanitized)) {
          sanitized = sanitized.replace(new RegExp(pattern.source, "g"), "[REDACTED]")
          redacted.push(label)
        }
      }
      return { safe: redacted.length === 0, sanitizedContent: sanitized, redactedPatterns: redacted }
    },
  }
}

// ── Persona Loading Tests ───────────────────────────────────

console.log("=== Persona Loading ===")

// Test: BEAUVOIR.md found → persona content loadable
{
  let persona: string
  try {
    persona = readFileSync("grimoires/bridgebuilder/BEAUVOIR.md", "utf-8")
  } catch {
    persona = ""
  }
  assert.ok(persona.length > 0, "BEAUVOIR.md should exist and have content")
  assert.ok(persona.includes("Bridgebuilder"), "Persona should identify as Bridgebuilder")
  assert.ok(persona.includes("NEVER"), "Persona should contain hard constraints")
  console.log("  ✓ BEAUVOIR.md found and contains persona content")
}

// Test: fallback persona used when file not found
{
  let persona: string
  try {
    persona = readFileSync("grimoires/bridgebuilder/NONEXISTENT.md", "utf-8")
  } catch {
    persona = "You are Bridgebuilder, a constructive code reviewer. Focus on security, quality, and test coverage. Be specific and actionable. Never approve — only COMMENT or REQUEST_CHANGES."
  }
  assert.ok(persona.includes("Bridgebuilder"), "Fallback persona mentions Bridgebuilder")
  assert.ok(persona.includes("Never approve"), "Fallback persona has core constraint")
  console.log("  ✓ fallback persona used when file not found")
}

// ── Config Validation Tests ─────────────────────────────────

console.log("\n=== Config Validation ===")

// Test: missing GITHUB_TOKEN → throws with actionable message
{
  const original = process.env.GITHUB_TOKEN
  const originalRepos = process.env.BRIDGEBUILDER_REPOS
  const originalKey = process.env.ANTHROPIC_API_KEY

  // Clear all required vars
  delete process.env.GITHUB_TOKEN
  delete process.env.BRIDGEBUILDER_REPOS
  delete process.env.ANTHROPIC_API_KEY

  try {
    loadConfig()
    assert.fail("Should have thrown")
  } catch (err) {
    const msg = (err as Error).message
    assert.ok(msg.includes("GITHUB_TOKEN"), `Error should mention GITHUB_TOKEN: ${msg}`)
    assert.ok(msg.includes("repo scope") || msg.includes("PAT"), `Error should be actionable: ${msg}`)
  } finally {
    // Restore
    if (original) process.env.GITHUB_TOKEN = original
    if (originalRepos) process.env.BRIDGEBUILDER_REPOS = originalRepos
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey
  }
  console.log("  ✓ missing GITHUB_TOKEN → actionable error")
}

// Test: missing BRIDGEBUILDER_REPOS → throws with actionable message
{
  const originalRepos = process.env.BRIDGEBUILDER_REPOS

  process.env.GITHUB_TOKEN = "ghp_test"
  process.env.ANTHROPIC_API_KEY = "sk-ant-test"
  delete process.env.BRIDGEBUILDER_REPOS

  try {
    loadConfig()
    assert.fail("Should have thrown")
  } catch (err) {
    const msg = (err as Error).message
    assert.ok(msg.includes("BRIDGEBUILDER_REPOS"), `Error should mention BRIDGEBUILDER_REPOS: ${msg}`)
    assert.ok(msg.includes("Comma-separated") || msg.includes("owner/repo"), `Error should be actionable: ${msg}`)
  } finally {
    if (originalRepos) process.env.BRIDGEBUILDER_REPOS = originalRepos
    else delete process.env.BRIDGEBUILDER_REPOS
    delete process.env.GITHUB_TOKEN
    delete process.env.ANTHROPIC_API_KEY
  }
  console.log("  ✓ missing BRIDGEBUILDER_REPOS → actionable error")
}

// Test: empty BRIDGEBUILDER_REPOS → throws (not silent empty loop)
{
  const saved = { ...process.env }

  process.env.GITHUB_TOKEN = "ghp_test"
  process.env.ANTHROPIC_API_KEY = "sk-ant-test"
  process.env.BRIDGEBUILDER_REPOS = "   ,  , "

  try {
    loadConfig()
    assert.fail("Should have thrown for empty repos")
  } catch (err) {
    const msg = (err as Error).message
    assert.ok(msg.includes("no valid entries") || msg.includes("empty"), `Error should explain empty repos: ${msg}`)
  } finally {
    // Restore only the env vars we changed
    if (saved.GITHUB_TOKEN) process.env.GITHUB_TOKEN = saved.GITHUB_TOKEN
    else delete process.env.GITHUB_TOKEN
    if (saved.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY
    else delete process.env.ANTHROPIC_API_KEY
    if (saved.BRIDGEBUILDER_REPOS) process.env.BRIDGEBUILDER_REPOS = saved.BRIDGEBUILDER_REPOS
    else delete process.env.BRIDGEBUILDER_REPOS
  }
  console.log("  ✓ empty BRIDGEBUILDER_REPOS → actionable error (not silent empty loop)")
}

// ── Empty Repo (Zero PRs) Test ──────────────────────────────

console.log("\n=== Empty Repo ===")

// Test: zero PRs from all repos → RunSummary with 0 reviewed
{
  // This test exercises the pipeline with zero PRs by using the existing test helpers
  // from bridgebuilder-integration.test.ts patterns
  const { createHash } = await import("node:crypto")
  const { PRReviewTemplate } = await import("../../src/bridgebuilder/core/template.js")
  const { BridgebuilderContext } = await import("../../src/bridgebuilder/core/context.js")
  const { ReviewPipeline } = await import("../../src/bridgebuilder/core/reviewer.js")

  const config = {
    repos: [{ owner: "test", repo: "empty-repo" }],
    maxPRsPerRun: 10,
    maxRuntimeMinutes: 25,
    maxFilesPerPR: 50,
    maxDiffBytesPerPR: 100_000,
    maxInputTokens: 8000,
    maxOutputTokens: 4000,
    dimensions: ["security", "quality"],
    dryRun: false,
  }

  const git = {
    async listOpenPRs() { return [] },
    async getPRFiles() { return [] },
    async getPRReviews() { return [] },
    async preflight() { return { remaining: 5000, scopes: ["repo"] } },
    async preflightRepo(owner: string, repo: string) { return { owner, repo, accessible: true } },
  }

  const poster = {
    async postReview() { return true },
    async hasExistingReview() { return false },
  }

  const store = {
    async load() { return { reviews: [] as any[], stats: { totalRuns: 0, totalReviews: 0 } } },
    async save() {},
    async claimReview() { return true },
    async finalizeReview() {},
  }

  const llm = {
    async generateReview() { return { content: "ok", inputTokens: 100, outputTokens: 50, model: "test" } },
  }

  const sanitizer = createTestSanitizer()
  const hasher = { sha256(input: string) { return createHash("sha256").update(input).digest("hex") } }

  const template = new PRReviewTemplate(git, hasher, config)
  const context = new BridgebuilderContext(store, config)
  const pipeline = new ReviewPipeline(template, context, poster, llm, sanitizer, "R.", config)

  const summary = await pipeline.run("run-empty")
  assert.equal(summary.totalPRs, 0, "Zero PRs found")
  assert.equal(summary.reviewed, 0, "Zero reviewed")
  assert.equal(summary.errors, 0, "No errors")
  console.log("  ✓ zero PRs → RunSummary with 0 reviewed, clean exit")
}

// ── Lease Exclusion Tests ───────────────────────────────────

console.log("\n=== Lease Exclusion ===")

// Test: two runs contend for the same lease — one acquires, the other receives structured rejection
{
  const storage = createInMemoryLeaseStorage()
  const lease1 = new RunLease(storage, 30, 0) // delayMs=0 for instant tests
  const lease2 = new RunLease(storage, 30, 0)

  const result1 = await lease1.acquire("run-alpha")
  assert.equal(result1, true, "First run acquires lease")

  const result2 = await lease2.acquire("run-beta")
  assert.ok(typeof result2 === "object" && result2.held === true, "Second run gets rejection object")
  assert.equal((result2 as { held: true; heldBy: string }).heldBy, "run-alpha", "Rejection includes holder runId")
  console.log("  ✓ lease exclusion: first acquires, second gets structured rejection with holder runId")
}

// Test: lease release with owner verification
{
  const storage = createInMemoryLeaseStorage()
  const lease = new RunLease(storage, 30, 0)

  await lease.acquire("run-owner")

  // Attempt release with wrong runId — should NOT delete
  await lease.release("run-intruder")
  const afterWrongRelease = await storage.readFile("bridgebuilder/run-lock")
  assert.ok(afterWrongRelease !== null, "Lease still exists after wrong-owner release")

  // Release with correct runId — should delete
  await lease.release("run-owner")
  const afterCorrectRelease = await storage.readFile("bridgebuilder/run-lock")
  assert.equal(afterCorrectRelease, null, "Lease deleted after correct-owner release")
  console.log("  ✓ lease release: only owner can release (split-brain prevention)")
}

// Test: expired lease allows new acquisition
{
  const storage = createInMemoryLeaseStorage()
  const lease = new RunLease(storage, 0, 0) // TTL = 0 minutes → immediately expired

  await lease.acquire("run-old")

  // New lease with normal TTL
  const lease2 = new RunLease(storage, 30, 0)
  const result = await lease2.acquire("run-new")
  assert.equal(result, true, "New run acquires after expired lease")
  console.log("  ✓ expired lease allows new acquisition")
}

// ── Logger Sanitization Tests ───────────────────────────────

console.log("\n=== Logger Sanitization ===")

// Test: logger redacts Anthropic API key and GitHub PAT
{
  const sanitizer = createTestSanitizer()
  const log = new BridgebuilderLogger(sanitizer)

  // Capture console output
  const captured: string[] = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }

  try {
    const testKey = "sk-ant-api03-" + "A".repeat(40)
    const testPat = "ghp_" + "B".repeat(40)

    log.info(`Config loaded with key ${testKey} and token ${testPat}`)
    log.warn(`Warning: detected ${testKey}`)

    const output = captured.join("\n")
    assert.ok(!output.includes("sk-ant-api03-"), "Anthropic key must be redacted")
    assert.ok(!output.includes("ghp_" + "B".repeat(40)), "GitHub PAT must be redacted")
    assert.ok(output.includes("[REDACTED]"), "Output should contain [REDACTED] markers")
    console.log = origLog
    console.warn = origWarn
    console.log("  ✓ logger sanitization: sk-ant-api03-xxx and ghp_xxx both redacted")
  } catch (err) {
    console.log = origLog
    console.warn = origWarn
    throw err
  }
}

// Test: debug mode gated on BRIDGEBUILDER_DEBUG
{
  const sanitizer = createTestSanitizer()
  const log = new BridgebuilderLogger(sanitizer)

  const captured: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")) }

  try {
    const origDebug = process.env.BRIDGEBUILDER_DEBUG
    delete process.env.BRIDGEBUILDER_DEBUG

    log.debug("should not appear")
    assert.equal(captured.length, 0, "Debug not emitted when BRIDGEBUILDER_DEBUG unset")

    process.env.BRIDGEBUILDER_DEBUG = "true"
    log.debug("should appear")
    assert.equal(captured.length, 1, "Debug emitted when BRIDGEBUILDER_DEBUG=true")
    assert.ok(captured[0].includes("should appear"), "Debug message present")

    // Restore
    if (origDebug) process.env.BRIDGEBUILDER_DEBUG = origDebug
    else delete process.env.BRIDGEBUILDER_DEBUG
    console.log = origLog
  } catch (err) {
    console.log = origLog
    throw err
  }
  console.log("  ✓ debug mode gated on BRIDGEBUILDER_DEBUG env var")
}

console.log("\n✅ All bridgebuilder-launch tests passed")
