// src/bridgebuilder/adapters/index.ts

import { createHash } from "node:crypto"
import type {
  IGitProvider, IReviewPoster, IContextStore, ILLMProvider,
  IHttpClient, IHasher, IOutputSanitizer,
} from "../ports/index.js"
import type { BridgebuilderEnvConfig } from "../config.js"
import { ResilientHttpClient } from "./resilient-http.js"
import { GitHubRestAdapter } from "./github-rest.js"
import { R2ContextAdapter } from "./r2-context.js"
import { AnthropicLLMAdapter } from "./anthropic-llm.js"
import { DryRunPoster } from "./dry-run-poster.js"
import { R2CheckpointStorage } from "../../persistence/r2-storage.js"

export interface BridgebuilderAdapters {
  http: IHttpClient
  git: IGitProvider
  poster: IReviewPoster
  context: IContextStore
  llm: ILLMProvider
  hasher: IHasher
  sanitizer: IOutputSanitizer
}

export function createAdapters(env: BridgebuilderEnvConfig): BridgebuilderAdapters {
  const http = new ResilientHttpClient({
    maxRetries: 3,
    baseDelayMs: 1000,
    rateLimitBuffer: 10,
    redactPatterns: [/ghp_\w+/, /ghs_\w+/, /github_pat_\w+/],
  })

  const github = new GitHubRestAdapter(http, env.githubToken)

  const poster: IReviewPoster = env.dryRun
    ? new DryRunPoster()
    : github

  let context: IContextStore
  if (env.r2Endpoint && env.r2Bucket && env.r2AccessKeyId && env.r2SecretAccessKey) {
    const r2 = new R2CheckpointStorage({
      endpoint: env.r2Endpoint,
      bucket: env.r2Bucket,
      accessKeyId: env.r2AccessKeyId,
      secretAccessKey: env.r2SecretAccessKey,
      prefix: "bridgebuilder",
    })
    context = new R2ContextAdapter(r2)
  } else {
    // Fallback: in-memory (single-run, no persistence across runs)
    console.warn("[bridgebuilder] No R2 config — context will not persist across runs")
    context = createInMemoryContext()
  }

  const llm = new AnthropicLLMAdapter(http, env.anthropicApiKey, env.model)

  // Node.js hasher adapter — arrakis can swap for WebCrypto/Deno
  const hasher: IHasher = {
    sha256(input: string): string {
      return createHash("sha256").update(input).digest("hex")
    },
  }

  // Output sanitizer — scans LLM output for leaked secrets before posting
  const SECRET_PATTERNS = [
    { pattern: /ghp_[A-Za-z0-9_]{36,}/, label: "GitHub PAT (classic)" },
    { pattern: /ghs_[A-Za-z0-9_]{36,}/, label: "GitHub App token" },
    { pattern: /github_pat_[A-Za-z0-9_]{22,}/, label: "GitHub fine-grained PAT" },
    { pattern: /sk-ant-[A-Za-z0-9-]{20,}/, label: "Anthropic API key" },
    { pattern: /sk-[A-Za-z0-9]{20,}/, label: "OpenAI-style API key" },
    { pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "Private key block" },
    { pattern: /xox[bpors]-[A-Za-z0-9-]+/, label: "Slack token" },
  ]

  const sanitizer: IOutputSanitizer = {
    sanitize(content: string) {
      const redacted: string[] = []
      let sanitized = content
      for (const { pattern, label } of SECRET_PATTERNS) {
        if (pattern.test(sanitized)) {
          sanitized = sanitized.replace(new RegExp(pattern.source, "g"), "[REDACTED]")
          redacted.push(label)
        }
      }
      return { safe: redacted.length === 0, sanitizedContent: sanitized, redactedPatterns: redacted }
    },
  }

  return { http, git: github, poster, context, llm, hasher, sanitizer }
}

function createInMemoryContext(): IContextStore {
  let data: import("../ports/index.js").ContextData = {
    reviews: [],
    stats: { totalRuns: 0, totalReviews: 0 },
  }
  return {
    async load() { return data },
    async save(d) { data = d },
    async claimReview() { return true },
    async finalizeReview() { /* no-op for in-memory */ },
  }
}
