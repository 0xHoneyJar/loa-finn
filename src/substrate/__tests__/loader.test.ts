// src/substrate/__tests__/loader.test.ts — Filesystem loader tests.
//
// Cycle-032 Sprint-1 Task 1.5. See PRD FR-1 + sprint plan acceptance criteria.
//
// Uses synthetic packs in os.tmpdir() — sprint-1 scope is the loader contract,
// not cross-pack Tag matching (deferred to Sprint 3) or end-to-end execution
// against real construct-lore-essay-grader (deferred to Sprint 7).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConstructsFromFilesystem } from "../loader.js"
import { makeJwtValidator } from "../jwt-validator.js"
import {
  EntryResolutionError,
  LicenseError,
  ManifestParseError,
  ManifestValidationError,
} from "../types.js"

// ── Shared keypair + signer ─────────────────────────────────────────

let publicPem: string
let signer: { kid: string; privateKey: CryptoKey }
let validator: ReturnType<typeof makeJwtValidator>

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
  publicPem = await exportSPKI(publicKey)
  signer = { kid: "test-key-1", privateKey }
  validator = makeJwtValidator({
    publicKeyResolver: async () => publicPem,
    clock: () => new Date("2025-01-01T00:00:00Z"),
  })
})

async function makeToken(opts: { exp?: number; tier?: string } = {}): Promise<string> {
  const nowSec = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000)
  return await new SignJWT({ tier: opts.tier ?? "pro", scope: "skill:load" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: signer.kid })
    .setIssuer("constructs.network")
    .setAudience("loa-framework")
    .setSubject("test-vendor/test-construct")
    .setIssuedAt(nowSec - 3600)
    .setExpirationTime(opts.exp ?? nowSec + 3600)
    .sign(signer.privateKey)
}

// ── Pack-builder helpers ────────────────────────────────────────────

interface PackOpts {
  slug?: string
  type?: string
  version?: string
  manifestExtra?: string
  /** When false, omit `executable.entry`. Default true. */
  withEntry?: boolean
  /** When set, override executable.entry value (e.g., "../../etc/passwd"). */
  entryOverride?: string
  /** When false, do not write entry.mjs. Default true. */
  writeEntryFile?: boolean
  /** When set, write licenseTokenOverride; otherwise mint a valid token. */
  licenseTokenOverride?: string
  /** When false, do not write .license.json. Default true. */
  withLicense?: boolean
  /** When set, raw YAML body to write (overrides default manifest construction). */
  rawYaml?: string
}

async function buildPack(rootDir: string, opts: PackOpts = {}): Promise<string> {
  const slug = opts.slug ?? "test-construct"
  const packDir = join(rootDir, slug)
  mkdirSync(packDir, { recursive: true })

  if (opts.rawYaml !== undefined) {
    writeFileSync(join(packDir, "construct.yaml"), opts.rawYaml)
  } else {
    const entryLine = opts.withEntry === false
      ? ""
      : `  entry: ${opts.entryOverride ?? "entry.mjs"}\n`
    const yaml = `name: ${slug}
slug: ${slug}
version: ${opts.version ?? "1.0.0"}
type: ${opts.type ?? "substrate-construct"}
executable:
${entryLine}  export: default
  protocol:
    input: schemas/input.ts
    output: schemas/output.ts
runtime:
  engine: effect-ts
${opts.manifestExtra ?? ""}`
    writeFileSync(join(packDir, "construct.yaml"), yaml)
  }

  if (opts.writeEntryFile !== false) {
    writeFileSync(join(packDir, "entry.mjs"), `export default { hello: "world" }\nexport const meta = { built: true }\n`)
  }

  if (opts.withLicense !== false) {
    const token = opts.licenseTokenOverride ?? (await makeToken())
    writeFileSync(join(packDir, ".license.json"), JSON.stringify({ token }))
  }

  return packDir
}

// ── Tests ───────────────────────────────────────────────────────────

