// src/dashboard/activity-feed.ts — Core data-fetching module (SDD §3.1)
// Framework-agnostic — no Hono imports. Uses IHttpClient from bridgebuilder ports.

import type { IHttpClient } from "../bridgebuilder/ports/http-client.js"

// --- Public Interfaces ---

export interface ActivityFeedConfig {
  githubToken: string
  repos: string[]                // ["owner/repo", ...]
  botUsername: string             // REQUIRED — explicit, not auto-detected
  cacheTtlMs: number             // Default: 300_000 (5 min)
  minRefreshIntervalMs: number   // Default: 60_000 (1 min) server-side cooldown
  idempotencyMarkerPrefix: string // Default: "<!-- finn-review: "
}

export interface ActivityItem {
  type: "pr_review" | "issue_comment"
  repo: string                   // "owner/repo"
  target: {
    number: number
    title: string
    url: string                  // GitHub HTML URL
    is_pr: boolean
  }
  verdict: string | null         // "COMMENTED" | "CHANGES_REQUESTED" | null
  preview: string                // First 120 chars of body
  body: string
  created_at: string             // ISO 8601
  url: string                    // Direct link to review/comment
  has_marker: boolean            // True if body contains idempotency marker
}

export interface ActivityFeedResult {
  items: ActivityItem[]
  total: number
  repos: string[]
  bot_username: string
  generated_at: string
  cached: boolean
  cache_expires_at: string | null
}

export interface ActivityFeedQuery {
  repo?: string
  type?: "pr_review" | "issue_comment"
  since?: string                 // ISO date
  limit?: number                 // Default 100
  force_refresh?: boolean
}

// --- Internal Types ---

interface CacheEntry {
  allItems: ActivityItem[]
  repos: string[]
  botUsername: string
  generated_at: string
  expires_at: number             // Date.now() + cacheTtlMs
}

interface GitHubReviewComment {
  user: { login: string } | null
  pull_request_url: string       // https://api.github.com/repos/owner/repo/pulls/N
  created_at: string
}

interface GitHubReview {
  id: number
  user: { login: string } | null
  body: string | null
  state: string                  // "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | etc.
  submitted_at: string | null
  html_url: string
}

interface GitHubIssueComment {
  id: number
  user: { login: string } | null
  body: string | null
  created_at: string
  html_url: string
  issue_url: string              // https://api.github.com/repos/owner/repo/issues/N
}

// --- Constants ---

const MAX_PAGES_PER_ENDPOINT = 3
const PER_PAGE = 100
const CONCURRENCY_CAP = 3
const DEFAULT_SINCE_DAYS = 30

// --- ActivityFeed Class ---

export class ActivityFeed {
  private cache: CacheEntry | null = null
  private lastFetchTimestamp: number = 0

  constructor(
    private readonly config: ActivityFeedConfig,
    private readonly http: IHttpClient,
  ) {}

  getBotUsername(): string {
    return this.config.botUsername
  }

  async getActivity(query: ActivityFeedQuery): Promise<ActivityFeedResult> {
    const useCache = this.cache !== null
      && Date.now() < this.cache.expires_at
      && !(query.force_refresh && this.canForceRefresh())

    if (useCache && this.cache) {
      return this.buildResult(this.cache, query, true)
    }

    // Fetch fresh data
    const botUser = this.getBotUsername()
    const since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000)
    const allItems: ActivityItem[] = []

    // Fetch repos with concurrency cap
    const repos = [...this.config.repos]
    for (let i = 0; i < repos.length; i += CONCURRENCY_CAP) {
      const batch = repos.slice(i, i + CONCURRENCY_CAP)
      const results = await Promise.allSettled(
        batch.map(repo => this.fetchRepo(repo, botUser, since))
      )

      for (const result of results) {
        if (result.status === "fulfilled") {
          allItems.push(...result.value)
        } else {
          console.error("[dashboard] repo fetch failed:", result.reason)
        }
      }
    }

    // Deduplicate by url
    const seen = new Set<string>()
    const deduped: ActivityItem[] = []
    for (const item of allItems) {
      if (!seen.has(item.url)) {
        seen.add(item.url)
        deduped.push(item)
      }
    }

    // Sort reverse-chronological
    deduped.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    // Compute unique repos with activity
    const activeRepos = [...new Set(deduped.map(item => item.repo))]

    // Cache the maximal unfiltered result
    const now = new Date()
    this.cache = {
      allItems: deduped,
      repos: activeRepos,
      botUsername: botUser,
      generated_at: now.toISOString(),
      expires_at: Date.now() + this.config.cacheTtlMs,
    }
    this.lastFetchTimestamp = Date.now()

