// tests/finn/redis-client.test.ts — RedisStateBackend tests (T-2.7)

import { describe, it, expect, vi } from "vitest"
import { RedisStateBackend, DEFAULT_REDIS_CONFIG } from "../../src/hounfour/redis/client.js"
import type { RedisConfig, RedisClientFactory, RedisCommandClient, RedisSubscriberClient } from "../../src/hounfour/redis/client.js"

// --- Mock Factory ---

interface MockClientHandlers {
  onConnect?: () => void
  onError?: () => void
  onClose?: () => void
}

function mockCommandClient(opts?: MockClientHandlers): RedisCommandClient & { on: any; _triggerEvent: (event: string) => void } {
  const handlers = new Map<string, Function[]>()
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    incrbyfloat: vi.fn(async () => "1.0"),
    expire: vi.fn(async () => 1),
    exists: vi.fn(async () => 0),
    ping: vi.fn(async () => "PONG"),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hincrby: vi.fn(async () => 1),
    zadd: vi.fn(async () => 1),
    zremrangebyscore: vi.fn(async () => 0),
    zcard: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    quit: vi.fn(async () => "OK"),
    on: vi.fn((event: string, handler: Function) => {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
    }),
    _triggerEvent(event: string) {
      const fns = handlers.get(event) ?? []
      for (const fn of fns) fn()
    },
  }
}

function mockSubscriberClient(): RedisSubscriberClient {
  return {
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
    on: vi.fn(),
    quit: vi.fn(async () => "OK"),
  }
}

function makeConfig(overrides?: Partial<RedisConfig>): RedisConfig {
  return {
    url: "redis://localhost:6379",
    ...DEFAULT_REDIS_CONFIG,
    ...overrides,
  }
}

function makeFactory(cmdClient?: ReturnType<typeof mockCommandClient>, subClient?: RedisSubscriberClient): RedisClientFactory {
  const cmd = cmdClient ?? mockCommandClient()
  const sub = subClient ?? mockSubscriberClient()
  return {
    createCommandClient: vi.fn(() => cmd),
    createSubscriberClient: vi.fn(() => sub),
  }
}

// --- Tests ---

