// src/hounfour/protocol-handshake.ts — Protocol Version Handshake (SDD §3.2, Phase 5 T4)
// Boot-time validation: ensures loa-finn and arrakis agree on protocol version
// before the server starts accepting requests.

import { validateCompatibility } from "@0xhoneyjar/loa-hounfour"

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
  message: string
}

// --- Public ---

/**
 * Validate protocol compatibility with arrakis at boot time.
 * MUST be called before server.listen().
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

  // Validate compatibility using loa-hounfour
  const compat = validateCompatibility(remoteVersion)
  if (!compat.compatible) {
    const msg = `incompatible protocol: ${compat.error} (remote=${remoteVersion})`
    if (isProd) throw new Error(`[protocol-handshake] FATAL: ${msg}`)
    console.warn(`[protocol-handshake] ${msg} — continuing (dev mode)`)
    return { ok: true, status: "incompatible", remoteVersion, message: msg }
  }

  console.log(`[protocol-handshake] status=compatible remote=${remoteVersion}`)
  return { ok: true, status: "compatible", remoteVersion, message: `compatible: remote=${remoteVersion}` }
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
