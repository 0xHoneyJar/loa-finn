// src/hounfour/protocol-handshake.ts — Protocol Version Handshake (SDD §3.2, Phase 5 T4)
// Boot-time validation: ensures loa-finn and arrakis agree on protocol version
// before the server starts accepting requests.

import { CONTRACT_VERSION, parseSemver } from "@0xhoneyjar/loa-hounfour"

// --- Constants ---

/**
 * loa-finn's own minimum supported version.
 * Bumped from 4.0.0 → 7.0.0 for v8.2.0 upgrade (cycle-033).
 * v7.9.2 accepted as grace period; v6.0.0 and below rejected.
 */
export const FINN_MIN_SUPPORTED = "7.0.0" as const

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

/** Feature detection based on remote version (Task 2.7, v7.11.0 convergence). */
export interface PeerFeatures {
  /** Remote supports trust_scopes (v6.0.0+). */
  trustScopes: boolean
  /** Remote supports reputation_gated access policies (v7.3.0+). */
  reputationGated: boolean
  /** Remote supports compound access policies with AND/OR (v7.4.0+). */
  compoundPolicies: boolean
  /** Remote supports economic boundary evaluation (v7.7.0+). */
  economicBoundary: boolean
  /** Remote supports denial codes and evaluation gaps (v7.9.1+). */
  denialCodes: boolean
  /** Remote supports task-dimensional reputation cohorts (v7.10.0+). */
  taskDimensionalRep: boolean
  /** Remote supports protocol-aligned hash chain (v7.10.1+). */
  hashChain: boolean
  /** Remote supports open enum task types (v7.11.0+). */
  openTaskTypes: boolean
  /** Remote supports commons governance module (v8.0.0+). */
  commonsModule: boolean
  /** Remote requires actor_id on GovernanceMutation (v8.1.0+). */
  governanceActorId: boolean
  /** Remote supports ModelPerformanceEvent as 4th ReputationEvent variant (v8.2.0+). */
  modelPerformance: boolean
}

/**
 * Arrakis health endpoint response contract (SDD §2.1.1, IMP-001).
 *
 * Versioning rules:
 *   - Parse contract_version with semver; failure → treat as unknown peer (all features false)
 *   - capabilities array absence → fall back to semver-only detection (v7.9.2 compat)
 *   - Unknown capabilities silently ignored (forward-compatible)
 *   - HTTP errors/timeouts → default PeerFeatures (all false)
 *
 * Transport security (SKP-005):
 *   - Health probes use service mesh mTLS, not per-request auth
 *   - Capabilities are hints for feature detection, not security-critical
 *   - Probes rate-limited (max 1 per 30s per peer, cached)
 *   - No per-request logging for probe responses
 */
export interface ArrakisHealthResponse {
  status: "ok" | "degraded" | "down"
  contract_version: string
  capabilities?: string[]
  trust_scopes?: Record<string, unknown>
}

/**
 * Version thresholds for protocol features.
 * Used by detectPeerFeatures() to determine capabilities from remote version.
 */
export const FEATURE_THRESHOLDS = {
  trustScopes:          { major: 6, minor: 0, patch: 0 },
  reputationGated:      { major: 7, minor: 3, patch: 0 },
  compoundPolicies:     { major: 7, minor: 4, patch: 0 },
  economicBoundary:     { major: 7, minor: 7, patch: 0 },
  denialCodes:          { major: 7, minor: 9, patch: 1 },
  taskDimensionalRep:   { major: 7, minor: 10, patch: 0 },
  hashChain:            { major: 7, minor: 10, patch: 1 },
  openTaskTypes:        { major: 7, minor: 11, patch: 0 },
  commonsModule:        { major: 8, minor: 0, patch: 0 },
  governanceActorId:    { major: 8, minor: 1, patch: 0 },
  modelPerformance:     { major: 8, minor: 2, patch: 0 },
} as const satisfies Record<keyof PeerFeatures, { major: number; minor: number; patch: number }>

/**
 * Ordered list of feature names for deterministic iteration.
 * Covers all PeerFeatures keys exactly once — TypeScript compile error if a key is missing.
 */
export const FEATURE_ORDER = [
  "trustScopes",
  "reputationGated",
  "compoundPolicies",
  "economicBoundary",
  "denialCodes",
  "taskDimensionalRep",
  "hashChain",
  "openTaskTypes",
  "commonsModule",
  "governanceActorId",
  "modelPerformance",
] as const satisfies readonly (keyof PeerFeatures)[]

/**
 * Feature thresholds in ordered array form, derived from FEATURE_ORDER and FEATURE_THRESHOLDS.
 * Thresholds are monotonically non-decreasing by version when iterated in order.
 */
