// src/bridgebuilder/ports/review-poster.ts

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES"

export interface PostReviewInput {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  body: string
  event: ReviewEvent
}

export interface IReviewPoster {
  /** Post a review comment to a PR. Returns true if posted, false if skipped (idempotency). */
  postReview(input: PostReviewInput): Promise<boolean>

  /** Check if a review already exists for this commit (marker search). */
  hasExistingReview(owner: string, repo: string, prNumber: number, headSha: string): Promise<boolean>
}
