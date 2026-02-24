// tests/finn/interop-handshake.test.ts — Interop Handshake Fixture (Sprint 65 Task 1.7)
//
// Verifies loa-finn v7.0.0 accepts handshakes from:
//   - arrakis v4.6.0 (transition period — synthetic fixture)
//   - arrakis v7.0.0 (current — exact match)
//   - versions below FINN_MIN_SUPPORTED (4.0.0) → rejected
//
// Arrakis source references (commit 3b19224b):
//   Health endpoint:  themes/sietch/src/api/routes/public.routes.ts:156
//     → Returns: { status, protocol_version: CONTRACT_VERSION, ... }
//   Compat endpoint:  themes/sietch/src/api/routes/public.routes.ts:174
//     → Returns: { contract_version: CONTRACT_VERSION, min_supported: MIN_SUPPORTED_VERSION }
//   Import:           themes/sietch/src/packages/core/protocol/arrakis-compat.ts:14
//     → import { validateCompatibility, CONTRACT_VERSION } from '@0xhoneyjar/loa-hounfour'
//   Pinned SHA:        packages/adapters/package.json:74
//     → github:0xHoneyJar/loa-hounfour#d091a3c0d4802402825fc7765bcc888f2477742f (v7.0.0)
//
// Wire captures: No stored captures from cycle-022 (PR #71). E2E billing tests
// existed but raw wire traffic was not preserved. Risk documented per acceptance criteria.

import { describe, it, expect, afterEach } from "vitest"
import {
  validateProtocolAtBoot,
  FINN_MIN_SUPPORTED,
  getProtocolInfo,
  FEATURE_THRESHOLDS,
  type HandshakeResult,
  type PeerFeatures,
} from "../../src/hounfour/protocol-handshake.js"
import { CONTRACT_VERSION } from "@0xhoneyjar/loa-hounfour"
import http from "node:http"

// --- Test Helpers ---

let mockServer: http.Server | null = null

/** Simulate an arrakis health endpoint returning a specific contract_version. */
function startArrakisHealth(
  contractVersion: string,
  extras?: Record<string, unknown>,
): Promise<number> {
  return new Promise((resolve) => {
    mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        status: "healthy",
        contract_version: contractVersion,
        ...extras,
      }))
    })
    mockServer.listen(0, () => {
      const addr = mockServer!.address()
      resolve(typeof addr === "object" && addr ? addr.port : 0)
    })
  })
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve())
      mockServer = null
    } else {
      resolve()
    }
  })
}

async function handshake(port: number): Promise<HandshakeResult> {
  return validateProtocolAtBoot({
    arrakisBaseUrl: `http://127.0.0.1:${port}`,
    env: "development",
  })
}

// --- Interop Tests ---

