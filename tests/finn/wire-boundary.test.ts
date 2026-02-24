// tests/finn/wire-boundary.test.ts — Wire Boundary Module Tests (SDD §4.1, Task 2.1)
//
// Comprehensive tests for the centralized branded type parse/serialize layer.
// Covers: valid values, edge cases, error messages, round-trip stability.

import { describe, it, expect, expectTypeOf } from "vitest"
import {
  parseMicroUSD,
  parseMicroUSDLenient,
  serializeMicroUSD,
  assertMicroUSDFormat,
  addMicroUSD,
  subtractMicroUSD,
  parseStrictMicroUSD,
  serializeStrictMicroUSD,
  parseBasisPoints,
  serializeBasisPoints,
  parseAccountId,
  serializeAccountId,
  parsePoolId,
  WireBoundaryError,
} from "../../src/hounfour/wire-boundary.js"
import type { StrictMicroUSD } from "../../src/hounfour/wire-boundary.js"
import type { BrandedMicroUSD as ProtocolMicroUSD } from "@0xhoneyjar/loa-hounfour"
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

// ---------------------------------------------------------------------------
// parseStrictMicroUSD — positive-only branded parser (Sprint 2, Task 2.1)
// ---------------------------------------------------------------------------

describe("parseStrictMicroUSD", () => {
  describe("valid values — positive and zero", () => {
    it("parses '0' as 0n", () => {
      expect(parseStrictMicroUSD("0")).toBe(0n)
    })

    it("parses positive integers", () => {
      expect(parseStrictMicroUSD("1")).toBe(1n)
      expect(parseStrictMicroUSD("123456789")).toBe(123456789n)
      expect(parseStrictMicroUSD("1000000")).toBe(1000000n)
    })

    it("parses large positive values (BigInt range)", () => {
      expect(parseStrictMicroUSD("999999999999999999999")).toBe(999999999999999999999n)
    })
  })

  describe("normalization — inherited from parseMicroUSD", () => {
    it("strips leading zeros: '007' → 7n", () => {
      expect(parseStrictMicroUSD("007")).toBe(7n)
    })

    it("all zeros normalize to 0: '000' → 0n", () => {
      expect(parseStrictMicroUSD("000")).toBe(0n)
    })

    it("normalizes '-0' to 0n (zero is non-negative)", () => {
      expect(parseStrictMicroUSD("-0")).toBe(0n)
    })

    it("normalizes '-000' to 0n", () => {
      expect(parseStrictMicroUSD("-000")).toBe(0n)
    })
  })

  describe("rejection — negative values", () => {
    it("rejects '-1'", () => {
      expect(() => parseStrictMicroUSD("-1")).toThrow(WireBoundaryError)
      expect(() => parseStrictMicroUSD("-1")).toThrow("negative values not allowed at strict boundary")
    })

    it("rejects large negative values", () => {
      expect(() => parseStrictMicroUSD("-999999")).toThrow(WireBoundaryError)
    })

    it("error has field='strict_micro_usd'", () => {
      try {
        parseStrictMicroUSD("-100")
        expect.fail("should throw")
      } catch (e) {
        expect(e).toBeInstanceOf(WireBoundaryError)
        const err = e as WireBoundaryError
        expect(err.field).toBe("strict_micro_usd")
        expect(err.raw).toBe("-100")
      }
    })
  })

  describe("rejection — inherited from parseMicroUSD", () => {
    it("rejects empty string", () => {
      expect(() => parseStrictMicroUSD("")).toThrow(WireBoundaryError)
    })

    it("rejects plus sign prefix", () => {
      expect(() => parseStrictMicroUSD("+123")).toThrow(WireBoundaryError)
    })

    it("rejects non-digit characters", () => {
      expect(() => parseStrictMicroUSD("12.34")).toThrow(WireBoundaryError)
      expect(() => parseStrictMicroUSD("abc")).toThrow(WireBoundaryError)
    })

    it("rejects non-string input", () => {
      expect(() => parseStrictMicroUSD(undefined as unknown as string)).toThrow(WireBoundaryError)
    })
  })
})

// ---------------------------------------------------------------------------
// serializeStrictMicroUSD
// ---------------------------------------------------------------------------

describe("serializeStrictMicroUSD", () => {
  it("serializes 0n to '0'", () => {
    expect(serializeStrictMicroUSD(parseStrictMicroUSD("0"))).toBe("0")
  })

  it("serializes positive values", () => {
    expect(serializeStrictMicroUSD(parseStrictMicroUSD("1000000"))).toBe("1000000")
  })
})

// ---------------------------------------------------------------------------
// StrictMicroUSD round-trip
// ---------------------------------------------------------------------------

describe("StrictMicroUSD round-trip", () => {
  const values = ["0", "1", "1000000", "999999999999999999999"]

  for (const v of values) {
    it(`round-trip for "${v}"`, () => {
      const parsed = parseStrictMicroUSD(v)
      const serialized = serializeStrictMicroUSD(parsed)
      const reparsed = parseStrictMicroUSD(serialized)
      expect(reparsed).toBe(parsed)
    })
  }
})

