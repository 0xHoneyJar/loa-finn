// src/boot/secrets.ts — SecretsLoader (SDD §3.1, cycle-035 T-1.6)
//
// Fetches all secrets from Secrets Manager at startup. Fail-fast if required
// secret missing. Cache with 1h TTL for rotation. Parallel fetch via Promise.all.
//
// Admin JWKS: fetches finn/admin-jwks as JWK Set JSON, parseable by jose's
// createLocalJWKSet. On TTL refresh, re-fetches + reconstructs without restart.

import type { SecretsManagerClient, FinnSecrets } from "../config/aws-secrets.js"
import { loadSecrets } from "../config/aws-secrets.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretsLoaderOptions {
  /** TTL for cached secrets in ms. Default: 3600000 (1h). */
  ttlMs?: number
  /** Required secret fields — startup fails if any missing. */
  required?: (keyof FinnSecrets)[]
  /** AWS Secrets Manager client (injected for testing). */
  client?: SecretsManagerClient
}

interface CachedSecret<T> {
  value: T
  fetchedAt: number
}

// ---------------------------------------------------------------------------
// SecretsLoader
// ---------------------------------------------------------------------------

export class SecretsLoader {
  private readonly client: SecretsManagerClient | undefined
  private readonly ttlMs: number
  private readonly requiredFields: (keyof FinnSecrets)[]
  private cache: CachedSecret<FinnSecrets> | null = null
  private jwksCache: CachedSecret<string> | null = null
  private refreshing = false

  constructor(options?: SecretsLoaderOptions) {
    this.client = options?.client
    this.ttlMs = options?.ttlMs ?? 3_600_000
    this.requiredFields = options?.required ?? ["anthropicApiKey", "finnAuthToken"]
  }

  /**
   * Load all secrets. Fail-fast if required secrets missing.
   * Must be called at startup before any service that needs secrets.
   */
  async load(): Promise<FinnSecrets> {
    const secrets = await loadSecrets(this.client)

    // Validate required secrets (fail-fast at startup)
    const missing = this.requiredFields.filter(k => !secrets[k])
    if (missing.length > 0) {
      throw new Error(`SecretsLoader: missing required secrets: ${missing.join(", ")}`)
    }

    this.cache = { value: secrets, fetchedAt: Date.now() }

    console.log(JSON.stringify({
      metric: "secrets.loaded",
      fields: Object.keys(secrets).filter(k => !!(secrets as Record<string, unknown>)[k]).length,
      required_ok: true,
      timestamp: Date.now(),
    }))

    return secrets
  }

  /**
   * Get cached secrets, refreshing if TTL expired.
   * Background refresh — returns stale while refreshing.
   */
  async getSecrets(): Promise<FinnSecrets> {
    if (!this.cache) {
      return this.load()
    }

    const age = Date.now() - this.cache.fetchedAt
    if (age > this.ttlMs && !this.refreshing) {
      // Background refresh — don't block callers
      this.refreshing = true
      this.load()
        .then(() => { this.refreshing = false })
        .catch((err) => {
          this.refreshing = false
          console.error(JSON.stringify({
            metric: "secrets.refresh_error",
            error: (err as Error).message,
            timestamp: Date.now(),
          }))
          // Keep serving stale cache
        })
    }

    return this.cache.value
  }

  /**
   * Load admin JWKS from Secrets Manager (finn/admin-jwks).
   * Returns raw JWK Set JSON string, suitable for JSON.parse → createLocalJWKSet.
   */
  async loadAdminJWKS(): Promise<string | null> {
    if (!this.client) return null

    // Check cache TTL
    if (this.jwksCache) {
      const age = Date.now() - this.jwksCache.fetchedAt
      if (age < this.ttlMs) return this.jwksCache.value
    }

    try {
      const result = await this.client.getSecretValue({ SecretId: "finn/admin-jwks" })
      if (result.SecretString) {
        // Validate it's parseable JSON with keys array
        const parsed = JSON.parse(result.SecretString) as { keys?: unknown[] }
        if (!parsed.keys || !Array.isArray(parsed.keys)) {
          throw new Error("admin JWKS missing 'keys' array")
        }
        this.jwksCache = { value: result.SecretString, fetchedAt: Date.now() }
        console.log(JSON.stringify({
          metric: "secrets.admin_jwks_loaded",
          key_count: parsed.keys.length,
          timestamp: Date.now(),
        }))
        return result.SecretString
      }
    } catch (err) {
      console.error(JSON.stringify({
        metric: "secrets.admin_jwks_error",
        error: (err as Error).message,
        timestamp: Date.now(),
      }))
    }

    return this.jwksCache?.value ?? null
  }

  /**
   * Force refresh all cached secrets (for manual rotation trigger).
   */
  async refresh(): Promise<FinnSecrets> {
    this.cache = null
    this.jwksCache = null
    return this.load()
  }

  /** Whether secrets have been loaded at least once. */
  get isLoaded(): boolean {
    return this.cache !== null
  }

  /** Age of cached secrets in ms. */
  get cacheAgeMs(): number {
    return this.cache ? Date.now() - this.cache.fetchedAt : -1
  }
}
