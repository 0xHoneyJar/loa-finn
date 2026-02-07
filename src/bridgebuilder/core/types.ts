// src/bridgebuilder/core/types.ts

import type { PullRequest, PullRequestFile, PRReview } from "../ports/index.js"

export interface BridgebuilderConfig {
  repos: Array<{ owner: string; repo: string }>
  maxPRsPerRun: number
  maxRuntimeMinutes: number
  maxFilesPerPR: number
  maxDiffBytesPerPR: number
  maxInputTokens: number
  maxOutputTokens: number
  dimensions: string[]
  reReviewHours?: number // undefined = disabled
  dryRun: boolean
}

export interface ReviewItem {
  owner: string
  repo: string
  pr: PullRequest
  files: PullRequestFile[]
  existingReviews: PRReview[]
  stateHash: string
}

export interface ReviewResult {
  item: ReviewItem
  posted: boolean
  skipped: boolean
  skipReason?: string
  inputTokens?: number
  outputTokens?: number
  error?: string
}

export interface RunSummary {
  runId: string
  startedAt: string
  completedAt: string
  durationMs: number
  totalPRs: number
  reviewed: number
  skipped: number
  errors: number
  tokenUsage: { input: number; output: number }
}
