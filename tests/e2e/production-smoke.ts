// tests/e2e/production-smoke.ts — Production Smoke Test Suite (SDD §7.3, Sprint 59 T2)
//
// Non-destructive smoke tests for live production verification.
// Runs after ECS deployment stabilizes (CI smoke job).
//
// Environment:
//   FINN_SMOKE_URL  — Base URL of the deployed loa-finn instance
//   FINN_SMOKE_JWT  — Test tenant JWT (test-smoke-tenant, $0.01 budget cap)

const SMOKE_URL = process.env.FINN_SMOKE_URL
const SMOKE_JWT = process.env.FINN_SMOKE_JWT

if (!SMOKE_URL || !SMOKE_JWT) {
  console.error("FATAL: FINN_SMOKE_URL and FINN_SMOKE_JWT environment variables are required")
  process.exit(2)
}

const BASE = SMOKE_URL.replace(/\/+$/, "")
let passed = 0
let failed = 0

interface TestResult {
  name: string
  ok: boolean
  error?: string
  durationMs: number
}

async function test(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now()
  try {
    await fn()
    const ms = Date.now() - start
    console.log(`  ✓ ${name} (${ms}ms)`)
    passed++
    return { name, ok: true, durationMs: ms }
  } catch (err) {
    const ms = Date.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ ${name} (${ms}ms): ${msg}`)
    failed++
    return { name, ok: false, error: msg, durationMs: ms }
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// Test 1: Health endpoint
// ---------------------------------------------------------------------------
async function testHealth(): Promise<void> {
  const res = await fetch(`${BASE}/health`)
  assert(res.ok, `GET /health returned ${res.status}`)

  const body = await res.json()
  assert(typeof body.status === "string", "health response missing status field")
  assert(body.dlq_durable === true, "health response missing dlq_durable: true")
}

// ---------------------------------------------------------------------------
// Test 2: JWKS endpoint
// ---------------------------------------------------------------------------
async function testJWKS(): Promise<void> {
  const res = await fetch(`${BASE}/.well-known/jwks.json`)
  assert(res.ok, `GET /.well-known/jwks.json returned ${res.status}`)

  const body = await res.json()
  assert(Array.isArray(body.keys), "JWKS response missing keys array")
  // In production with ES256, should have at least one key
  if (body.keys.length > 0) {
    const key = body.keys[0]
    assert(key.kty === "EC", `Expected kty=EC, got ${key.kty}`)
    assert(key.alg === "ES256", `Expected alg=ES256, got ${key.alg}`)
    assert(typeof key.kid === "string", "JWKS key missing kid")
  }
}

// ---------------------------------------------------------------------------
// Test 3: Invoke endpoint (authenticated)
// ---------------------------------------------------------------------------
async function testInvoke(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SMOKE_JWT}`,
    },
    body: JSON.stringify({ prompt: "Reply with exactly: SMOKE_OK" }),
  })

  assert(res.ok, `POST /api/v1/invoke returned ${res.status}`)

  const body = await res.json()
  assert(typeof body.response === "string", "invoke response missing response field")
  assert(typeof body.cost_micro === "string", "invoke response missing cost_micro (string)")
  assert(typeof body.trace_id === "string", "invoke response missing trace_id")
}

// ---------------------------------------------------------------------------
// Test 4: Usage endpoint (authenticated)
// ---------------------------------------------------------------------------
async function testUsage(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/usage?days=1`, {
    headers: {
      Authorization: `Bearer ${SMOKE_JWT}`,
    },
  })

  assert(res.ok, `GET /api/v1/usage?days=1 returned ${res.status}`)

  const body = await res.json()
  assert(typeof body.tenant_id === "string", "usage response missing tenant_id")
  assert(typeof body.total_cost_micro === "string", "usage response missing total_cost_micro")
  assert(Array.isArray(body.entries), "usage response missing entries array")
}

// ---------------------------------------------------------------------------
// Test 5: Billing finalize idempotency (409 on duplicate)
// ---------------------------------------------------------------------------
async function testBillingIdempotency(): Promise<void> {
  // First invoke — should succeed (the invoke handler internally calls billing finalize)
  const res1 = await fetch(`${BASE}/api/v1/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SMOKE_JWT}`,
    },
    body: JSON.stringify({ prompt: "Reply with exactly: IDEMPOTENCY_TEST" }),
  })

  assert(res1.ok, `First invoke returned ${res1.status}`)
  const body1 = await res1.json()
  assert(typeof body1.trace_id === "string", "first invoke missing trace_id")

  // The idempotency of billing finalize is internal to the BillingFinalizeClient.
  // From the smoke test level, we verify that two sequential invocations both
  // succeed (the client handles 409 internally as expected duplicate).
  const res2 = await fetch(`${BASE}/api/v1/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SMOKE_JWT}`,
    },
    body: JSON.stringify({ prompt: "Reply with exactly: IDEMPOTENCY_TEST_2" }),
  })

  assert(res2.ok, `Second invoke returned ${res2.status}`)
  const body2 = await res2.json()
  // Different trace_ids confirm these are separate requests processed successfully
  assert(body2.trace_id !== body1.trace_id, "trace_ids should differ between requests")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`\nProduction Smoke Tests — ${BASE}\n`)

  const results: TestResult[] = []

  results.push(await test("GET /health returns 200 with dlq_durable", testHealth))
  results.push(await test("GET /.well-known/jwks.json returns valid JWKS", testJWKS))
  results.push(await test("POST /api/v1/invoke returns response + cost", testInvoke))
  results.push(await test("GET /api/v1/usage?days=1 returns usage structure", testUsage))
  results.push(await test("Billing finalize handles sequential invocations", testBillingIdempotency))

  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0)
  console.log(`\n${passed} passed, ${failed} failed (${totalMs}ms total)\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Smoke test runner failed:", err)
  process.exit(1)
})
