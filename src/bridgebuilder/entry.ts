// src/bridgebuilder/entry.ts

import { readFileSync } from "node:fs"
import { loadConfig } from "./config.js"
import { createAdapters } from "./adapters/index.js"
import { BridgebuilderLogger } from "./logger.js"
import { PRReviewTemplate } from "./core/template.js"
import { BridgebuilderContext } from "./core/context.js"
import { ReviewPipeline } from "./core/reviewer.js"
import { RunLease } from "./lease.js"
import { R2CheckpointStorage } from "../persistence/r2-storage.js"

async function main(): Promise<number> {
  // Step 1: Load config (before adapters — no logger yet, but config errors are safe)
  const envConfig = loadConfig()

  // Step 2: Create adapters (includes preflight-capable GitHub client)
  const adapters = createAdapters(envConfig)

  // Step 3: Create sanitized logger — all runtime logging goes through this
  const log = new BridgebuilderLogger(adapters.sanitizer)

  log.info("Starting...")
  log.info(`Repos: ${envConfig.repos.length} configured`)
  log.info(`Dimensions: ${envConfig.dimensions.join(", ")}`)
  log.info(`Model: ${envConfig.model}`)
  log.info(`Dry run: ${envConfig.dryRun}`)
  log.info(`Max PRs per run: ${envConfig.maxPRsPerRun}`)
  log.info(`Max runtime: ${envConfig.maxRuntimeMinutes}m`)
  for (const r of envConfig.repos) {
    log.debug(`Repo: ${r.owner}/${r.repo}`)
  }

  // Step 4: Per-repo preflight — validate token can access each configured repo
  for (const r of envConfig.repos) {
    const result = await adapters.git.preflightRepo(r.owner, r.repo)
    if (!result.accessible) {
      throw new Error(`Preflight failed: ${result.error}`)
    }
  }
  log.info(`Preflight: all ${envConfig.repos.length} repos accessible`)

  // Step 5: Check API quota — skip run if insufficient
  const quotaCheck = await adapters.git.preflight()
  if (quotaCheck.remaining < 100) {
    log.warn(`Insufficient GitHub API quota (${quotaCheck.remaining} remaining, need >= 100) — skipping run`)
    return 0
  }
  log.debug(`API quota: ${quotaCheck.remaining} remaining`)

  // Step 6: Acquire run lease (if R2 available)
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
    if (acquired !== true) {
      const holder = typeof acquired === "object" && acquired.held ? acquired.heldBy : "unknown"
      log.info(`Run lease held by ${holder} — exiting cleanly`)
      return 0
    }
    log.info(`Lease acquired: ${runId}`)
  }

  try {
    // Step 7: Load persona
    let persona: string
    const personaPath = "grimoires/bridgebuilder/BEAUVOIR.md"
    try {
      persona = readFileSync(personaPath, "utf-8")
    } catch {
      log.warn(`BEAUVOIR.md not found at ${personaPath}, using default persona`)
      persona = "You are Bridgebuilder, a constructive code reviewer. Focus on security, quality, and test coverage. Be specific and actionable. Never approve — only COMMENT or REQUEST_CHANGES."
    }

    // Step 8: Wire core pipeline
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

    // Step 9: Run
    const summary = await pipeline.run(runId)

    // Step 10: Handle zero PRs
    if (summary.totalPRs === 0) {
      log.info(`No open PRs found across ${envConfig.repos.length} repos — nothing to review`)
      return 0
    }

    log.info("Run complete:")
    log.info(`  PRs found:  ${summary.totalPRs}`)
    log.info(`  Reviewed:   ${summary.reviewed}`)
    log.info(`  Skipped:    ${summary.skipped}`)
    log.info(`  Errors:     ${summary.errors}`)
    log.info(`  Tokens:     ${summary.tokenUsage.input} in / ${summary.tokenUsage.output} out`)
    log.info(`  Duration:   ${Math.round(summary.durationMs / 1000)}s`)

    return summary.errors > 0 ? 1 : 0
  } finally {
    if (lease) {
      await lease.release(runId).catch(() => {})
      log.info("Lease released")
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    // Fatal fallback — no logger available (adapters may have failed to initialize)
    console.error("[bridgebuilder] Fatal error:", err)
    process.exitCode = 1
  })
