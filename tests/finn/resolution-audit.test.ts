// tests/finn/resolution-audit.test.ts — Resolution Audit Gate (Sprint 126 Task 1.3)
//
// ABORT GATE: If any assertion fails, do not proceed to Task 1.4+.
// Enumerates all @0xhoneyjar/loa-hounfour import specifiers across:
//   - src/ (.ts source)
//   - tests/ (.ts test source)
//   - dist/src/ (.js built output)
// Verifies each resolves at runtime. Validates exports map subpaths.
// Confirms schemas directory exists for conformance vectors.

import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, "../..")

// Resolve the hounfour package root via node_modules filesystem path.
// Cannot use require.resolve("pkg/package.json") because the exports map
// doesn't include ./package.json and the package is ESM-only.
const HOUNFOUR_PKG_DIR = join(
  projectRoot,
  "node_modules",
  "@0xhoneyjar",
  "loa-hounfour",
)
const HOUNFOUR_PKG_JSON = JSON.parse(
  readFileSync(join(HOUNFOUR_PKG_DIR, "package.json"), "utf-8"),
)

// --- Helpers ---

/** Scan directory for files matching extensions, return absolute paths. */
function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, exts))
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
      results.push(fullPath)
    }
  }

  return results
}

/** Extract all @0xhoneyjar/loa-hounfour import specifiers from file content. */
function extractSpecifiers(content: string): string[] {
  const specifiers = new Set<string>()

  // Process line by line, skip comment-only lines
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue

    // Match: from "@0xhoneyjar/loa-hounfour..." and from '@0xhoneyjar/loa-hounfour...'
    const fromRegex = /from\s+["'](@0xhoneyjar\/loa-hounfour[^"']*)["']/g
    // Match: import("@0xhoneyjar/loa-hounfour...")
    const dynamicRegex = /import\s*\(\s*["'](@0xhoneyjar\/loa-hounfour[^"']*)["']\s*\)/g
    // Match: require("@0xhoneyjar/loa-hounfour...")
    const requireRegex = /require\s*\(\s*["'](@0xhoneyjar\/loa-hounfour[^"']*)["']\s*\)/g

    for (const regex of [fromRegex, dynamicRegex, requireRegex]) {
      let match
      while ((match = regex.exec(line)) !== null) {
        specifiers.add(match[1])
      }
    }
  }
  return [...specifiers]
}

// --- Collect specifiers ---

const sourceFiles = collectFiles(join(projectRoot, "src"), [".ts", ".tsx"])
const testFiles = collectFiles(join(projectRoot, "tests"), [".ts", ".tsx"])
const builtFiles = collectFiles(join(projectRoot, "dist", "src"), [".js", ".d.ts"])

const allSpecifiers = new Set<string>()
const specifiersByFile = new Map<string, string[]>()

for (const file of [...sourceFiles, ...testFiles, ...builtFiles]) {
  const content = readFileSync(file, "utf-8")
  const specifiers = extractSpecifiers(content)
  if (specifiers.length > 0) {
    specifiersByFile.set(file, specifiers)
    for (const s of specifiers) allSpecifiers.add(s)
  }
}

// --- Tests ---

describe("Resolution Audit Gate (ABORT GATE)", () => {
  it("finds at least one hounfour import specifier in source", () => {
    expect(allSpecifiers.size).toBeGreaterThan(0)
  })

  it("all unique specifiers resolve at runtime via dynamic import", async () => {
    const failures: Array<{ specifier: string; error: string }> = []

    for (const specifier of allSpecifiers) {
      try {
        await import(specifier)
      } catch (err) {
        failures.push({
          specifier,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    expect(failures).toEqual([])
  })

  it("exports map subpaths all resolve via dynamic import", async () => {
    const exports = HOUNFOUR_PKG_JSON.exports as Record<string, unknown>

    const subpaths = Object.keys(exports).filter(
      (k) => k !== "." && !k.includes("*"),
    )

    const failures: Array<{ subpath: string; error: string }> = []

    for (const subpath of subpaths) {
      const fullSpecifier = `@0xhoneyjar/loa-hounfour${subpath.slice(1)}`
      try {
        await import(fullSpecifier)
      } catch (err) {
        failures.push({
          subpath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 8 subpaths: core, economy, model, governance, constraints, integrity, graph, composition
    expect(subpaths.length).toBeGreaterThanOrEqual(8)
    expect(failures).toEqual([])
  })

  it("exports map subpath dist files exist on disk", () => {
    const exports = HOUNFOUR_PKG_JSON.exports as Record<string, Record<string, string>>

    const failures: Array<{ subpath: string; file: string }> = []

    for (const [subpath, conditions] of Object.entries(exports)) {
      if (subpath.includes("*")) continue
      const importPath = conditions.import
      if (importPath) {
        const fullPath = join(HOUNFOUR_PKG_DIR, importPath)
        if (!existsSync(fullPath)) {
          failures.push({ subpath, file: fullPath })
        }
      }
    }

    expect(failures).toEqual([])
  })

  it("schemas directory exists for conformance vectors", () => {
    const schemasDir = join(HOUNFOUR_PKG_DIR, "schemas")
    expect(existsSync(schemasDir)).toBe(true)

    const schemas = readdirSync(schemasDir).filter((f) => f.endsWith(".json"))
    expect(schemas.length).toBeGreaterThan(0)
  })

  it("dist/ built output contains hounfour specifiers (build not stale)", () => {
    const builtWithSpecifiers = [...specifiersByFile.entries()].filter(
      ([file]) => file.startsWith(join(projectRoot, "dist")),
    )
    expect(builtWithSpecifiers.length).toBeGreaterThan(0)
  })

  it("no specifiers in built JS differ from source TS specifiers", () => {
    const sourceSpecifiers = new Set<string>()
    const builtSpecifiers = new Set<string>()

    for (const [file, specifiers] of specifiersByFile) {
      const isBuilt = file.startsWith(join(projectRoot, "dist"))
      for (const s of specifiers) {
        if (isBuilt) builtSpecifiers.add(s)
        else sourceSpecifiers.add(s)
      }
    }

    // Every built specifier should also exist in source
    const builtOnly = [...builtSpecifiers].filter((s) => !sourceSpecifiers.has(s))
    expect(builtOnly).toEqual([])
  })

  it("CONTRACT_VERSION matches package expectation", async () => {
    const mod = await import("@0xhoneyjar/loa-hounfour")
    expect(mod.CONTRACT_VERSION).toBeDefined()
    expect(typeof mod.CONTRACT_VERSION).toBe("string")
    expect(mod.CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("key runtime exports are present and functional", async () => {
    const mod = await import("@0xhoneyjar/loa-hounfour")

    // Value exports (functions)
    expect(typeof mod.parseSemver).toBe("function")
    expect(typeof mod.deriveIdempotencyKey).toBe("function")
    expect(typeof mod.isValidPoolId).toBe("function")

    // Constants
    expect(mod.CONTRACT_VERSION).toBeDefined()
    expect(mod.POOL_IDS).toBeDefined()

    // parseSemver is functional
    const v = mod.parseSemver(mod.CONTRACT_VERSION)
    expect(v).toHaveProperty("major")
    expect(v).toHaveProperty("minor")
    expect(v).toHaveProperty("patch")
  })
})
