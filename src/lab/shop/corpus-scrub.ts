// src/lab/shop/corpus-scrub.ts — the corpus intake redaction gate (Shop tool #4).
//
// Applies the secret-scanning patterns from .loa.config.yaml
// (flatline_protocol.secret_scanning — ONE pattern SoT, never a private copy)
// to every file in an intake directory, redacts in place, writes
// manifest.yaml (per-file sha256 of raw and redacted + counts), and — per the
// retention policy (SDD 2.4) — the caller deletes raws AFTER verifying the
// manifest; this tool never retains raw content in its output.

import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync, lstatSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml, stringify as toYaml } from "yaml"
import { SHOP_SCHEMA_VERSION } from "./types.js"

const REDACTED = "[REDACTED:corpus-scrub]"

export function loadPatterns(repoRoot: string): RegExp[] {
  const cfg = parseYaml(readFileSync(join(repoRoot, ".loa.config.yaml"), "utf8")) as {
    flatline_protocol?: { secret_scanning?: { patterns?: string[] } }
  }
  const pats = cfg?.flatline_protocol?.secret_scanning?.patterns ?? []
  if (pats.length === 0) throw new Error("no secret_scanning patterns in .loa.config.yaml (refusing to scrub blind)")
  return pats.map((p) => new RegExp(p, "g"))
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

export interface ScrubEntry {
  file: string
  raw_sha256: string
  redacted_sha256: string
  redactions: number
}

export function scrubText(text: string, patterns: RegExp[]): { out: string; count: number } {
  let out = text
  let count = 0
  for (const re of patterns) {
    out = out.replace(re, () => {
      count += 1
      return REDACTED
    })
  }
  return { out, count }
}

/** Scrub every regular file in `dir` (flat, symlinks skipped) in place and
 *  write manifest.yaml alongside. Returns the manifest. */
export function scrubDir(dir: string, repoRoot: string): { schema_version: number; entries: ScrubEntry[] } {
  const patterns = loadPatterns(repoRoot)
  const entries: ScrubEntry[] = []
  for (const name of readdirSync(dir).sort()) {
    if (name === "manifest.yaml") continue
    const p = join(dir, name)
    const st = lstatSync(p)
    if (!st.isFile() || st.isSymbolicLink()) continue
    const raw = readFileSync(p, "utf8")
    const { out, count } = scrubText(raw, patterns)
    if (count > 0) writeFileSync(p, out)
    entries.push({ file: name, raw_sha256: sha256(raw), redacted_sha256: sha256(out), redactions: count })
  }
  const manifest = { schema_version: SHOP_SCHEMA_VERSION as number, entries }
  writeFileSync(join(dir, "manifest.yaml"), toYaml(manifest))
  return manifest
}

// CLI: corpus-scrub <intake-dir>   (repo root = cwd)
if (process.argv[1]?.endsWith("corpus-scrub.ts") || process.argv[1]?.endsWith("corpus-scrub.js")) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("usage: corpus-scrub <intake-dir>")
    process.exit(2)
  }
  const m = scrubDir(dir, process.cwd())
  console.log(toYaml({ schema_version: m.schema_version, files: m.entries.length, redactions: m.entries.reduce((a, e) => a + e.redactions, 0) }))
  process.exit(0)
}
