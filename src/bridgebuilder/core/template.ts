// src/bridgebuilder/core/template.ts

import type { IGitProvider, IHasher, PullRequestFile } from "../ports/index.js"
import type { BridgebuilderConfig, ReviewItem } from "./types.js"
import { truncateFiles } from "./truncation.js"

export class PRReviewTemplate {
  constructor(
    private readonly git: IGitProvider,
    private readonly hasher: IHasher,
    private readonly config: BridgebuilderConfig,
  ) {}

  /** Resolve all open PRs across configured repos into ReviewItems. */
  async resolveItems(): Promise<ReviewItem[]> {
    const items: ReviewItem[] = []

    for (const { owner, repo } of this.config.repos) {
      const prs = await this.git.listOpenPRs(owner, repo)

      for (const pr of prs) {
        if (items.length >= this.config.maxPRsPerRun) break

        const files = await this.git.getPRFiles(owner, repo, pr.number)
        const existingReviews = await this.git.getPRReviews(owner, repo, pr.number)

        const stateHash = this.computeHash(pr, files)

        items.push({ owner, repo, pr, files, existingReviews, stateHash })
      }

      if (items.length >= this.config.maxPRsPerRun) break
    }

    return items
  }

  /** Build the review prompt for a single PR. */
  buildPrompt(item: ReviewItem): string {
    const { pr, files, existingReviews } = item
    const truncated = truncateFiles(files, this.config)
    const sections: string[] = []

    // Header
    sections.push(`## PR #${pr.number}: ${pr.title}`)
    sections.push(`**Author**: ${pr.author} | **Base**: ${pr.baseBranch} | **Head**: ${pr.headSha.slice(0, 8)}`)

    // Review dimensions
    sections.push("\n### Review Dimensions")
    for (const dim of this.config.dimensions) {
      sections.push(`- **${dim}**: Evaluate this PR for ${dim} concerns.`)
    }

    // Change summary
    sections.push("\n### Change Summary")
    const totalAdd = files.reduce((s, f) => s + f.additions, 0)
    const totalDel = files.reduce((s, f) => s + f.deletions, 0)
    sections.push(`${files.length} file(s) changed (+${totalAdd} -${totalDel})`)

    if (truncated.included.length > 0) {
      sections.push("\n#### Files with diffs")
      for (const f of truncated.included) {
        sections.push(`\n##### \`${f.filename}\` (${f.status}, +${f.additions} -${f.deletions})`)
        if (f.patch) sections.push("```diff\n" + f.patch + "\n```")
      }
    }

    if (truncated.summarized.length > 0) {
      sections.push(`\n#### ${truncated.summarized.length} additional files (no diff — truncated)`)
      for (const f of truncated.summarized) {
        sections.push(`- \`${f.filename}\` (${f.status}, +${f.additions} -${f.deletions})`)
      }
    }

    if (truncated.truncationNotice) {
      sections.push(`\n> ${truncated.truncationNotice}`)
    }

    // Previous reviews
    sections.push("\n### Previous Review Context")
    if (existingReviews.length === 0) {
      sections.push("No previous reviews.")
    } else {
      for (const r of existingReviews) {
        sections.push(`- **${r.user}** (${r.state}, ${r.submittedAt}): ${r.body.slice(0, 200)}`)
      }
    }

    return sections.join("\n")
  }

  /**
   * Compute state hash from code-only fields.
   * headSha + normalized file list. Excludes reviews, CI, mergeable state.
   */
  private computeHash(pr: { headSha: string }, files: PullRequestFile[]): string {
    const canonical = {
      headSha: pr.headSha,
      files: files
        .map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }))
        .sort((a, b) => a.filename.localeCompare(b.filename)),
    }
    return this.hasher.sha256(JSON.stringify(canonical))
  }
}
