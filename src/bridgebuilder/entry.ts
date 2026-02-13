// src/bridgebuilder/entry.ts
// Composition root: GH_TOKEN bridge → loadConfig → createFinnAdapters → lease → pipeline → run

import { readFileSync } from "node:fs"
import { loadFinnConfig } from "./config.js"
import { createFinnAdapters } from "./adapters/index.js"
import { SanitizedLogger } from "./logger.js"
import { PRReviewTemplate, BridgebuilderContext, ReviewPipeline } from "./upstream.js"
import { RunLease, type ILeaseStorage } from "./lease.js"
import { R2CheckpointStorage } from "../persistence/r2-storage.js"

async function main(): Promise<number> {
  // Step 1: Bridge GH_TOKEN from GITHUB_TOKEN if needed (upstream GitHubCLIAdapter uses GH_TOKEN)
  if (!process.env.GH_TOKEN && process.env.GITHUB_TOKEN) {
    process.env.GH_TOKEN = process.env.GITHUB_TOKEN
  }

  // Step 2: Load config (upstream resolveConfig + finn R2/lease)
  const finnConfig = await loadFinnConfig()
  const config = finnConfig.upstream

  // Step 3: Create finn adapters (upstream + R2ContextStore override)
  const adapters = createFinnAdapters(config, finnConfig.anthropicApiKey, finnConfig.r2)

  // Step 4: Create sanitized logger wrapping upstream logger
  const log = new SanitizedLogger(adapters.logger, adapters.sanitizer)

  log.info("Starting...")
  log.info(`Repos: ${config.repos.length} configured`)
  log.info(`Dimensions: ${config.dimensions.join(", ")}`)
  log.info(`Model: ${config.model}`)
  log.info(`Dry run: ${config.dryRun}`)
  log.info(`Max PRs per run: ${config.maxPrs}`)
  log.info(`Max runtime: ${config.maxRuntimeMinutes}m`)

  // Step 5: Load R2ContextStore state (if R2 configured)
  await adapters.contextStore.load()

  // Step 6: Acquire run lease (if R2 available)
  let lease: RunLease | undefined
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  if (finnConfig.r2) {
    const r2Storage = new R2CheckpointStorage({
      endpoint: finnConfig.r2.endpoint,
      bucket: finnConfig.r2.bucket,
      accessKeyId: finnConfig.r2.accessKeyId,
      secretAccessKey: finnConfig.r2.secretAccessKey,
      prefix: "bridgebuilder",
    })

    lease = new RunLease(
      r2Storage as ILeaseStorage,
      finnConfig.lease.ttlMinutes,
      finnConfig.lease.delayMs,
    )
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
    // BB-063-017: Support legacy personaPath config for backward compatibility
    let persona: string
    const resolvedPath = config.repoOverridePath
      ?? (config as Record<string, unknown>).personaPath as string | undefined
      ?? "grimoires/bridgebuilder/BEAUVOIR.md"
    if ((config as Record<string, unknown>).personaPath && !config.repoOverridePath) {
      log.warn("config.personaPath is deprecated — use config.repoOverridePath instead")
    }
    try {
      persona = readFileSync(resolvedPath, "utf-8")
    } catch {
      log.warn(`BEAUVOIR.md not found at ${resolvedPath}, using default persona`)
      persona = "You are Bridgebuilder, a constructive code reviewer. Focus on security, quality, and test coverage. Be specific and actionable. Never approve — only COMMENT or REQUEST_CHANGES."
    }

    // Step 8: Wire core pipeline
    const template = new PRReviewTemplate(adapters.git, adapters.hasher, config)
    const context = new BridgebuilderContext(adapters.contextStore)
    const pipeline = new ReviewPipeline(
      template, context, adapters.git, adapters.poster, adapters.llm,
      adapters.sanitizer, log, persona, config,
    )

    // Step 9: Run
    const summary = await pipeline.run(runId)

    // Step 10: Log results
    log.info("Run complete:")
    log.info(`  Reviewed:   ${summary.reviewed}`)
    log.info(`  Skipped:    ${summary.skipped}`)
    log.info(`  Errors:     ${summary.errors}`)

    return summary.errors > 0 ? 1 : 0
  } finally {
    if (lease) {
      try {
        await lease.release(runId)
        log.info("Lease released")
      } catch {
        log.warn("Failed to release lease")
      }
    }
  }
}

function redactFatalError(err: unknown): string {
  const raw = err instanceof Error
    ? `${err.message}${err.stack ? `\n${err.stack}` : ""}`
    : String(err)
  const secrets = [
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_SECRET_ACCESS_KEY,
  ].filter(Boolean) as string[]
  return secrets.reduce((acc, s) => acc.split(s).join("[REDACTED]"), raw)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error("[bridgebuilder] Fatal error:", redactFatalError(err))
    process.exitCode = 1
  })
