// tests/finn/activity-feed.test.ts — Unit tests for ActivityFeed (Sprint Task 1.5)
// Uses mock IHttpClient — no real GitHub API calls.

import assert from "node:assert/strict"
import type { IHttpClient, HttpRequest, HttpResponse } from "../../src/bridgebuilder/ports/http-client.js"
import {
  ActivityFeed,
  type ActivityFeedConfig,
  type ActivityItem,
} from "../../src/dashboard/activity-feed.js"

// ── Test Helpers ────────────────────────────────────────────

interface MockCall {
  url: string
  method: string
}

function createMockHttp(
  handler: (req: HttpRequest) => HttpResponse,
): { http: IHttpClient; calls: MockCall[] } {
  const calls: MockCall[] = []
  const http: IHttpClient = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push({ url: req.url, method: req.method })
      return handler(req)
    },
    getRateLimitRemaining() {
      return undefined
    },
  }
  return { http, calls }
}

function jsonResp(status: number, body: unknown): HttpResponse {
  return {
    status,
    body: JSON.stringify(body),
    headers: {},
    rateLimitRemaining: undefined,
  }
}

function makeConfig(overrides?: Partial<ActivityFeedConfig>): ActivityFeedConfig {
  return {
    githubToken: "ghp_test123",
    repos: ["owner/repo1"],
    botUsername: "test-bot",
    cacheTtlMs: 300_000,
    minRefreshIntervalMs: 60_000,
    idempotencyMarkerPrefix: "<!-- finn-review: ",
    ...overrides,
  }
}

function makeReviewComment(login: string, prUrl: string, createdAt: string) {
  return {
    user: { login },
    pull_request_url: prUrl,
    created_at: createdAt,
  }
}

function makeReview(
  login: string,
  body: string,
  state: string,
  submittedAt: string,
  htmlUrl: string,
) {
  return {
    id: Math.floor(Math.random() * 10000),
    user: { login },
    body,
    state,
    submitted_at: submittedAt,
    html_url: htmlUrl,
  }
}

function makeIssueComment(
  login: string,
  body: string,
  createdAt: string,
  htmlUrl: string,
  issueUrl: string,
) {
  return {
    id: Math.floor(Math.random() * 10000),
    user: { login },
    body,
    created_at: createdAt,
    html_url: htmlUrl,
    issue_url: issueUrl,
  }
}

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

// ── Tests ───────────────────────────────────────────────────

console.log("=== ActivityFeed Unit Tests ===")

await test("getBotUsername returns config value", async () => {
  const { http } = createMockHttp(() => jsonResp(200, {}))
  const feed = new ActivityFeed(makeConfig({ botUsername: "my-bot" }), http)
  assert.equal(feed.getBotUsername(), "my-bot")
})

await test("discoverBotReviewedPRs: correct URL construction and bot filtering", async () => {
  const since = new Date("2026-01-01T00:00:00Z")
  const { http, calls } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      return jsonResp(200, [
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/42", "2026-01-15T00:00:00Z"),
        makeReviewComment("other-user", "https://api.github.com/repos/owner/repo1/pulls/43", "2026-01-15T00:00:00Z"),
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/42", "2026-01-16T00:00:00Z"),
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/44", "2026-01-17T00:00:00Z"),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)
  const prNumbers = await feed.discoverBotReviewedPRs("owner", "repo1", "test-bot", since)

  // Should have unique PR numbers, filtering out other-user
  assert.deepEqual(prNumbers.sort(), [42, 44])

  // Should have called pulls/comments with correct params
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes("pulls/comments"))
  assert.ok(calls[0].url.includes("since=2026-01-01"))
  assert.ok(calls[0].url.includes("per_page=100"))
})

await test("fetchRepoReviews: fetches only discovered PRs, filters by bot + since", async () => {
  const { http, calls } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      return jsonResp(200, [
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/10", "2026-01-15T00:00:00Z"),
      ])
    }
    if (req.url.includes("pulls/10/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "LGTM <!-- finn-review: abc -->", "COMMENTED", "2026-01-20T00:00:00Z", "https://github.com/owner/repo1/pull/10#review-1"),
        makeReview("other-user", "Also LGTM", "APPROVED", "2026-01-20T00:00:00Z", "https://github.com/owner/repo1/pull/10#review-2"),
        makeReview("test-bot", "Old review", "COMMENTED", "2025-12-01T00:00:00Z", "https://github.com/owner/repo1/pull/10#review-3"),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)
  const result = await feed.getActivity({})

  // Should only include the bot review that's after the since date
  const reviews = result.items.filter((i) => i.type === "pr_review")
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].verdict, "COMMENTED")
  assert.equal(reviews[0].has_marker, true)
  assert.equal(reviews[0].url, "https://github.com/owner/repo1/pull/10#review-1")
})

