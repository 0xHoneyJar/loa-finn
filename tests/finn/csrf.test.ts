// tests/finn/csrf.test.ts — CsrfProtection tests (TASK-6.6)

import assert from "node:assert/strict"
import { CsrfProtection } from "../../src/gateway/csrf.js"
import type { CsrfRequest } from "../../src/gateway/csrf.js"

// ── Test harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Helpers ─────────────────────────────────────────────────

function csrf(): CsrfProtection {
  return new CsrfProtection()
}

function postReq(cookies?: Record<string, string>, body?: Record<string, unknown>, headers?: Record<string, string>): CsrfRequest {
  return { method: "POST", headers: headers ?? {}, cookies, body }
}

// ── generateToken tests ─────────────────────────────────────

test("generateToken returns a hex token of expected length (64 chars)", () => {
  const { token } = csrf().generateToken()
  assert.equal(token.length, 64, "32 bytes → 64 hex chars")
  assert.match(token, /^[0-9a-f]{64}$/, "must be lowercase hex")
})

test("generateToken returns Set-Cookie header with correct format", () => {
  const { token, cookieHeader } = csrf().generateToken()
  assert.equal(cookieHeader, `_csrf=${token}; Path=/; HttpOnly; SameSite=Strict`)
})

// ── Safe methods ────────────────────────────────────────────

test("GET requests always valid (no CSRF check)", () => {
  const result = csrf().validate({ method: "GET", headers: {} })
  assert.equal(result.valid, true)
})

test("HEAD requests always valid", () => {
  const result = csrf().validate({ method: "HEAD", headers: {} })
  assert.equal(result.valid, true)
})

test("OPTIONS requests always valid", () => {
  const result = csrf().validate({ method: "OPTIONS", headers: {} })
  assert.equal(result.valid, true)
})

// ── POST with matching tokens ───────────────────────────────

test("POST with matching cookie + body token is valid", () => {
  const { token } = csrf().generateToken()
  const result = csrf().validate(postReq({ _csrf: token }, { _csrf: token }))
  assert.equal(result.valid, true)
})

test("POST with matching cookie + header token is valid", () => {
  const { token } = csrf().generateToken()
  const result = csrf().validate({
    method: "POST",
    headers: { "x-csrf-token": token },
    cookies: { _csrf: token },
  })
  assert.equal(result.valid, true)
})

// ── POST with missing/mismatched tokens ─────────────────────

test("POST with missing cookie token is invalid", () => {
  const { token } = csrf().generateToken()
  const result = csrf().validate(postReq(undefined, { _csrf: token }))
  assert.equal(result.valid, false)
  assert.equal(result.error, "CSRF cookie missing")
})

test("POST with missing body/header token is invalid", () => {
  const { token } = csrf().generateToken()
  const result = csrf().validate(postReq({ _csrf: token }, {}))
  assert.equal(result.valid, false)
  assert.equal(result.error, "CSRF token missing from request")
})

test("POST with mismatched tokens is invalid", () => {
  const c = csrf()
  const { token: tokenA } = c.generateToken()
  const { token: tokenB } = c.generateToken()
  const result = c.validate(postReq({ _csrf: tokenA }, { _csrf: tokenB }))
  assert.equal(result.valid, false)
  assert.equal(result.error, "CSRF token mismatch")
})

// ── Bearer bypass ───────────────────────────────────────────

test("Bearer token requests bypass CSRF check", () => {
  const result = csrf().validate({
    method: "POST",
    headers: { authorization: "Bearer some-api-token" },
  })
  assert.equal(result.valid, true)
})

// ── Other mutating methods ──────────────────────────────────

test("DELETE requests also checked", () => {
  // Missing tokens → should fail
  const fail = csrf().validate({ method: "DELETE", headers: {} })
  assert.equal(fail.valid, false)
  // With valid tokens → should pass
  const { token } = csrf().generateToken()
  const pass = csrf().validate({
    method: "DELETE",
    headers: {},
    cookies: { _csrf: token },
    body: { _csrf: token },
  })
  assert.equal(pass.valid, true)
})

test("PATCH requests also checked", () => {
  const fail = csrf().validate({ method: "PATCH", headers: {} })
  assert.equal(fail.valid, false)
  const { token } = csrf().generateToken()
  const pass = csrf().validate({
    method: "PATCH",
    headers: { "x-csrf-token": token },
    cookies: { _csrf: token },
  })
  assert.equal(pass.valid, true)
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("CsrfProtection Tests")
  console.log("====================")
  let passed = 0
  let failed = 0
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
