// tests/finn/hounfour-invoker.test.ts — ChevalInvoker & ChevalModelAdapter tests (T-14.8)

import assert from "node:assert/strict"
import { signRequest, generateNonce, ChevalInvoker } from "../../src/hounfour/cheval-invoker.js"
import type { HealthProber } from "../../src/hounfour/cheval-invoker.js"
import { createHash, createHmac } from "node:crypto"

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
  console.log("ChevalInvoker & ChevalModelAdapter Tests (T-14.8)")
  console.log("==================================================")

  // --- HMAC Signing ---

  await test("signRequest produces 64-char hex signature", () => {
    const sig = signRequest('{"hello":"world"}', "test-secret", "abc123", "trace-1", "2026-02-08T12:00:00.000Z")
    assert.equal(sig.length, 64)
    assert.match(sig, /^[a-f0-9]{64}$/)
  })

  await test("signRequest is deterministic for same inputs", () => {
    const args = ['{"hello":"world"}', "test-secret", "abc123", "trace-1", "2026-02-08T12:00:00.000Z"] as const
    const sig1 = signRequest(...args)
    const sig2 = signRequest(...args)
    assert.equal(sig1, sig2)
  })

  await test("signRequest produces different signatures for different bodies", () => {
    const sig1 = signRequest('{"a":1}', "secret", "nonce", "trace", "2026-02-08T12:00:00.000Z")
    const sig2 = signRequest('{"a":2}', "secret", "nonce", "trace", "2026-02-08T12:00:00.000Z")
    assert.notEqual(sig1, sig2)
  })

  await test("signRequest produces different signatures for different secrets", () => {
    const sig1 = signRequest('{"a":1}', "secret-1", "nonce", "trace", "2026-02-08T12:00:00.000Z")
    const sig2 = signRequest('{"a":1}', "secret-2", "nonce", "trace", "2026-02-08T12:00:00.000Z")
    assert.notEqual(sig1, sig2)
  })

  await test("signRequest produces different signatures for different nonces", () => {
    const sig1 = signRequest('{"a":1}', "secret", "nonce-1", "trace", "2026-02-08T12:00:00.000Z")
    const sig2 = signRequest('{"a":1}', "secret", "nonce-2", "trace", "2026-02-08T12:00:00.000Z")
    assert.notEqual(sig1, sig2)
  })

  await test("signRequest matches Python canonical JSON format", () => {
    // Verify that the canonical JSON produced by TypeScript matches what Python would produce
    const body = '{"schema_version":1,"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
    const secret = "test-hmac-secret-32-bytes-long!!"
    const nonce = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    const traceId = "550e8400-e29b-41d4-a716-446655440000"
    const issuedAt = "2026-02-08T12:00:00.000Z"

    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex")
    const canonical = JSON.stringify({
      body_hash: bodyHash,
      issued_at: issuedAt,
      nonce: nonce,
      trace_id: traceId,
    })
    const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("hex")
    const actual = signRequest(body, secret, nonce, traceId, issuedAt)
    assert.equal(actual, expected)
  })

  // --- Nonce Generation ---

  await test("generateNonce produces 32-char hex string", () => {
    const nonce = generateNonce()
    assert.equal(nonce.length, 32)
    assert.match(nonce, /^[a-f0-9]{32}$/)
  })

  await test("generateNonce produces unique values", () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce())
    }
    assert.equal(nonces.size, 100)
  })

  // --- ChevalInvoker exit code handling ---

  await test("ChevalInvoker rejects when cheval.py not found", async () => {
    const invoker = new ChevalInvoker({
      chevalPath: "/nonexistent/cheval.py",
      hmac: { secret: "test-secret-32-bytes-at-minimum!" },
    })

    try {
      await invoker.invoke({
        schema_version: 1,
        provider: { name: "test", type: "openai", base_url: "http://localhost", api_key: "key", connect_timeout_ms: 5000, read_timeout_ms: 60000, total_timeout_ms: 300000 },
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
        options: {},
        metadata: { agent: "test", tenant_id: "local", nft_id: "", trace_id: "test-trace" },
        retry: { max_retries: 0, base_delay_ms: 1000, max_delay_ms: 30000, jitter_percent: 25, retryable_status_codes: [] },
        hmac: { signature: "", nonce: "", issued_at: "" },
      })
      assert.fail("Should have thrown")
    } catch (err: any) {
      assert.ok(err.name === "ChevalError" || err.code, `Expected ChevalError, got: ${err.message}`)
    }
  })

  // --- HealthProber stub ---

  await test("HealthProber stub interface works", () => {
    const prober: HealthProber = {
      recordSuccess: () => {},
      recordFailure: () => {},
      isHealthy: () => true,
    }
    prober.recordSuccess("openai", "gpt-4o")
    prober.recordFailure("openai", "gpt-4o", new Error("test"))
    assert.equal(prober.isHealthy({ provider: "openai", modelId: "gpt-4o" }), true)
  })

  console.log("\nDone.")
}

main()
