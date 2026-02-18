// src/hounfour/protocol-handshake.ts — Protocol Version Handshake (SDD §3.2, Phase 5 T4)
// Boot-time validation: ensures loa-finn and arrakis agree on protocol version
// before the server starts accepting requests.

import { CONTRACT_VERSION, parseSemver } from "@0xhoneyjar/loa-hounfour"

// --- Constants ---

/**
 * loa-finn's own minimum supported version.
 * Wider than loa-hounfour v7's MIN_SUPPORTED_VERSION (6.0.0) because
 * arrakis is at v4.6.0 during the transition period.
 */
export const FINN_MIN_SUPPORTED = "4.0.0" as const

// --- Types ---

export interface HandshakeConfig {
  /** Explicit base URL for arrakis health endpoint (ARRAKIS_BASE_URL) */
  arrakisBaseUrl?: string
  /** Billing URL — used to derive base URL if arrakisBaseUrl not set */
  billingUrl?: string
  /** NODE_ENV or equivalent — "production" for fail-fast */
  env: string
}

// WHY: Kubernetes health probes distinguish Ready/NotReady/Unknown — collapsing
// success states loses observability. A startup dashboard showing "handshake: ok"
// is meaningless if "ok" means "we didn't even try." See Finding #5 (PR #68).
export type HandshakeStatus = "compatible" | "skipped" | "degraded" | "incompatible"

export interface HandshakeResult {
  ok: boolean           // Always true when result is returned (dev); prod failures throw
  status: HandshakeStatus
  remoteVersion?: string
  peerFeatures?: PeerFeatures
  message: string
}

/** Feature detection based on remote version. */
export interface PeerFeatures {
  /** Remote supports trust_scopes (v6.0.0+). */
  trustScopes: boolean
}

// --- Public ---

/** Protocol version info for /health endpoint. */
export function getProtocolInfo(): {
  contract_version: string
  finn_min_supported: string
} {
  return {
    contract_version: CONTRACT_VERSION,
    finn_min_supported: FINN_MIN_SUPPORTED,
  }
}

/**
 * Validate protocol compatibility with arrakis at boot time.
 * MUST be called before server.listen().
 *
 * Uses FINN_MIN_SUPPORTED (4.0.0) instead of loa-hounfour's MIN_SUPPORTED_VERSION (6.0.0)
 * to maintain backward compatibility with arrakis v4.6.0 during the transition.
 *
 * Production: incompatible/unreachable/missing → throws (fail-fast)
 * Development: incompatible/unreachable/missing → warns + continues
 */
export async function validateProtocolAtBoot(config: HandshakeConfig): Promise<HandshakeResult> {
  const isProd = config.env === "production"

  // Derive base URL
  const baseUrl = deriveBaseUrl(config)
  if (!baseUrl) {
    if (isProd) {
      throw new Error("[protocol-handshake] FATAL: neither ARRAKIS_BASE_URL nor ARRAKIS_BILLING_URL configured")
    }
    console.warn("[protocol-handshake] no arrakis URL configured — skipping handshake (dev mode)")
    return { ok: true, status: "skipped", message: "skipped: no URL configured (dev)" }
  }

  // Fetch health endpoint
  const healthUrl = `${baseUrl}/api/internal/health`
  let healthData: Record<string, unknown>

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(healthUrl, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) {
      const msg = `health endpoint returned ${response.status}`
      if (isProd) throw new Error(`[protocol-handshake] FATAL: ${msg}`)
      console.warn(`[protocol-handshake] ${msg} — continuing (dev mode)`)
      return { ok: true, status: "degraded", message: `warn: ${msg}` }
    }

    healthData = await response.json() as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[protocol-handshake] FATAL")) throw err
    const reason = err instanceof Error ? err.message : String(err)
    const msg = `arrakis unreachable: ${reason}`
    if (isProd) throw new Error(`[protocol-handshake] FATAL: ${msg}`)
    console.warn(`[protocol-handshake] ${msg} — continuing (dev mode)`)
    return { ok: true, status: "degraded", message: `warn: ${msg}` }
  }

  // Extract contract_version
  const remoteVersion = healthData.contract_version
  if (typeof remoteVersion !== "string" || !remoteVersion) {
    const msg = "arrakis health response missing contract_version — upgrade arrakis"
    if (isProd) throw new Error(`[protocol-handshake] FATAL: ${msg}`)
    console.warn(`[protocol-handshake] ${msg} — continuing (dev mode)`)
    return { ok: true, status: "degraded", message: `warn: ${msg}` }
  }

  // Validate compatibility using finn-specific acceptance window [4.0.0, 7.x]
  const compat = finnValidateCompatibility(remoteVersion)
  if (!compat.compatible) {
    const msg = `incompatible protocol: ${compat.error} (remote=${remoteVersion})`
    if (isProd) throw new Error(`[protocol-handshake] FATAL: ${msg}`)
    console.warn(`[protocol-handshake] ${msg} — continuing (dev mode)`)
    return { ok: true, status: "incompatible", remoteVersion, message: msg }
  }

  // Feature detection
  const peerFeatures = detectPeerFeatures(remoteVersion, healthData)

  const warnSuffix = compat.warning ? ` (${compat.warning})` : ""
  console.log(`[protocol-handshake] status=compatible remote=${remoteVersion} trustScopes=${peerFeatures.trustScopes}${warnSuffix}`)
  return {
    ok: true,
    status: "compatible",
    remoteVersion,
    peerFeatures,
    message: `compatible: remote=${remoteVersion}${warnSuffix}`,
  }
}

