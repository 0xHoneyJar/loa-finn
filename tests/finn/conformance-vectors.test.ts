// tests/finn/conformance-vectors.test.ts — Conformance Vector Infrastructure (Sprint 126 Task 1.5/1.6)
//
// Self-verifying conformance test infrastructure for loa-hounfour schemas.
// Discovery uses filesystem resolution (not hardcoded node_modules paths).
// Loads manifest from schemas/index.json, validates all schemas exist and parse.

import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, "../..")

// --- Package root discovery ---
// Resolve via import.meta.resolve() to handle pnpm/workspace layouts.
// Falls back to node_modules path if import.meta.resolve unavailable.

function resolveHounfourRoot(): string {
  try {
    // import.meta.resolve gives the main entry URL — walk up to package root
    const mainUrl = import.meta.resolve("@0xhoneyjar/loa-hounfour")
    const mainPath = fileURLToPath(mainUrl)
    // Walk up from dist/index.js to package root
    let dir = dirname(mainPath)
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
        if (pkg.name === "@0xhoneyjar/loa-hounfour") return dir
      }
      dir = dirname(dir)
    }
  } catch {
    // Fallback
  }
  return join(projectRoot, "node_modules", "@0xhoneyjar", "loa-hounfour")
}

const HOUNFOUR_PKG_DIR = resolveHounfourRoot()
const SCHEMAS_DIR = join(HOUNFOUR_PKG_DIR, "schemas")
const MANIFEST_PATH = join(SCHEMAS_DIR, "index.json")

// --- Load manifest ---

interface SchemaEntry {
  name: string
  $id: string
  file: string
  description: string
}

interface SchemaManifest {
  version: string
  schemas: SchemaEntry[]
}

const manifest: SchemaManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))

/** Resolve a schema file path, rejecting directory traversal. */
const SCHEMAS_DIR_REAL = resolve(SCHEMAS_DIR)

function safeSchemaPath(file: string): string {
  const resolved = resolve(SCHEMAS_DIR_REAL, file)
  if (!resolved.startsWith(SCHEMAS_DIR_REAL + sep)) {
    throw new Error(`Path traversal in schema file: ${file}`)
  }
  return resolved
}

// --- Category classification ---

function classifySchema(name: string): string {
  if (/jwt|claims/.test(name)) return "jwt"
  if (/billing|credit|cost/.test(name)) return "billing"
  if (/stream|invoke|usage/.test(name)) return "stream"
  if (/agent/.test(name)) return "agent"
  if (/nft|molecule|codex|basket/.test(name)) return "nft"
  if (/conversation|message|sealing/.test(name)) return "conversation"
  if (/transfer|settlement/.test(name)) return "transfer"
  if (/saga|lifecycle/.test(name)) return "lifecycle"
  if (/pool|tier|routing/.test(name)) return "routing"
  if (/trust|access|capability|scope/.test(name)) return "trust"
  if (/budget|reservation|allocation/.test(name)) return "budget"
  return "other"
}

// --- Tests ---

