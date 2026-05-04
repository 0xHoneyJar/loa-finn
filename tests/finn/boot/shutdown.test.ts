// tests/finn/boot/shutdown.test.ts — GracefulShutdown tests (cycle-035 T-1.9)

import { describe, it, expect, vi, afterEach } from "vitest"
import { GracefulShutdown } from "../../../src/boot/shutdown.js"
import type { ShutdownTarget } from "../../../src/boot/shutdown.js"

// Stub process.exit to prevent test runner from exiting
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never)

afterEach(() => {
  vi.restoreAllMocks()
  // Re-stub after restore since other tests need it
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never)
})

describe("GracefulShutdown", () => {
  describe("basic shutdown", () => {
    it("calls all targets on execute", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      const fn1 = vi.fn(async () => {})
      const fn2 = vi.fn(async () => {})

      gs.register({ name: "redis", shutdown: fn1 })
      gs.register({ name: "dynamo", shutdown: fn2 })

      await gs.execute("SIGTERM")

      expect(fn1).toHaveBeenCalledOnce()
      expect(fn2).toHaveBeenCalledOnce()
    })

    it("calls process.exit(0) on success", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      gs.register({ name: "test", shutdown: async () => {} })
      await gs.execute("SIGTERM")

      expect(exitSpy).toHaveBeenCalledWith(0)
    })

    it("is idempotent — second execute is no-op", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      const fn = vi.fn(async () => {})
      gs.register({ name: "test", shutdown: fn })

      await gs.execute("SIGTERM")
      await gs.execute("SIGINT")

      expect(fn).toHaveBeenCalledOnce()
    })

    it("sets isShuttingDown flag", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      expect(gs.isShuttingDown).toBe(false)

      gs.register({ name: "test", shutdown: async () => {} })
      await gs.execute("SIGTERM")

      expect(gs.isShuttingDown).toBe(true)
    })
  })

  describe("priority ordering", () => {
    it("executes lower priority first", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })
      const order: string[] = []

      gs.register({
        name: "flush-audit",
        shutdown: async () => { order.push("audit") },
        priority: 200,
      })
      gs.register({
        name: "stop-server",
        shutdown: async () => { order.push("server") },
        priority: 10,
      })
      gs.register({
        name: "close-redis",
        shutdown: async () => { order.push("redis") },
        priority: 100,
      })

      await gs.execute("SIGTERM")

      expect(order).toEqual(["server", "redis", "audit"])
    })

    it("runs same-priority targets in parallel", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })
      let concurrentCount = 0
      let maxConcurrent = 0

      const makeTarget = (name: string): ShutdownTarget => ({
        name,
        priority: 100,
        shutdown: async () => {
          concurrentCount++
          maxConcurrent = Math.max(maxConcurrent, concurrentCount)
          await new Promise(r => setTimeout(r, 50))
          concurrentCount--
        },
      })

      gs.register(makeTarget("a"))
      gs.register(makeTarget("b"))
      gs.register(makeTarget("c"))

      await gs.execute("SIGTERM")

      // All 3 should have been running concurrently
      expect(maxConcurrent).toBe(3)
    })

    it("defaults to priority 100 when not specified", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })
      const order: string[] = []

      gs.register({
        name: "explicit-50",
        shutdown: async () => { order.push("50") },
        priority: 50,
      })
      gs.register({
        name: "default",
        shutdown: async () => { order.push("default") },
        // No priority → 100
      })

      await gs.execute("SIGTERM")

      expect(order).toEqual(["50", "default"])
    })
  })

  describe("error handling", () => {
    it("continues shutdown if a target throws", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      const fn2 = vi.fn(async () => {})
      gs.register({
        name: "failing",
        shutdown: async () => { throw new Error("connection refused") },
        priority: 10,
      })
      gs.register({
        name: "healthy",
        shutdown: fn2,
        priority: 20,
      })

      await gs.execute("SIGTERM")

      // Second target still called despite first failing
      expect(fn2).toHaveBeenCalledOnce()
      // Error was logged
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("connection refused"),
      )
    })
  })

  describe("deadline", () => {
    it("uses custom deadline", () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ deadlineMs: 5000, log })

      gs.register({ name: "test", shutdown: async () => {} })

      // We can't easily test the actual timeout without real delays,
      // but we verify the option is accepted and logged
      gs.execute("SIGTERM")

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("deadline: 5000ms"),
      )
    })

    it("defaults to 25000ms deadline", () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      gs.register({ name: "test", shutdown: async () => {} })
      gs.execute("SIGTERM")

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("deadline: 25000ms"),
      )
    })
  })

  describe("logging", () => {
    it("logs signal, priority groups, and completion", async () => {
      const log = vi.fn()
      const gs = new GracefulShutdown({ log })

      gs.register({ name: "redis", shutdown: async () => {}, priority: 10 })
      gs.register({ name: "dynamo", shutdown: async () => {}, priority: 20 })

      await gs.execute("SIGTERM")

      const messages = log.mock.calls.map(c => c[0])
      expect(messages[0]).toContain("SIGTERM received")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining("priority 10: redis"),
          expect.stringContaining("priority 20: dynamo"),
          expect.stringContaining("complete in"),
        ]),
      )
    })
  })
})
