// src/substrate/runtime.ts — Per-construct Effect runtime composition.
//
// Cycle-032 Sprint-2. See PRD FR-2 + SDD §4.4 + build doc §5.3.
//
// Contract:
//   - composeLayer(loaded, layers) → Layer scoped to declared requirements
//   - createConstructRuntime(loaded, opts) → ConstructRuntime { slug, invoke, dispose }
//   - Capability-bounded: a construct can only request services in {ModelRunner, EventWriter}
//     ∪ AMBIENT_TAG_KEYS. UnknownRequirementError thrown at composition time, NOT invoke time.
//   - ManagedRuntime created once per ConstructRuntime instance (Layer construction is expensive)
//   - dispose() releases all Layer-allocated resources via runtime.dispose()
//
// NOT in this sprint:
//   - Per-worker per-construct cache (sprint-5: worker-runtime.ts owns that — this module's
//     ConstructRuntime is the per-(worker, slug) building block; worker-runtime.ts memoizes
//     instances by slug within each worker)

import { Effect, Layer, ManagedRuntime } from "effect"
import type { LoadedConstruct } from "./types.js"
import { UnknownRequirementError } from "./types.js"

/**
 * Tags the runtime provides unconditionally (ambient allowlist invariant per
 * PRD FR-2). Logger and Clock have no I/O capability — they are pure service
 * defaults Effect needs to function. Adding to this set requires doctrine
 * amendment + invariant-8 re-review.
 */
export const AMBIENT_TAG_KEYS = ["Logger", "Clock"] as const

/**
 * Tags the loader has Layer factories for. Capability-bound: must appear in
 * `construct.yaml#requirements[].tag` to be provided to the construct.
 */
export const CAPABILITY_BOUND_TAG_KEYS = ["ModelRunner", "EventWriter"] as const

/**
 * Set of all Tag keys the loader recognizes. A construct may only declare
 * requirements whose `tag` field is in this set.
 */
export const RECOGNIZED_TAG_KEYS = new Set<string>([
  ...CAPABILITY_BOUND_TAG_KEYS,
  ...AMBIENT_TAG_KEYS,
])

// ── Public surface ──────────────────────────────────────────────────

export interface ConstructRuntimeOptions {
  /** Layer providing the ModelRunner Tag. Must be present iff construct declares "ModelRunner". */
  modelRunnerLayer?: Layer.Layer<unknown, never, never>
  /** Layer providing the EventWriter Tag. Must be present iff construct declares "EventWriter". */
  eventWriterLayer?: Layer.Layer<unknown, never, never>
  /** Override: factory for the construct's program. Defaults to `loadModule` + `manifest.executable.export`. Useful for tests. */
  programFactory?: (loaded: LoadedConstruct) => Promise<(input: unknown) => Effect.Effect<unknown, unknown, unknown>>
}

export interface ConstructRuntime {
  slug: string
  /** Run the construct's Effect program with the composed Layer. */
  invoke<I, O>(input: I): Promise<O>
  /** Release all Layer-allocated resources. After dispose(), invoke() rejects. */
  dispose(): Promise<void>
  /** Visible-for-tests: whether dispose has been called. */
  isDisposed(): boolean
}

/**
 * Compose the Effect Layer for a loaded construct per its declared requirements.
 *
 * Throws `UnknownRequirementError` synchronously if the construct declares a
 * Tag the loader doesn't recognize, or a capability-bound Tag whose Layer
 * wasn't provided in opts.
 *
 * Ambient services (Logger, Clock) are always merged in even if not declared,
 * because Effect needs them to run; they are documented in the ambient
 * allowlist invariant (PRD FR-2 capability rule).
 */
