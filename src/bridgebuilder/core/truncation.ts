// src/bridgebuilder/core/truncation.ts

import type { PullRequestFile } from "../ports/index.js"
import type { BridgebuilderConfig } from "./types.js"

/** High-risk path patterns for review prioritization. */
const HIGH_RISK_PATTERNS = [
  /auth/i, /crypto/i, /secret/i, /\.env/i, /token/i,
  /password/i, /credential/i, /key/i, /security/i, /permission/i,
]

export interface TruncationResult {
  included: PullRequestFile[]   // Files with full diffs
  summarized: PullRequestFile[] // Files with name + stats only
  truncationNotice?: string
}

export function truncateFiles(
  files: PullRequestFile[],
  config: BridgebuilderConfig,
): TruncationResult {
  if (files.length === 0) return { included: [], summarized: [] }

  // Sort: high-risk first, then by change size (largest first)
  const sorted = [...files].sort((a, b) => {
    const aRisk = HIGH_RISK_PATTERNS.some(p => p.test(a.filename)) ? 0 : 1
    const bRisk = HIGH_RISK_PATTERNS.some(p => p.test(b.filename)) ? 0 : 1
    if (aRisk !== bRisk) return aRisk - bRisk
    return (b.additions + b.deletions) - (a.additions + a.deletions)
  })

  // Apply file count limit
  const capped = sorted.slice(0, config.maxFilesPerPR)
  const overFileLimit = sorted.length > config.maxFilesPerPR

  // Apply diff byte limit
  const included: PullRequestFile[] = []
  const summarized: PullRequestFile[] = []
  let totalDiffBytes = 0

  for (const f of capped) {
    const patchBytes = f.patch ? Buffer.byteLength(f.patch) : 0
    if (totalDiffBytes + patchBytes <= config.maxDiffBytesPerPR && f.patch) {
      included.push(f)
      totalDiffBytes += patchBytes
    } else {
      summarized.push({ ...f, patch: undefined })
    }
  }

  // Build truncation notice
  let notice: string | undefined
  const totalFiles = files.length
  const includedCount = included.length
  if (includedCount < totalFiles) {
    notice = `Review covers ${includedCount} of ${totalFiles} changed files with full diffs. ` +
      `${summarized.length} files summarized (name + stats only).`
    if (overFileLimit) {
      notice += ` ${totalFiles - config.maxFilesPerPR} files omitted (exceeded ${config.maxFilesPerPR} file limit).`
    }
  }

  return { included, summarized, truncationNotice: notice }
}
