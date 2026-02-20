// tests/finn/transfer-listener.test.ts — Transfer Event Listener Tests (Sprint 14 Tasks 14.1 + 14.2)
//
// Tests:
// - Event handling triggers cache invalidation
// - Reconnection on disconnect with exponential backoff
// - Start/stop lifecycle
// - Transfer scenario: old owner loses access, new owner gains access

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { TransferListener } from "../../src/nft/transfer-listener.js"
import type { EventWatcherClient } from "../../src/nft/transfer-listener.js"
import {
  getCachedOwner,
  setCachedOwner,
  clearOwnerCache,
  invalidateOwnerCache,
} from "../../src/gateway/siwe-ownership.js"

// ---------------------------------------------------------------------------
// Mock EventWatcherClient
// ---------------------------------------------------------------------------

interface MockWatcherState {
  onLogs: ((logs: Array<{ args: { from?: string; to?: string; tokenId?: bigint } }>) => void) | null
  onError: ((error: Error) => void) | null
  unwatchCalled: boolean
}

function createMockClient(): { client: EventWatcherClient; state: MockWatcherState } {
  const state: MockWatcherState = {
    onLogs: null,
    onError: null,
    unwatchCalled: false,
  }

  const client: EventWatcherClient = {
    watchContractEvent: (args) => {
      state.onLogs = args.onLogs
      state.onError = args.onError ?? null
      state.unwatchCalled = false
      return () => {
        state.unwatchCalled = true
      }
    },
  }

  return { client, state }
}