await test("fetchRepoIssueComments: bot filtering and has_marker computation", async () => {
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      return jsonResp(200, []) // no PR review activity
    }
    if (req.url.includes("issues/comments")) {
      return jsonResp(200, [
        makeIssueComment(
          "test-bot",
          "Hello <!-- finn-review: xyz -->",
          "2026-01-20T00:00:00Z",
          "https://github.com/owner/repo1/issues/5#issuecomment-1",
          "https://api.github.com/repos/owner/repo1/issues/5",
        ),
        makeIssueComment(
          "other-user",
          "Unrelated",
          "2026-01-20T00:00:00Z",
          "https://github.com/owner/repo1/issues/5#issuecomment-2",
          "https://api.github.com/repos/owner/repo1/issues/5",
        ),
        makeIssueComment(
          "test-bot",
          "No marker here",
          "2026-01-21T00:00:00Z",
          "https://github.com/owner/repo1/issues/6#issuecomment-3",
          "https://api.github.com/repos/owner/repo1/issues/6",
        ),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)
  const result = await feed.getActivity({})

  const comments = result.items.filter((i) => i.type === "issue_comment")
  assert.equal(comments.length, 2)
  assert.equal(comments[0].has_marker, false) // newer one first (reverse chrono)
  assert.equal(comments[1].has_marker, true)
})

await test("getActivity: cache hit on second call", async () => {
  let fetchCount = 0
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments") || req.url.includes("issues/comments")) {
      fetchCount++
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig({ cacheTtlMs: 60_000 }), http)

  await feed.getActivity({})
  const firstFetchCount = fetchCount

  await feed.getActivity({})
  // Second call should NOT trigger additional fetches (cache hit)
  assert.equal(fetchCount, firstFetchCount)
})

await test("cache expiry triggers re-fetch", async () => {
  let fetchCount = 0
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments") || req.url.includes("issues/comments")) {
      fetchCount++
    }
    return jsonResp(200, [])
  })

  // Very short TTL
  const feed = new ActivityFeed(makeConfig({ cacheTtlMs: 1 }), http)

  await feed.getActivity({})
  const firstFetchCount = fetchCount

  // Wait for cache to expire
  await new Promise((r) => setTimeout(r, 10))

  await feed.getActivity({})
  // Should have fetched again
  assert.ok(fetchCount > firstFetchCount, "Expected re-fetch after cache expiry")
})

await test("force refresh bypasses cache when cooldown passed", async () => {
  let fetchCount = 0
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments") || req.url.includes("issues/comments")) {
      fetchCount++
    }
    return jsonResp(200, [])
  })

  // Long cache TTL but short cooldown
  const feed = new ActivityFeed(
    makeConfig({ cacheTtlMs: 300_000, minRefreshIntervalMs: 1 }),
    http,
  )

  await feed.getActivity({})
  const firstFetchCount = fetchCount

  await new Promise((r) => setTimeout(r, 10))

  await feed.getActivity({ force_refresh: true })
  assert.ok(fetchCount > firstFetchCount, "Expected re-fetch on force_refresh")
})

await test("force refresh cooldown: returns cached when within cooldown", async () => {
  let fetchCount = 0
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments") || req.url.includes("issues/comments")) {
      fetchCount++
    }
    return jsonResp(200, [])
  })

  // Very long cooldown
  const feed = new ActivityFeed(
    makeConfig({ cacheTtlMs: 300_000, minRefreshIntervalMs: 999_999 }),
    http,
  )

  await feed.getActivity({})
  const firstFetchCount = fetchCount

  // Force refresh should be blocked by cooldown
  await feed.getActivity({ force_refresh: true })
  assert.equal(fetchCount, firstFetchCount, "Should not re-fetch during cooldown")
})

await test("post-cache filtering: repo filter", async () => {
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      if (req.url.includes("repo1")) {
        return jsonResp(200, [
          makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/1", "2026-01-15T00:00:00Z"),
        ])
      }
      if (req.url.includes("repo2")) {
        return jsonResp(200, [
          makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo2/pulls/2", "2026-01-15T00:00:00Z"),
        ])
      }
    }
    if (req.url.includes("pulls/1/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "Review 1", "COMMENTED", "2026-01-20T00:00:00Z", "https://github.com/owner/repo1/pull/1#r1"),
      ])
    }
    if (req.url.includes("pulls/2/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "Review 2", "APPROVED", "2026-01-21T00:00:00Z", "https://github.com/owner/repo2/pull/2#r2"),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(
    makeConfig({ repos: ["owner/repo1", "owner/repo2"] }),
    http,
  )

  const all = await feed.getActivity({})
  assert.equal(all.items.length, 2)

  const filtered = await feed.getActivity({ repo: "owner/repo1" })
  assert.equal(filtered.items.length, 1)
  assert.equal(filtered.items[0].repo, "owner/repo1")
})

