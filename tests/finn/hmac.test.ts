// tests/finn/hmac.test.ts — HMAC signing utility tests (T-1.1)

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash, createHmac } from "node:crypto"
import {
  buildCanonical,
  computeSignature,
  signRequest,
  verifySignature,
  generateNonce,
  signRequestLegacy,
} from "../../src/hounfour/hmac.js"
import type { HmacConfig } from "../../src/hounfour/hmac.js"

// Load test vectors
const vectors = JSON.parse(
  readFileSync("tests/fixtures/hmac-test-vector.json", "utf8"),
).vectors as Array<Record<string, string>>

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
  console.log("HMAC Signing Utility Tests (T-1.1)")
  console.log("===================================")

  // --- buildCanonical ---

  const basic = vectors.find(v => v.id === "basic")!

  await test("buildCanonical produces correct body hash", () => {
    const canonical = buildCanonical(
      basic.method, basic.path, basic.body,
      basic.issued_at, basic.nonce, basic.trace_id,
    )
    const bodyHash = canonical.split("\n")[2]
    assert.equal(bodyHash, basic.expected_body_hash)
  })

  await test("buildCanonical produces correct canonical string", () => {
    const canonical = buildCanonical(
      basic.method, basic.path, basic.body,
      basic.issued_at, basic.nonce, basic.trace_id,
    )
    assert.equal(canonical, basic.expected_canonical)
  })

  await test("buildCanonical includes method and path (endpoint binding)", () => {
    const canonical = buildCanonical("POST", "/invoke", "body", "t", "n", "id")
    assert.ok(canonical.startsWith("POST\n/invoke\n"))
  })

  // --- computeSignature ---

  await test("computeSignature matches expected for basic vector", () => {
    const canonical = buildCanonical(
      basic.method, basic.path, basic.body,
      basic.issued_at, basic.nonce, basic.trace_id,
    )
    const sig = computeSignature(canonical, basic.secret)
    assert.equal(sig, basic.expected_signature)
  })

  await test("computeSignature is deterministic", () => {
    const canonical = "test\ncanonical\nstring"
    const sig1 = computeSignature(canonical, "secret")
    const sig2 = computeSignature(canonical, "secret")
    assert.equal(sig1, sig2)
  })

  // --- Endpoint binding ---

  const stream = vectors.find(v => v.id === "stream_endpoint")!

  await test("different paths produce different signatures (endpoint binding)", () => {
    const sigInvoke = computeSignature(
      buildCanonical("POST", "/invoke", basic.body, basic.issued_at, basic.nonce, basic.trace_id),
      basic.secret,
    )
    const sigStream = computeSignature(
      buildCanonical("POST", "/invoke/stream", stream.body, stream.issued_at, stream.nonce, stream.trace_id),
      stream.secret,
    )
    assert.notEqual(sigInvoke, sigStream)
    assert.equal(sigInvoke, basic.expected_signature)
    assert.equal(sigStream, stream.expected_signature)
  })

  // --- signRequest ---

  await test("signRequest returns all required headers", () => {
    const headers = signRequest("POST", "/invoke", '{"test":true}', "trace-1", "secret")
    assert.ok(headers["x-cheval-signature"])
    assert.ok(headers["x-cheval-nonce"])
    assert.ok(headers["x-cheval-issued-at"])
    assert.equal(headers["x-cheval-trace-id"], "trace-1")
  })

  await test("signRequest signature is 64-char hex", () => {
    const headers = signRequest("POST", "/invoke", '{"test":true}', "trace-1", "secret")
    assert.equal(headers["x-cheval-signature"].length, 64)
    assert.match(headers["x-cheval-signature"], /^[a-f0-9]{64}$/)
  })

  await test("signRequest nonce is 32-char hex", () => {
    const headers = signRequest("POST", "/invoke", '{"test":true}', "trace-1", "secret")
    assert.equal(headers["x-cheval-nonce"].length, 32)
    assert.match(headers["x-cheval-nonce"], /^[a-f0-9]{32}$/)
  })

  await test("signRequest issued_at is ISO 8601", () => {
    const headers = signRequest("POST", "/invoke", '{"test":true}', "trace-1", "secret")
    const parsed = new Date(headers["x-cheval-issued-at"])
    assert.ok(!Number.isNaN(parsed.getTime()))
  })

  // --- verifySignature ---

  await test("verifySignature accepts valid signature from test vector", () => {
    const config: HmacConfig = { secret: basic.secret, skewSeconds: 999999 } // Large skew for static test
    const canonical = buildCanonical(
      basic.method, basic.path, basic.body,
      basic.issued_at, basic.nonce, basic.trace_id,
    )
    const sig = computeSignature(canonical, basic.secret)
    const valid = verifySignature(
      basic.method, basic.path, basic.body,
      sig, basic.nonce, basic.issued_at, basic.trace_id,
      config,
    )
    assert.ok(valid)
  })

  await test("verifySignature rejects tampered body", () => {
    const config: HmacConfig = { secret: basic.secret, skewSeconds: 999999 }
    const canonical = buildCanonical(
      basic.method, basic.path, basic.body,
      basic.issued_at, basic.nonce, basic.trace_id,
    )
    const sig = computeSignature(canonical, basic.secret)
    const valid = verifySignature(
      basic.method, basic.path, basic.body + "tampered",
      sig, basic.nonce, basic.issued_at, basic.trace_id,
      config,
    )
    assert.ok(!valid)
  })

  await test("verifySignature rejects wrong secret", () => {
    const config: HmacConfig = { secret: "wrong-secret", skewSeconds: 999999 }
    const sig = computeSignature(
      buildCanonical(basic.method, basic.path, basic.body, basic.issued_at, basic.nonce, basic.trace_id),
      basic.secret,
    )
    const valid = verifySignature(
      basic.method, basic.path, basic.body,
      sig, basic.nonce, basic.issued_at, basic.trace_id,
      config,
    )
    assert.ok(!valid)
  })

  await test("verifySignature rejects expired timestamp", () => {
    const config: HmacConfig = { secret: basic.secret, skewSeconds: 1 }
    const oldIssuedAt = "2020-01-01T00:00:00.000Z"
    const canonical = buildCanonical(
      basic.method, basic.path, basic.body,
      oldIssuedAt, basic.nonce, basic.trace_id,
    )
    const sig = computeSignature(canonical, basic.secret)
    const valid = verifySignature(
      basic.method, basic.path, basic.body,
      sig, basic.nonce, oldIssuedAt, basic.trace_id,
      config,
    )
    assert.ok(!valid)
  })

  await test("verifySignature rejects invalid issued_at", () => {
    const config: HmacConfig = { secret: basic.secret }
    const valid = verifySignature(
      basic.method, basic.path, basic.body,
      "sig", basic.nonce, "not-a-date", basic.trace_id,
      config,
    )
    assert.ok(!valid)
  })

  await test("verifySignature rejects wrong path (endpoint binding)", () => {
    const config: HmacConfig = { secret: basic.secret, skewSeconds: 999999 }
    const sig = computeSignature(
      buildCanonical("POST", "/invoke", basic.body, basic.issued_at, basic.nonce, basic.trace_id),
      basic.secret,
    )
    // Verify against /invoke/stream — should fail
    const valid = verifySignature(
      "POST", "/invoke/stream", basic.body,
      sig, basic.nonce, basic.issued_at, basic.trace_id,
      config,
    )
    assert.ok(!valid)
  })

  // --- Dual-secret rotation ---

  const rotation = vectors.find(v => v.id === "dual_secret_rotation")!

  await test("verifySignature accepts signature from previous secret (rotation)", () => {
    const config: HmacConfig = {
      secret: rotation.secret_current,
      secretPrev: rotation.secret_previous,
      skewSeconds: 999999,
    }
    // Signed with OLD secret
    const canonical = buildCanonical(
      rotation.method, rotation.path, rotation.body,
      rotation.issued_at, rotation.nonce, rotation.trace_id,
    )
    const sigOld = computeSignature(canonical, rotation.secret_previous)
    assert.equal(sigOld, rotation.expected_signature_old)

    const valid = verifySignature(
      rotation.method, rotation.path, rotation.body,
      sigOld, rotation.nonce, rotation.issued_at, rotation.trace_id,
      config,
    )
    assert.ok(valid)
  })

  await test("verifySignature accepts signature from current secret (rotation)", () => {
    const config: HmacConfig = {
      secret: rotation.secret_current,
      secretPrev: rotation.secret_previous,
      skewSeconds: 999999,
    }
    const canonical = buildCanonical(
      rotation.method, rotation.path, rotation.body,
      rotation.issued_at, rotation.nonce, rotation.trace_id,
    )
    const sigNew = computeSignature(canonical, rotation.secret_current)
    assert.equal(sigNew, rotation.expected_signature_new)

    const valid = verifySignature(
      rotation.method, rotation.path, rotation.body,
      sigNew, rotation.nonce, rotation.issued_at, rotation.trace_id,
      config,
    )
    assert.ok(valid)
  })

  await test("verifySignature rejects signature from unknown secret (rotation)", () => {
    const config: HmacConfig = {
      secret: rotation.secret_current,
      secretPrev: rotation.secret_previous,
      skewSeconds: 999999,
    }
    const canonical = buildCanonical(
      rotation.method, rotation.path, rotation.body,
      rotation.issued_at, rotation.nonce, rotation.trace_id,
    )
    const sigUnknown = computeSignature(canonical, "totally-wrong-secret-here!!!!")

    const valid = verifySignature(
      rotation.method, rotation.path, rotation.body,
      sigUnknown, rotation.nonce, rotation.issued_at, rotation.trace_id,
      config,
    )
    assert.ok(!valid)
  })

  // --- generateNonce ---

  await test("generateNonce produces 32-char hex string", () => {
    const nonce = generateNonce()
    assert.equal(nonce.length, 32)
    assert.match(nonce, /^[a-f0-9]{32}$/)
  })

  await test("generateNonce produces unique values", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()))
    assert.equal(nonces.size, 100)
  })

  // --- Legacy compatibility ---

  await test("signRequestLegacy matches old format (Phase 0-2)", () => {
    const body = '{"hello":"world"}'
    const secret = "test-secret"
    const nonce = "abc123"
    const traceId = "trace-1"
    const issuedAt = "2026-02-08T12:00:00.000Z"

    const sig = signRequestLegacy(body, secret, nonce, traceId, issuedAt)

    // Manually compute expected using old format
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex")
    const canonical = JSON.stringify({
      body_hash: bodyHash,
      issued_at: issuedAt,
      nonce: nonce,
      trace_id: traceId,
    })
    const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("hex")
    assert.equal(sig, expected)
  })

  console.log("\nDone.")
}

main()