// --- Helpers ---

/**
 * Derive arrakis base URL from config.
 * Priority: ARRAKIS_BASE_URL > new URL(billingUrl).origin
 */
export function deriveBaseUrl(config: HandshakeConfig): string | null {
  if (config.arrakisBaseUrl) return config.arrakisBaseUrl.replace(/\/+$/, "")
  if (config.billingUrl) {
    try {
      return new URL(config.billingUrl).origin
    } catch {
      return null
    }
  }
  return null
}

type CompatResult =
  | { compatible: true; warning?: string }
  | { compatible: false; error: string }

/**
 * loa-finn-specific compatibility check.
 * Uses FINN_MIN_SUPPORTED (4.0.0) for wider acceptance than loa-hounfour v7's
 * MIN_SUPPORTED_VERSION (6.0.0), allowing arrakis v4.6.0 during transition.
 */
function finnValidateCompatibility(remoteVersion: string): CompatResult {
  let remote
  try {
    remote = parseSemver(remoteVersion)
  } catch {
    return {
      compatible: false,
      error: `Invalid contract version format: "${remoteVersion}". Expected semver (e.g., ${CONTRACT_VERSION}).`,
    }
  }

  const local = parseSemver(CONTRACT_VERSION)
  const min = parseSemver(FINN_MIN_SUPPORTED)

  // Below finn's minimum supported → incompatible
  if (compareSemver(remote, min) < 0) {
    return {
      compatible: false,
      error: `Version ${remoteVersion} is below minimum supported ${FINN_MIN_SUPPORTED}.`,
    }
  }

  // Future major version → incompatible
  if (remote.major > local.major) {
    return {
      compatible: false,
      error: `Version ${remoteVersion} is a future major version (local=${CONTRACT_VERSION}). Upgrade loa-finn.`,
    }
  }

  // Cross-major within support window — compatible with warning
  if (remote.major < local.major) {
    return {
      compatible: true,
      warning: `Cross-major version: remote=${remoteVersion}, local=${CONTRACT_VERSION}. Set X-Contract-Version-Warning header.`,
    }
  }

  // Same major, minor version difference — compatible with warning
  if (remote.minor !== local.minor) {
    return {
      compatible: true,
      warning: `Minor version mismatch: remote=${remoteVersion}, local=${CONTRACT_VERSION}.`,
    }
  }

  // Exact match or patch difference — fully compatible
  return { compatible: true }
}

function compareSemver(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/**
 * Detect peer features based on remote version and health response.
 * trust_scopes is a v6.0.0+ feature.
 */
function detectPeerFeatures(remoteVersion: string, healthData: Record<string, unknown>): PeerFeatures {
  const remote = parseSemver(remoteVersion)
  return {
    trustScopes: remote.major >= 6 || "trust_scopes" in healthData,
  }
}