describe("loadConstructsFromFilesystem", () => {
  let tmpRoot: string

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "substrate-loader-test-"))
  })
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("loads a valid substrate-construct pack", async () => {
    const root = mkdtempSync(join(tmpRoot, "happy-"))
    await buildPack(root, { slug: "valid-pack" })

    const map = await loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })
    expect(map.size).toBe(1)
    const loaded = map.get("valid-pack")
    expect(loaded).toBeDefined()
    expect(loaded!.slug).toBe("valid-pack")
    expect(loaded!.manifest.type).toBe("substrate-construct")
    expect(loaded!.entryPath).toMatch(/entry\.mjs$/)
    expect(loaded!.license.tier).toBe("pro")
    expect(loaded!.license.status).toBe("valid")
  })

  it("rejects manifest missing executable.entry with ManifestValidationError", async () => {
    const root = mkdtempSync(join(tmpRoot, "no-entry-"))
    await buildPack(root, { slug: "no-entry", withEntry: false, writeEntryFile: false })

    await expect(loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })).rejects.toBeInstanceOf(
      ManifestValidationError,
    )
  })

  it("rejects path-traversal in executable.entry with EntryResolutionError", async () => {
    const root = mkdtempSync(join(tmpRoot, "traversal-"))
    // entry: ../../etc/passwd — outside pack dir
    await buildPack(root, { slug: "traversal", entryOverride: "../../etc/passwd", writeEntryFile: false })

    await expect(loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })).rejects.toBeInstanceOf(
      EntryResolutionError,
    )
  })

  it("rejects expired-beyond-grace license with LicenseError", async () => {
    const root = mkdtempSync(join(tmpRoot, "expired-"))
    const nowSec = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000)
    // Expired 30h ago — beyond pro's 24h grace
    const staleToken = await makeToken({ exp: nowSec - 30 * 3600 })
    await buildPack(root, { slug: "expired", licenseTokenOverride: staleToken })

    await expect(loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })).rejects.toBeInstanceOf(
      LicenseError,
    )
  })

  it("rejects malformed YAML with ManifestParseError", async () => {
    const root = mkdtempSync(join(tmpRoot, "malformed-"))
    await buildPack(root, { slug: "malformed", rawYaml: "name: test\n  bad: indent\nfoo: [unclosed" })

    await expect(loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })).rejects.toBeInstanceOf(
      ManifestParseError,
    )
  })

  it("rejects missing .license.json with LicenseError", async () => {
    const root = mkdtempSync(join(tmpRoot, "no-license-"))
    await buildPack(root, { slug: "no-license", withLicense: false })

    await expect(loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })).rejects.toBeInstanceOf(
      LicenseError,
    )
  })

  it("silently skips packs with non-substrate type (e.g., skill-pack)", async () => {
    const root = mkdtempSync(join(tmpRoot, "mixed-"))
    await buildPack(root, { slug: "skill-pack-1", type: "skill-pack", withLicense: false, writeEntryFile: false })
    await buildPack(root, { slug: "substrate-1" })

    const map = await loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })
    expect(map.size).toBe(1)
    expect(map.has("substrate-1")).toBe(true)
    expect(map.has("skill-pack-1")).toBe(false)
  })

  it("loadModule is memoized — repeated calls return same module instance", async () => {
    const root = mkdtempSync(join(tmpRoot, "memoized-"))
    await buildPack(root, { slug: "memoized" })

    const map = await loadConstructsFromFilesystem({ packsDir: root, jwtValidator: validator })
    const loaded = map.get("memoized")!
    const a = await loaded.loadModule()
    const b = await loaded.loadModule()
    expect(a).toBe(b) // referential equality
    expect(a.default).toBeDefined()
    expect((a as { meta: { built: boolean } }).meta.built).toBe(true)
  })

  it("respects slugAllowlist — only loads listed slugs", async () => {
    const root = mkdtempSync(join(tmpRoot, "allowlist-"))
    await buildPack(root, { slug: "allowed" })
    await buildPack(root, { slug: "blocked" })

    const map = await loadConstructsFromFilesystem({
      packsDir: root,
      jwtValidator: validator,
      slugAllowlist: new Set(["allowed"]),
    })
    expect(map.size).toBe(1)
    expect(map.has("allowed")).toBe(true)
    expect(map.has("blocked")).toBe(false)
  })

  it("returns empty map when packsDir does not exist", async () => {
    const map = await loadConstructsFromFilesystem({
      packsDir: join(tmpRoot, "does-not-exist"),
      jwtValidator: validator,
    })
    expect(map.size).toBe(0)
  })
})
