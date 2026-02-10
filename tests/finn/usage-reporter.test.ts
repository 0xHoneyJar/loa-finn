// tests/finn/usage-reporter.test.ts — Usage Report Pipeline tests (T-A.7)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { generateKeyPair, exportPKCS8 } from "jose"
import { UsageReporter } from "../../src/hounfour/usage-reporter.js"
import { S2SJwtSigner } from "../../src/hounfour/s2s-jwt.js"
import type { UsageReport, UsageReporterConfig } from "../../src/hounfour/usage-reporter.js"
import type { RedisStateBackend, RedisCommandClient } from "../../src/hounfour/redis/client.js"

// --- Mock arrakis server ---

interface ArrakisState {
  reports: Map<string, unknown>
  failCount: number
  failsRemaining: number
}

function createMockArrakis(state: ArrakisState) {
  const app = new Hono()

  app.post("/internal/usage-reports", async (c) => {
    // Check auth header exists
    const auth = c.req.header("Authorization")
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    if (state.failsRemaining > 0) {
      state.failsRemaining--
      state.failCount++
      return c.json({ error: "Service unavailable" }, 503)
    }

    const body = await c.req.json<{ report_id: string; jws_payload: string }>()

    // Idempotency: duplicate report_id → 200
    if (state.reports.has(body.report_id)) {
      return c.json({ status: "duplicate", report_id: body.report_id })
    }

    state.reports.set(body.report_id, body)
    return c.json({ status: "accepted", report_id: body.report_id }, 201)
  })

  return app
}

// --- Mock Redis ---

function createMockRedis(connected = true): {
  redis: RedisStateBackend
  store: Map<string, Map<string, number>>
} {
  const store = new Map<string, Map<string, number>>()

  const mockClient: Partial<RedisCommandClient> = {
    zadd: async (key: string, score: number, member: string) => {
      if (!store.has(key)) store.set(key, new Map())
      store.get(key)!.set(member, score)
      return 1
    },
    zpopmin: async (key: string, count = 1) => {
      const zset = store.get(key)
      if (!zset || zset.size === 0) return []

      // Sort by score, take count items
      const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1])
      const result: string[] = []
      const toTake = Math.min(count, sorted.length)
      for (let i = 0; i < toTake; i++) {
        const [member, score] = sorted[i]
        result.push(member, String(score))
        zset.delete(member)
      }
      return result
    },
    zcard: async (key: string) => {
      return store.get(key)?.size ?? 0
    },
  }

  const redis = {
    isConnected: () => connected,
    key: (_component: string, ...parts: string[]) => `finn:hounfour:${_component}:${parts.join(":")}`,
    getClient: () => mockClient as RedisCommandClient,
  } as unknown as RedisStateBackend

  return { redis, store }
}

// --- Helpers ---

let arrakisServer: ReturnType<typeof serve> | null = null
let arrakisPort: number
let signer: S2SJwtSigner

async function startArrakis(state: ArrakisState): Promise<number> {
  const app = createMockArrakis(state)
  return new Promise((resolve) => {
    arrakisServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      arrakisPort = info.port
      resolve(info.port)
    })
  })
}

function makeReport(id: string): UsageReport {
  return {
    report_id: id,
    tenant_id: "community:thj",
    original_jti: "jti-abc",
    pool_id: "fast-code",
    model: "qwen3-coder-next",
    input_tokens: 1000,
    output_tokens: 500,
    cost_micro: 150,
    timestamp: new Date().toISOString(),
  }
}

