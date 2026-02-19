// tests/finn/health.test.ts — Identity Health Check Tests (Sprint 16 Task 16.3)

import { describe, it, expect, vi } from "vitest"
import { getIdentityHealth, type IdentityHealthDeps } from "../../src/nft/health.js"

// ---------------------------------------------------------------------------
// Mock Graph Loader
// ---------------------------------------------------------------------------

function createMockGraphLoader(returnsGraph: boolean, throws = false) {
  return {
    load: throws
      ? vi.fn(() => { throw new Error("graph load failed") })
      : vi.fn(() => returnsGraph ? { nodes: [], edges: [] } : null),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getIdentityHealth", () => {
  it("should return all-healthy status when graph and codex are available", () => {
    const deps: IdentityHealthDeps = {
      graphLoader: createMockGraphLoader(true) as any,
      codexVersion: "v2.1.0",
    }

    const result = getIdentityHealth(deps)

    expect(result.graph_loaded).toBe(true)
    expect(result.codex_version).toBe("v2.1.0")
    expect(result.synthesis_available).toBe(true)
  })

  it("should return graph_loaded=false when no graphLoader provided", () => {
    const deps: IdentityHealthDeps = {
      codexVersion: "v2.1.0",
    }

    const result = getIdentityHealth(deps)

    expect(result.graph_loaded).toBe(false)
    expect(result.synthesis_available).toBe(false)
  })

  it("should return codex_version='unknown' when no codexVersion provided", () => {
    const deps: IdentityHealthDeps = {
      graphLoader: createMockGraphLoader(true) as any,
    }

    const result = getIdentityHealth(deps)

    expect(result.codex_version).toBe("unknown")
    expect(result.synthesis_available).toBe(false)
  })

  it("should return synthesis_available=false when graph loaded but codex unknown", () => {
    const deps: IdentityHealthDeps = {
      graphLoader: createMockGraphLoader(true) as any,
    }

    const result = getIdentityHealth(deps)

    expect(result.graph_loaded).toBe(true)
    expect(result.synthesis_available).toBe(false)
  })

  it("should return synthesis_available=false when codex available but no graph", () => {
    const deps: IdentityHealthDeps = {
      codexVersion: "v1.0.0",
    }

    const result = getIdentityHealth(deps)

    expect(result.graph_loaded).toBe(false)
    expect(result.synthesis_available).toBe(false)
  })

  it("should handle graphLoader.load() returning null", () => {
    const deps: IdentityHealthDeps = {
      graphLoader: createMockGraphLoader(false) as any,
      codexVersion: "v2.0.0",
    }

    const result = getIdentityHealth(deps)

    expect(result.graph_loaded).toBe(false)
    expect(result.synthesis_available).toBe(false)
  })

  it("should handle graphLoader.load() throwing an error", () => {
    const deps: IdentityHealthDeps = {
      graphLoader: createMockGraphLoader(false, true) as any,
      codexVersion: "v2.0.0",
    }

    const result = getIdentityHealth(deps)

    expect(result.graph_loaded).toBe(false)
    expect(result.synthesis_available).toBe(false)
  })

  it("should return degraded status with empty deps", () => {
    const result = getIdentityHealth({})

    expect(result.graph_loaded).toBe(false)
    expect(result.codex_version).toBe("unknown")
    expect(result.synthesis_available).toBe(false)
  })
})
