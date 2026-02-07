// tests/finn/bridgebuilder-github.test.ts — Unit tests for GitHubRestAdapter + ResilientHttpClient
// Uses mock IHttpClient to test without real GitHub API calls.

import assert from "node:assert/strict"
import type { IHttpClient, HttpRequest, HttpResponse } from "../../src/bridgebuilder/ports/http-client.js"
import { ResilientHttpClient } from "../../src/bridgebuilder/adapters/resilient-http.js"
import { GitHubRestAdapter } from "../../src/bridgebuilder/adapters/github-rest.js"

// ── Test helpers ────────────────────────────────────────────

interface MockCall {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}

function createMockHttp(responses: HttpResponse[]): { http: IHttpClient; calls: MockCall[] } {
  const calls: MockCall[] = []
  let idx = 0
  const http: IHttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: req.body })
      if (idx >= responses.length) throw new Error("No more mock responses")
      return responses[idx++]
    },
    getRateLimitRemaining() { return undefined },
  }
  return { http, calls }
}

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, body: JSON.stringify(body), headers, rateLimitRemaining: undefined }
}

// ── ResilientHttpClient tests ───────────────────────────────

console.log("=== ResilientHttpClient ===")

// Test: tracks X-RateLimit-Remaining header
{
  const delays: number[] = []
  const fakeSleep = async (ms: number) => { delays.push(ms) }

  const client = new ResilientHttpClient(
    { maxRetries: 3, baseDelayMs: 1000, rateLimitBuffer: 10, redactPatterns: [] },
    fakeSleep,
  )

  // Mock fetch
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("ok", {
    status: 200,
    headers: { "x-ratelimit-remaining": "42" },
  })

  const resp = await client.request({ url: "https://example.com", method: "GET" })
  assert.equal(resp.status, 200)
  assert.equal(resp.rateLimitRemaining, 42)
  assert.equal(client.getRateLimitRemaining(), 42)
  assert.equal(delays.length, 0, "No delays on first successful request")

  globalThis.fetch = origFetch
  console.log("  ✓ tracks X-RateLimit-Remaining")
}

// Test: throws when rate limit budget exhausted
{
  const client = new ResilientHttpClient(
    { maxRetries: 3, baseDelayMs: 1000, rateLimitBuffer: 10, redactPatterns: [] },
  )

  // Set remaining to within buffer
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("ok", {
    status: 200,
    headers: { "x-ratelimit-remaining": "5" },
  })
  await client.request({ url: "https://example.com", method: "GET" })
  globalThis.fetch = origFetch

  // Next request should throw
  await assert.rejects(
    () => client.request({ url: "https://example.com", method: "GET" }),
    /Rate limit budget exhausted/,
  )
  console.log("  ✓ throws on rate limit budget exhaustion")
}

// Test: retries on 5xx with exponential backoff
{
  const delays: number[] = []
  const fakeSleep = async (ms: number) => { delays.push(ms) }
  let callCount = 0

  const client = new ResilientHttpClient(
    { maxRetries: 3, baseDelayMs: 1000, rateLimitBuffer: 10, redactPatterns: [] },
    fakeSleep,
  )

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    callCount++
    if (callCount <= 2) {
      return new Response("server error", { status: 500 })
    }
    return new Response("ok", { status: 200 })
  }

  const resp = await client.request({ url: "https://example.com", method: "GET" })
  assert.equal(resp.status, 200)
  assert.equal(callCount, 3, "Should try 3 times (1 initial + 2 retries)")
  assert.deepStrictEqual(delays, [1000, 2000], "Exponential backoff: 1s, 2s")

  globalThis.fetch = origFetch
  console.log("  ✓ retries on 5xx with exponential backoff (injectable sleep)")
}

// Test: retries on network errors
{
  const delays: number[] = []
  const fakeSleep = async (ms: number) => { delays.push(ms) }
  let callCount = 0

  const client = new ResilientHttpClient(
    { maxRetries: 2, baseDelayMs: 500, rateLimitBuffer: 10, redactPatterns: [] },
    fakeSleep,
  )

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    callCount++
    if (callCount <= 2) throw new Error("ECONNRESET")
    return new Response("ok", { status: 200 })
  }

  const resp = await client.request({ url: "https://example.com", method: "GET" })
  assert.equal(resp.status, 200)
  assert.equal(callCount, 3)
  assert.deepStrictEqual(delays, [500, 1000])

  globalThis.fetch = origFetch
  console.log("  ✓ retries on network errors")
}

