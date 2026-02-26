// tests/finn/goodhart/calibration-hmac.test.ts — Calibration HMAC Integration Test (T-6.8, cycle-034)
//
// Verifies HMAC mismatch → data rejected (stale data retained).
// Valid HMAC → data applied.

import { describe, it, expect, vi } from "vitest"
import { createHmac } from "node:crypto"
import { CalibrationEngine, type CalibrationConfig, type S3Reader, type CalibrationEntry } from "../../../src/hounfour/goodhart/calibration.js"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"
import type { NFTRoutingKey } from "../../../src/hounfour/nft-routing-config.js"

// --- Test Helpers ---

const HMAC_SECRET = "e2e-test-hmac-secret-32-chars-ok"

const VALID_ENTRY_1: CalibrationEntry = {
  nftId: "nft-001",
  poolId: "pool-alpha" as PoolId,
  routingKey: "chat" as NFTRoutingKey,
  score: 0.85,
  evaluator: "human",
  timestamp: "2026-02-01T00:00:00Z",
}

const VALID_ENTRY_2: CalibrationEntry = {
  nftId: "nft-002",
  poolId: "pool-beta" as PoolId,
  routingKey: "code" as NFTRoutingKey,
  score: 0.72,
  evaluator: "human",
  timestamp: "2026-02-02T00:00:00Z",
}

/** Build JSONL content with valid HMAC signature on last line */
function buildSignedJSONL(entries: CalibrationEntry[], secret: string): string {
  const lines = entries.map((e) => JSON.stringify(e))
  const content = lines.join("\n")
  const hmac = createHmac("sha256", secret).update(content).digest("hex")
  return content + "\n" + JSON.stringify({ hmac })
}

/** Build JSONL content with WRONG HMAC */
function buildTamperedJSONL(entries: CalibrationEntry[], secret: string): string {
  const lines = entries.map((e) => JSON.stringify(e))
  const content = lines.join("\n")
  // Compute HMAC with wrong secret
  const hmac = createHmac("sha256", "wrong-secret").update(content).digest("hex")
  return content + "\n" + JSON.stringify({ hmac })
}

function makeConfig(overrides?: Partial<CalibrationConfig>): CalibrationConfig {
  return {
    s3Bucket: "finn-calibration-test",
    s3Key: "calibration/latest.jsonl",
    pollIntervalMs: 60000,
    calibrationWeight: 3.0,
    hmacSecret: HMAC_SECRET,
    ...overrides,
  }
}

function mockS3Reader(body: string): S3Reader {
  return {
    getObject: vi.fn().mockResolvedValue({
      status: 200,
      body,
      etag: "test-etag-1",
    }),
  }
}

// --- Tests ---

describe("Calibration HMAC Integration", () => {
  it("valid HMAC → data applied", async () => {
    const signedContent = buildSignedJSONL([VALID_ENTRY_1, VALID_ENTRY_2], HMAC_SECRET)
    const s3 = mockS3Reader(signedContent)
    const config = makeConfig()
    const engine = new CalibrationEngine(config, s3)

    // Trigger S3 fetch (normally done by polling)
    engine.startPolling()
    // Give async fetch time to complete
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    // Both entries should be loaded
    const entries1 = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entries1).toHaveLength(1)
    expect(entries1[0].score).toBe(0.85)

    const entries2 = engine.getCalibration("nft-002", "pool-beta" as PoolId, "code" as NFTRoutingKey)
    expect(entries2).toHaveLength(1)
    expect(entries2[0].score).toBe(0.72)
  })

  it("HMAC mismatch → data rejected, stale data retained", async () => {
    const config = makeConfig()

    // Step 1: Load valid data first
    const validContent = buildSignedJSONL([VALID_ENTRY_1], HMAC_SECRET)
    const s3Valid = mockS3Reader(validContent)
    const engine = new CalibrationEngine(config, s3Valid)

    engine.startPolling()
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    // Verify valid data loaded
    const entriesBefore = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entriesBefore).toHaveLength(1)
    expect(entriesBefore[0].score).toBe(0.85)

    // Step 2: Provide tampered data (wrong HMAC)
    const tamperedContent = buildTamperedJSONL([VALID_ENTRY_2], HMAC_SECRET)
    const s3Tampered = mockS3Reader(tamperedContent)
    engine.setS3Reader(s3Tampered)

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    engine.startPolling()
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    // HMAC failure should be logged
    const hmacError = errorSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string)
        return parsed.event === "hmac_verification_failed"
      } catch { return false }
    })
    expect(hmacError).toBeDefined()

    // Stale data should be retained (entry 1 still there)
    const entriesAfter = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entriesAfter).toHaveLength(1)
    expect(entriesAfter[0].score).toBe(0.85)

    // New tampered data should NOT be loaded
    const entriesNew = engine.getCalibration("nft-002", "pool-beta" as PoolId, "code" as NFTRoutingKey)
    expect(entriesNew).toHaveLength(0)

    errorSpy.mockRestore()
  })

  it("missing HMAC line → data rejected", async () => {
    const config = makeConfig()
    // Just raw JSONL without HMAC line
    const noHmacContent = JSON.stringify(VALID_ENTRY_1)
    const s3 = mockS3Reader(noHmacContent)
    const engine = new CalibrationEngine(config, s3)

    engine.startPolling()
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    // No entries loaded (HMAC check fails because only 1 line)
    const entries = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entries).toHaveLength(0)
  })

  it("empty HMAC value → data rejected", async () => {
    const config = makeConfig()
    const content = JSON.stringify(VALID_ENTRY_1) + "\n" + JSON.stringify({ hmac: "" })
    const s3 = mockS3Reader(content)
    const engine = new CalibrationEngine(config, s3)

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    engine.startPolling()
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    const entries = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entries).toHaveLength(0)

    errorSpy.mockRestore()
  })

  it("304 Not Modified → no change to entries", async () => {
    const config = makeConfig()

    // Load initial data
    const validContent = buildSignedJSONL([VALID_ENTRY_1], HMAC_SECRET)
    const s3Initial = mockS3Reader(validContent)
    const engine = new CalibrationEngine(config, s3Initial)

    engine.startPolling()
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    const entriesBefore = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entriesBefore).toHaveLength(1)

    // S3 returns 304 (not modified)
    const s3NotModified: S3Reader = {
      getObject: vi.fn().mockResolvedValue({ status: 304 }),
    }
    engine.setS3Reader(s3NotModified)

    engine.startPolling()
    await new Promise((r) => setTimeout(r, 50))
    engine.stopPolling()

    // Data unchanged
    const entriesAfter = engine.getCalibration("nft-001", "pool-alpha" as PoolId, "chat" as NFTRoutingKey)
    expect(entriesAfter).toHaveLength(1)
    expect(entriesAfter[0].score).toBe(0.85)
  })

  it("blendWithDecay: calibration entry shifts score more than automated observations (AC8)", () => {
    const config = makeConfig({ calibrationWeight: 3.0 })
    const engine = new CalibrationEngine(config)

    // decayedEma=0.5, sampleCount=3, one calibration entry score=0.9
    const blended = engine.blendWithDecay(0.5, 3, [VALID_ENTRY_1])
    // VALID_ENTRY_1 has score 0.85
    // blended = (0.5*3 + 0.85*3.0*1) / (3 + 3.0*1) = (1.5 + 2.55) / 6 = 4.05 / 6 = 0.675
    expect(blended).toBeCloseTo(0.675, 3)
    // Original was 0.5, blended is 0.675 — significant shift from one calibration entry
    expect(blended).toBeGreaterThan(0.5)
  })
})