    return this.buildResult(this.cache, query, false)
  }

  private buildResult(cache: CacheEntry, query: ActivityFeedQuery, servedFromCache: boolean): ActivityFeedResult {
    let items = cache.allItems

    // Post-cache filters
    if (query.repo) {
      items = items.filter(item => item.repo === query.repo)
    }
    if (query.type) {
      items = items.filter(item => item.type === query.type)
    }
    if (query.since) {
      const sinceDate = new Date(query.since)
      if (!isNaN(sinceDate.getTime())) {
        items = items.filter(item => new Date(item.created_at) >= sinceDate)
      }
    }

    const total = items.length
    const limit = query.limit ?? 100
    items = items.slice(0, limit)

    return {
      items,
      total,
      repos: cache.repos,
      bot_username: cache.botUsername,
      generated_at: cache.generated_at,
      cached: servedFromCache,
      cache_expires_at: cache.expires_at
        ? new Date(cache.expires_at).toISOString()
        : null,
    }
  }

  private canForceRefresh(): boolean {
    return Date.now() - this.lastFetchTimestamp >= this.config.minRefreshIntervalMs
  }

  private async fetchRepo(
    repoFull: string,
    botUser: string,
    since: Date,
  ): Promise<ActivityItem[]> {
    const [owner, repo] = repoFull.split("/")
    if (!owner || !repo) return []

    const [reviews, comments] = await Promise.allSettled([
      this.fetchRepoReviews(owner, repo, botUser, since),
      this.fetchRepoIssueComments(owner, repo, botUser, since),
    ])

    const items: ActivityItem[] = []

    if (reviews.status === "fulfilled") {
      items.push(...reviews.value)
    } else {
      console.error(`[dashboard] reviews fetch failed for ${repoFull}:`, reviews.reason)
    }

    if (comments.status === "fulfilled") {
      items.push(...comments.value)
    } else {
      console.error(`[dashboard] comments fetch failed for ${repoFull}:`, comments.reason)
    }

    return items
  }

  /**
   * Discover PR numbers where bot has review activity since cutoff.
   * Uses GET /repos/{owner}/{repo}/pulls/comments?since=...
   * Extracts unique PR numbers from the `pull_request_url` field.
   */
  async discoverBotReviewedPRs(
    owner: string,
    repo: string,
    botUser: string,
    since: Date,
  ): Promise<number[]> {
    const prNumbers = new Set<number>()
    const sinceISO = since.toISOString()

    for (let page = 1; page <= MAX_PAGES_PER_ENDPOINT; page++) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/comments?since=${sinceISO}&sort=created&direction=desc&per_page=${PER_PAGE}&page=${page}`

      try {
        const resp = await this.http.request({
          url,
          method: "GET",
          headers: this.githubHeaders(),
        })

        if (resp.status !== 200) break

        const comments = JSON.parse(resp.body) as GitHubReviewComment[]

        for (const c of comments) {
          if (!c.user || c.user.login !== botUser) continue
          const prNum = parseInt(c.pull_request_url.split("/").pop() ?? "0", 10)
          if (prNum > 0) prNumbers.add(prNum)
        }

        if (comments.length < PER_PAGE) break
      } catch (err) {
        console.error(`[dashboard] discover PRs failed for ${owner}/${repo} page ${page}:`, err)
        break
      }
    }

    return Array.from(prNumbers)
  }

  /**
   * Fetch formal PR reviews for discovered PRs.
   * Only fetches reviews for PRs the bot actually commented on.
   */
  private async fetchRepoReviews(
    owner: string,
    repo: string,
    botUser: string,
    since: Date,
  ): Promise<ActivityItem[]> {
    const items: ActivityItem[] = []

    // Step 1: Discover PRs with bot review activity
    const botPRNumbers = await this.discoverBotReviewedPRs(owner, repo, botUser, since)

    // Step 2: Fetch formal reviews for each discovered PR
    for (const prNum of botPRNumbers) {
      try {
        const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/reviews?per_page=${PER_PAGE}`
        const resp = await this.http.request({
          url,
          method: "GET",
          headers: this.githubHeaders(),
        })

        if (resp.status !== 200) continue

        const reviews = JSON.parse(resp.body) as GitHubReview[]

        for (const review of reviews) {
          if (!review.user || review.user.login !== botUser) continue
          if (!review.submitted_at || new Date(review.submitted_at) < since) continue

          const body = review.body ?? ""
          const hasMarker = body.includes(this.config.idempotencyMarkerPrefix)
          items.push({
            type: "pr_review",
            repo: `${owner}/${repo}`,
            target: {
              number: prNum,
              title: "",
              url: `https://github.com/${owner}/${repo}/pull/${prNum}`,
              is_pr: true,
            },
            verdict: review.state,
            preview: body.slice(0, 120),
            body,
            created_at: review.submitted_at,
            url: review.html_url,
            has_marker: hasMarker,
          })
        }
      } catch (err) {
        console.error(`[dashboard] reviews fetch failed for ${owner}/${repo}#${prNum}:`, err)
      }
    }

    return items
  }

  /**
   * Fetch bot-authored issue comments for a repo.
   * Uses server-side `since` filtering.
   */
  private async fetchRepoIssueComments(
    owner: string,
    repo: string,
    botUser: string,
    since: Date,
  ): Promise<ActivityItem[]> {
    const items: ActivityItem[] = []
    const sinceISO = since.toISOString()

    for (let page = 1; page <= MAX_PAGES_PER_ENDPOINT; page++) {
      try {
        const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments?since=${sinceISO}&sort=created&direction=desc&per_page=${PER_PAGE}&page=${page}`
        const resp = await this.http.request({
          url,
          method: "GET",
          headers: this.githubHeaders(),
        })

        if (resp.status !== 200) break

        const comments = JSON.parse(resp.body) as GitHubIssueComment[]

        for (const comment of comments) {
          if (!comment.user || comment.user.login !== botUser) continue

          const body = comment.body ?? ""
          const issueNumber = parseInt(comment.issue_url.split("/").pop() ?? "0", 10)
          const hasMarker = body.includes(this.config.idempotencyMarkerPrefix)

          items.push({
            type: "issue_comment",
            repo: `${owner}/${repo}`,
            target: {
              number: issueNumber,
              title: "",
              url: comment.html_url.replace(/#.*$/, ""),
              is_pr: false,
            },
            verdict: null,
            preview: body.slice(0, 120),
            body,
            created_at: comment.created_at,
            url: comment.html_url,
            has_marker: hasMarker,
          })
        }

        if (comments.length < PER_PAGE) break
      } catch (err) {
        console.error(`[dashboard] issue comments fetch failed for ${owner}/${repo} page ${page}:`, err)
        break
      }
    }

    return items
  }

  private githubHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.githubToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "loa-finn-dashboard",
    }
  }
}