// Test: exhausts retries and returns 5xx response on final attempt
{
  const delays: number[] = []
  const fakeSleep = async (ms: number) => { delays.push(ms) }

  const client = new ResilientHttpClient(
    { maxRetries: 2, baseDelayMs: 100, rateLimitBuffer: 10, redactPatterns: [] },
    fakeSleep,
  )

  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("error", { status: 500 })

  const resp = await client.request({ url: "https://example.com", method: "GET" })
  assert.equal(resp.status, 500, "Returns 500 response after exhausting retries")
  assert.equal(delays.length, 2, "2 retry delays")

  globalThis.fetch = origFetch
  console.log("  ✓ returns 5xx response after exhausting retries")
}

// ── GitHubRestAdapter tests ─────────────────────────────────

console.log("\n=== GitHubRestAdapter ===")

// Test: Authorization header uses Bearer token
{
  const { http, calls } = createMockHttp([
    jsonResp(200, []),
  ])
  const adapter = new GitHubRestAdapter(http, "test-token-123")
  await adapter.listOpenPRs("owner", "repo")

  assert.ok(calls[0].headers?.["Authorization"]?.includes("Bearer test-token-123"))
  assert.ok(calls[0].headers?.["X-GitHub-Api-Version"] === "2022-11-28")
  console.log("  ✓ sends Bearer token and API version header")
}

