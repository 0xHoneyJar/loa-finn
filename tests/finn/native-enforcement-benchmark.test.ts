// tests/finn/native-enforcement-benchmark.test.ts — Native Enforcement Performance Benchmark (Task 3.3)
// Reports throughput metrics for expression and geometry enforcement paths.
// This is a reported metric, NOT a CI gate. All assertions are non-blocking soft limits.

import { describe, it, expect } from "vitest"
import {
  enforcePoolClaims,
  evaluateWithGeometry,
} from "../../src/hounfour/pool-enforcement.js"
import type { JWTClaims } from "../../src/hounfour/jwt-auth.js"

// --- Helpers ---

const REQ_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

function makeClaims(tier: "free" | "pro" | "enterprise"): JWTClaims {
  return {
    tenant_id: "bench-tenant",
    tier,
    iss: "test",
    aud: "test",
    sub: "bench",
    req_hash: REQ_HASH,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: "bench-jti",
  } as JWTClaims
}

function makeClaimsWithPool(tier: "free" | "pro" | "enterprise", poolId: string): JWTClaims {
  return {
    ...makeClaims(tier),
    pool_id: poolId,
  } as JWTClaims
}

function makeClaimsWithAllowedPools(
  tier: "free" | "pro" | "enterprise",
  allowedPools: string[],
): JWTClaims {
  return {
    ...makeClaims(tier),
    allowed_pools: allowedPools,
  } as JWTClaims
}

// --- Benchmarks ---

describe("Native Enforcement Performance Benchmark (Task 3.3)", () => {
  it("benchmarks enforcePoolClaims (expression path) throughput", () => {
    const claims = makeClaims("pro")
    const iterations = 10_000

    // Warm up: prevent JIT compilation from skewing first measurement
    for (let i = 0; i < 100; i++) enforcePoolClaims(claims)

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      enforcePoolClaims(claims)
    }
    const durationMs = performance.now() - start
    const opsPerSec = (iterations / durationMs) * 1000

    console.log(
      `[benchmark] Expression path: ${iterations} iterations in ${durationMs.toFixed(1)}ms ` +
      `(${opsPerSec.toFixed(0)} ops/sec)`,
    )

    // Non-blocking assertion — just verify it completed in reasonable time
    expect(durationMs).toBeLessThan(30_000)
  })

  it("benchmarks evaluateWithGeometry throughput (expression mode)", () => {
    const claims = makeClaims("pro")
    const iterations = 10_000

    // Warm up
    for (let i = 0; i < 100; i++) evaluateWithGeometry(claims)

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      evaluateWithGeometry(claims)
    }
    const durationMs = performance.now() - start
    const opsPerSec = (iterations / durationMs) * 1000

    console.log(
      `[benchmark] evaluateWithGeometry (expression): ${iterations} iterations in ` +
      `${durationMs.toFixed(1)}ms (${opsPerSec.toFixed(0)} ops/sec)`,
    )

    expect(durationMs).toBeLessThan(30_000)
  })

  it("benchmarks across all tier variants", () => {
    const tiers = ["free", "pro", "enterprise"] as const
    const iterations = 5_000

    for (const tier of tiers) {
      const claims = makeClaims(tier)

      // Warm up
      for (let i = 0; i < 50; i++) enforcePoolClaims(claims)

      const start = performance.now()
      for (let i = 0; i < iterations; i++) {
        enforcePoolClaims(claims)
      }
      const durationMs = performance.now() - start
      const opsPerSec = (iterations / durationMs) * 1000
      console.log(`[benchmark] Tier ${tier}: ${opsPerSec.toFixed(0)} ops/sec`)
    }

    expect(true).toBe(true) // Benchmark is reporting only
  })

  it("benchmarks pool_id validation path", () => {
    const claims = makeClaimsWithPool("pro", "fast-code")
    const iterations = 10_000

    // Warm up
    for (let i = 0; i < 100; i++) enforcePoolClaims(claims)

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      enforcePoolClaims(claims)
    }
    const durationMs = performance.now() - start
    const opsPerSec = (iterations / durationMs) * 1000

    console.log(
      `[benchmark] pool_id validation path: ${iterations} iterations in ` +
      `${durationMs.toFixed(1)}ms (${opsPerSec.toFixed(0)} ops/sec)`,
    )

    expect(durationMs).toBeLessThan(30_000)
  })

  it("benchmarks allowed_pools mismatch detection path", () => {
    // Enterprise with subset mismatch (claims fewer pools than tier allows)
    const claims = makeClaimsWithAllowedPools("enterprise", ["cheap", "fast-code"])
    const iterations = 10_000

    // Warm up
    for (let i = 0; i < 100; i++) enforcePoolClaims(claims)

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      enforcePoolClaims(claims)
    }
    const durationMs = performance.now() - start
    const opsPerSec = (iterations / durationMs) * 1000

    console.log(
      `[benchmark] allowed_pools mismatch detection: ${iterations} iterations in ` +
      `${durationMs.toFixed(1)}ms (${opsPerSec.toFixed(0)} ops/sec)`,
    )

    expect(durationMs).toBeLessThan(30_000)
  })

  it("benchmarks failure path (unknown pool)", () => {
    const claims = makeClaimsWithPool("pro", "nonexistent-pool")
    const iterations = 10_000

    // Warm up
    for (let i = 0; i < 100; i++) enforcePoolClaims(claims)

    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      enforcePoolClaims(claims)
    }
    const durationMs = performance.now() - start
    const opsPerSec = (iterations / durationMs) * 1000

    console.log(
      `[benchmark] Failure path (unknown pool): ${iterations} iterations in ` +
      `${durationMs.toFixed(1)}ms (${opsPerSec.toFixed(0)} ops/sec)`,
    )

    expect(durationMs).toBeLessThan(30_000)
  })

  it("reports speedup ratio placeholder", () => {
    // When native enforcement is available (NATIVE_ENFORCEMENT_ENABLED=true),
    // the native path should be >= 3x faster due to pre-computed lookup tables.
    // This test documents the expected comparison but cannot validate it
    // with flags off (default).
    console.log(
      "[benchmark] Note: Native vs expression speedup ratio requires " +
      "NATIVE_ENFORCEMENT_ENABLED=true + ENFORCEMENT_GEOMETRY=native",
    )
    console.log("[benchmark] Expected target: >= 3x speedup for native path")
    expect(true).toBe(true)
  })
})
