// tests/finn/redaction-middleware.test.ts — ResponseRedactor unit tests (TASK-6.8)

import assert from "node:assert/strict"
import { ResponseRedactor } from "../../src/gateway/redaction-middleware.js"

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

const redactor = new ResponseRedactor()

// ── Field-name redaction ───────────────────────────────────────

test("redacts field named 'token'", () => {
  const result = redactor.redact({ token: "abc123" })
  assert.equal(result.token, "[REDACTED]")
})

test("redacts field named 'secret' (case-insensitive)", () => {
  const r1 = redactor.redact({ secret: "val" })
  const r2 = redactor.redact({ Secret: "val" })
  const r3 = redactor.redact({ SECRET: "val" })
  assert.equal(r1.secret, "[REDACTED]")
  assert.equal(r2.Secret, "[REDACTED]")
  assert.equal(r3.SECRET, "[REDACTED]")
})

test("redacts field named 'password'", () => {
  const result = redactor.redact({ password: "hunter2" })
  assert.equal(result.password, "[REDACTED]")
})

test("redacts field named 'authorization'", () => {
  const result = redactor.redact({ authorization: "Bearer xyz" })
  assert.equal(result.authorization, "[REDACTED]")
})

test("does not redact field named 'title' or 'status'", () => {
  const result = redactor.redact({ title: "Hello", status: "ok" })
  assert.equal(result.title, "Hello")
  assert.equal(result.status, "ok")
})

// ── Token pattern redaction in string values ───────────────────

test("redacts GitHub PAT pattern (ghp_...) in string values", () => {
  const result = redactor.redact({ message: "tok ghp_ABCDEFghijklmnop1234567890ABCDEFGHIJKL end" })
  assert.ok(!result.message.includes("ghp_"), "ghp_ token should be redacted")
  assert.ok(result.message.includes("[REDACTED:github-pat]"))
})

test("redacts GitHub App token (ghs_...) in string values", () => {
  const result = redactor.redact({ log: "ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx00" })
  assert.ok(!result.log.includes("ghs_"), "ghs_ token should be redacted")
  assert.ok(result.log.includes("[REDACTED:github-app]"))
})

test("redacts AWS key pattern in string values", () => {
  const result = redactor.redact({ info: "key AKIAIOSFODNN7EXAMPLE here" })
  assert.ok(!result.info.includes("AKIA"), "AWS key should be redacted")
  assert.ok(result.info.includes("[REDACTED:aws-key]"))
})

// ── Deep redaction ─────────────────────────────────────────────

test("deep redaction in nested objects", () => {
  const result = redactor.redact({ outer: { credentials: "x", name: "safe" } })
  assert.equal(result.outer.credentials, "[REDACTED]")
  assert.equal(result.outer.name, "safe")
})

test("deep redaction in arrays", () => {
  const result = redactor.redact({ items: [{ token: "x" }, { title: "ok" }] })
  assert.equal(result.items[0].token, "[REDACTED]")
  assert.equal(result.items[1].title, "ok")
})

// ── Immutability ───────────────────────────────────────────────

test("does not mutate original object", () => {
  const original = { token: "secret-value", name: "test" }
  const copy = redactor.redact(original)
  assert.equal(original.token, "secret-value", "original should be unchanged")
  assert.equal(copy.token, "[REDACTED]")
  assert.notEqual(original, copy)
})

// ── Edge cases ─────────────────────────────────────────────────

test("handles null, undefined, empty objects gracefully", () => {
  assert.equal(redactor.redact(null), null)
  assert.equal(redactor.redact(undefined), undefined)
  assert.deepEqual(redactor.redact({}), {})
  assert.equal(redactor.redact(42), 42)
  assert.equal(redactor.redact(true), true)
})

// ── Runner ─────────────────────────────────────────────────────

async function main() {
  console.log("ResponseRedactor Tests (TASK-6.8)")
  console.log("==================================")
  let passed = 0, failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      console.log(`  ✓ ${t.name}`)
    } catch (err: any) {
      failed++
      console.error(`  ✗ ${t.name}: ${err.message}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`)
  if (failed > 0) process.exit(1)
}

main()
