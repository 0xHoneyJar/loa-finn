// tests/x402/pricing.test.ts — Pricing Tests (Sprint 2 T2.9)

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { getRequestCost, resetPricingCache } from "../../src/x402/pricing.js"

describe("getRequestCost", () => {
  beforeEach(() => {
    resetPricingCache()
  })

  afterEach(() => {
    delete process.env.X402_REQUEST_COST_MICRO
    resetPricingCache()
  })

  it("returns default cost when env var not set", () => {
    delete process.env.X402_REQUEST_COST_MICRO
    const cost = getRequestCost("0x1", "claude-opus-4-6", 4096)
    expect(cost).toBe("100000")
  })

  it("reads cost from X402_REQUEST_COST_MICRO env var", () => {
    process.env.X402_REQUEST_COST_MICRO = "500000"
    const cost = getRequestCost("0x1", "claude-opus-4-6", 4096)
    expect(cost).toBe("500000")
  })

  it("returns string for BigInt compatibility", () => {
    const cost = getRequestCost("0x1", "claude-opus-4-6", 4096)
    expect(typeof cost).toBe("string")
    expect(BigInt(cost)).toBeGreaterThan(0n)
  })

  it("ignores model/tokenId/maxTokens in v1 (flat fee)", () => {
    const a = getRequestCost("0x1", "claude-opus-4-6", 4096)
    const b = getRequestCost("0x2", "claude-haiku-4-5", 8192)
    expect(a).toBe(b)
  })

  it("throws on invalid env var (non-numeric)", () => {
    process.env.X402_REQUEST_COST_MICRO = "not-a-number"
    expect(() => getRequestCost("0x1", "claude-opus-4-6", 4096)).toThrow(
      "X402_REQUEST_COST_MICRO must be a positive integer",
    )
  })

  it("throws on zero cost", () => {
    process.env.X402_REQUEST_COST_MICRO = "0"
    expect(() => getRequestCost("0x1", "claude-opus-4-6", 4096)).toThrow(
      "X402_REQUEST_COST_MICRO must be a positive integer",
    )
  })

  it("throws on negative cost", () => {
    process.env.X402_REQUEST_COST_MICRO = "-100"
    expect(() => getRequestCost("0x1", "claude-opus-4-6", 4096)).toThrow(
      "X402_REQUEST_COST_MICRO must be a positive integer",
    )
  })

  it("caches the loaded value (reads env once)", () => {
    process.env.X402_REQUEST_COST_MICRO = "250000"
    const first = getRequestCost("0x1", "claude-opus-4-6", 4096)
    process.env.X402_REQUEST_COST_MICRO = "999999"
    const second = getRequestCost("0x1", "claude-opus-4-6", 4096)
    expect(first).toBe(second) // cached
    expect(first).toBe("250000")
  })
})
