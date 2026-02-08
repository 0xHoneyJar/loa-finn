// tests/finn/activity-handler.test.ts — Handler integration tests (Sprint Task 1.6)
// Tests HTTP contract: auth, status codes, query param validation, error handling.

import assert from "node:assert/strict"
import { Hono } from "hono"
import { createActivityHandler } from "../../src/dashboard/activity-handler.js"
import type { ActivityFeed, ActivityFeedQuery, ActivityFeedResult } from "../../src/dashboard/activity-feed.js"

// ── Test Harness ────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++
      console.log(`  \u2713 ${name}`)
    })
    .catch((err) => {
      failed++
      console.error(`  \u2717 ${name}`)
      console.error(`    ${err.message}`)
    })
}

// ── Mock Factories ──────────────────────────────────────────

const AUTH_TOKEN = "test-secret-token-1234567890abcdef"

function makeApp(feed: ActivityFeed | undefined, bearerToken?: string) {
  const app = new Hono()

  // Simulate auth middleware (same logic as gateway/auth.ts)
  const token = bearerToken ?? AUTH_TOKEN
  app.use("/api/*", async (c, next) => {
    if (!token) return next()
    const authHeader = c.req.header("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, 401)
    }
    const provided = authHeader.slice(7)
    if (provided !== token) {
      return c.json({ error: "Unauthorized", code: "AUTH_INVALID" }, 401)
    }
    return next()
  })

  app.get("/api/dashboard/activity", createActivityHandler(feed))
  return app
}

