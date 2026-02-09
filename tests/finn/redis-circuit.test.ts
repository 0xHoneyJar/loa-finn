// tests/finn/redis-circuit.test.ts — RedisCircuitBreaker tests (T-2.8)

import { describe, it, expect, vi, beforeEach } from "vitest"
import { RedisCircuitBreaker, DEFAULT_CIRCUIT_CONFIG } from "../../src/hounfour/redis/circuit.js"
import type { CircuitEntry } from "../../src/hounfour/redis/circuit.js"
import type { RedisStateBackend } from "../../src/hounfour/redis/client.js"

// --- Mock Redis ---

function mockRedis(connected = true) {
  const store = new Map<string, string>()
  const published: Array<{ channel: string; message: string }> = []
  const subscriptions = new Map<string, Function>()

  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number) => {
      store.set(key, value)
      return "OK"
    }),
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message })
      // Deliver to local subscriber
      const handler = subscriptions.get(channel)
      if (handler) handler(channel, message)
      return 1
    }),
  }

  const subscriber = {
    subscribe: vi.fn(async (channel: string) => {
      return 1
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (event === "message") {
        // Store handler so publish can deliver
        for (const [, fn] of subscriptions) { /* clear */ }
      }
    }),
  }

  const backend = {
    isConnected: vi.fn(() => connected),
    key: vi.fn((...parts: string[]) => `finn:hounfour:${parts.join(":")}`),
    getClient: vi.fn(() => client),
    getSubscriber: vi.fn(() => subscriber),
  } as unknown as RedisStateBackend

  return { backend, client, subscriber, store, published }
}

// --- Tests ---

