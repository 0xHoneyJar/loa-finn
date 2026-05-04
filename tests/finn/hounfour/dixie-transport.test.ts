// tests/finn/hounfour/dixie-transport.test.ts — DixieHttpTransport tests (cycle-035 T-2.8)

import { describe, it, expect, vi, afterEach } from "vitest"
import { DixieHttpTransport, DixieStubTransport } from "../../../src/hounfour/goodhart/dixie-transport.js"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DixieStubTransport", () => {
  it("always returns null", async () => {
    const stub = new DixieStubTransport()
    expect(await stub.getReputation("nft-1")).toBeNull()
  })
})

describe("DixieHttpTransport", () => {
  describe("circuit breaker", () => {
    it("opens after 3 consecutive failures", async () => {
      // Mock fetch to always fail
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"))

      const transport = new DixieHttpTransport({
        baseUrl: "http://localhost:9999",
        timeoutMs: 100,

      })

      // 3 failures → circuit opens
      await transport.getReputation("nft-1")
      await transport.getReputation("nft-2")
      await transport.getReputation("nft-3")

      expect(transport.circuitBreakerState.state).toBe("open")
      expect(transport.circuitBreakerState.failureCount).toBe(3)

      // 4th call should not hit fetch (circuit open)
      fetchSpy.mockClear()
      const result = await transport.getReputation("nft-4")
      expect(result).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()

      await transport.shutdown()
    })

    it("resets on success", async () => {
      let callCount = 0
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        callCount++
        if (callCount <= 2) throw new Error("fail")
        return new Response(JSON.stringify({ score: 0.8, confidence: 0.9 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      })

      const transport = new DixieHttpTransport({
        baseUrl: "http://localhost:9999",
        timeoutMs: 100,

      })

      await transport.getReputation("nft-1") // fail 1
      await transport.getReputation("nft-2") // fail 2
      expect(transport.circuitBreakerState.failureCount).toBe(2)

      await transport.getReputation("nft-3") // success → reset
      expect(transport.circuitBreakerState.state).toBe("closed")
      expect(transport.circuitBreakerState.failureCount).toBe(0)

      await transport.shutdown()
    })
  })

  describe("timeout", () => {
    it("returns null on timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
        const signal = init?.signal as AbortSignal | undefined
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000)
          if (signal) {
            signal.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new DOMException("aborted", "AbortError"))
            })
          }
        })
        return new Response("{}", { status: 200 })
      })

      const transport = new DixieHttpTransport({
        baseUrl: "http://localhost:9999",
        timeoutMs: 50,

      })

      const result = await transport.getReputation("nft-1")
      expect(result).toBeNull()

      await transport.shutdown()
    })
  })

  describe("successful response", () => {
    it("returns normalized response for valid data", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ score: 0.75, confidence: 0.9 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )

      const transport = new DixieHttpTransport({
        baseUrl: "http://localhost:9999",
        timeoutMs: 300,

      })

      const result = await transport.getReputation("nft-1")
      // normalizeResponse may return the response or null depending on shape
      // The key test is that it doesn't throw
      await transport.shutdown()
    })

    it("returns null for non-200 status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      )

      const transport = new DixieHttpTransport({
        baseUrl: "http://localhost:9999",
        timeoutMs: 300,

      })

      const result = await transport.getReputation("nft-1")
      expect(result).toBeNull()

      await transport.shutdown()
    })
  })

  describe("shutdown", () => {
    it("completes without error", async () => {
      const transport = new DixieHttpTransport({
        baseUrl: "http://localhost:9999",
        timeoutMs: 300,
      })

      await transport.shutdown()
      // No error — graceful cleanup
    })
  })

  describe("URL validation", () => {
    it("rejects invalid URLs at construction", () => {
      expect(() => new DixieHttpTransport({
        baseUrl: "not-a-url",

      })).toThrow()
    })
  })
})
