// src/substrate/loader.ts — Filesystem scanner for substrate-construct packs.
//
// Cycle-032 Sprint-1 Task 1.4. See PRD FR-1 + SDD §4.2 + build doc §5.2.
//
// Responsibilities:
//   1. Scan packsDir for directories with construct.yaml of type substrate-construct
//   2. Parse + validate each manifest against inlined Zod schema
//   3. Validate JWT license at .license.json via jwt-validator
//   4. Resolve executable.entry to realpath under pack root (rejects traversal)
//   5. Return Map<slug, LoadedConstruct> with memoized lazy loadModule

import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"
import { packManifestSchema } from "./manifest-schema.js"
import type { JwtValidator } from "./jwt-validator.js"
import {
  EntryResolutionError,
  LicenseError,
  ManifestParseError,
  ManifestValidationError,
  type LoadedConstruct,
  type ValidatedPackManifest,
} from "./types.js"

export interface LoadOptions {
  /** Absolute path to the directory containing substrate-construct packs (one subdir per pack). */
  packsDir: string
  /** JWT validator instance. Loader calls validator.validate() per pack. */
  jwtValidator: JwtValidator
  /**
   * Optional filter: when present, ONLY packs whose slug is in this set are loaded.
   * Useful for tests + per-tenant scoping.
   */
  slugAllowlist?: ReadonlySet<string>
}

/**
 * Scan a packs directory and return a map of validated, license-checked
 * substrate-constructs ready to be invoked.
 *
 * Pure: no global state, no side effects beyond fs reads + JWT validator
 * cache (owned by validator instance).
 *
 * Each LoadedConstruct's `loadModule` is a memoized closure: first call does
 * `await import(pathToFileURL(entryPath))`, subsequent calls return the same
 * module instance (referential equality).
 */
export async function loadConstructsFromFilesystem(opts: LoadOptions): Promise<Map<string, LoadedConstruct>> {
  const result = new Map<string, LoadedConstruct>()

  const entries = await safeReaddir(opts.packsDir)
  for (const entry of entries) {
    const packDir = join(opts.packsDir, entry)
    const packStat = await safeStat(packDir)
    if (!packStat?.isDirectory()) continue

    const manifestPath = join(packDir, "construct.yaml")
    const manifestExists = await safeStat(manifestPath)
    if (!manifestExists?.isFile()) continue

    const loaded = await loadOneConstruct(packDir, manifestPath, opts.jwtValidator)
    if (!loaded) continue

    if (opts.slugAllowlist && !opts.slugAllowlist.has(loaded.slug)) continue

    result.set(loaded.slug, loaded)
  }

  return result
}

/**
 * Load a single construct from its pack directory. Returns null if the manifest
 * is not a substrate-construct (so the loader can silently skip skill-packs +
 * codex-packs co-located in the same packs dir).
 *
 * Throws ManifestParseError / ManifestValidationError / LicenseError /
 * EntryResolutionError for substrate-constructs that fail validation.
 */
async function loadOneConstruct(
  packDir: string,
  manifestPath: string,
  jwtValidator: JwtValidator,
): Promise<LoadedConstruct | null> {
  // 1. Parse YAML
  let raw: unknown
  let manifestText: string
  try {
    manifestText = await readFile(manifestPath, "utf-8")
    raw = parseYaml(manifestText)
  } catch (cause) {
    throw new ManifestParseError(packDir, cause)
  }
  if (raw == null || typeof raw !== "object") {
    throw new ManifestParseError(packDir, "manifest is not an object")
  }

  // Skip non-substrate constructs silently (allows mixed packs dir)
  const rawObj = raw as { type?: unknown }
  if (rawObj.type !== "substrate-construct") {
    return null
  }

  // 2. Validate against Zod schema (with substrate-construct superRefine)
  const parsed = packManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestValidationError(packDir, parsed.error.issues)
  }
  const manifest = parsed.data as ValidatedPackManifest

  // After superRefine, executable + runtime are guaranteed for substrate-construct
  // (Zod's safeParse would have rejected otherwise).
  if (!manifest.executable || !manifest.runtime) {
    // Defensive: should be unreachable thanks to superRefine
    throw new ManifestValidationError(packDir, [
      {
        code: "custom",
        path: ["executable"],
        message: "post-refine guarantee violated (executable/runtime missing)",
      },
    ])
  }

  // 3. Resolve executable.entry to realpath under pack root
  const packRealRoot = await realpath(packDir)
  const entryAbs = resolve(packRealRoot, manifest.executable.entry)
  let entryReal: string
  try {
    entryReal = await realpath(entryAbs)
  } catch (cause) {
    throw new EntryResolutionError(manifest.executable.entry, `cannot resolve entry path (${String(cause)})`)
  }
  // Realpath containment check: entryReal must live under packRealRoot
  if (!isPathContained(entryReal, packRealRoot)) {
    throw new EntryResolutionError(manifest.executable.entry, `path traversal detected (resolved to ${entryReal}, outside pack root ${packRealRoot})`)
  }

  // 4. Validate JWT license (.license.json)
  const licensePath = join(packDir, ".license.json")
  const licenseFile = await safeReadFile(licensePath)
  if (!licenseFile) {
    throw new LicenseError(`missing .license.json in pack ${packDir}`)
  }

  let licenseJson: { token?: string }
  try {
    licenseJson = JSON.parse(licenseFile)
  } catch (cause) {
    throw new LicenseError(`malformed .license.json in pack ${packDir}`, cause)
  }
  const token = licenseJson.token
  if (!token || typeof token !== "string") {
    throw new LicenseError(`.license.json missing "token" field in pack ${packDir}`)
  }

  const validation = await jwtValidator.validate(token)

  // 5. Build memoized loadModule closure
  let modulePromise: Promise<Record<string, unknown>> | null = null
  const loadModule = (): Promise<Record<string, unknown>> => {
    if (!modulePromise) {
      modulePromise = import(pathToFileURL(entryReal).href)
    }
    return modulePromise
  }

  return {
    slug: manifest.slug,
    manifest,
    entryPath: entryReal,
    loadModule,
    license: validation.license,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return null
  }
}

/**
 * Path-containment check that handles trailing-separator edge cases.
 * Returns true iff `child` is `parent` itself or strictly inside `parent`.
 */
function isPathContained(child: string, parent: string): boolean {
  const parentNormalized = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(parentNormalized)
}
