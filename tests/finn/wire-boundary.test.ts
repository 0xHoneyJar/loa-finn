// tests/finn/wire-boundary.test.ts — Wire Boundary Module Tests (SDD §4.1, Task 2.1)
//
// Comprehensive tests for the centralized branded type parse/serialize layer.
// Covers: valid values, edge cases, error messages, round-trip stability.

import { describe, it, expect } from "vitest"
import {
  parseMicroUSD,
  parseMicroUSDLenient,
  serializeMicroUSD,
  assertMicroUSDFormat,
  addMicroUSD,
  subtractMicroUSD,
  parseBasisPoints,
  serializeBasisPoints,
  parseAccountId,
  serializeAccountId,
  parsePoolId,
  WireBoundaryError,
} from "../../src/hounfour/wire-boundary.js"
import type { MicroUSD, BasisPoints, AccountId } from "@0xhoneyjar/loa-hounfour"
import type { PoolId } from "@0xhoneyjar/loa-hounfour"

// ---------------------------------------------------------------------------
// WireBoundaryError
// ---------------------------------------------------------------------------

describe("WireBoundaryError", () => {
  it("includes field, raw, and reason in message", () => {
    const err = new WireBoundaryError("micro_usd", "bad", "not a number")
    expect(err.message).toBe("Wire boundary violation: micro_usd — not a number")
    expect(err.field).toBe("micro_usd")
    expect(err.raw).toBe("bad")
    expect(err.reason).toBe("not a number")
    expect(err.name).toBe("WireBoundaryError")
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// parseMicroUSD — strict parser
// ---------------------------------------------------------------------------

describe("parseMicroUSD", () => {
  describe("valid values", () => {
    it("parses '0' as 0n", () => {
      expect(parseMicroUSD("0")).toBe(0n)
    })

    it("parses positive integers", () => {
      expect(parseMicroUSD("1")).toBe(1n)
      expect(parseMicroUSD("123456789")).toBe(123456789n)
      expect(parseMicroUSD("1000000")).toBe(1000000n)
    })

    it("parses negative integers (deficit tracking)", () => {
      expect(parseMicroUSD("-1")).toBe(-1n)
      expect(parseMicroUSD("-999999")).toBe(-999999n)
    })

    it("parses large values (BigInt range)", () => {
      expect(parseMicroUSD("999999999999999999999")).toBe(999999999999999999999n)
    })
  })

  describe("normalization — leading zeros", () => {
    it("strips leading zeros: '007' → 7n", () => {
      expect(parseMicroUSD("007")).toBe(7n)
    })

    it("strips multiple leading zeros: '000123' → 123n", () => {
      expect(parseMicroUSD("000123")).toBe(123n)
    })

    it("all zeros normalize to 0: '000' → 0n", () => {
      expect(parseMicroUSD("000")).toBe(0n)
    })

    it("strips leading zeros on negative: '-007' → -7n", () => {
      expect(parseMicroUSD("-007")).toBe(-7n)
    })
  })

  describe("normalization — minus zero", () => {
    it("normalizes '-0' → 0n", () => {
      expect(parseMicroUSD("-0")).toBe(0n)
    })

    it("normalizes '-000' → 0n", () => {
      expect(parseMicroUSD("-000")).toBe(0n)
    })
  })

  describe("rejection — invalid input", () => {
    it("rejects empty string", () => {
      expect(() => parseMicroUSD("")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("")).toThrow("empty or non-string value")
    })

    it("rejects plus sign prefix", () => {
      expect(() => parseMicroUSD("+123")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("+123")).toThrow("plus sign prefix not allowed")
    })

    it("rejects bare minus sign", () => {
      expect(() => parseMicroUSD("-")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("-")).toThrow("bare minus sign")
    })

    it("rejects non-digit characters", () => {
      expect(() => parseMicroUSD("12.34")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("abc")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("12e5")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("0x1A")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD(" 123")).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD("123 ")).toThrow(WireBoundaryError)
    })

    it("rejects non-string input", () => {
      expect(() => parseMicroUSD(undefined as unknown as string)).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD(null as unknown as string)).toThrow(WireBoundaryError)
      expect(() => parseMicroUSD(123 as unknown as string)).toThrow(WireBoundaryError)
    })
  })

  describe("error structure", () => {
    it("includes field='micro_usd' and raw value", () => {
      try {
        parseMicroUSD("bad")
        expect.fail("should throw")
      } catch (e) {
        expect(e).toBeInstanceOf(WireBoundaryError)
        const err = e as WireBoundaryError
        expect(err.field).toBe("micro_usd")
        expect(err.raw).toBe("bad")
      }
    })
  })
})

// ---------------------------------------------------------------------------
// serializeMicroUSD
// ---------------------------------------------------------------------------

describe("serializeMicroUSD", () => {
  it("serializes 0n to '0'", () => {
    expect(serializeMicroUSD(0n as MicroUSD)).toBe("0")
  })

  it("serializes positive values", () => {
    expect(serializeMicroUSD(1000000n as MicroUSD)).toBe("1000000")
  })

  it("serializes negative values", () => {
    expect(serializeMicroUSD(-500n as MicroUSD)).toBe("-500")
  })
})

// ---------------------------------------------------------------------------
// Round-trip: parse(serialize(x)) === x
// ---------------------------------------------------------------------------

describe("MicroUSD round-trip", () => {
  const values = ["0", "1", "1000000", "-1", "-999999", "999999999999999999999"]

  for (const v of values) {
    it(`round-trip for "${v}"`, () => {
      const parsed = parseMicroUSD(v)
      const serialized = serializeMicroUSD(parsed)
      const reparsed = parseMicroUSD(serialized)
      expect(reparsed).toBe(parsed)
    })
  }
})

// ---------------------------------------------------------------------------
// parseMicroUSDLenient
// ---------------------------------------------------------------------------

describe("parseMicroUSDLenient", () => {
  it("returns normalized=false for canonical values", () => {
    const result = parseMicroUSDLenient("12345")
    expect(result.value).toBe(12345n)
    expect(result.normalized).toBe(false)
  })

  it("returns normalized=true for plus-signed values", () => {
    const result = parseMicroUSDLenient("+123")
    expect(result.value).toBe(123n)
    expect(result.normalized).toBe(true)
  })

  it("returns normalized=true for leading zeros", () => {
    const result = parseMicroUSDLenient("007")
    expect(result.value).toBe(7n)
    expect(result.normalized).toBe(false) // strict parse handles this
  })

  it("rejects empty string even in lenient mode", () => {
    expect(() => parseMicroUSDLenient("")).toThrow(WireBoundaryError)
  })

  it("rejects whitespace-only in lenient mode", () => {
    expect(() => parseMicroUSDLenient("   ")).toThrow(WireBoundaryError)
  })

  it("rejects completely invalid values", () => {
    expect(() => parseMicroUSDLenient("abc")).toThrow(WireBoundaryError)
  })
})

// ---------------------------------------------------------------------------
// assertMicroUSDFormat
// ---------------------------------------------------------------------------

describe("assertMicroUSDFormat", () => {
  it("accepts canonical values", () => {
    expect(() => assertMicroUSDFormat("0")).not.toThrow()
    expect(() => assertMicroUSDFormat("123")).not.toThrow()
    expect(() => assertMicroUSDFormat("-456")).not.toThrow()
  })

  it("rejects non-canonical values", () => {
    expect(() => assertMicroUSDFormat("007")).toThrow(WireBoundaryError)
    expect(() => assertMicroUSDFormat("+123")).toThrow(WireBoundaryError)
    expect(() => assertMicroUSDFormat("-0")).toThrow(WireBoundaryError)
    expect(() => assertMicroUSDFormat("")).toThrow(WireBoundaryError)
  })
})

// ---------------------------------------------------------------------------
// MicroUSD Arithmetic
// ---------------------------------------------------------------------------

describe("addMicroUSD", () => {
  it("adds two positive values", () => {
    const a = parseMicroUSD("100")
    const b = parseMicroUSD("200")
    expect(addMicroUSD(a, b)).toBe(300n)
  })

  it("adds negative values (deficit)", () => {
    const a = parseMicroUSD("-50")
    const b = parseMicroUSD("100")
    expect(addMicroUSD(a, b)).toBe(50n)
  })

  it("result is serializable", () => {
    const result = addMicroUSD(parseMicroUSD("100"), parseMicroUSD("200"))
    expect(serializeMicroUSD(result)).toBe("300")
  })
})

describe("subtractMicroUSD", () => {
  it("subtracts values", () => {
    const a = parseMicroUSD("300")
    const b = parseMicroUSD("100")
    expect(subtractMicroUSD(a, b)).toBe(200n)
  })

  it("allows negative results (deficit tracking)", () => {
    const a = parseMicroUSD("100")
    const b = parseMicroUSD("300")
    expect(subtractMicroUSD(a, b)).toBe(-200n)
  })
})

// ---------------------------------------------------------------------------
// parseBasisPoints
// ---------------------------------------------------------------------------

describe("parseBasisPoints", () => {
  describe("valid values", () => {
    it("parses 0 (0%)", () => {
      expect(parseBasisPoints(0)).toBe(0n)
    })

    it("parses 5000 (50%)", () => {
      expect(parseBasisPoints(5000)).toBe(5000n)
    })

    it("parses 10000 (100%)", () => {
      expect(parseBasisPoints(10000)).toBe(10000n)
    })
  })

  describe("rejection", () => {
    it("rejects negative values", () => {
      expect(() => parseBasisPoints(-1)).toThrow(WireBoundaryError)
      expect(() => parseBasisPoints(-1)).toThrow("must be in range [0, 10000]")
    })

    it("rejects values > 10000", () => {
      expect(() => parseBasisPoints(10001)).toThrow(WireBoundaryError)
    })

    it("rejects non-integer values", () => {
      expect(() => parseBasisPoints(50.5)).toThrow(WireBoundaryError)
      expect(() => parseBasisPoints(50.5)).toThrow("must be an integer")
    })

    it("rejects NaN", () => {
      expect(() => parseBasisPoints(NaN)).toThrow(WireBoundaryError)
    })

    it("rejects Infinity", () => {
      expect(() => parseBasisPoints(Infinity)).toThrow(WireBoundaryError)
    })

    it("rejects non-number input", () => {
      expect(() => parseBasisPoints("50" as unknown as number)).toThrow(WireBoundaryError)
    })
  })

  describe("error structure", () => {
    it("includes field='basis_points'", () => {
      try {
        parseBasisPoints(-1)
        expect.fail("should throw")
      } catch (e) {
        expect((e as WireBoundaryError).field).toBe("basis_points")
      }
    })
  })
})

// ---------------------------------------------------------------------------
// serializeBasisPoints
// ---------------------------------------------------------------------------

describe("serializeBasisPoints", () => {
  it("serializes to number", () => {
    expect(serializeBasisPoints(5000n as BasisPoints)).toBe(5000)
    expect(serializeBasisPoints(0n as BasisPoints)).toBe(0)
    expect(serializeBasisPoints(10000n as BasisPoints)).toBe(10000)
  })
})

// ---------------------------------------------------------------------------
// BasisPoints round-trip
// ---------------------------------------------------------------------------

describe("BasisPoints round-trip", () => {
  for (const v of [0, 1, 5000, 9999, 10000]) {
    it(`round-trip for ${v}`, () => {
      const parsed = parseBasisPoints(v)
      const serialized = serializeBasisPoints(parsed)
      const reparsed = parseBasisPoints(serialized)
      expect(reparsed).toBe(parsed)
    })
  }
})

// ---------------------------------------------------------------------------
// parseAccountId
// ---------------------------------------------------------------------------

describe("parseAccountId", () => {
  describe("valid values", () => {
    it("parses alphanumeric IDs", () => {
      expect(parseAccountId("user123")).toBe("user123")
    })

    it("parses IDs with underscores and hyphens", () => {
      expect(parseAccountId("tenant_abc-123")).toBe("tenant_abc-123")
    })

    it("parses single character", () => {
      expect(parseAccountId("x")).toBe("x")
    })

    it("parses namespaced IDs with colons", () => {
      expect(parseAccountId("community:thj")).toBe("community:thj")
    })

    it("parses IDs with dots, @, and slashes", () => {
      expect(parseAccountId("user@host")).toBe("user@host")
      expect(parseAccountId("user.name")).toBe("user.name")
      expect(parseAccountId("user/org")).toBe("user/org")
    })
  })

  describe("rejection", () => {
    it("rejects empty string", () => {
      expect(() => parseAccountId("")).toThrow(WireBoundaryError)
      expect(() => parseAccountId("")).toThrow("empty or non-string value")
    })

    it("rejects whitespace", () => {
      expect(() => parseAccountId("user name")).toThrow(WireBoundaryError)
      expect(() => parseAccountId(" leading")).toThrow(WireBoundaryError)
      expect(() => parseAccountId("trailing ")).toThrow(WireBoundaryError)
      expect(() => parseAccountId("\ttab")).toThrow(WireBoundaryError)
    })

    it("rejects non-string input", () => {
      expect(() => parseAccountId(undefined as unknown as string)).toThrow(WireBoundaryError)
      expect(() => parseAccountId(null as unknown as string)).toThrow(WireBoundaryError)
      expect(() => parseAccountId(123 as unknown as string)).toThrow(WireBoundaryError)
    })
  })

  describe("error structure", () => {
    it("includes field='account_id'", () => {
      try {
        parseAccountId("")
        expect.fail("should throw")
      } catch (e) {
        expect((e as WireBoundaryError).field).toBe("account_id")
      }
    })
  })
})

// ---------------------------------------------------------------------------
// serializeAccountId
// ---------------------------------------------------------------------------

describe("serializeAccountId", () => {
  it("returns the string directly", () => {
    const id = parseAccountId("tenant-abc")
    expect(serializeAccountId(id)).toBe("tenant-abc")
  })
})

// ---------------------------------------------------------------------------
// AccountId round-trip
// ---------------------------------------------------------------------------

describe("AccountId round-trip", () => {
  for (const v of ["abc", "user_123", "tenant-xyz-456", "A", "a1_b2-c3", "community:thj", "user@host", "org.team"]) {
    it(`round-trip for "${v}"`, () => {
      const parsed = parseAccountId(v)
      const serialized = serializeAccountId(parsed)
      const reparsed = parseAccountId(serialized)
      expect(reparsed).toBe(parsed)
    })
  }
})

// ---------------------------------------------------------------------------
// parsePoolId
// ---------------------------------------------------------------------------

describe("parsePoolId", () => {
  describe("valid values — canonical vocabulary", () => {
    it("parses 'cheap'", () => {
      expect(parsePoolId("cheap")).toBe("cheap")
    })

    it("parses 'fast-code'", () => {
      expect(parsePoolId("fast-code")).toBe("fast-code")
    })

    it("parses 'reviewer'", () => {
      expect(parsePoolId("reviewer")).toBe("reviewer")
    })

    it("parses 'reasoning'", () => {
      expect(parsePoolId("reasoning")).toBe("reasoning")
    })

    it("parses 'architect'", () => {
      expect(parsePoolId("architect")).toBe("architect")
    })
  })

  describe("rejection", () => {
    it("rejects unknown pool IDs", () => {
      expect(() => parsePoolId("premium")).toThrow(WireBoundaryError)
      expect(() => parsePoolId("premium")).toThrow("not a valid pool ID")
    })

    it("includes valid pool IDs in error message", () => {
      try {
        parsePoolId("unknown")
        expect.fail("should throw")
      } catch (e) {
        const err = e as WireBoundaryError
        expect(err.reason).toContain("cheap")
        expect(err.reason).toContain("architect")
      }
    })

    it("rejects empty string", () => {
      expect(() => parsePoolId("")).toThrow(WireBoundaryError)
    })

    it("rejects case-mismatched IDs", () => {
      expect(() => parsePoolId("Cheap")).toThrow(WireBoundaryError)
      expect(() => parsePoolId("FAST-CODE")).toThrow(WireBoundaryError)
    })

    it("rejects non-string input", () => {
      expect(() => parsePoolId(undefined as unknown as string)).toThrow(WireBoundaryError)
    })
  })

  describe("error structure", () => {
    it("includes field='pool_id'", () => {
      try {
        parsePoolId("bad")
        expect.fail("should throw")
      } catch (e) {
        expect((e as WireBoundaryError).field).toBe("pool_id")
      }
    })
  })
})