export function composeLayer(
  loaded: LoadedConstruct,
  opts: Pick<ConstructRuntimeOptions, "modelRunnerLayer" | "eventWriterLayer">,
): Layer.Layer<unknown, never, never> {
  const declaredTags = (loaded.manifest.requirements ?? []).map((r) => r.tag)

  // Capability check: every declared tag must be recognized
  for (const tag of declaredTags) {
    if (!RECOGNIZED_TAG_KEYS.has(tag)) {
      throw new UnknownRequirementError(tag)
    }
  }

  // Capability check: capability-bound tags must have matching Layer in opts
  const layers: Array<Layer.Layer<unknown, never, never>> = []
  for (const tag of declaredTags) {
    if (tag === "ModelRunner") {
      if (!opts.modelRunnerLayer) {
        throw new UnknownRequirementError(
          `ModelRunner declared in requirements[] but no modelRunnerLayer provided in opts`,
        )
      }
      layers.push(opts.modelRunnerLayer)
    } else if (tag === "EventWriter") {
      if (!opts.eventWriterLayer) {
        throw new UnknownRequirementError(
          `EventWriter declared in requirements[] but no eventWriterLayer provided in opts`,
        )
      }
      layers.push(opts.eventWriterLayer)
    }
    // Logger / Clock fall through: ambient (Effect provides defaults)
  }

  // Note: we do NOT inject ModelRunner / EventWriter Layers if the construct
  // didn't declare them — capability-bounded principle. Logger and Clock are
  // ambient and provided by Effect's default runtime.
  if (layers.length === 0) {
    // Layer.empty is Layer<never, never, never>; widen to the public return type
    return Layer.empty as Layer.Layer<unknown, never, never>
  }
  if (layers.length === 1) {
    return layers[0]!
  }
  // Effect's Layer.mergeAll takes a tuple — fold left. Layer.merge widens
  // input variance, so we cast the seed back to the public return type.
  return layers.reduce((acc, l) => Layer.merge(acc, l)) as Layer.Layer<unknown, never, never>
}

/**
 * Build a ConstructRuntime for a loaded construct.
 *
 * The ManagedRuntime is constructed lazily on first `invoke()` — Layer
 * composition happens synchronously in this call (so capability errors throw
 * here), but the runtime itself defers expensive setup.
 */
export function createConstructRuntime(
  loaded: LoadedConstruct,
  opts: ConstructRuntimeOptions = {},
): ConstructRuntime {
  // Compose Layer eagerly so capability errors throw at construction time.
  const layer = composeLayer(loaded, opts)

  let runtime: ManagedRuntime.ManagedRuntime<unknown, never> | null = null
  let disposed = false
  let cachedProgram: ((input: unknown) => Effect.Effect<unknown, unknown, unknown>) | null = null

  async function getProgram(): Promise<(input: unknown) => Effect.Effect<unknown, unknown, unknown>> {
    if (cachedProgram) return cachedProgram

    const factory = opts.programFactory
    if (factory) {
      cachedProgram = await factory(loaded)
      return cachedProgram
    }

    const mod = await loaded.loadModule()
    const exportName = loaded.manifest.executable?.export
    if (!exportName) {
      // Should be unreachable due to manifest schema superRefine, but defend
      throw new Error(`Construct ${loaded.slug} has no executable.export declared`)
    }
    const program = mod[exportName] as unknown
    if (typeof program !== "function") {
      throw new Error(`Construct ${loaded.slug} export "${exportName}" is not callable`)
    }
    cachedProgram = program as (input: unknown) => Effect.Effect<unknown, unknown, unknown>
    return cachedProgram
  }

  function getRuntime(): ManagedRuntime.ManagedRuntime<unknown, never> {
    if (!runtime) {
      runtime = ManagedRuntime.make(layer)
    }
    return runtime
  }

  async function invoke<I, O>(input: I): Promise<O> {
    if (disposed) {
      throw new Error(`ConstructRuntime ${loaded.slug} has been disposed`)
    }
    const program = await getProgram()
    const rt = getRuntime()
    const result = await rt.runPromise(program(input as unknown))
    return result as O
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    if (runtime) {
      await runtime.dispose()
      runtime = null
    }
    cachedProgram = null
  }

  return {
    slug: loaded.slug,
    invoke,
    dispose,
    isDisposed: () => disposed,
  }
}
