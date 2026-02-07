// src/bridgebuilder/config.ts

export interface BridgebuilderEnvConfig {
  githubToken: string
  repos: Array<{ owner: string; repo: string }>
  anthropicApiKey: string
  model: string
  maxPRsPerRun: number
  maxRuntimeMinutes: number
  maxFilesPerPR: number
  maxDiffBytesPerPR: number
  maxInputTokens: number
  maxOutputTokens: number
  reReviewHours?: number
  dimensions: string[]
  dryRun: boolean
  r2Endpoint?: string
  r2Bucket?: string
  r2AccessKeyId?: string
  r2SecretAccessKey?: string
}

export function loadConfig(): BridgebuilderEnvConfig {
  // Collect all missing required vars before throwing
  const missing: string[] = []
  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) missing.push("GITHUB_TOKEN")
  const reposRaw = process.env.BRIDGEBUILDER_REPOS
  if (!reposRaw) missing.push("BRIDGEBUILDER_REPOS")
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) missing.push("ANTHROPIC_API_KEY")

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }

  const repos = reposRaw!.split(",").map(r => {
    const [owner, repo] = r.trim().split("/")
    if (!owner || !repo) throw new Error(`Invalid repo format: "${r}" — expected "owner/repo"`)
    return { owner, repo }
  })

  return {
    githubToken: githubToken!,
    repos,
    anthropicApiKey: anthropicApiKey!,
    model: env("BRIDGEBUILDER_MODEL", "claude-sonnet-4-5-20250929"),
    maxPRsPerRun: intEnv("BRIDGEBUILDER_MAX_PRS", 10),
    maxRuntimeMinutes: intEnv("BRIDGEBUILDER_MAX_RUNTIME_MINUTES", 25),
    maxFilesPerPR: intEnv("BRIDGEBUILDER_MAX_FILES_PER_PR", 50),
    maxDiffBytesPerPR: intEnv("BRIDGEBUILDER_MAX_DIFF_BYTES", 100_000),
    maxInputTokens: intEnv("BRIDGEBUILDER_MAX_INPUT_TOKENS", 8000),
    maxOutputTokens: intEnv("BRIDGEBUILDER_MAX_OUTPUT_TOKENS", 4000),
    reReviewHours: optionalIntEnv("BRIDGEBUILDER_RE_REVIEW_HOURS"),
    dimensions: env("BRIDGEBUILDER_DIMENSIONS", "security,quality,test-coverage").split(","),
    dryRun: env("BRIDGEBUILDER_DRY_RUN", "false") === "true",
    r2Endpoint: process.env.R2_ENDPOINT,
    r2Bucket: process.env.R2_BUCKET,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  }
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  return raw ? parseInt(raw, 10) : fallback
}

function optionalIntEnv(key: string): number | undefined {
  const raw = process.env[key]
  return raw ? parseInt(raw, 10) : undefined
}
