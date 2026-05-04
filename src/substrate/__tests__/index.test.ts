// src/substrate/__tests__/index.test.ts — Programmatic Substrate.invoke() API tests.
//
// Cycle-032 Sprint-6 Task 6.4. See PRD FR-6 + SDD §4.10.

import { describe, it, expect, vi } from "vitest"
import { makeSubstrate, Substrate } from "../index.js"
import type { LoadedConstruct, ValidatedLicense } from "../types.js"
import type { SandboxBridge } from "../sandbox-bridge.js"

// ── Test helpers ────────────────────────────────────────────────────

const fakeLicense: ValidatedLicense = {
  fingerprint: "f",
  kid: "k",
  issuedAt: new Date(),
  expiresAt: new Date(Date.now() + 3_600_000),
  graceUntil: new Date(Date.now() + 7_200_000),
  tier: "pro",
  status: "valid",
}

function fakeLoaded(slug: string): LoadedConstruct {
  return {
    slug,
    entryPath: `/fake/${slug}/index.js`,
    license: fakeLicense,
    loadModule: async () => ({}),
    manifest: {
      name: slug,
      slug,
      version: "1.0.0",
      type: "substrate-construct",
      license: "MIT",
      schema_version: 1,
      executable: { entry: "index.js", export: "default", protocol: { input: "in", output: "out" } },
      runtime: { engine: "effect-ts" },
      requirements: [],
    } as unknown as LoadedConstruct["manifest"],
  }
}

function makeMockBridge(): SandboxBridge {
  return {
    invoke: vi.fn(async (loaded, _opts, input) => ({ status: "APPROVED", echo: input, slug: loaded.slug })),
    dispose: vi.fn(),
    shutdown: vi.fn(async () => {}),
    inFlightCount: () => 0,
  }
}

// ── makeSubstrate / Substrate.make ──────────────────────────────────

describe("makeSubstrate", () => {
  it("invoke(slug, input) routes through bridge with looked-up LoadedConstruct", async () => {
    const registry = new Map([["lore-essay-grader", fakeLoaded("lore-essay-grader")]])
    const bridge = makeMockBridge()
    const substrate = makeSubstrate({
      registry,
      bridge,
      runtimeOptsFor: (loaded) => ({
        agentId: `agent-${loaded.slug}`,
        tenantId: "default",
        poolId: "essay-pool",
        modelId: "claude-sonnet-4-6",
        tier: "pro",
      }),
    })

    const result = await substrate.invoke("lore-essay-grader", { essay: "x" })
    expect(result).toEqual({ status: "APPROVED", echo: { essay: "x" }, slug: "lore-essay-grader" })
    expect(bridge.invoke).toHaveBeenCalledOnce()
    const [calledLoaded, calledOpts, calledInput] = (bridge.invoke as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(calledLoaded.slug).toBe("lore-essay-grader")
    expect(calledOpts).toEqual({
      agentId: "agent-lore-essay-grader",
      tenantId: "default",
      poolId: "essay-pool",
      modelId: "claude-sonnet-4-6",
      tier: "pro",
    })
    expect(calledInput).toEqual({ essay: "x" })
  })

  it("invoke() rejects on unknown slug", async () => {
    const registry = new Map<string, LoadedConstruct>()
    const bridge = makeMockBridge()
    const substrate = makeSubstrate({
      registry,
      bridge,
      runtimeOptsFor: () => ({ agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }),
    })
    await expect(substrate.invoke("nope", null)).rejects.toThrow(/unknown substrate-construct slug/)
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it("dispose(slug) forwards to bridge", () => {
    const registry = new Map<string, LoadedConstruct>()
    const bridge = makeMockBridge()
    const substrate = makeSubstrate({
      registry,
      bridge,
      runtimeOptsFor: () => ({ agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }),
    })
    substrate.dispose("some-slug")
    expect(bridge.dispose).toHaveBeenCalledWith("some-slug")
  })

  it("shutdown() forwards to bridge", async () => {
    const registry = new Map<string, LoadedConstruct>()
    const bridge = makeMockBridge()
    const substrate = makeSubstrate({
      registry,
      bridge,
      runtimeOptsFor: () => ({ agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }),
    })
    await substrate.shutdown()
    expect(bridge.shutdown).toHaveBeenCalled()
  })

  it("registry is exposed for inspection", () => {
    const registry = new Map([["x", fakeLoaded("x")]])
    const bridge = makeMockBridge()
    const substrate = makeSubstrate({
      registry,
      bridge,
      runtimeOptsFor: () => ({ agentId: "", tenantId: "", poolId: "", modelId: "", tier: "" }),
    })
    expect(substrate.registry.get("x")).toBeDefined()
  })

  it("Substrate namespace export equals { make: makeSubstrate }", () => {
    expect(Substrate.make).toBe(makeSubstrate)
  })
})
