// tests/finn/ws-broadcast.test.ts — WebSocket event broadcast tests (TASK-3.7)

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
  EventBroadcaster,
  BROADCAST_EVENTS,
  type BroadcastClient,
  type BroadcastMessage,
} from "../../src/gateway/ws-broadcast.js"

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

/** Creates a mock client that records sent messages. */
function mockClient(): BroadcastClient & { messages: string[] } {
  const messages: string[] = []
  return { messages, send(data: string) { messages.push(data) } }
}

async function main() {
  console.log("WebSocket Broadcast Tests (TASK-3.7)")
  console.log("=====================================")

  // ── 1. Client management ──────────────────────────────

  console.log("\n--- Client Management ---")

  await test("addClient / removeClient / getClientCount", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    const c1 = mockClient()
    const c2 = mockClient()

    assert.equal(broadcaster.getClientCount(), 0)
    broadcaster.addClient(c1)
    assert.equal(broadcaster.getClientCount(), 1)
    broadcaster.addClient(c2)
    assert.equal(broadcaster.getClientCount(), 2)
    broadcaster.removeClient(c1)
    assert.equal(broadcaster.getClientCount(), 1)
    broadcaster.removeClient(c2)
    assert.equal(broadcaster.getClientCount(), 0)
  })

  // ── 2. Broadcast sends JSON to all clients ────────────

  console.log("\n--- Broadcasting ---")

  await test("broadcast sends JSON to all connected clients", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    broadcaster.start()

    const c1 = mockClient()
    const c2 = mockClient()
    broadcaster.addClient(c1)
    broadcaster.addClient(c2)

    emitter.emit("job:started", { jobId: "j1" })

    assert.equal(c1.messages.length, 1)
    assert.equal(c2.messages.length, 1)
    assert.equal(c1.messages[0], c2.messages[0])
    broadcaster.stop()
  })

  await test("multi-client broadcast: 3 clients receive same event", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    broadcaster.start()

    const clients = [mockClient(), mockClient(), mockClient()]
    for (const c of clients) broadcaster.addClient(c)

    emitter.emit("alert", { level: "high" })

    for (const c of clients) {
      assert.equal(c.messages.length, 1)
      const msg: BroadcastMessage = JSON.parse(c.messages[0])
      assert.equal(msg.type, "alert")
    }
    broadcaster.stop()
  })

  // ── 3. Client error during send ───────────────────────

  console.log("\n--- Error Handling ---")

  await test("client error during send removes client from set", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    broadcaster.start()

    const good = mockClient()
    const bad: BroadcastClient = {
      send() { throw new Error("connection reset") },
    }
    broadcaster.addClient(good)
    broadcaster.addClient(bad)
    assert.equal(broadcaster.getClientCount(), 2)

    emitter.emit("job:failed", { reason: "timeout" })

    // Bad client removed, good client still present
    assert.equal(broadcaster.getClientCount(), 1)
    assert.equal(good.messages.length, 1)
  })

  // ── 4. start() subscribes to all BROADCAST_EVENTS ────

  console.log("\n--- Lifecycle ---")

  await test("start() subscribes to all BROADCAST_EVENTS", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    const client = mockClient()
    broadcaster.addClient(client)

    broadcaster.start()

    for (const event of BROADCAST_EVENTS) {
      emitter.emit(event, { event })
    }

    assert.equal(client.messages.length, BROADCAST_EVENTS.length)
    for (let i = 0; i < BROADCAST_EVENTS.length; i++) {
      const msg: BroadcastMessage = JSON.parse(client.messages[i])
      assert.equal(msg.type, BROADCAST_EVENTS[i])
    }
    broadcaster.stop()
  })

  // ── 5. stop() unsubscribes and clears clients ────────

  await test("stop() unsubscribes and clears clients", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    const client = mockClient()
    broadcaster.addClient(client)
    broadcaster.start()

    // Emit one event to confirm subscription works
    emitter.emit("job:completed", { ok: true })
    assert.equal(client.messages.length, 1)

    broadcaster.stop()
    assert.equal(broadcaster.getClientCount(), 0)

    // Events after stop() should not reach any client
    emitter.emit("job:completed", { ok: true })
    assert.equal(client.messages.length, 1, "no new messages after stop()")
  })

  // ── 6. Event from source reaches all clients ─────────

  console.log("\n--- Integration ---")

  await test("event from source emitter reaches all clients", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    broadcaster.start()

    const c1 = mockClient()
    const c2 = mockClient()
    broadcaster.addClient(c1)
    broadcaster.addClient(c2)

    emitter.emit("kill-switch", { reason: "manual" })

    assert.equal(c1.messages.length, 1)
    assert.equal(c2.messages.length, 1)

    const m1: BroadcastMessage = JSON.parse(c1.messages[0])
    const m2: BroadcastMessage = JSON.parse(c2.messages[0])
    assert.equal(m1.type, "kill-switch")
    assert.deepEqual(m1.data, { reason: "manual" })
    assert.equal(m2.type, "kill-switch")
    assert.deepEqual(m2.data, { reason: "manual" })
    broadcaster.stop()
  })

  // ── 7. Message format ────────────────────────────────

  await test("message format includes type, timestamp, data", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    broadcaster.start()

    const client = mockClient()
    broadcaster.addClient(client)

    const payload = { id: "run-42", status: "ok" }
    emitter.emit("job:completed", payload)

    const msg: BroadcastMessage = JSON.parse(client.messages[0])
    assert.equal(msg.type, "job:completed")
    assert.equal(typeof msg.timestamp, "string")
    // Verify timestamp is a valid ISO date
    assert.ok(!isNaN(Date.parse(msg.timestamp)), "timestamp should be valid ISO date")
    assert.deepEqual(msg.data, payload)
    broadcaster.stop()
  })

  // ── 8. No delivery before start() ───────────────────

  await test("no delivery before start() is called", () => {
    const emitter = new EventEmitter()
    const broadcaster = new EventBroadcaster(emitter)
    const client = mockClient()
    broadcaster.addClient(client)

    emitter.emit("job:started", { jobId: "j1" })
    assert.equal(client.messages.length, 0, "should not receive events before start()")

    broadcaster.start()
    emitter.emit("job:started", { jobId: "j1" })
    assert.equal(client.messages.length, 1, "should receive events after start()")
    broadcaster.stop()
  })

  console.log("\nDone.")
}

main()
