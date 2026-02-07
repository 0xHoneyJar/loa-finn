// src/bridgebuilder/adapters/dry-run-poster.ts

import type { IReviewPoster, PostReviewInput } from "../ports/index.js"

export class DryRunPoster implements IReviewPoster {
  readonly posted: PostReviewInput[] = []

  async postReview(input: PostReviewInput): Promise<boolean> {
    console.log(`[DRY RUN] Would post ${input.event} to ${input.owner}/${input.repo}#${input.prNumber}`)
    console.log(`[DRY RUN] Body length: ${input.body.length} chars`)
    this.posted.push(input)
    return false // false = not actually posted
  }

  async hasExistingReview(): Promise<boolean> {
    return false // In dry-run, never skip due to existing review
  }
}
