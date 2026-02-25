// tests/finn/interop-handshake.test.ts — Interop Handshake Fixture (Sprint 132 Task 1.6)
//
// Verifies loa-finn v8.2.0 handshake acceptance window:
//   - v8.2.0 accepted (primary target, same major)
//   - v7.9.2 accepted (grace period — cross-major with warning)
//   - v6.0.0 rejected (below FINN_MIN_SUPPORTED 7.0.0)
//   - v9.0.0 rejected (future major)
//
// Feature thresholds now include v8.x capabilities:
//   commonsModule (8.0.0), governanceActorId (8.1.0), modelPerformance (8.2.0)

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

  // --- AC4: v8.2.0 accepted (primary target) ---

  it("accepts v8.2.0 handshake (exact match — primary target)", async () => {
    const port = await startArrakisHealth("8.2.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.remoteVersion).toBe("8.2.0")
  })

  it("accepts v8.0.0 with minor mismatch warning", async () => {
    const port = await startArrakisHealth("8.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.message).toContain("Minor version mismatch")
  })

  // --- AC4: v7.9.2 accepted (grace period, cross-major warning) ---

  it("accepts v7.9.2 handshake (grace period — cross-major warning)", async () => {
    const port = await startArrakisHealth("7.9.2")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.remoteVersion).toBe("7.9.2")
    expect(result.message).toContain("Cross-major version")
  })

  it("accepts v7.0.0 with cross-major warning", async () => {
    const port = await startArrakisHealth("7.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
    expect(result.message).toContain("Cross-major version")
  })

  it("accepts exactly FINN_MIN_SUPPORTED (7.0.0)", async () => {
    const port = await startArrakisHealth("7.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("compatible")
  })

  // --- AC4: v6.0.0 rejected ---

  it("rejects v6.0.0 (below FINN_MIN_SUPPORTED 7.0.0)", async () => {
    const port = await startArrakisHealth("6.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true) // dev mode
    expect(result.status).toBe("incompatible")
    expect(result.message).toContain("below minimum supported")
  })

  it("rejects v4.6.0 (below FINN_MIN_SUPPORTED 7.0.0)", async () => {
    const port = await startArrakisHealth("4.6.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true) // dev mode
    expect(result.status).toBe("incompatible")
    expect(result.message).toContain("below minimum supported")
  })

  it("rejects v6.9.9 in production (throws FATAL)", async () => {
    const port = await startArrakisHealth("6.9.9")
    await expect(validateProtocolAtBoot({
      arrakisBaseUrl: `http://127.0.0.1:${port}`,
      env: "production",
    })).rejects.toThrow("FATAL")
  })

  // --- Future version ---

  it("rejects future major version (9.0.0)", async () => {
    const port = await startArrakisHealth("9.0.0")
    const result = await handshake(port)

    expect(result.ok).toBe(true) // dev mode
    expect(result.status).toBe("incompatible")
    expect(result.message).toContain("future major version")
  })

  // --- Feature detection: v8.x thresholds ---

  it("FEATURE_THRESHOLDS covers all PeerFeatures keys", () => {
    const expectedKeys: (keyof PeerFeatures)[] = [
      "trustScopes",
      "reputationGated",
      "compoundPolicies",
      "economicBoundary",
      "denialCodes",
      "commonsModule",
      "governanceActorId",
      "modelPerformance",
    ]
    for (const key of expectedKeys) {
      expect(FEATURE_THRESHOLDS[key]).toBeDefined()
      expect(FEATURE_THRESHOLDS[key].major).toBeGreaterThanOrEqual(6)
    }
  })

  it("v7.9.2: all v7 features=true, all v8 features=false", async () => {
    const port = await startArrakisHealth("7.9.2")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(true)
    expect(f.compoundPolicies).toBe(true)
    expect(f.economicBoundary).toBe(true)
    expect(f.denialCodes).toBe(true)
    expect(f.commonsModule).toBe(false)
    expect(f.governanceActorId).toBe(false)
    expect(f.modelPerformance).toBe(false)
  })

  it("v8.0.0: commonsModule=true, governanceActorId=false", async () => {
    const port = await startArrakisHealth("8.0.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.denialCodes).toBe(true)
    expect(f.commonsModule).toBe(true)
    expect(f.governanceActorId).toBe(false)
    expect(f.modelPerformance).toBe(false)
  })

  it("v8.1.0: governanceActorId=true, modelPerformance=false", async () => {
    const port = await startArrakisHealth("8.1.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.commonsModule).toBe(true)
    expect(f.governanceActorId).toBe(true)
    expect(f.modelPerformance).toBe(false)
  })

  it("v8.2.0: all features=true (full v8.2.0 protocol)", async () => {
    const port = await startArrakisHealth("8.2.0")
    const result = await handshake(port)
    const f = result.peerFeatures!
    expect(f.trustScopes).toBe(true)
    expect(f.reputationGated).toBe(true)
    expect(f.compoundPolicies).toBe(true)
    expect(f.economicBoundary).toBe(true)
    expect(f.denialCodes).toBe(true)
    expect(f.commonsModule).toBe(true)
    expect(f.governanceActorId).toBe(true)
    expect(f.modelPerformance).toBe(true)
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
    expect(f.commonsModule).toBe(false)
  })

  it("detects trust_scopes=true for v7.0.0 with explicit trust_scopes field", async () => {
    const port = await startArrakisHealth("7.0.0", { trust_scopes: ["read", "write"] })
    const result = await handshake(port)
    expect(result.peerFeatures!.trustScopes).toBe(true)
  })

  // --- Protocol info for /health ---

  it("getProtocolInfo returns correct version constants", () => {
    const info = getProtocolInfo()
    expect(info.contract_version).toBe(CONTRACT_VERSION)
    expect(info.contract_version).toBe("8.2.0")
    expect(info.finn_min_supported).toBe(FINN_MIN_SUPPORTED)
    expect(info.finn_min_supported).toBe("7.0.0")
  })
})
