// src/bridgebuilder/entry.ts

import { readFileSync } from "node:fs"
import { loadConfig } from "./config.js"
import { createAdapters } from "./adapters/index.js"
import { PRReviewTemplate } from "./core/template.js"
import { BridgebuilderContext } from "./core/context.js"
import { ReviewPipeline } from "./core/reviewer.js"
import { RunLease } from "./lease.js"
import { R2CheckpointStorage } from "../persistence/r2-storage.js"

async function main(): Promise<void> {
  console.log("[bridgebuilder] Starting...")

  // Step 1: Load config
  const envConfig = loadConfig()
  console.log(`[bridgebuilder] Repos: ${envConfig.repos.map(r => `${r.owner}/${r.repo}`).join(", ")}`)
  console.log(`[bridgebuilder] Model: ${envConfig.model}`)
  console.log(`[bridgebuilder] Dry run: ${envConfig.dryRun}`)

  // Step 2: Create adapters (includes preflight-capable GitHub client)
  const adapters = createAdapters(envConfig)

  // Step 3: Acquire run lease (if R2 available)
  let lease: RunLease | undefined
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (envConfig.r2Endpoint && envConfig.r2Bucket && envConfig.r2AccessKeyId && envConfig.r2SecretAccessKey) {
    const r2 = new R2CheckpointStorage({
      endpoint: envConfig.r2Endpoint,
      bucket: envConfig.r2Bucket,
      accessKeyId: envConfig.r2AccessKeyId,
      secretAccessKey: envConfig.r2SecretAccessKey,
      prefix: "bridgebuilder",
    })

    lease = new RunLease(r2, envConfig.maxRuntimeMinutes + 5)
    const acquired = await lease.acquire(runId)
    if (!acquired) {
      console.log("[bridgebuilder] Another run is active — exiting cleanly")
      process.exit(0)
    }
    console.log(`[bridgebuilder] Lease acquired: ${runId}`)
  }

  try {
    // Step 4: Load persona
    let persona: string
    try {
      persona = readFileSync("grimoires/bridgebuilder/BEAUVOIR.md", "utf-8")
    } catch {
      persona = "You are Bridgebuilder, a constructive code reviewer. Focus on security, quality, and test coverage. Be specific and actionable. Never approve — only COMMENT or REQUEST_CHANGES."
    }

    // Step 5: Wire core pipeline
    const config = {
      repos: envConfig.repos,
      maxPRsPerRun: envConfig.maxPRsPerRun,
      maxRuntimeMinutes: envConfig.maxRuntimeMinutes,
      maxFilesPerPR: envConfig.maxFilesPerPR,
      maxDiffBytesPerPR: envConfig.maxDiffBytesPerPR,
      maxInputTokens: envConfig.maxInputTokens,
      maxOutputTokens: envConfig.maxOutputTokens,
      dimensions: envConfig.dimensions,
      reReviewHours: envConfig.reReviewHours,
      dryRun: envConfig.dryRun,
    }

    const template = new PRReviewTemplate(adapters.git, adapters.hasher, config)
    const context = new BridgebuilderContext(adapters.context, config)
    const pipeline = new ReviewPipeline(
      template, context, adapters.poster, adapters.llm,
      adapters.sanitizer, persona, config,
    )

    // Step 6: Run
    const summary = await pipeline.run(runId)

    console.log("[bridgebuilder] Run complete:")
    console.log(`  PRs found:  ${summary.totalPRs}`)
    console.log(`  Reviewed:   ${summary.reviewed}`)
    console.log(`  Skipped:    ${summary.skipped}`)
    console.log(`  Errors:     ${summary.errors}`)
    console.log(`  Tokens:     ${summary.tokenUsage.input} in / ${summary.tokenUsage.output} out`)
    console.log(`  Duration:   ${Math.round(summary.durationMs / 1000)}s`)

    process.exit(summary.errors > 0 ? 1 : 0)
  } finally {
    if (lease) {
      await lease.release().catch(() => {})
      console.log("[bridgebuilder] Lease released")
    }
  }
}

main().catch((err) => {
  console.error("[bridgebuilder] Fatal error:", err)
  process.exit(1)
})