// Test: listOpenPRs maps response correctly
{
  const { http } = createMockHttp([
    jsonResp(200, [
      {
        number: 42,
        title: "Add feature",
        head: { sha: "abc123def456" },
        base: { ref: "main" },
        labels: [{ name: "enhancement" }],
        user: { login: "dev1" },
      },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const prs = await adapter.listOpenPRs("owner", "repo")

  assert.equal(prs.length, 1)
  assert.equal(prs[0].number, 42)
  assert.equal(prs[0].title, "Add feature")
  assert.equal(prs[0].headSha, "abc123def456")
  assert.equal(prs[0].baseBranch, "main")
  assert.deepStrictEqual(prs[0].labels, ["enhancement"])
  assert.equal(prs[0].author, "dev1")
  console.log("  ✓ listOpenPRs maps response correctly")
}

// Test: pagination — multi-page with Link headers
{
  const { http, calls } = createMockHttp([
    jsonResp(200, [
      { number: 1, title: "PR 1", head: { sha: "aaa" }, base: { ref: "main" }, labels: [], user: { login: "a" } },
    ], { link: '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next"' }),
    jsonResp(200, [
      { number: 2, title: "PR 2", head: { sha: "bbb" }, base: { ref: "main" }, labels: [], user: { login: "b" } },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const prs = await adapter.listOpenPRs("o", "r")

  assert.equal(prs.length, 2)
  assert.equal(prs[0].number, 1)
  assert.equal(prs[1].number, 2)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].url.includes("page=2"), "Followed next page link")
  console.log("  ✓ pagination follows Link headers")
}

// Test: pagination terminates when no Link header
{
  const { http, calls } = createMockHttp([
    jsonResp(200, [{ number: 1, title: "PR", head: { sha: "x" }, base: { ref: "main" }, labels: [], user: { login: "u" } }]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const prs = await adapter.listOpenPRs("o", "r")

  assert.equal(prs.length, 1)
  assert.equal(calls.length, 1, "No additional requests when no Link header")
  console.log("  ✓ pagination stops when no Link header")
}

// Test: getPRFiles with pagination
{
  const { http } = createMockHttp([
    jsonResp(200, [
      { filename: "a.ts", status: "added", additions: 10, deletions: 0, patch: "+code" },
    ], { link: '<https://api.github.com/next>; rel="next"' }),
    jsonResp(200, [
      { filename: "b.ts", status: "modified", additions: 5, deletions: 3, patch: "-old\n+new" },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const files = await adapter.getPRFiles("o", "r", 1)

  assert.equal(files.length, 2)
  assert.equal(files[0].filename, "a.ts")
  assert.equal(files[1].status, "modified")
  console.log("  ✓ getPRFiles paginates correctly")
}

// Test: getPRReviews maps to PRReview type
{
  const { http } = createMockHttp([
    jsonResp(200, [
      { id: 100, body: "Looks good", user: { login: "reviewer1" }, state: "COMMENTED", submitted_at: "2026-01-01T00:00:00Z" },
      { id: 101, body: "Fix this <!-- finn-review: abc123 -->", user: { login: "bot" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z" },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const reviews = await adapter.getPRReviews("o", "r", 1)

  assert.equal(reviews.length, 2)
  assert.equal(reviews[0].id, 100)
  assert.equal(reviews[0].user, "reviewer1")
  assert.equal(reviews[0].state, "COMMENTED")
  assert.equal(reviews[1].submittedAt, "2026-01-02T00:00:00Z")
  console.log("  ✓ getPRReviews maps to PRReview type")
}

// Test: hasExistingReview detects idempotency marker
{
  const { http } = createMockHttp([
    jsonResp(200, [
      { id: 1, body: "Review content <!-- finn-review: sha123 -->", user: { login: "bot" }, state: "COMMENTED", submitted_at: "2026-01-01" },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")

  assert.equal(await adapter.hasExistingReview("o", "r", 1, "sha123"), true)
  console.log("  ✓ detects existing idempotency marker")
}

// Test: hasExistingReview returns false when no marker
{
  const { http } = createMockHttp([
    jsonResp(200, [
      { id: 1, body: "Just a normal review", user: { login: "human" }, state: "COMMENTED", submitted_at: "2026-01-01" },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")

  assert.equal(await adapter.hasExistingReview("o", "r", 1, "sha999"), false)
  console.log("  ✓ returns false when marker not found")
}

// Test: hasExistingReview with different sha
{
  const { http } = createMockHttp([
    jsonResp(200, [
      { id: 1, body: "<!-- finn-review: sha111 -->", user: { login: "bot" }, state: "COMMENTED", submitted_at: "2026-01-01" },
    ]),
  ])
  const adapter = new GitHubRestAdapter(http, "token")

  assert.equal(await adapter.hasExistingReview("o", "r", 1, "sha222"), false, "Different sha should not match")
  console.log("  ✓ marker sha mismatch returns false")
}

// Test: postReview sends correct payload
{
  const { http, calls } = createMockHttp([
    jsonResp(201, { id: 99 }),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const result = await adapter.postReview({
    owner: "o", repo: "r", prNumber: 42, headSha: "abc",
    body: "Review body", event: "COMMENT",
  })

  assert.equal(result, true)
  const payload = JSON.parse(calls[0].body!)
  assert.equal(payload.commit_id, "abc")
  assert.equal(payload.body, "Review body")
  assert.equal(payload.event, "COMMENT")
  console.log("  ✓ postReview sends correct payload")
}

// Test: postReview returns false on 422
{
  const { http } = createMockHttp([
    jsonResp(422, { message: "Validation failed" }),
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const result = await adapter.postReview({
    owner: "o", repo: "r", prNumber: 42, headSha: "abc",
    body: "body", event: "COMMENT",
  })

  assert.equal(result, false)
  console.log("  ✓ postReview returns false on 422")
}

// Test: postReview throws on 403
{
  const { http } = createMockHttp([
    jsonResp(403, { message: "Forbidden" }),
  ])
  const adapter = new GitHubRestAdapter(http, "token")

  await assert.rejects(
    () => adapter.postReview({
      owner: "o", repo: "r", prNumber: 42, headSha: "abc",
      body: "body", event: "COMMENT",
    }),
    /HTTP 403/,
  )
  console.log("  ✓ postReview throws on 403")
}

// Test: throws on 404 from listOpenPRs
{
  const { http } = createMockHttp([
    jsonResp(404, { message: "Not Found" }),
  ])
  const adapter = new GitHubRestAdapter(http, "token")

  await assert.rejects(
    () => adapter.listOpenPRs("o", "nonexistent"),
    /GitHub API error: HTTP 404/,
  )
  console.log("  ✓ throws on 404")
}

// Test: preflight returns rate limit and scopes
{
  const { http } = createMockHttp([
    {
      status: 200,
      body: JSON.stringify({ resources: { core: { remaining: 4500 } } }),
      headers: { "x-oauth-scopes": "repo, read:org" },
    },
  ])
  const adapter = new GitHubRestAdapter(http, "token")
  const result = await adapter.preflight()

  assert.equal(result.remaining, 4500)
  assert.deepStrictEqual(result.scopes, ["repo", "read:org"])
  console.log("  ✓ preflight returns rate limit and scopes")
}

// Test: preflight throws on non-200
{
  const { http } = createMockHttp([
    jsonResp(401, { message: "Bad credentials" }),
  ])
  const adapter = new GitHubRestAdapter(http, "token")

  await assert.rejects(
    () => adapter.preflight(),
    /GitHub preflight failed/,
  )
  console.log("  ✓ preflight throws on non-200")
}

console.log("\n✅ All bridgebuilder-github tests passed")