describe("Conformance Vector Infrastructure", () => {
  it("schemas directory exists", () => {
    expect(existsSync(SCHEMAS_DIR)).toBe(true)
  })

  it("manifest (index.json) exists and parses", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true)
    expect(manifest.version).toBeDefined()
    expect(manifest.schemas).toBeDefined()
    expect(Array.isArray(manifest.schemas)).toBe(true)
  })

  it("manifest declares non-empty schema set", () => {
    // Self-verifying: exact count comes from the manifest, not hardcoded.
    // If hounfour adds/removes schemas, the disk check below catches drift.
    expect(manifest.schemas.length).toBeGreaterThan(0)
  })

  it("all manifest schemas have required fields", () => {
    const invalid: string[] = []
    for (const s of manifest.schemas) {
      if (!s.name || !s.file || !s.$id) {
        invalid.push(s.name ?? "(unnamed)")
      }
    }
    expect(invalid).toEqual([])
  })

  it("schema IDs are unique", () => {
    const ids = manifest.schemas.map((s) => s.$id)
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(duplicates).toEqual([])
  })

  it("schema names are unique", () => {
    const names = manifest.schemas.map((s) => s.name)
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i)
    expect(duplicates).toEqual([])
  })

  it("every manifest schema file exists on disk", () => {
    const missing: string[] = []
    for (const s of manifest.schemas) {
      const filePath = safeSchemaPath(s.file)
      if (!existsSync(filePath)) {
        missing.push(s.file)
      }
    }
    expect(missing).toEqual([])
  })

  it("disk schema count matches manifest (no orphan schemas)", () => {
    const diskSchemas = readdirSync(SCHEMAS_DIR).filter((f) =>
      f.endsWith(".schema.json"),
    )
    const manifestFiles = new Set(manifest.schemas.map((s) => s.file))
    const orphans = diskSchemas.filter((f) => !manifestFiles.has(f))
    expect(orphans).toEqual([])
  })

  it("required categories are present", () => {
    const categories = new Set(manifest.schemas.map((s) => classifySchema(s.name)))
    // JWT is critical for auth; billing for payment; stream for SSE
    expect(categories.has("jwt")).toBe(true)
    expect(categories.has("billing")).toBe(true)
    expect(categories.has("stream")).toBe(true)
  })

  it("each required category has at least one schema", () => {
    const categoryMap = new Map<string, string[]>()
    for (const s of manifest.schemas) {
      const cat = classifySchema(s.name)
      const existing = categoryMap.get(cat) ?? []
      existing.push(s.name)
      categoryMap.set(cat, existing)
    }

    // Check required categories specifically — not tautological since
    // classification could misroute all schemas to "other"
    const requiredCategories = ["jwt", "billing", "stream", "agent", "trust"]
    const emptyRequired = requiredCategories.filter(
      (cat) => (categoryMap.get(cat)?.length ?? 0) === 0,
    )
    expect(emptyRequired).toEqual([])
  })

  it("JWT schema exists and has required fields", () => {
    const jwtSchema = manifest.schemas.find((s) => s.name === "jwt-claims")
    expect(jwtSchema).toBeDefined()

    const schemaContent = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, jwtSchema!.file), "utf-8"),
    )
    // JWT schema must define core claims
    expect(schemaContent.required).toContain("iss")
    expect(schemaContent.required).toContain("aud")
    expect(schemaContent.required).toContain("sub")
    expect(schemaContent.required).toContain("tenant_id")
    expect(schemaContent.required).toContain("tier")
  })

  it("billing-entry schema exists and has required fields", () => {
    const billingSchema = manifest.schemas.find(
      (s) => s.name === "billing-entry",
    )
    expect(billingSchema).toBeDefined()

    const schemaContent = JSON.parse(
      readFileSync(join(SCHEMAS_DIR, billingSchema!.file), "utf-8"),
    )
    expect(schemaContent.required).toBeDefined()
    expect(schemaContent.properties).toBeDefined()
  })
})

describe("Conformance Vector Execution", () => {
  // Validate every schema in the manifest parses as valid JSON Schema
  it(`all ${manifest.schemas.length} schemas parse as valid JSON`, () => {
    const failures: Array<{ name: string; error: string }> = []

    for (const s of manifest.schemas) {
      try {
        const content = readFileSync(safeSchemaPath(s.file), "utf-8")
        const parsed = JSON.parse(content)
        // Minimal JSON Schema validation: must be an object with $schema or type
        if (typeof parsed !== "object" || parsed === null) {
          failures.push({ name: s.name, error: "Not a JSON object" })
        }
      } catch (err) {
        failures.push({
          name: s.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    expect(failures).toEqual([])
  })

  it("all schemas have valid $id matching manifest", () => {
    const mismatches: Array<{ name: string; manifest$id: string; file$id: string }> = []

    for (const s of manifest.schemas) {
      const content = JSON.parse(
        readFileSync(safeSchemaPath(s.file), "utf-8"),
      )
      if (content.$id && content.$id !== s.$id) {
        mismatches.push({
          name: s.name,
          manifest$id: s.$id,
          file$id: content.$id,
        })
      }
    }

    expect(mismatches).toEqual([])
  })

  it("all schemas reference the current protocol version in $id", () => {
    const wrongVersion: Array<{ name: string; $id: string }> = []

    for (const s of manifest.schemas) {
      // $id format: https://schemas.0xhoneyjar.com/loa-hounfour/{version}/{name}
      if (s.$id && !s.$id.includes(`/${manifest.version}/`)) {
        wrongVersion.push({ name: s.name, $id: s.$id })
      }
    }

    expect(wrongVersion).toEqual([])
  })

  it("schema files have valid JSON Schema structure", () => {
    const invalid: Array<{ name: string; reason: string }> = []

    for (const s of manifest.schemas) {
      const content = JSON.parse(
        readFileSync(safeSchemaPath(s.file), "utf-8"),
      )

      // Must have either $schema, type, or properties (basic JSON Schema structure)
      const hasSchema = "$schema" in content
      const hasType = "type" in content
      const hasProperties = "properties" in content
      const hasOneOf = "oneOf" in content || "anyOf" in content || "allOf" in content
      const hasEnum = "enum" in content
      const hasConst = "const" in content

      if (!hasSchema && !hasType && !hasProperties && !hasOneOf && !hasEnum && !hasConst) {
        invalid.push({ name: s.name, reason: "Missing JSON Schema structure" })
      }
    }

    expect(invalid).toEqual([])
  })
})