await test("post-cache filtering: type filter", async () => {
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      return jsonResp(200, [
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/1", "2026-01-15T00:00:00Z"),
      ])
    }
    if (req.url.includes("pulls/1/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "Review", "COMMENTED", "2026-01-20T00:00:00Z", "https://github.com/owner/repo1/pull/1#r1"),
      ])
    }
    if (req.url.includes("issues/comments")) {
      return jsonResp(200, [
        makeIssueComment("test-bot", "Comment", "2026-01-20T00:00:00Z", "https://github.com/owner/repo1/issues/5#ic1", "https://api.github.com/repos/owner/repo1/issues/5"),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)

  const all = await feed.getActivity({})
  assert.equal(all.items.length, 2)

  const reviews = await feed.getActivity({ type: "pr_review" })
  assert.equal(reviews.items.length, 1)
  assert.equal(reviews.items[0].type, "pr_review")

  const comments = await feed.getActivity({ type: "issue_comment" })
  assert.equal(comments.items.length, 1)
  assert.equal(comments.items[0].type, "issue_comment")
})

await test("post-cache filtering: since sub-filter within cached window", async () => {
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      return jsonResp(200, [
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/1", "2026-01-10T00:00:00Z"),
      ])
    }
    if (req.url.includes("pulls/1/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "Old", "COMMENTED", "2026-01-10T00:00:00Z", "https://github.com/owner/repo1/pull/1#r1"),
        makeReview("test-bot", "New", "APPROVED", "2026-02-05T00:00:00Z", "https://github.com/owner/repo1/pull/1#r2"),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)

  const all = await feed.getActivity({})
  assert.equal(all.items.length, 2)

  // Filter to only items after Feb 1
  const recent = await feed.getActivity({ since: "2026-02-01T00:00:00Z" })
  assert.equal(recent.items.length, 1)
  assert.equal(recent.items[0].body, "New")
})

await test("post-cache filtering: limit", async () => {
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) return jsonResp(200, [])
    if (req.url.includes("issues/comments")) {
      const comments = []
      for (let i = 0; i < 10; i++) {
        comments.push(
          makeIssueComment(
            "test-bot",
            `Comment ${i}`,
            new Date(Date.now() - i * 3600000).toISOString(),
            `https://github.com/owner/repo1/issues/${i}#ic${i}`,
            `https://api.github.com/repos/owner/repo1/issues/${i}`,
          ),
        )
      }
      return jsonResp(200, comments)
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)

  const all = await feed.getActivity({})
  assert.equal(all.items.length, 10)

  const limited = await feed.getActivity({ limit: 3 })
  assert.equal(limited.items.length, 3)
  assert.equal(limited.total, 10) // total reflects unsliced count
})