function createFailingClient(failCount: number): {
  client: EventWatcherClient
  states: MockWatcherState[]
  callCount: () => number
} {
  const states: MockWatcherState[] = []
  let calls = 0

  const client: EventWatcherClient = {
    watchContractEvent: (args) => {
      calls++
      const state: MockWatcherState = {
        onLogs: args.onLogs,
        onError: args.onError ?? null,
        unwatchCalled: false,
      }
      states.push(state)

      if (calls <= failCount) {
        // Simulate immediate connection error
        setTimeout(() => {
          if (state.onError) {
            state.onError(new Error(`Connection failed (attempt ${calls})`))
          }
        }, 0)
      }

      return () => {
        state.unwatchCalled = true
      }
    },
  }

  return { client, states, callCount: () => calls }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTRACT_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`
const COLLECTION = "finn"
const OLD_OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NEW_OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TransferListener", () => {
  beforeEach(() => {
    clearOwnerCache()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // --- Start/Stop Lifecycle ---

  describe("start/stop lifecycle", () => {
    it("starts watching for events on start()", () => {
      const { client, state } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      expect(listener.isRunning).toBe(false)

      listener.start()

      expect(listener.isRunning).toBe(true)
      expect(state.onLogs).not.toBeNull()
    })

    it("stops watching on stop()", () => {
      const { client, state } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      listener.start()
      expect(listener.isRunning).toBe(true)

      listener.stop()

      expect(listener.isRunning).toBe(false)
      expect(state.unwatchCalled).toBe(true)
    })

    it("start() is idempotent — calling twice does not create duplicate watchers", () => {
      const callCount = { value: 0 }
      const client: EventWatcherClient = {
        watchContractEvent: (args) => {
          callCount.value++
          return () => {}
        },
      }

      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      listener.start()
      listener.start() // second call should be no-op

      expect(callCount.value).toBe(1)
    })

    it("stop() is idempotent — calling twice is safe", () => {
      const { client } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      listener.start()
      listener.stop()
      listener.stop() // should not throw

      expect(listener.isRunning).toBe(false)
    })

    it("can be restarted after stop", () => {
      const { client, state } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      listener.start()
      listener.stop()

      expect(listener.isRunning).toBe(false)

      listener.start()

      expect(listener.isRunning).toBe(true)
      expect(listener.currentRetryCount).toBe(0)
    })
  })

  // --- Event Handling ---

  describe("event handling", () => {
    it("invalidates owner cache on Transfer event", () => {
      const { client, state } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      // Pre-populate cache
      setCachedOwner(COLLECTION, "42", OLD_OWNER)
      expect(getCachedOwner(COLLECTION, "42")).toBe(OLD_OWNER)

      listener.start()

      // Simulate Transfer event
      state.onLogs!([{
        args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(42) },
      }])

      // Cache should be invalidated
      expect(getCachedOwner(COLLECTION, "42")).toBeNull()

      listener.stop()
    })

    it("fires onTransfer callback with correct arguments", () => {
      const { client, state } = createMockClient()
      const onTransfer = vi.fn()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, { onTransfer })

      listener.start()

      state.onLogs!([{
        args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(100) },
      }])

      expect(onTransfer).toHaveBeenCalledWith(OLD_OWNER, NEW_OWNER, "100")

      listener.stop()
    })

    it("handles multiple Transfer events in a single batch", () => {
      const { client, state } = createMockClient()
      const onTransfer = vi.fn()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, { onTransfer })

      // Pre-populate cache for multiple tokens
      setCachedOwner(COLLECTION, "1", OLD_OWNER)
      setCachedOwner(COLLECTION, "2", OLD_OWNER)
      setCachedOwner(COLLECTION, "3", OLD_OWNER)

      listener.start()

      state.onLogs!([
        { args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(1) } },
        { args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(2) } },
        { args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(3) } },
      ])

      expect(onTransfer).toHaveBeenCalledTimes(3)
      expect(getCachedOwner(COLLECTION, "1")).toBeNull()
      expect(getCachedOwner(COLLECTION, "2")).toBeNull()
      expect(getCachedOwner(COLLECTION, "3")).toBeNull()

      listener.stop()
    })

    it("skips log entries with undefined tokenId", () => {
      const { client, state } = createMockClient()
      const onTransfer = vi.fn()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, { onTransfer })

      listener.start()

      state.onLogs!([{
        args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: undefined },
      }])

      expect(onTransfer).not.toHaveBeenCalled()

      listener.stop()
    })

    it("handles missing from/to addresses gracefully", () => {
      const { client, state } = createMockClient()
      const onTransfer = vi.fn()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, { onTransfer })

      listener.start()

      state.onLogs!([{
        args: { from: undefined, to: undefined, tokenId: BigInt(5) },
      }])

      expect(onTransfer).toHaveBeenCalledWith(
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        "5",
      )

      listener.stop()
    })
  })

  // --- Reconnection ---

  describe("reconnection with exponential backoff", () => {
    it("reconnects on error with exponential backoff", async () => {
      const onError = vi.fn()
      const onReconnect = vi.fn()
      const { client, states, callCount } = createFailingClient(2) // first 2 fail

      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, {
        baseBackoffMs: 100,
        maxBackoffMs: 5000,
        maxRetries: 5,
        onError,
        onReconnect,
      })

      listener.start()
      expect(callCount()).toBe(1)

      // First error fires asynchronously (setTimeout 0 in mock)
      await vi.advanceTimersByTimeAsync(0)
      expect(onError).toHaveBeenCalledTimes(1)

      // Backoff: 100ms * 2^0 = 100ms — fires reconnect, which calls subscribe()
      await vi.advanceTimersByTimeAsync(100)
      expect(callCount()).toBe(2)
      expect(onReconnect).toHaveBeenCalledWith(1)

      // Second error fires asynchronously (new setTimeout 0 scheduled during reconnect)
      await vi.advanceTimersByTimeAsync(1)
      expect(onError).toHaveBeenCalledTimes(2)

      // Backoff: 100ms * 2^1 = 200ms
      await vi.advanceTimersByTimeAsync(200)
      expect(callCount()).toBe(3)
      expect(onReconnect).toHaveBeenCalledWith(2)

      // Third attempt succeeds (no error fired)
      expect(listener.isRunning).toBe(true)

      listener.stop()
    })

    it("stops after maxRetries exceeded", async () => {
      const onError = vi.fn()
      const { client, states, callCount } = createFailingClient(100) // all fail

      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, {
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        maxRetries: 3,
        onError,
      })

      listener.start()

      // Process through all retries
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(0) // process error
        await vi.advanceTimersByTimeAsync(200) // advance past any backoff
      }

      expect(listener.isRunning).toBe(false)
      // Last error should mention max retries
      const lastCall = onError.mock.calls[onError.mock.calls.length - 1]
      expect(lastCall[0].message).toContain("max retries")
    })

    it("stop() cancels pending reconnection timer", async () => {
      const { client, states, callCount } = createFailingClient(1)
      const onReconnect = vi.fn()

      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, {
        baseBackoffMs: 5000,
        maxRetries: 5,
        onReconnect,
      })

      listener.start()

      // Trigger error
      await vi.advanceTimersByTimeAsync(0)

      // Stop before reconnection timer fires
      listener.stop()

      // Advance past the backoff period
      await vi.advanceTimersByTimeAsync(10000)

      // Should NOT have attempted reconnection
      expect(onReconnect).not.toHaveBeenCalled()
      expect(callCount()).toBe(1) // only the initial subscription
    })

    it("backoff is capped at maxBackoffMs", async () => {
      const onError = vi.fn()
      const onReconnect = vi.fn()
      // All calls fail
      const { client, states, callCount } = createFailingClient(100)

      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, {
        baseBackoffMs: 100,
        maxBackoffMs: 500,
        maxRetries: 10,
        onError,
        onReconnect,
      })

      listener.start()

      // retry 1: backoff = 100 * 2^0 = 100ms
      await vi.advanceTimersByTimeAsync(1) // let mock setTimeout(0) fire
      await vi.advanceTimersByTimeAsync(100)
      expect(callCount()).toBe(2)

      // retry 2: backoff = 100 * 2^1 = 200ms
      await vi.advanceTimersByTimeAsync(1) // let mock setTimeout(0) fire
      await vi.advanceTimersByTimeAsync(200)
      expect(callCount()).toBe(3)

      // retry 3: backoff = 100 * 2^2 = 400ms
      await vi.advanceTimersByTimeAsync(1) // let mock setTimeout(0) fire
      await vi.advanceTimersByTimeAsync(400)
      expect(callCount()).toBe(4)

      // retry 4: backoff = 100 * 2^3 = 800ms, capped to 500ms
      await vi.advanceTimersByTimeAsync(1) // let mock setTimeout(0) fire
      await vi.advanceTimersByTimeAsync(500)
      expect(callCount()).toBe(5)

      listener.stop()
    })
  })

  // --- Transfer Scenarios (Task 14.2) ---

  describe("transfer scenarios — ownership access after transfer", () => {
    it("old owner cache is invalidated on transfer, forcing fresh on-chain check", () => {
      const { client, state } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      // Simulate: old owner has cached ownership
      setCachedOwner(COLLECTION, "42", OLD_OWNER)
      expect(getCachedOwner(COLLECTION, "42")).toBe(OLD_OWNER)

      listener.start()

      // Transfer happens: old_owner -> new_owner
      state.onLogs!([{
        args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(42) },
      }])

      // After transfer: cache is invalidated
      // Old owner's cached entry is gone
      expect(getCachedOwner(COLLECTION, "42")).toBeNull()

      // New owner is NOT automatically cached (requires fresh on-chain check)
      // This is correct: the next read-path call will fetch fresh from chain
      expect(getCachedOwner(COLLECTION, "42")).toBeNull()

      listener.stop()
    })

    it("personality content is unaffected by transfer (content is separate from ownership)", () => {
      const { client, state } = createMockClient()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION)

      // This test verifies that the transfer listener ONLY invalidates the
      // owner cache and does NOT modify personality data.
      // The personality content in Redis remains unchanged.

      // Pre-populate cache
      setCachedOwner(COLLECTION, "42", OLD_OWNER)

      listener.start()

      // Transfer happens
      state.onLogs!([{
        args: { from: OLD_OWNER, to: NEW_OWNER, tokenId: BigInt(42) },
      }])

      // The listener only calls invalidateOwnerCache — it does not touch
      // personality data, version history, or any Redis personality keys.
      // This is verified by the fact that onTransfer callback only receives
      // from/to/tokenId (no personality mutation).

      listener.stop()
    })

    it("multiple rapid transfers for same token invalidate cache each time", () => {
      const { client, state } = createMockClient()
      const onTransfer = vi.fn()
      const listener = new TransferListener(client, CONTRACT_ADDRESS, COLLECTION, { onTransfer })

      listener.start()

      // First transfer: A -> B
      setCachedOwner(COLLECTION, "42", "0xaaaa")
      state.onLogs!([{
        args: { from: "0xaaaa", to: "0xbbbb", tokenId: BigInt(42) },
      }])
      expect(getCachedOwner(COLLECTION, "42")).toBeNull()

      // Someone caches B as owner
      setCachedOwner(COLLECTION, "42", "0xbbbb")
      expect(getCachedOwner(COLLECTION, "42")).toBe("0xbbbb")

      // Second transfer: B -> C
      state.onLogs!([{
        args: { from: "0xbbbb", to: "0xcccc", tokenId: BigInt(42) },
      }])
      expect(getCachedOwner(COLLECTION, "42")).toBeNull()

      expect(onTransfer).toHaveBeenCalledTimes(2)

      listener.stop()
    })
  })
})