describe("RedisStateBackend", () => {
  it("starts in connecting state", () => {
    const factory = makeFactory()
    const backend = new RedisStateBackend(makeConfig(), factory)
    expect(backend.state).toBe("connecting")
    expect(backend.isConnected()).toBe(false)
  })

  it("transitions to connected on successful connect", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 100 }), factory)

    // Start connect — will register event handlers and wait
    const connectPromise = backend.connect()

    // Simulate successful connection
    cmd._triggerEvent("connect")

    await connectPromise

    expect(backend.state).toBe("connected")
    expect(backend.isConnected()).toBe(true)
  })

  it("transitions to disconnected on connect timeout", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    // Don't trigger connect event — should timeout
    await backend.connect()

    expect(backend.state).toBe("disconnected")
    expect(backend.isConnected()).toBe(false)
  })

  it("transitions to disconnected on error event", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const connectPromise = backend.connect()
    cmd._triggerEvent("connect")
    await connectPromise

    expect(backend.isConnected()).toBe(true)

    // Simulate error
    cmd._triggerEvent("error")
    expect(backend.state).toBe("disconnected")
  })

  it("transitions to disconnected on close event", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const connectPromise = backend.connect()
    cmd._triggerEvent("connect")
    await connectPromise

    cmd._triggerEvent("close")
    expect(backend.state).toBe("disconnected")
  })

  it("transitions to connecting on reconnecting event", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const connectPromise = backend.connect()
    cmd._triggerEvent("connect")
    await connectPromise

    cmd._triggerEvent("close")
    expect(backend.state).toBe("disconnected")

    cmd._triggerEvent("reconnecting")
    expect(backend.state).toBe("connecting")
  })

  it("creates both command and subscriber clients", async () => {
    const factory = makeFactory()
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    await backend.connect()

    expect(factory.createCommandClient).toHaveBeenCalledOnce()
    expect(factory.createSubscriberClient).toHaveBeenCalledOnce()
  })

  it("key() applies prefix and component namespace", async () => {
    const factory = makeFactory()
    const backend = new RedisStateBackend(makeConfig({ keyPrefix: "test:prefix" }), factory)

    expect(backend.key("circuit", "openai", "gpt-4")).toBe("test:prefix:circuit:openai:gpt-4")
    expect(backend.key("budget", "scope-key")).toBe("test:prefix:budget:scope-key")
  })

  it("getClient() throws before connect", () => {
    const factory = makeFactory()
    const backend = new RedisStateBackend(makeConfig(), factory)

    expect(() => backend.getClient()).toThrow("Redis not connected")
  })

  it("getClient() returns command client after connect", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    const client = backend.getClient()
    expect(client.ping).toBeDefined()
  })

  it("getSubscriber() throws before connect", () => {
    const factory = makeFactory()
    const backend = new RedisStateBackend(makeConfig(), factory)

    expect(() => backend.getSubscriber()).toThrow("Redis not connected")
  })

  it("getSubscriber() returns subscriber after connect", async () => {
    const cmd = mockCommandClient()
    const sub = mockSubscriberClient()
    const factory = makeFactory(cmd, sub)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    const subscriber = backend.getSubscriber()
    expect(subscriber.subscribe).toBeDefined()
  })

  it("ping() returns connected=true with latency when connected", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    const result = await backend.ping()
    expect(result.connected).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(cmd.ping).toHaveBeenCalledOnce()
  })

  it("ping() returns connected=false when disconnected", async () => {
    const factory = makeFactory()
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    await backend.connect()

    const result = await backend.ping()
    expect(result.connected).toBe(false)
  })

  it("ping() returns connected=false when ping throws", async () => {
    const cmd = mockCommandClient()
    cmd.ping = vi.fn(async () => { throw new Error("connection lost") })
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    const result = await backend.ping()
    expect(result.connected).toBe(false)
  })

  it("disconnect() quits both clients", async () => {
    const cmd = mockCommandClient()
    const sub = mockSubscriberClient()
    const factory = makeFactory(cmd, sub)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    await backend.disconnect()

    expect(cmd.quit).toHaveBeenCalledOnce()
    expect(sub.quit).toHaveBeenCalledOnce()
    expect(backend.state).toBe("disconnected")
    expect(backend.isConnected()).toBe(false)
  })

  it("disconnect() handles quit errors gracefully", async () => {
    const cmd = mockCommandClient()
    cmd.quit = vi.fn(async () => { throw new Error("already closed") })
    const sub = mockSubscriberClient()
    sub.quit = vi.fn(async () => { throw new Error("already closed") })
    const factory = makeFactory(cmd, sub)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    // Should not throw
    await backend.disconnect()
    expect(backend.state).toBe("disconnected")
  })

  it("waitUntilReady() resolves immediately when already connected", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 100 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    // Should resolve immediately
    await backend.waitUntilReady(50)
  })

  it("waitUntilReady() rejects on timeout", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 200 }), factory)

    // Start connect but don't trigger connect event
    backend.connect() // don't await

    await expect(backend.waitUntilReady(50)).rejects.toThrow("not ready within 50ms")
  })

  it("getClient()/getSubscriber() return null after disconnect", async () => {
    const cmd = mockCommandClient()
    const factory = makeFactory(cmd)
    const backend = new RedisStateBackend(makeConfig({ connectTimeoutMs: 50 }), factory)

    const p = backend.connect()
    cmd._triggerEvent("connect")
    await p

    await backend.disconnect()

    expect(() => backend.getClient()).toThrow("Redis not connected")
    expect(() => backend.getSubscriber()).toThrow("Redis not connected")
  })
})