describe("UsageReporter (T-A.7)", () => {
  beforeEach(async () => {
    const keyPair = await generateKeyPair("ES256", { extractable: true })
    const pem = await exportPKCS8(keyPair.privateKey)
    signer = new S2SJwtSigner({
      privateKeyPem: pem,
      kid: "test-v1",
      issuer: "loa-finn",
      audience: "arrakis",
    })
    await signer.init()
  })

  afterEach(() => {
    if (arrakisServer) {
      arrakisServer.close()
      arrakisServer = null
    }
  })

  it("delivers report successfully on first try", async () => {
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 0 }
    await startArrakis(state)

    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
      baseDelayMs: 10,
    })

    const result = await reporter.report(makeReport("report-1"))
    expect(result.delivered).toBe(true)
    expect(result.deadLettered).toBe(false)
    expect(state.reports.has("report-1")).toBe(true)

    reporter.destroy()
  })

  it("retries on 503 and succeeds", async () => {
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 2 }
    await startArrakis(state)

    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
      maxRetries: 3,
      baseDelayMs: 10, // fast for tests
    })

    const result = await reporter.report(makeReport("report-retry"))
    expect(result.delivered).toBe(true)
    expect(state.failCount).toBe(2)
    expect(state.reports.has("report-retry")).toBe(true)

    reporter.destroy()
  })

  it("dead-letters to Redis after all retries exhausted", async () => {
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 999 }
    await startArrakis(state)

    const { redis, store } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
      maxRetries: 2,
      baseDelayMs: 10,
    })

    const result = await reporter.report(makeReport("report-dead"))
    expect(result.delivered).toBe(false)
    expect(result.deadLettered).toBe(true)

    // Verify Redis ZSET has the report
    const dlKey = "finn:hounfour:usage-reports:dead-letter:"
    // Find the key that was created
    const keys = [...store.keys()]
    expect(keys.length).toBe(1)
    const zset = store.get(keys[0])!
    expect(zset.size).toBe(1)

    // Verify the serialized report is parseable
    const [serialized] = zset.keys()
    const parsed = JSON.parse(serialized)
    expect(parsed.report_id).toBe("report-dead")

    reporter.destroy()
  })

  it("falls back to JSONL file when Redis unavailable", async () => {
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 999 }
    await startArrakis(state)

    const { redis } = createMockRedis(false) // disconnected
    const tmpFile = `/tmp/test-dead-letter-${Date.now()}.jsonl`
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
      maxRetries: 1,
      baseDelayMs: 10,
      deadLetterFilePath: tmpFile,
    })

    const result = await reporter.report(makeReport("report-file"))
    expect(result.delivered).toBe(false)
    expect(result.deadLettered).toBe(true)

    // Verify file contains the report
    const { readFile } = await import("node:fs/promises")
    const content = await readFile(tmpFile, "utf-8")
    const parsed = JSON.parse(content.trim())
    expect(parsed.report_id).toBe("report-file")

    // Cleanup
    const { unlink } = await import("node:fs/promises")
    await unlink(tmpFile).catch(() => {})

    reporter.destroy()
  })

  it("includes S2S JWT auth header", async () => {
    let capturedAuth = ""
    const app = new Hono()
    app.post("/internal/usage-reports", async (c) => {
      capturedAuth = c.req.header("Authorization") ?? ""
      return c.json({ status: "accepted" }, 201)
    })

    const port = await new Promise<number>((resolve) => {
      arrakisServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })

    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${port}`,
    })

    await reporter.report(makeReport("report-auth"))
    expect(capturedAuth).toMatch(/^Bearer ey/)

    reporter.destroy()
  })

  it("sends JWS-signed payload", async () => {
    let capturedBody: any = null
    const app = new Hono()
    app.post("/internal/usage-reports", async (c) => {
      capturedBody = await c.req.json()
      return c.json({ status: "accepted" }, 201)
    })

    const port = await new Promise<number>((resolve) => {
      arrakisServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })

    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${port}`,
    })

    await reporter.report(makeReport("report-jws"))
    expect(capturedBody).toBeTruthy()
    expect(capturedBody.report_id).toBe("report-jws")
    // JWS compact format: header.payload.signature
    expect(capturedBody.jws_payload.split(".")).toHaveLength(3)

    reporter.destroy()
  })

  it("handles duplicate report_id (idempotency)", async () => {
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 0 }
    await startArrakis(state)

    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
    })

    // Send same report twice
    const r1 = await reporter.report(makeReport("report-dup"))
    const r2 = await reporter.report(makeReport("report-dup"))
    expect(r1.delivered).toBe(true)
    expect(r2.delivered).toBe(true)
    // Both succeed because arrakis returns 200 for duplicates

    reporter.destroy()
  })

  it("replays dead-lettered reports", async () => {
    // First, dead-letter some reports
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 999 }
    await startArrakis(state)

    const { redis, store } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
      maxRetries: 0,
      baseDelayMs: 10,
    })

    await reporter.report(makeReport("replay-1"))
    await reporter.report(makeReport("replay-2"))

    // Verify dead-lettered
    const keys = [...store.keys()]
    expect(keys.length).toBe(1)
    const zset = store.get(keys[0])!
    expect(zset.size).toBe(2)

    // Now make arrakis healthy
    state.failsRemaining = 0

    // Replay
    const result = await reporter.replayBatch()
    expect(result.replayed).toBe(2)
    expect(result.failed).toBe(0)
    expect(state.reports.has("replay-1")).toBe(true)
    expect(state.reports.has("replay-2")).toBe(true)

    // Dead-letter queue should be empty
    expect(zset.size).toBe(0)

    reporter.destroy()
  })

  it("re-dead-letters reports that fail during replay", async () => {
    const state: ArrakisState = { reports: new Map(), failCount: 0, failsRemaining: 999 }
    await startArrakis(state)

    const { redis, store } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${arrakisPort}`,
      maxRetries: 0,
      baseDelayMs: 10,
    })

    // Dead-letter a report
    await reporter.report(makeReport("re-dead"))

    // Replay while arrakis still down
    const result = await reporter.replayBatch()
    expect(result.failed).toBe(1)
    expect(result.replayed).toBe(0)

    // Report should be back in the queue
    const keys = [...store.keys()]
    const zset = store.get(keys[0])!
    expect(zset.size).toBe(1)

    reporter.destroy()
  })

  it("deadLetterSize returns queue length", async () => {
    const { redis, store } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: "http://unused",
    })

    // Manually add to mock store
    const key = redis.key("usage-reports:dead-letter")
    store.set(key, new Map([
      ['{"report_id":"a"}', 1],
      ['{"report_id":"b"}', 2],
      ['{"report_id":"c"}', 3],
    ]))

    const size = await reporter.deadLetterSize()
    expect(size).toBe(3)

    reporter.destroy()
  })

  it("deadLetterSize returns -1 when Redis unavailable", async () => {
    const { redis } = createMockRedis(false)
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: "http://unused",
    })

    const size = await reporter.deadLetterSize()
    expect(size).toBe(-1)

    reporter.destroy()
  })

  it("includes original_jti in report", async () => {
    let capturedBody: any = null
    const app = new Hono()
    app.post("/internal/usage-reports", async (c) => {
      capturedBody = await c.req.json()
      return c.json({ status: "accepted" }, 201)
    })

    const port = await new Promise<number>((resolve) => {
      arrakisServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    })

    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: `http://localhost:${port}`,
    })

    const report = makeReport("report-jti")
    report.original_jti = "user-jwt-jti-123"
    await reporter.report(report)

    // The JWS payload contains the original_jti
    // Decode JWS to verify (base64url decode the payload)
    const parts = capturedBody.jws_payload.split(".")
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
    expect(payload.original_jti).toBe("user-jwt-jti-123")

    reporter.destroy()
  })

  it("startReplay and stopReplay manage timer", async () => {
    const { redis } = createMockRedis()
    const reporter = new UsageReporter(signer, redis, {
      arrakisBaseUrl: "http://unused",
      replayIntervalMs: 60000,
    })

    reporter.startReplay()
    // Starting again should be a no-op
    reporter.startReplay()

    reporter.stopReplay()
    reporter.destroy()
  })
})
