// src/substrate/manifest-schema.ts — Zod schemas for substrate-construct manifests.
//
// Cycle-032 Sprint-1 Task 1.4 (used by loader.ts).
//
// **Source provenance**: inlined from
//   `~/Documents/GitHub/loa-constructs/packages/shared/src/validation.ts`
//   commit context: loa-constructs#223 (substrate-construct schema merged 2026-05-03 PM)
//
// Why inlined (not imported from `@loa-constructs/shared`):
//   - loa-constructs is a monorepo; the `@loa-constructs/shared` package lives at
//     `packages/shared/` and isn't published to npm.
//   - Adding a github subpath dep is awkward and brittle.
//   - The substrate-construct schema is frozen at contract version 1.0.0 per cycle-1
//     sealing — drift risk is low.
//
// If the upstream schema evolves (e.g., new required field added to construct.yaml),
// re-sync this file from the canonical source. The schema covers the minimum surface
// the substrate runtime loader needs to validate; non-substrate fields (skills, commands,
// pricing, etc.) are accepted via `passthrough()` without validation here.

import { z } from "zod"

// ── Common schemas ──────────────────────────────────────────────────

const slugSchema = z
  .string()
  .min(3, "Slug must be at least 3 characters")
  .max(100, "Slug must be less than 100 characters")
  .regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, numbers, and hyphens")

const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/, "Invalid semver version")

// ── Construct type ──────────────────────────────────────────────────

export const constructTypeSchema = z.enum([
  "skill-pack",
  "tool-pack",
  "codex",
  "template",
  "substrate-construct",
])

// ── Substrate-Construct schemas (from loa-constructs#223) ───────────

/** Runtime engine declaration for substrate-constructs. */
export const substrateRuntimeSchema = z
  .object({
    engine: z.enum(["effect-ts", "vanilla-ts", "node"]).optional(),
    engine_version: z.string().max(50).optional(),
    node_version: z.string().max(50).optional(),
  })
  .passthrough()

/** Executable declaration. `entry` and `export` are required for substrate-construct. */
export const substrateExecutableSchema = z
  .object({
    entry: z.string().min(1).max(500),
    export: z.string().min(1).max(200),
    protocol: z
      .object({
        input: z.string().max(500).optional(),
        output: z.string().max(500).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

/** Effect Requirements channel declaration. */
export const substrateRequirementSchema = z
  .object({
    tag: z.string().min(1).max(200),
    contract: z.string().max(500).optional(),
    description: z.string().max(500).optional(),
  })
  .passthrough()

/** Single stream declaration on the read or write side. */
export const substrateStreamEntrySchema = z.union([
  z.string().min(1).max(200),
  z
    .object({
      subject: z.string().min(1).max(200),
      schema: z.string().max(500).optional(),
      narrows_to: z.string().max(500).optional(),
      from: z.string().max(500).optional(),
    })
    .passthrough(),
])

/** Streams declaration. */
export const substrateStreamsSchema = z
  .object({
    reads: z.array(substrateStreamEntrySchema).max(20).optional(),
    writes: z.array(substrateStreamEntrySchema).max(20).optional(),
  })
  .passthrough()

// ── Pack manifest (substrate-construct-aware subset) ────────────────

/**
 * Pack manifest schema with conditional substrate-construct refinement.
 *
 * For `type: substrate-construct`, the `superRefine` enforces presence of:
 *   - executable
 *   - executable.entry
 *   - executable.export
 *   - executable.protocol.input
 *   - executable.protocol.output
 *   - runtime
 *   - runtime.engine
 *
 * Per loa-constructs#223 superRefine logic. Other pack types pass through
 * without these constraints.
 */
export const packManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1).max(255),
    slug: slugSchema,
    version: semverSchema,
    type: constructTypeSchema.optional(),

    description: z.string().max(500).optional(),
    short_description: z.string().min(5).max(80).optional(),
    long_description: z.string().max(10000).optional(),
    author: z.union([z.string().max(255), z.unknown()]).optional(),
    license: z.string().max(50).default("MIT"),
    repository: z.string().url().optional(),
    homepage: z.string().url().optional(),

    schema_version: z.number().int().min(1).default(1),

    // Substrate-construct fields (required for type: substrate-construct, optional otherwise)
    executable: substrateExecutableSchema.optional(),
    runtime: substrateRuntimeSchema.optional(),
    requirements: z.array(substrateRequirementSchema).max(20).optional(),
    streams: substrateStreamsSchema.optional(),

    // Other pack-shape fields accepted but not validated here (skills, commands, etc.)
    // The substrate loader doesn't act on them.
  })
  .passthrough()
  .superRefine((manifest, ctx) => {
    if (manifest.type !== "substrate-construct") return

    if (!manifest.executable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executable"],
        message: "substrate-construct requires `executable`",
      })
      return
    }
    if (!manifest.executable.entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executable", "entry"],
        message: "substrate-construct requires `executable.entry`",
      })
    }
    if (!manifest.executable.export) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executable", "export"],
        message: "substrate-construct requires `executable.export`",
      })
    }
    if (!manifest.executable.protocol?.input) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executable", "protocol", "input"],
        message: "substrate-construct requires `executable.protocol.input`",
      })
    }
    if (!manifest.executable.protocol?.output) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executable", "protocol", "output"],
        message: "substrate-construct requires `executable.protocol.output`",
      })
    }
    if (!manifest.runtime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime"],
        message: "substrate-construct requires `runtime`",
      })
      return
    }
    if (!manifest.runtime.engine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "engine"],
        message: "substrate-construct requires `runtime.engine`",
      })
    }
  })
