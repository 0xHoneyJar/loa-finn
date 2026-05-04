// tests/finn/hounfour/kill-switch-async.test.ts — KillSwitch async tests (cycle-035 T-1.7)

import { describe, it, expect, beforeEach, vi } from "vitest"
import { KillSwitch } from "../../../src/hounfour/goodhart/kill-switch.js"
import { RuntimeConfig } from "../../../src/hounfour/runtime-config.js"
import type { RedisCommandClient } from "../../../src/hounfour/redis/client.js"

function createMockRedis(store: Map<string, string> = new Map()): RedisCommandClient {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK" }),
    del: vi.fn(async () => 0),
    incrby: vi.fn(async () => 0),
    incrbyfloat: vi.fn(async () => "0"),
    expire: vi.fn(async () => 0),
    exists: vi.fn(async () => 0),
    ping: vi.fn(async () => "PONG"),
    eval: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    hincrby: vi.fn(async () => 0),
    zadd: vi.fn(async () => 0),
    zpopmin: vi.fn(async () => []),
    zremrangebyscore: vi.fn(async () => 0),
    zcard: vi.fn(async () => 0),
    publish: vi.fn(async () => 0),
    quit: vi.fn(async () => "OK"),
  }
}

describe("KillSwitch (async)", () => {
  beforeEach(() => {
    delete process.env.FINN_REPUTATION_ROUTING
  })

  describe("with RuntimeConfig", () => {
    it("isDisabled() returns true when mode is disabled", async () => {
      const store = new Map([["finn:config:reputation_routing", "disabled"]])
      const rc = new RuntimeConfig(createMockRedis(store))
      const ks = new KillSwitch(rc)

      expect(await ks.isDisabled()).toBe(true)
    })

    it("isDisabled() returns false for enabled/shadow", async () => {
      const store = new Map([["finn:config:reputation_routing", "enabled"]])
      const rc = new RuntimeConfig(createMockRedis(store))
      const ks = new KillSwitch(rc)

      expect(await ks.isDisabled()).toBe(false)
    })

    it("getState() returns current mode from RuntimeConfig", async () => {
      const store = new Map([["finn:config:reputation_routing", "shadow"]])
      const rc = new RuntimeConfig(createMockRedis(store))
      const ks = new KillSwitch(rc)

      expect(await ks.getState()).toBe("shadow")
    })

    it("reflects mode transitions", async () => {
      const store = new Map([["finn:config:reputation_routing", "shadow"]])
      const redis = createMockRedis(store)
      const rc = new RuntimeConfig(redis)
      const ks = new KillSwitch(rc)

      expect(await ks.getState()).toBe("shadow")

      await rc.setMode("enabled")
      expect(await ks.getState()).toBe("enabled")

      await rc.setMode("disabled")
      expect(await ks.isDisabled()).toBe(true)
    })
  })

  describe("without RuntimeConfig (backward compat)", () => {
    it("reads from env var directly", async () => {
      process.env.FINN_REPUTATION_ROUTING = "disabled"
      const ks = new KillSwitch()

      expect(await ks.isDisabled()).toBe(true)
      expect(await ks.getState()).toBe("disabled")
    })

    it("defaults to enabled when env var unset", async () => {
      const ks = new KillSwitch()

      expect(await ks.isDisabled()).toBe(false)
      expect(await ks.getState()).toBe("enabled")
    })
  })

  describe("logTransition()", () => {
    it("logs state changes", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      const ks = new KillSwitch()

      ks.logTransition("shadow", "enabled")

      expect(logSpy).toHaveBeenCalledOnce()
      const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
      expect(logged.from).toBe("shadow")
      expect(logged.to).toBe("enabled")
      logSpy.mockRestore()
    })

    it("does not log when state unchanged", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
      const ks = new KillSwitch()

      ks.logTransition("shadow", "shadow")

      expect(logSpy).not.toHaveBeenCalled()
      logSpy.mockRestore()
    })
  })

  describe("concurrent read during write (race condition safety)", () => {
    it("returns either old or new value, never partial state", async () => {
      const store = new Map([["finn:config:reputation_routing", "shadow"]])
      const redis = createMockRedis(store)
      const rc = new RuntimeConfig(redis)
      const ks = new KillSwitch(rc)

      // Concurrent reads + write
      const [state1, , state2] = await Promise.all([
        ks.getState(),
        rc.setMode("enabled"),
        ks.getState(),
      ])

      // Both must be valid states (shadow or enabled), never partial
      expect(["shadow", "enabled"]).toContain(state1)
      expect(["shadow", "enabled"]).toContain(state2)
    })
  })
})
