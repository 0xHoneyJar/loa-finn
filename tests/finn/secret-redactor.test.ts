// tests/finn/secret-redactor.test.ts — Secret Redaction unit tests (TASK-3.4)

import assert from "node:assert/strict"
import { SecretRedactor } from "../../src/safety/secret-redactor.js"
import type { RedactionPattern } from "../../src/safety/secret-redactor.js"

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
  console.log("Secret Redactor Tests (TASK-3.4)")
  console.log("=================================")

  const redactor = new SecretRedactor()

  // ── GitHub Token Patterns ──────────────────────────────────

  console.log("\n--- GitHub Token Patterns ---")

  await test("redacts classic PAT (ghp_...)", () => {
    const input = "token: ghp_ABCDEFghijklmnop1234567890ABCDEFGHIJKL"
    const result = redactor.redact(input)
    assert.equal(result, "token: [REDACTED:github-pat]")
  })

  await test("redacts fine-grained PAT (github_pat_...)", () => {
    const input = "auth=github_pat_11ABCDEF0123456789abcdef01"
    const result = redactor.redact(input)
    assert.equal(result, "auth=[REDACTED:github-pat]")
  })

  await test("redacts GitHub App token (ghs_...)", () => {
    const input = "Authorization: Bearer ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx00"
    const result = redactor.redact(input)
    assert.equal(result, "Authorization: Bearer [REDACTED:github-app]")
  })

  await test("redacts legacy token (v1.<40hex>)", () => {
    const input = "old=v1.1234567890abcdef1234567890abcdef12345678"
    const result = redactor.redact(input)
    assert.equal(result, "old=[REDACTED:github-token]")
  })

  // ── Generic Patterns ───────────────────────────────────────

  console.log("\n--- Generic Patterns ---")

  await test("redacts AWS access key (AKIA...)", () => {
    const input = "aws_key=AKIAIOSFODNN7EXAMPLE"
    const result = redactor.redact(input)
    assert.equal(result, "aws_key=[REDACTED:aws-key]")
  })

  await test("redacts generic key= parameter", () => {
    const input = "url?key=abcdef1234567890abcdef1234567890ab"
    const result = redactor.redact(input)
    assert.equal(result, "url?[REDACTED:api-key]")
  })

  await test("redacts generic token= parameter", () => {
    const input = "token=1234567890abcdef1234567890abcdef"
    const result = redactor.redact(input)
    assert.equal(result, "[REDACTED:api-key]")
  })

  // ── Preservation & Multi-match ─────────────────────────────

  console.log("\n--- Preservation & Multi-match ---")

  await test("preserves text without tokens", () => {
    const input = "Hello, this is a normal message with no secrets."
    const result = redactor.redact(input)
    assert.equal(result, input)
  })

  await test("redacts multiple tokens in same string", () => {
    const input = "first=ghp_ABCDEFghijklmnop1234567890ABCDEFGHIJKL second=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx00"
    const result = redactor.redact(input)
    assert.ok(result.includes("[REDACTED:github-pat]"), "should redact classic PAT")
    assert.ok(result.includes("[REDACTED:github-app]"), "should redact app token")
    assert.ok(!result.includes("ghp_"), "no raw ghp_ should remain")
    assert.ok(!result.includes("ghs_"), "no raw ghs_ should remain")
  })

  // ── Custom Patterns ────────────────────────────────────────

  console.log("\n--- Custom Patterns ---")

  await test("custom patterns via constructor", () => {
    const custom: RedactionPattern[] = [
      { name: "slack-token", pattern: /xoxb-[A-Za-z0-9-]{20,}/g, replacement: "[REDACTED:slack-bot]" },
    ]
    const customRedactor = new SecretRedactor(custom)
    const input = "SLACK_TOKEN=xoxb-1234567890-abcdefghij"
    const result = customRedactor.redact(input)
    assert.equal(result, "SLACK_TOKEN=[REDACTED:slack-bot]")
  })

  // ── Repeated calls (regex lastIndex safety) ────────────────

  console.log("\n--- Repeated Calls ---")

  await test("redact works correctly on repeated calls", () => {
    const input = "ghp_ABCDEFghijklmnop1234567890ABCDEFGHIJKL"
    assert.equal(redactor.redact(input), "[REDACTED:github-pat]")
    assert.equal(redactor.redact(input), "[REDACTED:github-pat]")
    assert.equal(redactor.redact(input), "[REDACTED:github-pat]")
  })

  console.log("\nDone.")
}

main()