describe("RedisCircuitBreaker", () => {
  describe("initial state", () => {
    it("returns healthy for unknown provider/model", () => {
      const cb = new RedisCircuitBreaker(null)
      expect(cb.isHealthy("openai", "gpt-4")).toBe(true)
    })

    it("returns closed state for unknown key", () => {
      const cb = new RedisCircuitBreaker(null)
      const state = cb.getState("openai", "gpt-4")
      expect(state.state).toBe("closed")
      expect(state.failure_count).toBe(0)
      expect(state.consecutive_failures).toBe(0)
    })
  })

  describe("state transitions", () => {
    it("stays closed on success", async () => {
      const cb = new RedisCircuitBreaker(null)
      await cb.recordSuccess("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("closed")
    })

    it("stays closed below failure threshold", async () => {
      const cb = new RedisCircuitBreaker(null, { failureThreshold: 5 })
      for (let i = 0; i < 4; i++) {
        await cb.recordFailure("openai", "gpt-4")
      }
      const state = cb.getState("openai", "gpt-4")
      expect(state.state).toBe("closed")
      expect(state.consecutive_failures).toBe(4)
      expect(cb.isHealthy("openai", "gpt-4")).toBe(true)
    })

    it("opens circuit at failure threshold", async () => {
      const cb = new RedisCircuitBreaker(null, { failureThreshold: 3 })
      for (let i = 0; i < 3; i++) {
        await cb.recordFailure("openai", "gpt-4")
      }
      const state = cb.getState("openai", "gpt-4")
      expect(state.state).toBe("open")
      expect(state.recovery_at).not.toBeNull()
      expect(cb.isHealthy("openai", "gpt-4")).toBe(false)
    })

    it("transitions open → half_open after recovery time", async () => {
      const cb = new RedisCircuitBreaker(null, {
        failureThreshold: 2,
        recoveryTimeMs: 100,
      })

      await cb.recordFailure("openai", "gpt-4")
      await cb.recordFailure("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("open")
      expect(cb.isHealthy("openai", "gpt-4")).toBe(false)

      // Fast-forward recovery time
      const entry = cb.getState("openai", "gpt-4")
      entry.recovery_at = new Date(Date.now() - 1).toISOString()

      expect(cb.isHealthy("openai", "gpt-4")).toBe(true)
      expect(cb.getState("openai", "gpt-4").state).toBe("half_open")
    })

    it("transitions half_open → closed on success", async () => {
      const cb = new RedisCircuitBreaker(null, {
        failureThreshold: 2,
        recoveryTimeMs: 10,
      })

      await cb.recordFailure("openai", "gpt-4")
      await cb.recordFailure("openai", "gpt-4")

      // Fast-forward
      const entry = cb.getState("openai", "gpt-4")
      entry.recovery_at = new Date(Date.now() - 1).toISOString()
      cb.isHealthy("openai", "gpt-4") // triggers transition to half_open

      await cb.recordSuccess("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("closed")
      expect(cb.getState("openai", "gpt-4").consecutive_failures).toBe(0)
    })

    it("reopens on failure during half_open", async () => {
      const cb = new RedisCircuitBreaker(null, {
        failureThreshold: 1,
        recoveryTimeMs: 10,
      })

      await cb.recordFailure("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("open")

      // Fast-forward to half_open
      const entry = cb.getState("openai", "gpt-4")
      entry.recovery_at = new Date(Date.now() - 1).toISOString()
      cb.isHealthy("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("half_open")

      await cb.recordFailure("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("open")
    })

    it("resets consecutive failures on success", async () => {
      const cb = new RedisCircuitBreaker(null, { failureThreshold: 5 })
      await cb.recordFailure("openai", "gpt-4")
      await cb.recordFailure("openai", "gpt-4")
      await cb.recordSuccess("openai", "gpt-4")

      const state = cb.getState("openai", "gpt-4")
      expect(state.consecutive_failures).toBe(0)
      expect(state.failure_count).toBe(2) // Total failures preserved
    })
  })

  describe("version tracking", () => {
    it("increments version on each state change", async () => {
      const cb = new RedisCircuitBreaker(null)
      const v0 = cb.getState("openai", "gpt-4").version

      await cb.recordFailure("openai", "gpt-4")
      const v1 = cb.getState("openai", "gpt-4").version
      expect(v1).toBe(v0 + 1)

      await cb.recordSuccess("openai", "gpt-4")
      const v2 = cb.getState("openai", "gpt-4").version
      expect(v2).toBe(v1 + 1)
    })
  })

  describe("Redis persistence", () => {
    it("persists state to Redis on state change", async () => {
      const { backend, client } = mockRedis()
      const cb = new RedisCircuitBreaker(backend, { failureThreshold: 2 })

      await cb.recordFailure("openai", "gpt-4")
      await cb.recordFailure("openai", "gpt-4") // Opens circuit

      expect(client.set).toHaveBeenCalled()
      const lastCall = client.set.mock.calls[client.set.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1]) as CircuitEntry
      expect(stored.state).toBe("open")
    })

    it("broadcasts state changes via Pub/Sub", async () => {
      const { backend, published } = mockRedis()
      const cb = new RedisCircuitBreaker(backend, { failureThreshold: 1 })

      await cb.recordFailure("openai", "gpt-4") // Opens → broadcast

      expect(published.length).toBeGreaterThan(0)
      const msg = JSON.parse(published[published.length - 1].message)
      expect(msg.entry.state).toBe("open")
    })

    it("does not broadcast on non-state-change events", async () => {
      const { backend, published } = mockRedis()
      const cb = new RedisCircuitBreaker(backend, { failureThreshold: 5 })

      await cb.recordFailure("openai", "gpt-4") // Still closed, no state change

      // Should persist but not broadcast
      expect(published.length).toBe(0)
    })

    it("continues working when Redis is unavailable", async () => {
      const { backend } = mockRedis(false)
      const cb = new RedisCircuitBreaker(backend, { failureThreshold: 2 })

      // Should not throw
      await cb.recordFailure("openai", "gpt-4")
      await cb.recordFailure("openai", "gpt-4")

      expect(cb.getState("openai", "gpt-4").state).toBe("open")
    })

    it("handles Redis errors gracefully during persist", async () => {
      const { backend, client } = mockRedis()
      client.set.mockRejectedValue(new Error("Redis timeout"))

      const cb = new RedisCircuitBreaker(backend, { failureThreshold: 1 })
      // Should not throw
      await cb.recordFailure("openai", "gpt-4")
      expect(cb.getState("openai", "gpt-4").state).toBe("open")
    })
  })

  describe("cross-replica sync", () => {
    it("subscribe() sets up Pub/Sub listener", async () => {
      const { backend, subscriber } = mockRedis()
      const cb = new RedisCircuitBreaker(backend)

      await cb.subscribe()

      expect(subscriber.subscribe).toHaveBeenCalledWith(DEFAULT_CIRCUIT_CONFIG.pubsubChannel)
      expect(subscriber.on).toHaveBeenCalledWith("message", expect.any(Function))
    })

    it("subscribe() is idempotent", async () => {
      const { backend, subscriber } = mockRedis()
      const cb = new RedisCircuitBreaker(backend)

      await cb.subscribe()
      await cb.subscribe()

      expect(subscriber.subscribe).toHaveBeenCalledOnce()
    })

    it("subscribe() skips when Redis unavailable", async () => {
      const { backend, subscriber } = mockRedis(false)
      const cb = new RedisCircuitBreaker(backend)

      await cb.subscribe()

      expect(subscriber.subscribe).not.toHaveBeenCalled()
    })
  })

  describe("isolation", () => {
    it("tracks separate circuits per provider/model", async () => {
      const cb = new RedisCircuitBreaker(null, { failureThreshold: 2 })

      await cb.recordFailure("openai", "gpt-4")
      await cb.recordFailure("openai", "gpt-4")

      await cb.recordFailure("anthropic", "claude-3")

      expect(cb.getState("openai", "gpt-4").state).toBe("open")
      expect(cb.getState("anthropic", "claude-3").state).toBe("closed")
      expect(cb.getState("anthropic", "claude-3").consecutive_failures).toBe(1)
    })
  })

  describe("loadFromRedis", () => {
    it("returns 0 when Redis unavailable", async () => {
      const cb = new RedisCircuitBreaker(null)
      const count = await cb.loadFromRedis()
      expect(count).toBe(0)
    })
  })
})