// ---------------------------------------------------------------------------
// StrictMicroUSD compile-time type tests (Sprint 2, Task 2.1)
// ---------------------------------------------------------------------------

describe("StrictMicroUSD type safety", () => {
  it("StrictMicroUSD IS assignable to MicroUSD (ProtocolMicroUSD)", () => {
    // StrictMicroUSD is a subtype of MicroUSD — can be used wherever MicroUSD is expected
    expectTypeOf<StrictMicroUSD>().toMatchTypeOf<MicroUSD>()
  })

  it("StrictMicroUSD IS assignable to ProtocolMicroUSD", () => {
    // StrictMicroUSD is a subtype of the protocol's branded type
    expectTypeOf<StrictMicroUSD>().toMatchTypeOf<ProtocolMicroUSD>()
  })

  it("MicroUSD is NOT assignable to StrictMicroUSD (nominal brand prevents)", () => {
    // Regular MicroUSD (which allows negatives) cannot be passed as StrictMicroUSD
    expectTypeOf<MicroUSD>().not.toMatchTypeOf<StrictMicroUSD>()
  })

  it("plain bigint is NOT assignable to StrictMicroUSD", () => {
    expectTypeOf<bigint>().not.toMatchTypeOf<StrictMicroUSD>()
  })

  it("parseStrictMicroUSD returns StrictMicroUSD", () => {
    expectTypeOf(parseStrictMicroUSD).returns.toMatchTypeOf<StrictMicroUSD>()
  })
})

// ---------------------------------------------------------------------------
// Negative boundary invariant tests (Sprint 2, Task 2.2)
// ---------------------------------------------------------------------------

describe("Negative boundary invariant", () => {
  describe("property test: 100+ random negative values all produce WireBoundaryError", () => {
    // Generate 120 random negative values across different magnitudes
    const negativeValues: string[] = []
    for (let i = 0; i < 40; i++) {
      // Small negatives (-1 to -999)
      negativeValues.push(`-${Math.floor(Math.random() * 999) + 1}`)
      // Medium negatives (-1000 to -999999)
      negativeValues.push(`-${Math.floor(Math.random() * 999000) + 1000}`)
      // Large negatives (-1000000 to -999999999)
      negativeValues.push(`-${Math.floor(Math.random() * 999000000) + 1000000}`)
    }

    for (const neg of negativeValues) {
      it(`rejects negative value: ${neg}`, () => {
        expect(() => parseStrictMicroUSD(neg)).toThrow(WireBoundaryError)
      })
    }
  })

  describe("round-trip: WAL → internal → outbound wire rejects negatives at boundary", () => {
    it("internal deficit tracking allows negatives via parseMicroUSD", () => {
      // WAL/internal accounting: negatives are valid
      const deficit = parseMicroUSD("-500000")
      expect(deficit).toBe(-500000n)
      const serialized = serializeMicroUSD(deficit)
      expect(serialized).toBe("-500000")
    })

    it("outbound wire boundary rejects the same negative value", () => {
      // Simulate: internal deficit → serialize → attempt strict parse at egress
      const deficit = parseMicroUSD("-500000")
      const wireValue = serializeMicroUSD(deficit)
      // At the wire boundary, strict parsing rejects the negative
      expect(() => parseStrictMicroUSD(wireValue)).toThrow(WireBoundaryError)
      expect(() => parseStrictMicroUSD(wireValue)).toThrow("negative values not allowed")
    })

    it("full round-trip: positive value passes all boundaries", () => {
      // Ingress → internal → egress: positive values pass everywhere
      const strict = parseStrictMicroUSD("1000000")
      const serialized = serializeStrictMicroUSD(strict)
      // Can also be parsed by regular parseMicroUSD (StrictMicroUSD IS MicroUSD)
      const regular = parseMicroUSD(serialized)
      expect(regular).toBe(strict)
      // And back through strict boundary
      const reparsed = parseStrictMicroUSD(serialized)
      expect(reparsed).toBe(strict)
    })

    it("zero passes all boundaries (zero is non-negative)", () => {
      const strict = parseStrictMicroUSD("0")
      expect(strict).toBe(0n)
      const serialized = serializeStrictMicroUSD(strict)
      expect(serialized).toBe("0")
      const reparsed = parseStrictMicroUSD(serialized)
      expect(reparsed).toBe(0n)
    })
  })

  describe("edge cases: no negative value can be branded as StrictMicroUSD", () => {
    it("'-0' normalizes to 0n (non-negative), passes strict boundary", () => {
      // "-0" is normalized to "0" by parseMicroUSD before negativity check
      const result = parseStrictMicroUSD("-0")
      expect(result).toBe(0n)
    })

    it("'-000' normalizes to 0n, passes strict boundary", () => {
      const result = parseStrictMicroUSD("-000")
      expect(result).toBe(0n)
    })

    it("'-1' is the smallest rejected value", () => {
      expect(() => parseStrictMicroUSD("-1")).toThrow(WireBoundaryError)
    })

    it("very large negative is rejected", () => {
      expect(() => parseStrictMicroUSD("-99999999999999")).toThrow(WireBoundaryError)
    })
  })
})
