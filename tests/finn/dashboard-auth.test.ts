// tests/finn/dashboard-auth.test.ts — DashboardAuth tests (TASK-6.4)

import assert from "node:assert/strict"
import { DashboardAuth } from "../../src/gateway/dashboard-auth.js"
import type { AuthRequest, Role } from "../../src/gateway/dashboard-auth.js"

// ── Test harness ────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = []
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn })
}

// ── Helpers ─────────────────────────────────────────────────

const TOKEN = "super-secret-admin-token-99"

function makeAuth(bind = "127.0.0.1"): DashboardAuth {
  return new DashboardAuth({ adminToken: TOKEN, bindAddress: bind })
}

function req(remoteAddr: string, token?: string | null): AuthRequest {
  const headers: Record<string, string> = {}
  if (token !== null && token !== undefined) {
    headers["authorization"] = `Bearer ${token}`
  }
  return { headers, remoteAddr }
}

// ── Tests ───────────────────────────────────────────────────

test("localhost viewer access passes without token", () => {
  const auth = makeAuth("127.0.0.1")
  const result = auth.checkAccess(req("127.0.0.1"), "viewer")
  assert.equal(result, null)
})

test("localhost operator access requires token", () => {
  const auth = makeAuth("127.0.0.1")
  const result = auth.checkAccess(req("127.0.0.1"), "operator")
  assert.notEqual(result, null)
  assert.equal(result!.status, 401)
  assert.equal(result!.body.code, "AUTH_REQUIRED")
})

test("localhost operator access with valid token passes", () => {
  const auth = makeAuth("127.0.0.1")
  const result = auth.checkAccess(req("127.0.0.1", TOKEN), "operator")
  assert.equal(result, null)
})

test("remote viewer access requires token", () => {
  const auth = makeAuth("0.0.0.0")
  const result = auth.checkAccess(req("192.168.1.50"), "viewer")
  assert.notEqual(result, null)
  assert.equal(result!.status, 401)
  assert.equal(result!.body.code, "AUTH_REQUIRED")
})

test("remote viewer access with valid token passes", () => {
  const auth = makeAuth("0.0.0.0")
  const result = auth.checkAccess(req("192.168.1.50", TOKEN), "viewer")
  assert.equal(result, null)
})

test("remote operator access with valid token passes", () => {
  const auth = makeAuth("0.0.0.0")
  const result = auth.checkAccess(req("10.0.0.5", TOKEN), "operator")
  assert.equal(result, null)
})

test("missing Authorization header returns 401 AUTH_REQUIRED", () => {
  const auth = makeAuth("0.0.0.0")
  const result = auth.checkAccess(req("10.0.0.5"), "viewer")
  assert.notEqual(result, null)
  assert.equal(result!.status, 401)
  assert.equal(result!.body.code, "AUTH_REQUIRED")
})

test("invalid token returns 401 AUTH_INVALID", () => {
  const auth = makeAuth("0.0.0.0")
  const result = auth.checkAccess(req("10.0.0.5", "wrong-token"), "viewer")
  assert.notEqual(result, null)
  assert.equal(result!.status, 401)
  assert.equal(result!.body.code, "AUTH_INVALID")
})

test("timing-safe comparison: different length tokens do not crash", () => {
  const auth = makeAuth("0.0.0.0")
  // Short token
  const r1 = auth.checkAccess(req("10.0.0.5", "x"), "viewer")
  assert.equal(r1!.status, 401)
  assert.equal(r1!.body.code, "AUTH_INVALID")
  // Empty token (after "Bearer ")
  const r2 = auth.checkAccess(req("10.0.0.5", ""), "viewer")
  assert.equal(r2!.status, 401)
  assert.equal(r2!.body.code, "AUTH_INVALID")
})

test("IPv6 localhost (::1) recognized as local", () => {
  const auth = makeAuth("127.0.0.1")
  const result = auth.checkAccess(req("::1"), "viewer")
  assert.equal(result, null)
})

test("IPv6 mapped localhost (::ffff:127.0.0.1) recognized as local", () => {
  const auth = makeAuth("127.0.0.1")
  const result = auth.checkAccess(req("::ffff:127.0.0.1"), "viewer")
  assert.equal(result, null)
})

test("loopback bind + remote client still requires token for viewer", () => {
  // bindAddress is 127.0.0.1 but client is remote — should not get pass-through
  // (In practice this scenario shouldn't happen, but defense-in-depth)
  const auth = makeAuth("127.0.0.1")
  const result = auth.checkAccess(req("192.168.1.50"), "viewer")
  assert.notEqual(result, null)
  assert.equal(result!.status, 401)
})

// ── Runner ──────────────────────────────────────────────────

async function main() {
  console.log("DashboardAuth Tests")
  console.log("===================")
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
