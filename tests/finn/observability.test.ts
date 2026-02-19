// tests/finn/observability.test.ts — Structured Logger Tests (Sprint 16 Task 16.2)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createIdentityLogger, type IdentityLogger } from "../../src/nft/logger.js"

describe("IdentityLogger", () => {
  let logger: IdentityLogger
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    logger = createIdentityLogger()
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  // ---------------------------------------------------------------------------
  // log()
  // ---------------------------------------------------------------------------

  describe("log()", () => {
    it("should output valid JSON to console.log", () => {
      logger.log("signal_build", "test-collection:42")

      expect(consoleSpy).toHaveBeenCalledOnce()
      const output = consoleSpy.mock.calls[0][0] as string
      const parsed = JSON.parse(output)

      expect(parsed).toBeDefined()
      expect(typeof parsed).toBe("object")
    })

    it("should include required fields: timestamp, operation, personality_id", () => {
      logger.log("dapm_derive", "col:99")

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.timestamp).toBeDefined()
      expect(typeof parsed.timestamp).toBe("string")
      expect(parsed.operation).toBe("dapm_derive")
      expect(parsed.personality_id).toBe("col:99")
    })

    it("should include latency_ms when provided", () => {
      logger.log("synthesis", "col:1", undefined, 142)

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.latency_ms).toBe(142)
    })

    it("should omit latency_ms when not provided", () => {
      logger.log("graph_resolve", "col:2")

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.latency_ms).toBeUndefined()
    })

    it("should include metadata when provided", () => {
      logger.log("version_create", "col:3", { version_id: "abc123", authored_by: "0xdead" })

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.version_id).toBe("abc123")
      expect(parsed.authored_by).toBe("0xdead")
    })

    it("should produce valid ISO timestamp", () => {
      logger.log("ownership_check", "col:4")

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)
      const date = new Date(parsed.timestamp)

      expect(date.getTime()).not.toBeNaN()
    })

    it("should support all defined operation types", () => {
      const operations = [
        "signal_build", "dapm_derive", "graph_resolve",
        "synthesis", "version_create", "ownership_check",
      ] as const

      for (const op of operations) {
        consoleSpy.mockClear()
        logger.log(op, "test:1")

        const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)
        expect(parsed.operation).toBe(op)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // logError()
  // ---------------------------------------------------------------------------

  describe("logError()", () => {
    it("should output valid JSON with error field", () => {
      logger.logError("synthesis", "col:5", new Error("LLM timeout"))

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.error).toBe("LLM timeout")
      expect(parsed.error_name).toBe("Error")
      expect(parsed.operation).toBe("synthesis")
      expect(parsed.personality_id).toBe("col:5")
    })

    it("should handle string errors", () => {
      logger.logError("dapm_derive", "col:6", "something broke")

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.error).toBe("something broke")
      expect(parsed.error_name).toBeUndefined()
    })

    it("should include metadata alongside error", () => {
      logger.logError("graph_resolve", "col:7", new Error("not found"), { graph_version: "v2" })

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.error).toBe("not found")
      expect(parsed.graph_version).toBe("v2")
    })

    it("should include timestamp on error entries", () => {
      logger.logError("ownership_check", "col:8", new Error("denied"))

      const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)

      expect(parsed.timestamp).toBeDefined()
      expect(new Date(parsed.timestamp).getTime()).not.toBeNaN()
    })
  })
})
