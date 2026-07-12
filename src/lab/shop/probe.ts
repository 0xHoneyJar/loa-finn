// src/lab/shop/probe.ts — the self-legibility probe runner (Shop tool #3).
//
// G1's instrument (PRD §7): fixtures enumerate the probe dimensions and the
// citation CLASSES each answer must carry; a probe ANSWER file (markdown,
// one `## <dimension>` section per fixture) passes iff every section is
// present, carries at least one citation of each required class, and EVERY
// citation in the file resolves via cite-check (the primary gate — one
// dangling citation fails the probe). Results append to
// grimoires/loa/lab/probe-results.jsonl — the persisted artifact `finn
// doctor` reads (the CLI stays a reader). Deterministic: fixture matching and
// citation classes are mechanical; no LLM judges answer quality.
//
// Citation classes (closed): doc (path cite) · commit (commit:/@sha cite) ·
// ledger (ledger:<id> cite).

import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { extractCites, resolveCite, report } from "./cite-check.js"
import { SHOP_SCHEMA_VERSION } from "./types.js"

const RESULTS = "grimoires/loa/lab/probe-results.jsonl"

export type CiteClass = "doc" | "commit" | "ledger"

export interface ProbeFixture {
  dimension: string
  question: string
  required_citation_classes: CiteClass[]
}

export interface ProbeFixtures {
  schema_version: number
  fixtures: ProbeFixture[]
}

export function classifyCite(tok: string): CiteClass {
  if (tok.startsWith("ledger:")) return "ledger"
  if (tok.startsWith("commit:") || /@[0-9a-f]{7,40}$/.test(tok)) return "commit"
  return "doc"
}

export function loadFixtures(repoRoot: string, path = "grimoires/loa/lab/probe-fixtures.yaml"): ProbeFixtures {
  const doc = parseYaml(readFileSync(join(repoRoot, path), "utf8")) as ProbeFixtures
  if (doc?.schema_version !== SHOP_SCHEMA_VERSION)
    throw new Error(`unknown fixtures schema_version (want ${SHOP_SCHEMA_VERSION})`)
  if (!Array.isArray(doc.fixtures) || doc.fixtures.length === 0) throw new Error("no fixtures")
  return doc
}

export interface ProbeResult {
  schema_version: number
  tool: "probe"
  ts: string
  fixtures_version: number
  pass: boolean
  dimensions: Record<string, { present: boolean; classes_ok: boolean; missing_classes: CiteClass[] }>
  citations: { total: number; failing: number }
}

export function runProbe(answerFile: string, repoRoot: string, now: string): ProbeResult {
  const fixtures = loadFixtures(repoRoot)
  const md = readFileSync(answerFile, "utf8")
  const sections = new Map<string, string>()
  for (const m of md.split(/^## +/m).slice(1)) {
    const nl = m.indexOf("\n")
    sections.set(m.slice(0, nl === -1 ? undefined : nl).trim().toLowerCase(), nl === -1 ? "" : m.slice(nl))
  }
  const allCites = extractCites(md).map((c) => resolveCite(c, repoRoot))
  const citesPass = report(allCites).pass
  const dimensions: ProbeResult["dimensions"] = {}
  let allDims = true
  for (const f of fixtures.fixtures) {
    const body = sections.get(f.dimension.toLowerCase())
    const present = body !== undefined
    const classes = new Set((body ? extractCites(body) : []).map(classifyCite))
    const missing = f.required_citation_classes.filter((c) => !classes.has(c))
    const ok = present && missing.length === 0
    dimensions[f.dimension] = { present, classes_ok: missing.length === 0, missing_classes: missing }
    if (!ok) allDims = false
  }
  return {
    schema_version: SHOP_SCHEMA_VERSION,
    tool: "probe",
    ts: now,
    fixtures_version: fixtures.schema_version,
    pass: allDims && citesPass,
    dimensions,
    citations: { total: allCites.length, failing: allCites.filter((r) => r.status !== "ok").length },
  }
}

// CLI: probe <answer.md>   (repo root = cwd; appends to probe-results.jsonl)
if (process.argv[1]?.endsWith("probe.ts") || process.argv[1]?.endsWith("probe.js")) {
  const answer = process.argv[2]
  if (!answer) {
    console.error("usage: probe <answer.md>")
    process.exit(2)
  }
  const res = runProbe(answer, process.cwd(), new Date().toISOString())
  appendFileSync(join(process.cwd(), RESULTS), JSON.stringify(res) + "\n")
  console.log(JSON.stringify(res, null, 2))
  process.exit(res.pass ? 0 : 1)
}
