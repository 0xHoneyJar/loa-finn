// src/substrate/__tests__/worker-runtime-trust.test.ts —
// F4 (Bridgebuilder iter-1, MEDIUM): proves the trustedPacksDir prefix
// trailing-separator-guard correctly rejects path-prefix-collision attacks.
//
// Shape of the attack: register /trusted/packs as trusted, then the path
// /trusted/packs-evil/foo.js naively startsWith("/trusted/packs") would be
// admitted. The fix in registerTrustedPacksDir is to append `sep` to the
// canonical path so the prefix becomes /trusted/packs/, against which
// /trusted/packs-evil/... correctly fails.

import { describe, expect, it } from "vitest"
import { _clearWorkerRuntimeCaches, handleSubstrateInvoke, registerTrustedPacksDir } from "../worker-runtime.js"

const noopPort = { postMessage: () => undefined }
const baseRuntimeOpts = {
  agentId: "test-agent",
  tenantId: "test-tenant",
  poolId: "test-pool",
  modelId: "test-model",
  tier: "test-tier",
}

describe("F4: trustedPacksDir prefix-edge-case rejection", () => {
  it("rejects /trusted/packs-evil/foo.js when only /trusted/packs is registered (prefix-collision attack)", async () => {
    _clearWorkerRuntimeCaches()
    registerTrustedPacksDir("/test-f4-collision/packs")

    const result = await handleSubstrateInvoke(
      {
        jobId: "j-collision",
        slug: "slug-collision",
        modPath: "/test-f4-collision/packs-evil/foo.js",
        exportName: "main",
        input: {},
        runtimeOpts: baseRuntimeOpts,
      },
      noopPort,
    )

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { _tag: string } }).error._tag).toBe("ModPathTrustError")
  })

  it("admits a path inside the registered prefix (positive case — trust check passes; downstream import then fails for non-existent file)", async () => {
    _clearWorkerRuntimeCaches()
    registerTrustedPacksDir("/test-f4-positive/packs")

    const result = await handleSubstrateInvoke(
      {
        jobId: "j-positive",
        slug: "slug-positive",
        modPath: "/test-f4-positive/packs/nonexistent.js",
        exportName: "main",
        input: {},
        runtimeOpts: baseRuntimeOpts,
      },
      noopPort,
    )

    // Trust check passed → the failure mode is now from the dynamic import,
    // not from path-trust rejection. Assert NOT a ModPathTrustError.
    expect(result.ok).toBe(false)
    const err = (result as { ok: false; error: { _tag: string } }).error
    expect(err._tag).not.toBe("ModPathTrustError")
  })

  it("rejects the registered dir-itself (without trailing sep) — directory-vs-file boundary", async () => {
    _clearWorkerRuntimeCaches()
    registerTrustedPacksDir("/test-f4-diritself/packs")

    // The dir itself, no trailing slash. The registered prefix becomes
    // "/test-f4-diritself/packs/" so "/test-f4-diritself/packs" (no sep)
    // does NOT startsWith the prefix. Trust check rejects.
    const result = await handleSubstrateInvoke(
      {
        jobId: "j-diritself",
        slug: "slug-diritself",
        modPath: "/test-f4-diritself/packs",
        exportName: "main",
        input: {},
        runtimeOpts: baseRuntimeOpts,
      },
      noopPort,
    )

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { _tag: string } }).error._tag).toBe("ModPathTrustError")
  })
})
