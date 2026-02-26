// src/config/aws-secrets.ts — AWS Secrets Manager Integration (SDD §7.1, T-5.4)
//
// Fetches secrets from AWS Secrets Manager at startup.
// In production: ECS task role provides credentials automatically.
// In dev: uses env vars directly (no Secrets Manager call).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Secrets Manager client interface (injectable for testing). */
export interface SecretsManagerClient {
  getSecretValue(params: { SecretId: string }): Promise<{ SecretString?: string }>
}

/** All secrets needed by finn (Sprint 3 x402 + Sprint 4 audit). */
export interface FinnSecrets {
  // Existing secrets
  anthropicApiKey: string
  finnAuthToken: string
  s2sPrivateKey: string
  redisUrl: string
  metricsAuthToken?: string

  // x402 Settlement (Sprint 3)
  relayerPrivateKey?: string
  merchantAddress?: string

  // Audit (Sprint 4)
  kmsKeyId?: string
  auditBucketName?: string

  // Calibration (Sprint 1)
  calibrationBucketName?: string
  calibrationHmacKey?: string
}

/** Secret ID → FinnSecrets field mapping. */
const SECRET_MAP: Record<string, keyof FinnSecrets> = {
  "finn/anthropic-api-key": "anthropicApiKey",
  "finn/auth-token": "finnAuthToken",
  "finn/s2s-private-key": "s2sPrivateKey",
  "finn/redis-url": "redisUrl",
  "finn/metrics-auth-token": "metricsAuthToken",
  "finn/relayer-private-key": "relayerPrivateKey",
  "finn/merchant-address": "merchantAddress",
  "finn/kms-key-id": "kmsKeyId",
  "finn/audit-bucket-name": "auditBucketName",
  "finn/calibration-bucket-name": "calibrationBucketName",
  "finn/calibration-hmac-key": "calibrationHmacKey",
}

/** Env var → FinnSecrets field mapping (dev fallback). */
const ENV_MAP: Record<string, keyof FinnSecrets> = {
  ANTHROPIC_API_KEY: "anthropicApiKey",
  FINN_AUTH_TOKEN: "finnAuthToken",
  FINN_S2S_PRIVATE_KEY: "s2sPrivateKey",
  REDIS_URL: "redisUrl",
  METRICS_AUTH_TOKEN: "metricsAuthToken",
  FINN_RELAYER_PRIVATE_KEY: "relayerPrivateKey",
  FINN_MERCHANT_ADDRESS: "merchantAddress",
  FINN_KMS_KEY_ID: "kmsKeyId",
  FINN_AUDIT_BUCKET_NAME: "auditBucketName",
  FINN_CALIBRATION_BUCKET_NAME: "calibrationBucketName",
  FINN_CALIBRATION_HMAC_KEY: "calibrationHmacKey",
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load secrets from AWS Secrets Manager (production) or env vars (dev).
 *
 * Production: ECS task definition injects secrets via Secrets Manager ARNs.
 * The task role (see loa-finn-ecs.tf) has GetSecretValue permission.
 *
 * Dev: secrets come from .env or shell environment.
 */
export async function loadSecrets(
  client?: SecretsManagerClient,
): Promise<FinnSecrets> {
  const secrets: Partial<FinnSecrets> = {}

  if (client && process.env.NODE_ENV === "production") {
    // Production: fetch from Secrets Manager
    const fetches = Object.entries(SECRET_MAP).map(async ([secretId, field]) => {
      try {
        const result = await client.getSecretValue({ SecretId: secretId })
        if (result.SecretString) {
          secrets[field] = result.SecretString
        }
      } catch (err) {
        // Log but don't fail — some secrets are optional
        console.warn(JSON.stringify({
          metric: "secrets.fetch_error",
          secret_id: secretId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }))
      }
    })

    await Promise.all(fetches)
  } else {
    // Dev: load from env vars
    for (const [envVar, field] of Object.entries(ENV_MAP)) {
      const value = process.env[envVar]
      if (value) {
        secrets[field] = value
      }
    }
  }

  // Validate required secrets
  const required: (keyof FinnSecrets)[] = ["anthropicApiKey", "finnAuthToken"]
  const missing = required.filter(k => !secrets[k])
  if (missing.length > 0) {
    console.error(JSON.stringify({
      metric: "secrets.missing_required",
      missing,
      env: process.env.NODE_ENV,
      timestamp: Date.now(),
    }))
    // Don't throw — let the application start and fail at the point of use
    // This allows health checks to report the specific missing dependency
  }

  return secrets as FinnSecrets
}

/**
 * Check which optional secrets are available (for health endpoint).
 */
export function getSecretsHealth(secrets: FinnSecrets): Record<string, boolean> {
  return {
    anthropic_api_key: !!secrets.anthropicApiKey,
    auth_token: !!secrets.finnAuthToken,
    s2s_private_key: !!secrets.s2sPrivateKey,
    redis_url: !!secrets.redisUrl,
    relayer_private_key: !!secrets.relayerPrivateKey,
    merchant_address: !!secrets.merchantAddress,
    kms_key_id: !!secrets.kmsKeyId,
    audit_bucket: !!secrets.auditBucketName,
    calibration_bucket: !!secrets.calibrationBucketName,
  }
}
