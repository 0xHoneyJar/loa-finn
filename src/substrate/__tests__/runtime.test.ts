// src/substrate/__tests__/runtime.test.ts — ConstructRuntime composition + lifecycle.
//
// Cycle-032 Sprint-2 Task 2.4. See PRD FR-2 + SDD §4.4 + sprint plan.

import { describe, it, expect } from "vitest"
import { Context, Effect, Layer } from "effect"
import {
  AMBIENT_TAG_KEYS,
  CAPABILITY_BOUND_TAG_KEYS,
  RECOGNIZED_TAG_KEYS,
  composeLayer,
  createConstructRuntime,
} from "../runtime.js"
import { UnknownRequirementError, type LoadedConstruct, type ValidatedLicense } from "../types.js"

// ── Test helpers ────────────────────────────────────────────────────

class ModelRunnerTag extends Context.Tag("ModelRunner")<
  ModelRunnerTag,
  { complete: (params: { systemPrompt: string; userMessage: string }) => Effect.Effect<string> }
>() {}

class EventWriterTag extends Context.Tag("EventWriter")<
  EventWriterTag,
  { publish: (subject: string, payload: unknown) => Effect.Effect<void> }
>() {}

const buildMockModelRunnerLayer = (canned: string = "ok") =>
  Layer.succeed(ModelRunnerTag, {
    complete: () => Effect.succeed(canned),
  })

const buildMockEventWriterLayer = () =>
  Layer.succeed(EventWriterTag, {
    publish: () => Effect.void,
  })

const fakeLicense: ValidatedLicense = {
  fingerprint: "deadbeef",
  kid: "test-kid",
  issuedAt: new Date("2025-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-01T00:00:00Z"),
  graceUntil: new Date("2026-01-02T00:00:00Z"),
  tier: "pro",
  status: "valid",
}

