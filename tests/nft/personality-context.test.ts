// tests/nft/personality-context.test.ts — PersonalityContext Tests (Sprint 27 Task 27.3)
//
// Tests: serialization round-trip (echo semantics), protocol version gating,
// dominant dimension extraction, fingerprint hash determinism, null handling.

import { describe, it, expect } from "vitest"
import {
  buildPersonalityContext,
  buildPersonalityContextSync,
  serializePersonalityContext,
  deserializePersonalityContext,
  computeFingerprintHash,
  computeFingerprintHashSync,
  extractDominantDimensions,
  PERSONALITY_CONTEXT_VERSION,
  DOMINANT_DIMENSION_COUNT,
} from "../../src/nft/personality-context.js"
import type { PersonalityContext } from "../../src/nft/personality-context.js"
import type { DAMPFingerprint, DAMPDialId } from "../../src/nft/signal-types.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeFingerprint(baseValue: number = 0.5): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = baseValue
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-sha-abc123",
    derived_at: Date.now(),
  }
}

function makeFingerprintWithVariation(): DAMPFingerprint {
  const dials = {} as Record<DAMPDialId, number>
  for (let i = 0; i < DAMP_DIAL_IDS.length; i++) {
    // Create variation: values from 0.01 to 0.96
    dials[DAMP_DIAL_IDS[i]] = (i + 1) / 100
  }
  return {
    dials,
    mode: "default",
    derived_from: "test-sha-variation",
    derived_at: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Serialization Round-Trip (Echo Semantics)
// ---------------------------------------------------------------------------

describe("PersonalityContext serialization (echo semantics)", () => {
  it("serialize(deserialize(serialize(ctx))) === serialize(ctx)", async () => {
    const fingerprint = makeFingerprint(0.7)
    const ctx = await buildPersonalityContext("honeybears:42", "freetekno", fingerprint)
    expect(ctx).not.toBeNull()

    const serialized = serializePersonalityContext(ctx!)
    const deserialized = deserializePersonalityContext(serialized)
    const reSerialized = serializePersonalityContext(deserialized!)

    expect(reSerialized).toEqual(serialized)
  })

  it("deserialize(serialize(ctx)) preserves all fields", async () => {
    const fingerprint = makeFingerprint(0.3)
    const ctx = await buildPersonalityContext("bears:99", "milady", fingerprint)
    expect(ctx).not.toBeNull()

    const serialized = serializePersonalityContext(ctx!)
    const deserialized = deserializePersonalityContext(serialized)

    expect(deserialized).not.toBeNull()
    expect(deserialized!.personality_id).toBe(ctx!.personality_id)
    expect(deserialized!.damp_fingerprint_hash).toBe(ctx!.damp_fingerprint_hash)
    expect(deserialized!.archetype).toBe(ctx!.archetype)
    expect(deserialized!.protocol_version).toBe(ctx!.protocol_version)
    expect(deserialized!.dominant_dimensions).toEqual(ctx!.dominant_dimensions)
  })

  it("serialize(null) returns null", () => {
    expect(serializePersonalityContext(null)).toBeNull()
  })

  it("deserialize(null) returns null", () => {
    expect(deserializePersonalityContext(null)).toBeNull()
  })

  it("deserialize(undefined) returns null", () => {
    expect(deserializePersonalityContext(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Protocol Version Gating
// ---------------------------------------------------------------------------

describe("PersonalityContext protocol version gating", () => {
  it("rejects context with wrong protocol_version", async () => {
    const fingerprint = makeFingerprint()
    const ctx = await buildPersonalityContext("test:1", "freetekno", fingerprint)
    const serialized = serializePersonalityContext(ctx!)

    // Tamper with protocol version
    serialized!.protocol_version = "3.0"
    const result = deserializePersonalityContext(serialized)
    expect(result).toBeNull()
  })

  it("rejects context with missing protocol_version", () => {
    const raw = {
      personality_id: "test:1",
      damp_fingerprint_hash: "abc123",
      archetype: "freetekno",
      dominant_dimensions: [],
      // protocol_version intentionally missing
    }
    const result = deserializePersonalityContext(raw)
    expect(result).toBeNull()
  })

  it("accepts context with correct protocol_version", async () => {
    const fingerprint = makeFingerprint()
    const ctx = await buildPersonalityContext("test:1", "freetekno", fingerprint)
    const serialized = serializePersonalityContext(ctx!)
    const result = deserializePersonalityContext(serialized)
    expect(result).not.toBeNull()
    expect(result!.protocol_version).toBe(PERSONALITY_CONTEXT_VERSION)
  })

  it("protocol version is 4.5", () => {
    expect(PERSONALITY_CONTEXT_VERSION).toBe("4.5")
  })
})

// ---------------------------------------------------------------------------
// Fingerprint Hash Determinism
// ---------------------------------------------------------------------------

describe("Fingerprint hash determinism", () => {
  it("same fingerprint produces same hash", async () => {
    const fp = makeFingerprint(0.5)
    const hash1 = await computeFingerprintHash(fp)
    const hash2 = await computeFingerprintHash(fp)
    expect(hash1).toBe(hash2)
  })

  it("sync and async hash produce same result", async () => {
    const fp = makeFingerprint(0.5)
    const asyncHash = await computeFingerprintHash(fp)
    const syncHash = computeFingerprintHashSync(fp)
    expect(asyncHash).toBe(syncHash)
  })

  it("different fingerprints produce different hashes", async () => {
    const fp1 = makeFingerprint(0.5)
    const fp2 = makeFingerprint(0.6)
    const hash1 = await computeFingerprintHash(fp1)
    const hash2 = await computeFingerprintHash(fp2)
    expect(hash1).not.toBe(hash2)
  })

  it("hash is a 64-char hex string (SHA-256)", async () => {
    const fp = makeFingerprint()
    const hash = await computeFingerprintHash(fp)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// Dominant Dimensions
// ---------------------------------------------------------------------------

describe("Dominant dimension extraction", () => {
  it("returns exactly DOMINANT_DIMENSION_COUNT dimensions by default", () => {
    const fp = makeFingerprintWithVariation()
    const dims = extractDominantDimensions(fp)
    expect(dims).toHaveLength(DOMINANT_DIMENSION_COUNT)
  })

  it("dimensions are sorted by value descending", () => {
    const fp = makeFingerprintWithVariation()
    const dims = extractDominantDimensions(fp)
    for (let i = 1; i < dims.length; i++) {
      expect(dims[i].value).toBeLessThanOrEqual(dims[i - 1].value)
    }
  })

  it("respects custom count parameter", () => {
    const fp = makeFingerprintWithVariation()
    const dims = extractDominantDimensions(fp, 3)
    expect(dims).toHaveLength(3)
  })

  it("ties broken by dial_id ascending (lexicographic)", () => {
    const fp = makeFingerprint(0.5) // all dials are 0.5
    const dims = extractDominantDimensions(fp, 96)
    // All values are equal, so should be sorted by dial_id
    for (let i = 1; i < dims.length; i++) {
      expect(dims[i].dial_id.localeCompare(dims[i - 1].dial_id)).toBeGreaterThanOrEqual(0)
    }
  })

  it("returns highest-value dials", () => {
    const fp = makeFingerprintWithVariation()
    const dims = extractDominantDimensions(fp, 1)
    // The highest value should be 0.96 (96/100 for index 95)
    expect(dims[0].value).toBe(96 / 100)
  })
})

// ---------------------------------------------------------------------------
// Null Fingerprint Handling
// ---------------------------------------------------------------------------

describe("Null fingerprint handling", () => {
  it("buildPersonalityContext returns null when fingerprint is null", async () => {
    const ctx = await buildPersonalityContext("test:1", "freetekno", null)
    expect(ctx).toBeNull()
  })

  it("buildPersonalityContextSync returns null when fingerprint is null", () => {
    const ctx = buildPersonalityContextSync("test:1", "milady", null)
    expect(ctx).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Full Context Build
// ---------------------------------------------------------------------------

describe("Full context build", () => {
  it("builds context with all fields populated", async () => {
    const fp = makeFingerprintWithVariation()
    const ctx = await buildPersonalityContext("bears:42", "acidhouse", fp)

    expect(ctx).not.toBeNull()
    expect(ctx!.personality_id).toBe("bears:42")
    expect(ctx!.archetype).toBe("acidhouse")
    expect(ctx!.protocol_version).toBe("4.5")
    expect(ctx!.damp_fingerprint_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ctx!.dominant_dimensions).toHaveLength(DOMINANT_DIMENSION_COUNT)
  })

  it("sync build produces same result as async", async () => {
    const fp = makeFingerprint(0.42)
    const asyncCtx = await buildPersonalityContext("test:sync", "chicago_detroit", fp)
    const syncCtx = buildPersonalityContextSync("test:sync", "chicago_detroit", fp)

    expect(asyncCtx).not.toBeNull()
    expect(syncCtx).not.toBeNull()
    expect(asyncCtx!.damp_fingerprint_hash).toBe(syncCtx!.damp_fingerprint_hash)
    expect(asyncCtx!.dominant_dimensions).toEqual(syncCtx!.dominant_dimensions)
  })
})

// ---------------------------------------------------------------------------
// Deserialization Validation
// ---------------------------------------------------------------------------

describe("Deserialization validation", () => {
  it("rejects non-object input", () => {
    expect(deserializePersonalityContext("string" as unknown as Record<string, unknown>)).toBeNull()
  })

  it("rejects missing personality_id", () => {
    const raw = {
      damp_fingerprint_hash: "abc",
      archetype: "freetekno",
      dominant_dimensions: [],
      protocol_version: PERSONALITY_CONTEXT_VERSION,
    }
    expect(deserializePersonalityContext(raw)).toBeNull()
  })

  it("rejects missing archetype", () => {
    const raw = {
      personality_id: "test:1",
      damp_fingerprint_hash: "abc",
      dominant_dimensions: [],
      protocol_version: PERSONALITY_CONTEXT_VERSION,
    }
    expect(deserializePersonalityContext(raw)).toBeNull()
  })

  it("rejects non-array dominant_dimensions", () => {
    const raw = {
      personality_id: "test:1",
      damp_fingerprint_hash: "abc",
      archetype: "freetekno",
      dominant_dimensions: "not-an-array",
      protocol_version: PERSONALITY_CONTEXT_VERSION,
    }
    expect(deserializePersonalityContext(raw)).toBeNull()
  })
})
