// src/substrate/index.ts — Public substrate-runtime API barrel export.
//
// Cycle-032 Sprint-6. See PRD FR-6 + SDD §4.10.
//
// Programmatic surface for cycle-3 freeside-quests/apps/api consumers and
// the operator CLI. The TYPES are the API.

// ── Loader + types ──────────────────────────────────────────────────
export { loadConstructsFromFilesystem } from "./loader.js"
export type { LoadOptions } from "./loader.js"
export {
  type LoadedConstruct,
  type ValidatedLicense,
  type ValidatedPackManifest,
  type LicenseTier,
  type ValidationStatus,
  TIER_GRACE_SECONDS,
  ManifestParseError,
  ManifestValidationError,
  LicenseError,
  EntryResolutionError,
  UnknownRequirementError,
} from "./types.js"

// ── JWT validator ───────────────────────────────────────────────────
export { makeJwtValidator } from "./jwt-validator.js"
export type { JwtValidator, JwtValidatorOptions, ValidationResult } from "./jwt-validator.js"

// ── Manifest schema (for operators authoring custom validators) ─────
export { packManifestSchema } from "./manifest-schema.js"

// ── Runtime composition ─────────────────────────────────────────────
export {
  composeLayer,
  createConstructRuntime,
  AMBIENT_TAG_KEYS,
  CAPABILITY_BOUND_TAG_KEYS,
  RECOGNIZED_TAG_KEYS,
} from "./runtime.js"
export type { ConstructRuntime, ConstructRuntimeOptions } from "./runtime.js"

// ── Layers ──────────────────────────────────────────────────────────
export { buildModelRunnerLayer, ModelRunner, ModelRunnerError, mapErrorToModelRunnerError } from "./model-runner-layer.js"
export type { BuildModelRunnerLayerOptions, ModelInvoker } from "./model-runner-layer.js"

export {
  buildEventWriterLayer,
  EventWriter as EventWriterTag,
  EventWriterError,
  SubjectError,
  validateSubject,
} from "./event-writer-layer.js"
export type { BuildEventWriterLayerOptions } from "./event-writer-layer.js"

// ── Sandbox bridge (parent-side) ────────────────────────────────────
export { makeSandboxBridge } from "./sandbox-bridge.js"
export type { SandboxBridge, SandboxBridgeOptions, RuntimeOpts } from "./sandbox-bridge.js"

// ── Top-level Substrate facade ──────────────────────────────────────

import type { LoadedConstruct } from "./types.js"
import type { SandboxBridge, RuntimeOpts } from "./sandbox-bridge.js"

/**
 * Top-level facade for substrate-construct invocation. Wraps a registry of
 * loaded constructs + a sandbox bridge into a single entry point per the
 * `Substrate.invoke(slug, input)` programmatic API in PRD FR-6.
 *
 * Construction is left to operators because production wiring requires
 * concrete `JwtValidator`, `ModelInvoker`, and `EventStoreWriter`
 * instances — passing those through here would couple this facade to
 * cheval/EventStore concretes. Keep the facade thin; let the caller wire.
 */
export function makeSubstrate(deps: {
  registry: Map<string, LoadedConstruct>
  bridge: SandboxBridge
  runtimeOptsFor: (loaded: LoadedConstruct) => RuntimeOpts
}): {
  invoke: (slug: string, input: unknown) => Promise<unknown>
  dispose: (slug: string) => void
  shutdown: () => Promise<void>
  registry: Map<string, LoadedConstruct>
} {
  return {
    registry: deps.registry,
    invoke: async (slug, input) => {
      const loaded = deps.registry.get(slug)
      if (!loaded) {
        throw new Error(`unknown substrate-construct slug: "${slug}"`)
      }
      const runtimeOpts = deps.runtimeOptsFor(loaded)
      return deps.bridge.invoke(loaded, runtimeOpts, input)
    },
    dispose: (slug) => deps.bridge.dispose(slug),
    shutdown: () => deps.bridge.shutdown(),
  }
}

// Conventional namespace export. Construction is via makeSubstrate; this
// shorthand is just for ergonomic import.
export const Substrate = { make: makeSubstrate }