function makeMockFeed(overrides?: {
  items?: Array<{ type: string; created_at: string; repo: string }>
  throws?: boolean
}): ActivityFeed {
  const mockResult: ActivityFeedResult = {
    items: (overrides?.items ?? [
      {
        type: "pr_review" as const,
        repo: "owner/repo1",
        target: { number: 1, title: "Test PR", url: "https://github.com/owner/repo1/pull/1", is_pr: true },
        verdict: "COMMENTED",
        preview: "Test preview",
        body: "Test body",
        created_at: "2026-02-01T00:00:00Z",
        url: "https://github.com/owner/repo1/pull/1#r1",
        has_marker: true,
      },
    ]) as ActivityFeedResult["items"],
    total: overrides?.items?.length ?? 1,
    repos: ["owner/repo1"],
    bot_username: "test-bot",
    generated_at: new Date().toISOString(),
    cached: false,
    cache_expires_at: new Date(Date.now() + 300000).toISOString(),
  }

  return {
    getActivity: async (_query: ActivityFeedQuery) => {
      if (overrides?.throws) throw new Error("Feed error")
      return mockResult
    },
    getBotUsername: () => "test-bot",
  } as ActivityFeed
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` }
}

// ── Tests ───────────────────────────────────────────────────

console.log("=== Activity Handler Integration Tests ===")

await test("401 response when no Authorization header", async () => {
  const app = makeApp(makeMockFeed())
  const res = await app.request("/api/dashboard/activity")
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.code, "AUTH_REQUIRED")
})

await test("401 response when invalid token provided", async () => {
  const app = makeApp(makeMockFeed())
  const res = await app.request("/api/dashboard/activity", {
    headers: { Authorization: "Bearer wrong-token" },
  })
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.code, "AUTH_INVALID")
})

await test("503 response when feed is undefined (GITHUB_NOT_CONFIGURED)", async () => {
  const app = makeApp(undefined)
  const res = await app.request("/api/dashboard/activity", {
    headers: authHeaders(),
  })
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.code, "GITHUB_NOT_CONFIGURED")
})

await test("200 response with correct JSON shape when feed is defined and auth valid", async () => {
  const app = makeApp(makeMockFeed())
  const res = await app.request("/api/dashboard/activity", {
    headers: authHeaders(),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.items), "items should be array")
  assert.ok(typeof body.total === "number", "total should be number")
  assert.ok(Array.isArray(body.repos), "repos should be array")
  assert.ok(typeof body.bot_username === "string", "bot_username should be string")
  assert.ok(typeof body.generated_at === "string", "generated_at should be string")
  assert.ok(typeof body.cached === "boolean", "cached should be boolean")
})

await test("query param validation: invalid type is ignored (becomes undefined)", async () => {
  let capturedQuery: ActivityFeedQuery | undefined
  const feed = {
    getActivity: async (query: ActivityFeedQuery) => {
      capturedQuery = query
      return {
        items: [], total: 0, repos: [], bot_username: "test-bot",
        generated_at: new Date().toISOString(), cached: false, cache_expires_at: null,
      }
    },
    getBotUsername: () => "test-bot",
  } as ActivityFeed

  const app = makeApp(feed)
  await app.request("/api/dashboard/activity?type=invalid_type", {
    headers: authHeaders(),
  })

  assert.equal(capturedQuery?.type, undefined, "Invalid type should be ignored")
})

await test("query param validation: since is clamped to max 30 days ago", async () => {
  let capturedQuery: ActivityFeedQuery | undefined
  const feed = {
    getActivity: async (query: ActivityFeedQuery) => {
      capturedQuery = query
      return {
        items: [], total: 0, repos: [], bot_username: "test-bot",
        generated_at: new Date().toISOString(), cached: false, cache_expires_at: null,
      }
    },
    getBotUsername: () => "test-bot",
  } as ActivityFeed

  const app = makeApp(feed)
  // 60 days ago — should be clamped to 30 days
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  await app.request(`/api/dashboard/activity?since=${encodeURIComponent(sixtyDaysAgo)}`, {
    headers: authHeaders(),
  })

  assert.ok(capturedQuery?.since, "since should be defined")
  const sinceDate = new Date(capturedQuery!.since!)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  // Should be within 1 second of 30 days ago (clamped)
  const diff = Math.abs(sinceDate.getTime() - thirtyDaysAgo.getTime())
  assert.ok(diff < 2000, `since should be clamped to ~30 days ago, diff=${diff}ms`)
})

await test("query param validation: limit is capped at 500", async () => {
  let capturedQuery: ActivityFeedQuery | undefined
  const feed = {
    getActivity: async (query: ActivityFeedQuery) => {
      capturedQuery = query
      return {
        items: [], total: 0, repos: [], bot_username: "test-bot",
        generated_at: new Date().toISOString(), cached: false, cache_expires_at: null,
      }
    },
    getBotUsername: () => "test-bot",
  } as ActivityFeed

  const app = makeApp(feed)
  await app.request("/api/dashboard/activity?limit=9999", {
    headers: authHeaders(),
  })

  assert.equal(capturedQuery?.limit, 500, "Limit should be capped at 500")
})

await test("500 response when feed throws", async () => {
  const app = makeApp(makeMockFeed({ throws: true }))
  const res = await app.request("/api/dashboard/activity", {
    headers: authHeaders(),
  })
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.code, "ACTIVITY_FETCH_FAILED")
})

await test("since param correctly filters returned items", async () => {
  let capturedQuery: ActivityFeedQuery | undefined
  const feed = {
    getActivity: async (query: ActivityFeedQuery) => {
      capturedQuery = query
      return {
        items: [], total: 0, repos: [], bot_username: "test-bot",
        generated_at: new Date().toISOString(), cached: false, cache_expires_at: null,
      }
    },
    getBotUsername: () => "test-bot",
  } as ActivityFeed

  const app = makeApp(feed)
  const since = "2026-02-01T00:00:00Z"
  await app.request(`/api/dashboard/activity?since=${encodeURIComponent(since)}`, {
    headers: authHeaders(),
  })

  assert.ok(capturedQuery?.since, "since should be passed to feed")
  // Compare as timestamps since toISOString() normalizes milliseconds
  const capturedTime = new Date(capturedQuery!.since!).getTime()
  const expectedTime = new Date(since).getTime()
  assert.equal(capturedTime, expectedTime, "since values should represent the same time")
})

// ── Summary ─────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
