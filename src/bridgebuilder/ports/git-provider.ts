// src/bridgebuilder/ports/git-provider.ts

export interface PullRequest {
  number: number
  title: string
  headSha: string
  baseBranch: string
  labels: string[]
  author: string
}

export interface PullRequestFile {
  filename: string
  status: "added" | "modified" | "removed" | "renamed"
  additions: number
  deletions: number
  patch?: string
}

/**
 * Represents a Pull Request Review (submitted via "Submit review" on GitHub).
 * This is the GitHub Pull Request Reviews endpoint (/pulls/:id/reviews),
 * NOT the Review Comments endpoint (/pulls/:id/comments).
 * The marker lives in the review body — this is the authoritative channel.
 */
export interface PRReview {
  id: number
  body: string
  user: string
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"
  submittedAt: string
}

export interface PreflightResult {
  remaining: number
  scopes: string[]
}

export interface IGitProvider {
  /** List open PRs for a repo. Returns ALL open PRs (handles pagination internally). */
  listOpenPRs(owner: string, repo: string): Promise<PullRequest[]>

  /** Get ALL changed files for a PR (handles pagination internally). */
  getPRFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]>

  /**
   * Get ALL submitted reviews for a PR (handles pagination internally).
   * Uses the Pull Request Reviews endpoint — NOT review comments.
   * Marker detection searches review bodies from this channel.
   */
  getPRReviews(owner: string, repo: string, prNumber: number): Promise<PRReview[]>

  /** Validate GitHub connectivity and token permissions. */
  preflight(): Promise<PreflightResult>
}