await test("graceful degradation: single repo failure does not fail entire feed", async () => {
  let callCount = 0
  const { http } = createMockHttp((req) => {
    callCount++
    if (req.url.includes("repo-bad")) {
      throw new Error("Network error for bad repo")
    }
    if (req.url.includes("pulls/comments") && req.url.includes("repo-good")) {
      return jsonResp(200, [
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo-good/pulls/1", "2026-01-15T00:00:00Z"),
      ])
    }
    if (req.url.includes("pulls/1/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "Good review", "COMMENTED", "2026-01-20T00:00:00Z", "https://github.com/owner/repo-good/pull/1#r1"),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(
    makeConfig({ repos: ["owner/repo-good", "owner/repo-bad"] }),
    http,
  )

  // Should not throw — bad repo is skipped
  const result = await feed.getActivity({})
  assert.ok(result.items.length >= 1, "Should have items from good repo")
  assert.equal(result.items[0].repo, "owner/repo-good")
})

await test("deduplication: same URL from different sources produces single item", async () => {
  const sharedUrl = "https://github.com/owner/repo1/pull/1#r1"
  const { http } = createMockHttp((req) => {
    if (req.url.includes("pulls/comments")) {
      return jsonResp(200, [
        makeReviewComment("test-bot", "https://api.github.com/repos/owner/repo1/pulls/1", "2026-01-15T00:00:00Z"),
      ])
    }
    if (req.url.includes("pulls/1/reviews")) {
      return jsonResp(200, [
        makeReview("test-bot", "Review body", "COMMENTED", "2026-01-20T00:00:00Z", sharedUrl),
        // Duplicate with same URL
        makeReview("test-bot", "Review body copy", "COMMENTED", "2026-01-20T00:00:00Z", sharedUrl),
      ])
    }
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)
  const result = await feed.getActivity({})

  const withUrl = result.items.filter((i) => i.url === sharedUrl)
  assert.equal(withUrl.length, 1, "Duplicate URLs should be deduped")
})

await test("pagination: multi-page response aggregated correctly", async () => {
  let pagesRequested: number[] = []
  const { http } = createMockHttp((req) => {
    if (req.url.includes("issues/comments")) {
      const parsed = new URL(req.url)
      const page = parseInt(parsed.searchParams.get("page") ?? "1", 10)
      pagesRequested.push(page)

      if (page === 1) {
        // Return full page (100 items) to trigger pagination
        const items = Array.from({ length: 100 }, (_, i) =>
          makeIssueComment(
            "test-bot",
            `Comment page1-${i}`,
            "2026-01-20T00:00:00Z",
            `https://github.com/owner/repo1/issues/${i}#ic-p1-${i}`,
            `https://api.github.com/repos/owner/repo1/issues/${i}`,
          ),
        )
        return jsonResp(200, items)
      }
      if (page === 2) {
        // Return partial page (stop condition)
        const items = Array.from({ length: 5 }, (_, i) =>
          makeIssueComment(
            "test-bot",
            `Comment page2-${i}`,
            "2026-01-19T00:00:00Z",
            `https://github.com/owner/repo1/issues/${100 + i}#ic-p2-${i}`,
            `https://api.github.com/repos/owner/repo1/issues/${100 + i}`,
          ),
        )
        return jsonResp(200, items)
      }
      return jsonResp(200, [])
    }
    if (req.url.includes("pulls/comments")) return jsonResp(200, [])
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)
  const result = await feed.getActivity({})

  assert.ok(pagesRequested.includes(1), `Should fetch page 1, got pages: ${pagesRequested}`)
  assert.ok(pagesRequested.includes(2), `Should fetch page 2, got pages: ${pagesRequested}`)
  // total reflects pre-limit count; items may be limited by default limit of 100
  assert.equal(result.total, 105, `Total should reflect all items from both pages`)
  assert.equal(result.items.length, 100, `Items should be default-limited to 100`)
})

await test("pagination cap: stops at max 3 pages", async () => {
  const issueCommentPages: number[] = []
  const { http } = createMockHttp((req) => {
    if (req.url.includes("issues/comments")) {
      const parsed = new URL(req.url)
      const page = parseInt(parsed.searchParams.get("page") ?? "1", 10)
      issueCommentPages.push(page)

      // Always return full page to keep pagination going
      const items = Array.from({ length: 100 }, (_, i) =>
        makeIssueComment(
          "test-bot",
          `Comment p${page}-${i}`,
          "2026-01-20T00:00:00Z",
          `https://github.com/owner/repo1/issues/${(page - 1) * 100 + i}#ic${page}-${i}`,
          `https://api.github.com/repos/owner/repo1/issues/${(page - 1) * 100 + i}`,
        ),
      )
      return jsonResp(200, items)
    }
    if (req.url.includes("pulls/comments")) return jsonResp(200, [])
    return jsonResp(200, [])
  })

  const feed = new ActivityFeed(makeConfig(), http)
  await feed.getActivity({})

  const maxPage = Math.max(...issueCommentPages)
  assert.ok(maxPage <= 3, `Should stop at page 3 (MAX_PAGES_PER_ENDPOINT), got max page ${maxPage}`)
  assert.ok(issueCommentPages.includes(3), "Should reach page 3")
})

await test("bot_username is surfaced in result", async () => {
  const { http } = createMockHttp(() => jsonResp(200, []))
  const feed = new ActivityFeed(makeConfig({ botUsername: "bridgebuilder-bot" }), http)
  const result = await feed.getActivity({})
  assert.equal(result.bot_username, "bridgebuilder-bot")
})

await test("result includes cache metadata", async () => {
  const { http } = createMockHttp(() => jsonResp(200, []))
  const feed = new ActivityFeed(makeConfig(), http)

  const result = await feed.getActivity({})
  assert.ok(result.generated_at, "Should have generated_at")
  assert.ok(typeof result.cached === "boolean", "Should have cached flag")
  assert.ok(result.cache_expires_at, "Should have cache_expires_at")
})

// ── Summary ─────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
