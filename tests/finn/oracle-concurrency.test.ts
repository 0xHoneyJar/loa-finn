// tests/finn/oracle-concurrency.test.ts — Concurrency limiter tests (Sprint 3 Task 3.7)

import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { ConcurrencyLimiter, oracleConcurrencyMiddleware } from "../../src/gateway/oracle-concurrency.js"

describe("ConcurrencyLimiter", () => {
  it("should allow requests under capacity", () => {
    const limiter = new ConcurrencyLimiter(3)
    expect(limiter.acquire()).toBe(true)
    expect(limiter.getActive()).toBe(1)
  })

  it("should deny requests at capacity", () => {
    const limiter = new ConcurrencyLimiter(2)
    expect(limiter.acquire()).toBe(true)
    expect(limiter.acquire()).toBe(true)
    expect(limiter.acquire()).toBe(false)
    expect(limiter.getActive()).toBe(2)
  })

  it("should release slots correctly", () => {
    const limiter = new ConcurrencyLimiter(1)
    expect(limiter.acquire()).toBe(true)
    expect(limiter.acquire()).toBe(false)
    limiter.release()
    expect(limiter.getActive()).toBe(0)
    expect(limiter.acquire()).toBe(true)
  })

  it("should not go below zero on extra release", () => {
    const limiter = new ConcurrencyLimiter(3)
    limiter.release()
    limiter.release()
    expect(limiter.getActive()).toBe(0)
  })

  it("should handle full acquire/release cycle", () => {
    const limiter = new ConcurrencyLimiter(3)
    limiter.acquire()
    limiter.acquire()
    limiter.acquire()
    expect(limiter.acquire()).toBe(false)
    limiter.release()
    expect(limiter.acquire()).toBe(true)
    expect(limiter.getActive()).toBe(3)
  })
})

describe("oracleConcurrencyMiddleware", () => {
  it("should pass through when under capacity", async () => {
    const limiter = new ConcurrencyLimiter(3)
    const app = new Hono()
    app.use("*", oracleConcurrencyMiddleware(limiter))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(200)
    // Limiter should have released after handler completes
    expect(limiter.getActive()).toBe(0)
  })

  it("should return 429 with Retry-After when at capacity", async () => {
    const limiter = new ConcurrencyLimiter(0) // no capacity
    const app = new Hono()
    app.use("*", oracleConcurrencyMiddleware(limiter))
    app.post("/", (c) => c.json({ ok: true }))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("5")
    const body = await res.json()
    expect(body.code).toBe("ORACLE_CONCURRENCY_EXCEEDED")
  })

  it("should release slot even if handler throws", async () => {
    const limiter = new ConcurrencyLimiter(1)
    const app = new Hono()
    app.use("*", oracleConcurrencyMiddleware(limiter))
    app.post("/", () => {
      throw new Error("boom")
    })
    app.onError((err, c) => c.json({ error: err.message }, 500))

    const res = await app.request("/", { method: "POST" })
    expect(res.status).toBe(500)
    expect(limiter.getActive()).toBe(0)
  })
})
