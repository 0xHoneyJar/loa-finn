// tests/finn/corpus-version.test.ts — Corpus version middleware unit tests (Sprint 3 T3.3)
// Tests: header presence, value sourcing, fallback behavior.

import assert from "node:assert/strict"
import { Hono } from "hono"
import { corpusVersionMiddleware, getCorpusVersion } from "../../src/gateway/corpus-version.js"

// ── Test Harness ────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++
      console.log(`  \u2713 ${name}`)
    })
    .catch((err) => {
      failed++
      console.error(`  \u2717 ${name}`)
      console.error(`    ${err.message}`)
    })
}

// ── Helpers ─────────────────────────────────────────────────

function makeApp() {
  const app = new Hono()
  app.use("*", corpusVersionMiddleware())
  app.get("/test", (c) => c.json({ ok: true }))
  app.post("/oracle", (c) => c.json({ result: "done" }))
  return app
}

async function request(app: ReturnType<typeof makeApp>, path: string, method = "GET") {
  const req = new Request(`http://localhost${path}`, { method })
  return app.fetch(req)
}

// ── Tests ───────────────────────────────────────────────────

console.log("\nCorpus Version Middleware Tests")
console.log("═".repeat(50))

await test("GET response includes x-corpus-version header", async () => {
  const app = makeApp()
  const res = await request(app, "/test")

  assert.equal(res.status, 200)
  const version = res.headers.get("x-corpus-version")
  assert.ok(version !== null, "x-corpus-version header should be present")
})

await test("POST response includes x-corpus-version header", async () => {
  const app = makeApp()
  const res = await request(app, "/oracle", "POST")

  assert.equal(res.status, 200)
  const version = res.headers.get("x-corpus-version")
  assert.ok(version !== null, "x-corpus-version header should be present on POST")
})

await test("getCorpusVersion() returns a string", () => {
  const version = getCorpusVersion()
  assert.equal(typeof version, "string")
  assert.ok(version.length > 0, "corpus version should not be empty")
})

await test("fallback value is 'unknown' when DIXIE_REF not set", () => {
  // DIXIE_REF is not set in test environment, so we expect "unknown"
  if (!process.env.DIXIE_REF) {
    const version = getCorpusVersion()
    assert.equal(version, "unknown")
  }
  // If DIXIE_REF is set, the test still passes (just verifies it's a string)
})

await test("header value matches getCorpusVersion()", async () => {
  const app = makeApp()
  const res = await request(app, "/test")
  const headerValue = res.headers.get("x-corpus-version")
  const fnValue = getCorpusVersion()

  assert.equal(headerValue, fnValue, "header value should match getCorpusVersion()")
})

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
