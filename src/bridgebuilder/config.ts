// src/bridgebuilder/config.ts
// Finn-specific config: wraps upstream resolveConfig() with R2 and lease env vars.

import type { BridgebuilderConfig, CLIArgs, EnvVars } from "./upstream.js"
import { resolveConfig, parseCLIArgs } from "./upstream.js"
import type { R2ClientConfig } from "./r2-client.js"

export interface LeaseConfig {
  ttlMinutes: number
  delayMs: number
}

export interface FinnConfig {
  upstream: BridgebuilderConfig
  anthropicApiKey: string
  r2: R2ClientConfig | null
  lease: LeaseConfig
}

/**
 * Load finn config: upstream resolveConfig() for standard settings,
 * plus finn-specific R2 and lease env vars.
 */
export async function loadFinnConfig(): Promise<FinnConfig> {
  const cliArgs: CLIArgs = parseCLIArgs(process.argv.slice(2))
  const envVars: EnvVars = {
    BRIDGEBUILDER_REPOS: process.env.BRIDGEBUILDER_REPOS,
    BRIDGEBUILDER_MODEL: process.env.BRIDGEBUILDER_MODEL,
    BRIDGEBUILDER_DRY_RUN: process.env.BRIDGEBUILDER_DRY_RUN,
  }

  const { config: upstream } = await resolveConfig(cliArgs, envVars)

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    throw new Error("Missing required environment variable: ANTHROPIC_API_KEY")
  }

  // R2 config is null when env vars missing (graceful degradation)
  const r2Endpoint = process.env.R2_ENDPOINT
  const r2Bucket = process.env.R2_BUCKET
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY

  const r2: R2ClientConfig | null =
    r2Endpoint && r2Bucket && r2AccessKeyId && r2SecretAccessKey
      ? { endpoint: r2Endpoint, bucket: r2Bucket, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey }
      : null

  const lease: LeaseConfig = {
    ttlMinutes: intEnv("BRIDGEBUILDER_LEASE_TTL_MINUTES", 30),
    delayMs: intEnv("BRIDGEBUILDER_LEASE_DELAY_MS", 200),
  }

  return { upstream, anthropicApiKey, r2, lease }
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key]
  return raw ? parseInt(raw, 10) : fallback
}