describe("Interop Handshake Fixtures", () => {
  afterEach(async () => {
    await stopMockServer()
  })

  // --- Arrakis v4.6.0 (transition period) ---

  it("accepts arrakis v4.6.0 handshake (above FINN_MIN_SUPPORTED)", async () => {
    // Synthetic fixture: arrakis v4.6.0 returns contract_version: '4.6.0'
    // This is above FINN_MIN_SUPPORTED (4.0.0) but below local (7.0.0)
    const port = await startArrakisHealth("4.6.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.remoteVersion).toBe("4.6.0")
    // Cross-major warning expected (remote major 4 < local major 7)
    expect(result.message).toContain("Cross-major version")
  })

  it("detects trust_scopes=false for arrakis v4.6.0", async () => {
    const port = await startArrakisHealth("4.6.0")
    const result = await handshake(port)

    expect(result.peerFeatures).toBeDefined()
    expect(result.peerFeatures!.trustScopes).toBe(false)
  })

  it("detects trust_scopes=true for arrakis v4.6.0 with explicit trust_scopes field", async () => {
    // Even if version is pre-6.0.0, if the health response includes trust_scopes,
    // feature detection should recognize it (forward-compatible)
    const port = await startArrakisHealth("4.6.0", { trust_scopes: ["read", "write"] })
    const result = await handshake(port)

    expect(result.peerFeatures).toBeDefined()
    expect(result.peerFeatures!.trustScopes).toBe(true)
  })

  // --- Arrakis v7.0.0 (same major, minor mismatch vs local 7.9.1) ---

  it("accepts arrakis v7.0.0 handshake (same major, minor mismatch)", async () => {
    const port = await startArrakisHealth("7.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.remoteVersion).toBe("7.0.0")
    // Same major — no cross-major warning
    expect(result.message).not.toContain("Cross-major")
    // Minor version mismatch expected: remote=7.0.0 vs local=7.9.1
    expect(result.message).toContain("Minor version mismatch")
  })

  it("detects trust_scopes=true for arrakis v7.0.0", async () => {
    const port = await startArrakisHealth("7.0.0")
    const result = await handshake(port)

    expect(result.peerFeatures).toBeDefined()
    expect(result.peerFeatures!.trustScopes).toBe(true)
  })

  // --- Boundary: FINN_MIN_SUPPORTED ---

  it("accepts exactly FINN_MIN_SUPPORTED (4.0.0)", async () => {
    const port = await startArrakisHealth("4.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
  })

  it("rejects version below FINN_MIN_SUPPORTED (3.9.9)", async () => {
    const port = await startArrakisHealth("3.9.9")
    const result = await handshake(port)

    // Dev mode: ok=true but status=incompatible
    expect(result.ok).toBe(true)
    expect(result.status).toBe("incompatible")
    expect(result.message).toContain("below minimum supported")
  })

  it("rejects version below FINN_MIN_SUPPORTED in production (throws)", async () => {
    const port = await startArrakisHealth("3.9.9")
    await expect(validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "production",
    })).rejects.toThrow("FATAL")
  })

  // --- Future version ---

  it("rejects future major version (8.0.0)", async () => {
    const port = await startArrakisHealth("8.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true) // dev mode
    expect(result.status).toBe("incompatible")
    expect(result.message).toContain("future major version")
  })

  // --- Version range coverage ---

  it("accepts v5.0.0 with cross-major warning", async () => {
    const port = await startArrakisHealth("5.0.0")
    const result = await handshake(port)

    expect(result.status).toBe("compatible")
    expect(result.message).toContain("Cross-major version")
    expect(result.peerFeatures!.trustScopes).toBe(false) // < 6.0.0
  })

  it("accepts v6.0.0 with cross-major warning and trust_scopes=true", async () => {
    const port = await startArrakisHealth("6.0.0")
    const result = await handshake(port)

    expect(result.status).toBe("compatible")
    expect(result.message).toContain("Cross-major version")
    expect(result.peerFeatures!.trustScopes).toBe(true) // >= 6.0.0
  })

  it("accepts v7.1.0 with minor mismatch warning", async () => {
    const port = await startArrakisHealth("7.1.0")
    const result = await handshake(port)

    expect(result.status).toBe("compatible")
    expect(result.message).toContain("Minor version mismatch")
  })

  // --- Feature detection thresholds (Task 2.7) ---

  it("FEATURE_THRESHOLDS covers all PeerFeatures keys", () => {
    const expectedKeys: (keyof PeerFeatures)[] = [
      "trustScopes",
      "reputationGated",
      "compoundPolicies",
      "economicBoundary",
      "denialCodes",
    ]
    for (const key of expectedKeys) {
      expect(FEATURE_THRESHOLDS[key]).toBeDefined()
      expect(FEATURE_THRESHOLDS[key].major).toBeGreaterThanOrEqual(4)
    }
  })

  it("v4.6.0: only trustScopes=false, all v7 features=false", async () => {
    const port = await startArrakisHealth("4.6.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(false)
    expect(f.reputationGated).toBe(false)
    expect(f.compoundPolicies).toBe(false)
    expect(f.economicBoundary).toBe(false)
    expect(f.denialCodes).toBe(false)
  })

  it("v7.0.0: trustScopes=true, all v7.3+ features=false", async () => {
    const port = await startArrakisHealth("7.0.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(false)
    expect(f.compoundPolicies).toBe(false)
    expect(f.economicBoundary).toBe(false)
    expect(f.denialCodes).toBe(false)
  })

  it("v7.3.0: reputationGated=true, compoundPolicies=false", async () => {
    const port = await startArrakisHealth("7.3.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(true)
    expect(f.compoundPolicies).toBe(false)
    expect(f.economicBoundary).toBe(false)
    expect(f.denialCodes).toBe(false)
  })

  it("v7.4.0: compoundPolicies=true, economicBoundary=false", async () => {
    const port = await startArrakisHealth("7.4.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(true)
    expect(f.compoundPolicies).toBe(true)
    expect(f.economicBoundary).toBe(false)
    expect(f.denialCodes).toBe(false)
  })

  it("v7.7.0: economicBoundary=true, denialCodes=false", async () => {
    const port = await startArrakisHealth("7.7.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(true)
    expect(f.compoundPolicies).toBe(true)
    expect(f.economicBoundary).toBe(true)
    expect(f.denialCodes).toBe(false)
  })

  it("v7.9.1: all features=true (full v7.9.2 protocol)", async () => {
    const port = await startArrakisHealth("7.9.1")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(true)
    expect(f.compoundPolicies).toBe(true)
    expect(f.economicBoundary).toBe(true)
    expect(f.denialCodes).toBe(true)
  })

  it("v7.9.0: denialCodes=false (requires v7.9.1+)", async () => {
    const port = await startArrakisHealth("7.9.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.denialCodes).toBe(false)
    expect(f.economicBoundary).toBe(true)
  })

  // --- Protocol info for /health ---

  it("getProtocolInfo returns correct version constants", () => {
    const info = getProtocolInfo()
    expect(info.contract_version).toBe(CONTRACT_VERSION)
    expect(info.contract_version).toBe("7.9.1")
    expect(info.finn_min_supported).toBe(FINN_MIN_SUPPORTED)
    expect(info.finn_min_supported).toBe("4.0.0")
  })
})
