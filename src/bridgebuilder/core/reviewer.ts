// src/bridgebuilder/core/reviewer.ts

import type { IReviewPoster, ILLMProvider, IOutputSanitizer } from "../ports/index.js"
import type { BridgebuilderConfig, ReviewItem, ReviewResult, RunSummary } from "./types.js"
import type { PRReviewTemplate } from "./template.js"
import type { BridgebuilderContext } from "./context.js"

/** Rough chars-per-token ratio for prompt size estimation. */
const CHARS_PER_TOKEN = 4

export class ReviewPipeline {
  constructor(
    private readonly template: PRReviewTemplate,
    private readonly context: BridgebuilderContext,
    private readonly poster: IReviewPoster,
    private readonly llm: ILLMProvider,
    private readonly sanitizer: IOutputSanitizer,
    private readonly persona: string,
    private readonly config: BridgebuilderConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async run(runId: string): Promise<RunSummary> {
    const startMs = this.now()
    const maxRuntimeMs = this.config.maxRuntimeMinutes * 60_000

    await this.context.load()
    this.context.recordRun()

    const items = await this.template.resolveItems()

    const results: ReviewResult[] = []
    let totalInput = 0
    let totalOutput = 0

    for (const item of items) {
      // Runtime check
      if (this.now() - startMs >= maxRuntimeMs) break

      const result = await this.reviewItem(item)
      results.push(result)
      totalInput += result.inputTokens ?? 0
      totalOutput += result.outputTokens ?? 0
    }

    await this.context.save()

    return {
      runId,
      startedAt: new Date(startMs).toISOString(),
      completedAt: new Date(this.now()).toISOString(),
      durationMs: this.now() - startMs,
      totalPRs: items.length,
      reviewed: results.filter(r => r.posted).length,
      skipped: results.filter(r => r.skipped).length,
      errors: results.filter(r => r.error).length,
      tokenUsage: { input: totalInput, output: totalOutput },
    }
  }

  private async reviewItem(item: ReviewItem): Promise<ReviewResult> {
    const { owner, repo, pr } = item
    const repoSlug = `${owner}/${repo}`

    // Step 1: Change detection (in-memory, cheap)
    if (!this.context.hasChanged(repoSlug, pr.number, pr.headSha)) {
      return { item, posted: false, skipped: true, skipReason: "unchanged" }
    }

    // Step 2: Check for existing review marker FIRST (GitHub is authoritative)
    // This prevents: (a) wasting LLM tokens on already-reviewed PRs,
    // (b) poisoning the claim store if a previous run posted but failed to persist claim
    const hasMarker = await this.poster.hasExistingReview(owner, repo, pr.number, pr.headSha)
    if (hasMarker) {
      return { item, posted: false, skipped: true, skipReason: "marker-exists" }
    }

    // Step 3: CAS idempotency claim (R2, defense-in-depth)
    // Only attempt after confirming no marker — avoids permanently suppressing
    // reviews if claim succeeds but posting later fails
    const claimed = await this.context.claimReview(repoSlug, pr.number, pr.headSha)
    if (!claimed) {
      return { item, posted: false, skipped: true, skipReason: "already-claimed" }
    }

    // Step 4: Generate review
    try {
      const prompt = this.template.buildPrompt(item)

      // Step 4a: Enforce prompt size budget (maxInputTokens)
      const estimatedTokens = Math.ceil(
        (this.persona.length + prompt.length) / CHARS_PER_TOKEN,
      )
      if (estimatedTokens > this.config.maxInputTokens) {
        return {
          item, posted: false, skipped: true,
          skipReason: `prompt-too-large (${estimatedTokens} est. tokens > ${this.config.maxInputTokens} limit)`,
        }
      }

      const response = await this.llm.generateReview({
        systemPrompt: this.persona,
        userPrompt: prompt,
        maxOutputTokens: this.config.maxOutputTokens,
      })

      // Step 5: Sanitize LLM output before posting (prompt injection defense)
      const sanitized = this.sanitizer.sanitize(response.content)
      if (!sanitized.safe) {
        console.warn(
          `[bridgebuilder] Output sanitizer flagged ${sanitized.redactedPatterns.length} pattern(s) ` +
          `in review for ${repoSlug}#${pr.number} — using sanitized version`,
        )
      }

      // Step 6: Re-check marker immediately before posting (final race guard)
      // Covers the window between Step 2 and now (another run may have posted)
      const markerRecheck = await this.poster.hasExistingReview(owner, repo, pr.number, pr.headSha)
      if (markerRecheck) {
        return { item, posted: false, skipped: true, skipReason: "marker-exists-recheck" }
      }

      // Step 7: Post review
      const body = sanitized.sanitizedContent + `\n\n<!-- finn-review: ${pr.headSha} -->`
      const event = this.classifyEvent(sanitized.sanitizedContent)

      const posted = await this.poster.postReview({
        owner, repo,
        prNumber: pr.number,
        headSha: pr.headSha,
        body,
        event,
      })

      // Step 8: Finalize claim + record in context ONLY after successful post
      // This upgrades the in-progress claim to permanent "posted" status.
      // If posting fails, the in-progress claim will expire after TTL,
      // allowing a future run to retry.
      if (posted) {
        await this.context.finalizeReview(repoSlug, pr.number, pr.headSha)
        this.context.recordReview({
          repo: repoSlug,
          prNumber: pr.number,
          headSha: pr.headSha,
          reviewedAt: new Date().toISOString(),
          dimensions: this.config.dimensions,
        })
      }

      return {
        item,
        posted,
        skipped: !posted,
        skipReason: posted ? undefined : "dry-run",
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { item, posted: false, skipped: false, error }
    }
  }

  /**
   * Classify review event based on content severity.
   * Look for critical/blocking keywords to decide COMMENT vs REQUEST_CHANGES.
   */
  private classifyEvent(content: string): "COMMENT" | "REQUEST_CHANGES" {
    const criticalPatterns = [
      /\bcritical\b/i,
      /\bsecurity\s+vulnerabilit/i,
      /\bsql\s+injection\b/i,
      /\bxss\b/i,
      /\bsecret\s+(leak|expos)/i,
      /\bmust\s+fix\b/i,
    ]
    return criticalPatterns.some(p => p.test(content))
      ? "REQUEST_CHANGES"
      : "COMMENT"
  }
}
