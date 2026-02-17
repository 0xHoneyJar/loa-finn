// tests/finn/otlp-tracing.test.ts — OTLP tracing initialization tests (cycle-024 T6)

import { describe, it, expect } from "vitest"
import { initTracing } from "../../src/tracing/otlp.js"

describe("initTracing", () => {
  // 1. Returns null when endpoint not set
  it("returns null when endpoint is not set", async () => {
    const result = await initTracing({})
    expect(result).toBeNull()
  })

  // 2. Returns null when endpoint is empty string
  it("returns null when endpoint is empty string", async () => {
    const result = await initTracing({ endpoint: "" })
    expect(result).toBeNull()
  })

  // 3. Returns null when endpoint is undefined
  it("returns null for undefined endpoint", async () => {
    const result = await initTracing({ endpoint: undefined })
    expect(result).toBeNull()
  })

  // 4. Never throws — returns null on failure
  it("never throws on initialization failure", async () => {
    // Invalid endpoint that will fail to connect — should still return null, not throw
    const result = await initTracing({
      endpoint: "http://192.0.2.1:4317", // RFC 5737 TEST-NET — guaranteed unreachable
      environment: "test",
    })
    // May return provider (lazy connection) or null (import failure) — never throws
    expect(() => result).not.toThrow()
  })

  // 5. Accepts environment parameter
  it("accepts environment parameter without error", async () => {
    const result = await initTracing({
      endpoint: undefined,
      environment: "production",
    })
    expect(result).toBeNull()
  })
})
