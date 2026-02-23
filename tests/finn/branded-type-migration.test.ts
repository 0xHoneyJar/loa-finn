// tests/finn/branded-type-migration.test.ts — MicroUSDC Brand Migration Verification (Sprint 2, Task 2.3)
//
// Compile-time and runtime tests verifying the MicroUSDC type migration from
// local brand to protocol import (@0xhoneyjar/loa-hounfour/economy).

import { describe, it, expect, expectTypeOf } from "vitest"
import {
  parseMicroUSDC,
  serializeMicroUSDC,
  convertMicroUSDtoMicroUSDC,
  parseMicroUSD,
  WireBoundaryError,
} from "../../src/hounfour/wire-boundary.js"
import type { MicroUSDC } from "../../src/hounfour/wire-boundary.js"
import type { MicroUSDC as ProtocolMicroUSDC } from "@0xhoneyjar/loa-hounfour/economy"
import type { MicroUSDC as ReExportedMicroUSDC } from "../../src/hounfour/protocol-types.js"
import type { BrandedMicroUSD as MicroUSD } from "@0xhoneyjar/loa-hounfour"

// ---------------------------------------------------------------------------
// Compile-time type verification
// ---------------------------------------------------------------------------

describe("MicroUSDC brand migration — compile-time verification", () => {
  it("wire-boundary MicroUSDC is identical to protocol MicroUSDC", () => {
    // The re-exported type from wire-boundary.ts must be the protocol type
    expectTypeOf<MicroUSDC>().toMatchTypeOf<ProtocolMicroUSDC>()
    expectTypeOf<ProtocolMicroUSDC>().toMatchTypeOf<MicroUSDC>()
  })

  it("protocol-types.ts re-export is identical to protocol MicroUSDC", () => {
    expectTypeOf<ReExportedMicroUSDC>().toMatchTypeOf<ProtocolMicroUSDC>()
    expectTypeOf<ProtocolMicroUSDC>().toMatchTypeOf<ReExportedMicroUSDC>()
  })

  it("parseMicroUSDC returns protocol MicroUSDC", () => {
    expectTypeOf(parseMicroUSDC).returns.toMatchTypeOf<ProtocolMicroUSDC>()
  })

  it("convertMicroUSDtoMicroUSDC returns protocol MicroUSDC", () => {
    expectTypeOf(convertMicroUSDtoMicroUSDC).returns.toMatchTypeOf<ProtocolMicroUSDC>()
  })

  it("plain bigint is NOT assignable to MicroUSDC", () => {
    expectTypeOf<bigint>().not.toMatchTypeOf<MicroUSDC>()
  })

  it("MicroUSD is NOT assignable to MicroUSDC (different brands)", () => {
    expectTypeOf<MicroUSD>().not.toMatchTypeOf<MicroUSDC>()
  })
})

// ---------------------------------------------------------------------------
// Runtime: parseMicroUSDC uses protocol brand
// ---------------------------------------------------------------------------

describe("MicroUSDC brand migration — runtime verification", () => {
  it("parseMicroUSDC returns non-negative values", () => {
    const result = parseMicroUSDC("1000000")
    expect(result).toBe(1000000n)
  })

  it("parseMicroUSDC rejects negatives (on-chain amounts never negative)", () => {
    expect(() => parseMicroUSDC("-1")).toThrow(WireBoundaryError)
    expect(() => parseMicroUSDC("-1")).toThrow("negative values not allowed for on-chain amounts")
  })

  it("parseMicroUSDC accepts zero", () => {
    expect(parseMicroUSDC("0")).toBe(0n)
  })

  it("parseMicroUSDC normalizes leading zeros", () => {
    expect(parseMicroUSDC("007")).toBe(7n)
    expect(parseMicroUSDC("000")).toBe(0n)
  })

  it("parseMicroUSDC round-trip through serializeMicroUSDC", () => {
    const values = ["0", "1", "1000000", "999999999"]
    for (const v of values) {
      const parsed = parseMicroUSDC(v)
      const serialized = serializeMicroUSDC(parsed)
      const reparsed = parseMicroUSDC(serialized)
      expect(reparsed).toBe(parsed)
    }
  })

  it("convertMicroUSDtoMicroUSDC uses protocol branding", () => {
    const usd = parseMicroUSD("1000000") // $1.00
    const usdc = convertMicroUSDtoMicroUSDC(usd, 1.0, "ceil")
    expect(usdc).toBe(1000000n)
    // Verify it serializes correctly
    expect(serializeMicroUSDC(usdc)).toBe("1000000")
  })

  it("convertMicroUSDtoMicroUSDC rejects negative input", () => {
    const deficit = parseMicroUSD("-1000000")
    expect(() => convertMicroUSDtoMicroUSDC(deficit, 1.0, "ceil")).toThrow(WireBoundaryError)
    expect(() => convertMicroUSDtoMicroUSDC(deficit, 1.0, "ceil")).toThrow("negative MicroUSD not allowed")
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility: import paths
// ---------------------------------------------------------------------------

describe("MicroUSDC backward compatibility", () => {
  it("MicroUSDC importable from wire-boundary.ts", async () => {
    const mod = await import("../../src/hounfour/wire-boundary.js")
    expect(mod.parseMicroUSDC).toBeDefined()
    expect(mod.serializeMicroUSDC).toBeDefined()
    expect(mod.convertMicroUSDtoMicroUSDC).toBeDefined()
  })

  it("MicroUSDC importable from protocol-types.ts", async () => {
    const mod = await import("../../src/hounfour/protocol-types.js")
    expect(mod.readMicroUSDC).toBeDefined()
    expect(mod.microUSDC).toBeDefined()
  })
})