export const FEATURE_THRESHOLDS_ORDERED = FEATURE_ORDER.map((name) => ({
  name,
  threshold: FEATURE_THRESHOLDS[name],
}))

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
 * Uses FINN_MIN_SUPPORTED (7.0.0) as the compatibility floor.
 * v7.x accepted as grace period (cross-major warning), v6.x and below rejected.
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

  let fetchTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    const controller = new AbortController()
    fetchTimeout = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(healthUrl, { signal: controller.signal })

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
  } finally {
    if (fetchTimeout) clearTimeout(fetchTimeout)
  }

  // Validate health response structure (Task 2.12)
  const validatedHealth = validateHealthResponse(healthData)
  if (!validatedHealth) {
    const msg = "arrakis health response has invalid structure"
    if (isProd) throw new Error(`[protocol-handshake] FATAL: ${msg}`)
    console.warn(`[protocol-handshake] ${msg} — continuing with default features (dev mode)`)
    return { ok: true, status: "degraded", message: `warn: ${msg}` }
  }

  // Extract contract_version
  const remoteVersion = validatedHealth.contract_version
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
  const peerFeatures = detectPeerFeatures(remoteVersion, validatedHealth)

  const warnSuffix = compat.warning ? ` (${compat.warning})` : ""
  const featureSummary = Object.entries(peerFeatures)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(",") || "none"
  console.log(`[protocol-handshake] status=compatible remote=${remoteVersion} features=${featureSummary}${warnSuffix}`)
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
 * Uses FINN_MIN_SUPPORTED (7.0.0) — accepts v7.9.2 as grace period,
 * rejects v6.0.0 and below. v8.x is the primary target.
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
 * Runtime structural validation for ArrakisHealthResponse (SDD §4.2, Task 2.12).
 * Uses typeof/in guards — no schema library (finn doesn't use zod/typebox).
 * Returns validated response or null (with logged warning) on invalid shape.
 */
function validateHealthResponse(data: Record<string, unknown>): ArrakisHealthResponse | null {
  // status must be a string
  if (typeof data.status !== "string") {
    console.warn("[protocol-handshake] Health response missing or invalid 'status' field")
    return null
  }

  // contract_version must be a string
  if (typeof data.contract_version !== "string") {
    console.warn("[protocol-handshake] Health response missing or invalid 'contract_version' field")
    return null
  }

  // capabilities is optional, but if present must be array of strings
  if (data.capabilities !== undefined) {
    if (!Array.isArray(data.capabilities)) {
      console.warn("[protocol-handshake] Health response 'capabilities' is not an array — ignoring")
      // Don't fail — just ignore capabilities
      return {
        status: data.status as "ok" | "degraded" | "down",
        contract_version: data.contract_version,
        trust_scopes: data.trust_scopes as Record<string, unknown> | undefined,
      }
    }
    // Filter out non-string entries (forward-compatible — unknown entries silently ignored)
    const validCapabilities = data.capabilities.filter((c: unknown) => typeof c === "string") as string[]
    return {
      status: data.status as "ok" | "degraded" | "down",
      contract_version: data.contract_version,
      capabilities: validCapabilities,
      trust_scopes: data.trust_scopes as Record<string, unknown> | undefined,
    }
  }

  return {
    status: data.status as "ok" | "degraded" | "down",
    contract_version: data.contract_version,
    trust_scopes: data.trust_scopes as Record<string, unknown> | undefined,
  }
}

/**
 * Detect peer features based on remote version and health response.
 * Uses dual-strategy detection (SDD §4.2):
 *   1. Capabilities array (primary) — explicit declaration from peer
 *   2. Semver FEATURE_THRESHOLDS (fallback) — backward compat with v7.9.2
 *   3. legacy_field (trustScopes only) — backward compat with pre-v7.0
 */
function detectPeerFeatures(remoteVersion: string, healthData: ArrakisHealthResponse): PeerFeatures {
  const remote = parseSemver(remoteVersion)
  const meetsThreshold = (threshold: { major: number; minor: number; patch: number }) =>
    compareSemver(remote, threshold) >= 0

  // Dual-strategy detection (SDD §4.2):
  // 1. Capabilities array (primary) — explicit declaration from peer
  // 2. Semver FEATURE_THRESHOLDS (fallback) — backward compat with v7.9.2
  // 3. legacy_field (trustScopes only) — backward compat with pre-v7.0
  const capabilities = healthData.capabilities
    ? new Set(healthData.capabilities)
    : null

  const detect = (capabilityName: string, threshold: { major: number; minor: number; patch: number }): boolean => {
    if (capabilities?.has(capabilityName)) return true
    return meetsThreshold(threshold)
  }

  return {
    trustScopes:        detect("trust_scopes", FEATURE_THRESHOLDS.trustScopes) || healthData.trust_scopes !== undefined,
    reputationGated:    detect("reputation_gated", FEATURE_THRESHOLDS.reputationGated),
    compoundPolicies:   detect("compound_policies", FEATURE_THRESHOLDS.compoundPolicies),
    economicBoundary:   detect("economic_boundary", FEATURE_THRESHOLDS.economicBoundary),
    denialCodes:        detect("denial_codes", FEATURE_THRESHOLDS.denialCodes),
    taskDimensionalRep: detect("task_dimensional_reputation", FEATURE_THRESHOLDS.taskDimensionalRep),
    hashChain:          detect("hash_chain", FEATURE_THRESHOLDS.hashChain),
    openTaskTypes:      detect("open_task_types", FEATURE_THRESHOLDS.openTaskTypes),
    commonsModule:      detect("commons_module", FEATURE_THRESHOLDS.commonsModule),
    governanceActorId:  detect("governance_actor_id", FEATURE_THRESHOLDS.governanceActorId),
    modelPerformance:   detect("model_performance", FEATURE_THRESHOLDS.modelPerformance),
  }
}
