// tests/nft/schemas.test.ts — Runtime Validator Tests (Sprint 120 T3.2)

import { describe, it, expect } from "vitest"
import {
  parseSignalSnapshot,
  parseDAMPFingerprint,
  parseDerivedVoiceProfile,
  SignalValidationError,
} from "../../src/nft/schemas.js"
import { DAMP_DIAL_IDS } from "../../src/nft/signal-types.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validSnapshot() {
  return {
    archetype: "freetekno",
    ancestor: "Marcus Aurelius",
    birthday: "2024-03-15",
    era: "ancient",
    molecule: "C8H10N4O2",
    tarot: { name: "The Magician", number: 1, suit: "major", element: "fire" },
    element: "fire",
    swag_rank: "S",
    swag_score: 85,
    sun_sign: "aries",
    moon_sign: "cancer",
    ascending_sign: "libra",
  }
}

function validFingerprint() {
  const dials: Record<string, number> = {}
  for (const id of DAMP_DIAL_IDS) {
    dials[id] = 0.5
  }
  return { dials }
}

function validVoiceProfile() {
  return {
    primary_voice: "analytical",
    confidence: 0.85,
    reasoning: "High analytical signal from archetype and ancestor combination",
  }
}

// ---------------------------------------------------------------------------
// parseSignalSnapshot
// ---------------------------------------------------------------------------

describe("parseSignalSnapshot", () => {
  it("accepts a valid snapshot", () => {
    const result = parseSignalSnapshot(validSnapshot())
    expect(result.archetype).toBe("freetekno")
    expect(result.ancestor).toBe("Marcus Aurelius")
    expect(result.tarot.name).toBe("The Magician")
    expect(result.swag_score).toBe(85)
  })

  it("rejects null input", () => {
    expect(() => parseSignalSnapshot(null)).toThrow(SignalValidationError)
  })

  it("rejects non-object input", () => {
    expect(() => parseSignalSnapshot("not an object")).toThrow(SignalValidationError)
  })

  it("rejects invalid archetype", () => {
    const snap = validSnapshot()
    snap.archetype = "InvalidArchetype"
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
    try {
      parseSignalSnapshot(snap)
    } catch (e) {
      expect((e as SignalValidationError).field).toBe("archetype")
    }
  })

  it("rejects empty ancestor", () => {
    const snap = validSnapshot()
    snap.ancestor = ""
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects invalid era", () => {
    const snap = validSnapshot()
    snap.era = "future" as any
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects invalid tarot (non-object)", () => {
    const snap = validSnapshot()
    ;(snap as any).tarot = "not an object"
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects invalid tarot suit", () => {
    const snap = validSnapshot()
    snap.tarot.suit = "hearts" as any
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects swag_score out of range (>100)", () => {
    const snap = validSnapshot()
    snap.swag_score = 101
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects swag_score out of range (<0)", () => {
    const snap = validSnapshot()
    snap.swag_score = -1
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects invalid zodiac sign", () => {
    const snap = validSnapshot()
    snap.sun_sign = "NotASign" as any
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })

  it("rejects missing field", () => {
    const snap = validSnapshot()
    delete (snap as any).element
    expect(() => parseSignalSnapshot(snap)).toThrow(SignalValidationError)
  })
})

// ---------------------------------------------------------------------------
// parseDAMPFingerprint
// ---------------------------------------------------------------------------

describe("parseDAMPFingerprint", () => {
  it("accepts a valid fingerprint with all 96 dials", () => {
    const result = parseDAMPFingerprint(validFingerprint())
    expect(Object.keys(result.dials).length).toBe(DAMP_DIAL_IDS.length)
    expect(result.dials[DAMP_DIAL_IDS[0]]).toBe(0.5)
  })

  it("rejects null input", () => {
    expect(() => parseDAMPFingerprint(null)).toThrow(SignalValidationError)
  })

  it("rejects missing dials object", () => {
    expect(() => parseDAMPFingerprint({})).toThrow(SignalValidationError)
  })

  it("rejects dial value > 1.0", () => {
    const fp = validFingerprint()
    fp.dials[DAMP_DIAL_IDS[0]] = 1.5
    expect(() => parseDAMPFingerprint(fp)).toThrow(SignalValidationError)
  })

  it("rejects dial value < 0.0", () => {
    const fp = validFingerprint()
    fp.dials[DAMP_DIAL_IDS[0]] = -0.1
    expect(() => parseDAMPFingerprint(fp)).toThrow(SignalValidationError)
  })

  it("rejects non-number dial value", () => {
    const fp = validFingerprint()
    ;(fp.dials as any)[DAMP_DIAL_IDS[0]] = "not a number"
    expect(() => parseDAMPFingerprint(fp)).toThrow(SignalValidationError)
  })

  it("rejects missing dial", () => {
    const fp = validFingerprint()
    delete fp.dials[DAMP_DIAL_IDS[0]]
    expect(() => parseDAMPFingerprint(fp)).toThrow(SignalValidationError)
  })

  it("accepts optional fields", () => {
    const fp = { ...validFingerprint(), mode: "derived", derived_from: "test", derived_at: 12345 }
    const result = parseDAMPFingerprint(fp)
    expect(result.mode).toBe("derived")
    expect(result.derived_from).toBe("test")
    expect(result.derived_at).toBe(12345)
  })

  it("accepts fingerprint without optional fields", () => {
    const result = parseDAMPFingerprint(validFingerprint())
    expect(result.mode).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseDerivedVoiceProfile
// ---------------------------------------------------------------------------

describe("parseDerivedVoiceProfile", () => {
  it("accepts a valid voice profile", () => {
    const result = parseDerivedVoiceProfile(validVoiceProfile())
    expect(result.primary_voice).toBe("analytical")
    expect(result.confidence).toBe(0.85)
    expect(result.reasoning).toContain("analytical")
  })

  it("rejects null input", () => {
    expect(() => parseDerivedVoiceProfile(null)).toThrow(SignalValidationError)
  })

  it("rejects invalid voice type", () => {
    const vp = validVoiceProfile()
    ;(vp as any).primary_voice = "mysterious"
    expect(() => parseDerivedVoiceProfile(vp)).toThrow(SignalValidationError)
  })

  it("rejects confidence > 1.0", () => {
    const vp = validVoiceProfile()
    vp.confidence = 1.5
    expect(() => parseDerivedVoiceProfile(vp)).toThrow(SignalValidationError)
  })

  it("rejects confidence < 0.0", () => {
    const vp = validVoiceProfile()
    vp.confidence = -0.1
    expect(() => parseDerivedVoiceProfile(vp)).toThrow(SignalValidationError)
  })

  it("rejects empty reasoning", () => {
    const vp = validVoiceProfile()
    vp.reasoning = ""
    expect(() => parseDerivedVoiceProfile(vp)).toThrow(SignalValidationError)
  })
})

// ---------------------------------------------------------------------------
// SignalValidationError
// ---------------------------------------------------------------------------

describe("SignalValidationError", () => {
  it("includes field and reason in message", () => {
    const err = new SignalValidationError("archetype", "must be valid")
    expect(err.message).toContain("archetype")
    expect(err.message).toContain("must be valid")
    expect(err.field).toBe("archetype")
    expect(err.reason).toBe("must be valid")
    expect(err.name).toBe("SignalValidationError")
  })
})
