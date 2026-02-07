// src/bridgebuilder/adapters/github-rest.ts

import type {
  IGitProvider, IReviewPoster,
  PullRequest, PullRequestFile, PRReview, PreflightResult,
  PostReviewInput,
} from "../ports/index.js"
import type { IHttpClient, HttpResponse } from "../ports/http-client.js"

const IDEMPOTENCY_MARKER_PREFIX = "<!-- finn-review: "

export class GitHubRestAdapter implements IGitProvider, IReviewPoster {
  constructor(
    private readonly http: IHttpClient,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.token}`,
      "Accept": "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }
  }

  /**
   * Paginate through all pages of a GitHub API endpoint.
   * Follows Link: <url>; rel="next" headers until exhausted.
   */
  private async paginate<T>(url: string): Promise<T[]> {
    const results: T[] = []
    let nextUrl: string | null = url

    while (nextUrl) {
      const resp: HttpResponse = await this.http.request({
        url: nextUrl,
        method: "GET",
        headers: this.headers(),
      })
      if (resp.status !== 200) {
        throw new Error(`GitHub API error: HTTP ${resp.status} for ${nextUrl}`)
      }

      const page = JSON.parse(resp.body) as T[]
      results.push(...page)

      // Parse Link header for next page
      nextUrl = this.parseNextLink(resp.headers["link"] ?? resp.headers["Link"])
    }

    return results
  }

  /** Extract next page URL from GitHub Link header. */
  private parseNextLink(linkHeader: string | undefined): string | null {
    if (!linkHeader) return null
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
    return match?.[1] ?? null
  }

  async listOpenPRs(owner: string, repo: string): Promise<PullRequest[]> {
    const raw = await this.paginate<Record<string, unknown>>(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
    )
    return raw.map(pr => ({
      number: pr.number as number,
      title: pr.title as string,
      headSha: (pr.head as Record<string, unknown>).sha as string,
      baseBranch: (pr.base as Record<string, unknown>).ref as string,
      labels: ((pr.labels as Array<Record<string, unknown>>) ?? []).map(l => l.name as string),
      author: (pr.user as Record<string, unknown>).login as string,
    }))
  }

  async getPRFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]> {
    const raw = await this.paginate<Record<string, unknown>>(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    )
    return raw.map(f => ({
      filename: f.filename as string,
      status: f.status as PullRequestFile["status"],
      additions: f.additions as number,
      deletions: f.deletions as number,
      patch: f.patch as string | undefined,
    }))
  }

  async getPRReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]> {
    const raw = await this.paginate<Record<string, unknown>>(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
    )
    return raw.map(r => ({
      id: r.id as number,
      body: (r.body as string) ?? "",
      user: (r.user as Record<string, unknown>).login as string,
      state: r.state as PRReview["state"],
      submittedAt: r.submitted_at as string,
    }))
  }

  async preflight(): Promise<PreflightResult> {
    const resp = await this.http.request({
      url: "https://api.github.com/rate_limit",
      method: "GET",
      headers: this.headers(),
    })
    if (resp.status !== 200) {
      throw new Error(`GitHub preflight failed: HTTP ${resp.status}`)
    }

    const data = JSON.parse(resp.body) as { resources: { core: { remaining: number } } }
    const scopes = (resp.headers["x-oauth-scopes"] ?? "").split(",").map(s => s.trim()).filter(Boolean)

    return {
      remaining: data.resources.core.remaining,
      scopes,
    }
  }

  async postReview(input: PostReviewInput): Promise<boolean> {
    const resp = await this.http.request({
      url: `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/reviews`,
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        commit_id: input.headSha,
        body: input.body,
        event: input.event,
      }),
    })

    if (resp.status === 200 || resp.status === 201) return true
    if (resp.status === 422) return false // Validation error — PR may have been closed
    throw new Error(`postReview: HTTP ${resp.status}: ${resp.body.slice(0, 200)}`)
  }

  async hasExistingReview(owner: string, repo: string, prNumber: number, headSha: string): Promise<boolean> {
    const reviews = await this.getPRReviews(owner, repo, prNumber)
    const marker = `${IDEMPOTENCY_MARKER_PREFIX}${headSha} -->`
    return reviews.some(r => r.body.includes(marker))
  }
}