function buildMockLoaded(opts: {
  slug?: string
  requirementTags?: string[]
  exportName?: string
  module?: Record<string, unknown>
} = {}): LoadedConstruct {
  const slug = opts.slug ?? "mock-construct"
  const exportName = opts.exportName ?? "default"
  const fakeModule = opts.module ?? {
    [exportName]: (input: unknown) =>
      Effect.gen(function* () {
        const runner = yield* ModelRunnerTag
        const text = yield* runner.complete({ systemPrompt: "sys", userMessage: String(input) })
        return { ok: true, text, echo: input }
      }),
  }

  return {
    slug,
    entryPath: `/fake/${slug}/entry.mjs`,
    license: fakeLicense,
    loadModule: async () => fakeModule,
    manifest: {
      name: slug,
      slug,
      version: "1.0.0",
      type: "substrate-construct",
      license: "MIT",
      schema_version: 1,
      executable: {
        entry: "entry.mjs",
        export: exportName,
        protocol: { input: "schemas/in.ts", output: "schemas/out.ts" },
      },
      runtime: { engine: "effect-ts" },
      requirements: (opts.requirementTags ?? []).map((tag) => ({ tag })),
    } as unknown as LoadedConstruct["manifest"],
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe("composeLayer", () => {
  it("returns Layer.empty for construct with no requirements", () => {
    const loaded = buildMockLoaded({ requirementTags: [] })
    const layer = composeLayer(loaded, {})
    expect(layer).toBe(Layer.empty)
  })

  it("composes ModelRunner Layer when declared", () => {
    const loaded = buildMockLoaded({ requirementTags: ["ModelRunner"] })
    const mockLayer = buildMockModelRunnerLayer("response")
    const layer = composeLayer(loaded, { modelRunnerLayer: mockLayer as never })
    expect(layer).toBeDefined()
  })

  it("merges ModelRunner + EventWriter when both declared", () => {
    const loaded = buildMockLoaded({ requirementTags: ["ModelRunner", "EventWriter"] })
    const layer = composeLayer(loaded, {
      modelRunnerLayer: buildMockModelRunnerLayer() as never,
      eventWriterLayer: buildMockEventWriterLayer() as never,
    })
    expect(layer).toBeDefined()
  })

  it("ignores ambient tags (Logger, Clock) — they don't require Layer in opts", () => {
    const loaded = buildMockLoaded({ requirementTags: ["Logger", "Clock"] })
    expect(() => composeLayer(loaded, {})).not.toThrow()
  })

  it("throws UnknownRequirementError for unknown Tag", () => {
    const loaded = buildMockLoaded({ requirementTags: ["UnknownService"] })
    expect(() => composeLayer(loaded, {})).toThrow(UnknownRequirementError)
  })

  it("throws UnknownRequirementError for ModelRunner declared without Layer in opts", () => {
    const loaded = buildMockLoaded({ requirementTags: ["ModelRunner"] })
    expect(() => composeLayer(loaded, {})).toThrow(UnknownRequirementError)
  })

  it("throws UnknownRequirementError for EventWriter declared without Layer in opts", () => {
    const loaded = buildMockLoaded({ requirementTags: ["EventWriter"] })
    expect(() => composeLayer(loaded, {})).toThrow(UnknownRequirementError)
  })

  it("does NOT inject ModelRunner if construct didn't declare it (capability-bounded invariant 8)", () => {
    const loaded = buildMockLoaded({ requirementTags: [] })
    // Even though we provide the Layer, composeLayer doesn't include it because
    // the construct didn't declare ModelRunner in requirements[]
    const layer = composeLayer(loaded, {
      modelRunnerLayer: buildMockModelRunnerLayer() as never,
    })
    expect(layer).toBe(Layer.empty)
  })
})

describe("RECOGNIZED_TAG_KEYS", () => {
  it("includes capability-bound + ambient tags", () => {
    expect(RECOGNIZED_TAG_KEYS).toEqual(new Set(["ModelRunner", "EventWriter", "Logger", "Clock"]))
  })

  it("AMBIENT_TAG_KEYS is exactly Logger and Clock (invariant — extending this is doctrine work)", () => {
    expect([...AMBIENT_TAG_KEYS]).toEqual(["Logger", "Clock"])
  })

  it("CAPABILITY_BOUND_TAG_KEYS is exactly ModelRunner and EventWriter", () => {
    expect([...CAPABILITY_BOUND_TAG_KEYS]).toEqual(["ModelRunner", "EventWriter"])
  })
})

describe("createConstructRuntime", () => {
  it("constructs runtime + invokes Effect program", async () => {
    const loaded = buildMockLoaded({ requirementTags: ["ModelRunner"] })
    const rt = createConstructRuntime(loaded, {
      modelRunnerLayer: buildMockModelRunnerLayer("hello") as never,
    })

    const result = await rt.invoke<string, { ok: boolean; text: string; echo: string }>("world")
    expect(result.ok).toBe(true)
    expect(result.text).toBe("hello")
    expect(result.echo).toBe("world")
    expect(rt.slug).toBe("mock-construct")
  })

  it("throws UnknownRequirementError synchronously at construction (NOT at invoke)", () => {
    const loaded = buildMockLoaded({ requirementTags: ["UnknownService"] })
    expect(() =>
      createConstructRuntime(loaded, {}),
    ).toThrow(UnknownRequirementError)
  })

  it("memoizes program resolution (loadModule called once)", async () => {
    let loadCount = 0
    const loaded: LoadedConstruct = {
      ...buildMockLoaded({ requirementTags: ["ModelRunner"] }),
      loadModule: async () => {
        loadCount++
        return {
          default: () =>
            Effect.gen(function* () {
              const runner = yield* ModelRunnerTag
              return yield* runner.complete({ systemPrompt: "s", userMessage: "u" })
            }),
        }
      },
    }
    const rt = createConstructRuntime(loaded, {
      modelRunnerLayer: buildMockModelRunnerLayer("x") as never,
    })
    await rt.invoke<unknown, string>(null)
    await rt.invoke<unknown, string>(null)
    await rt.invoke<unknown, string>(null)
    expect(loadCount).toBe(1)
    await rt.dispose()
  })

  it("dispose() releases runtime and rejects subsequent invokes", async () => {
    const loaded = buildMockLoaded({ requirementTags: ["ModelRunner"] })
    const rt = createConstructRuntime(loaded, {
      modelRunnerLayer: buildMockModelRunnerLayer("x") as never,
    })
    await rt.invoke<unknown, unknown>("first")
    expect(rt.isDisposed()).toBe(false)

    await rt.dispose()
    expect(rt.isDisposed()).toBe(true)

    await expect(rt.invoke<unknown, unknown>("after")).rejects.toThrow(/disposed/i)
  })

  it("dispose() is idempotent", async () => {
    const loaded = buildMockLoaded({ requirementTags: [] })
    const rt = createConstructRuntime(loaded, {})
    await rt.dispose()
    await rt.dispose() // should not throw
    expect(rt.isDisposed()).toBe(true)
  })

  it("supports programFactory override (for tests)", async () => {
    const loaded = buildMockLoaded({ requirementTags: [] })
    const factoryProgram = (input: unknown) => Effect.succeed({ overridden: true, input })
    const rt = createConstructRuntime(loaded, {
      programFactory: async () => factoryProgram as never,
    })
    const result = await rt.invoke<string, { overridden: boolean; input: string }>("x")
    expect(result.overridden).toBe(true)
    expect(result.input).toBe("x")
  })

  it("invoke() rejects when export is not callable", async () => {
    const loaded = buildMockLoaded({
      requirementTags: [],
      exportName: "notAFunction",
      module: { notAFunction: { not: "callable" } },
    })
    const rt = createConstructRuntime(loaded, {})
    await expect(rt.invoke<unknown, unknown>("x")).rejects.toThrow(/not callable/i)
  })
})
