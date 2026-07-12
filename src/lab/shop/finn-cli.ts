#!/usr/bin/env tsx
// src/lab/shop/finn-cli.ts — finn-cli v0 (Shop, bd-1vp7 S4).
//
// The composition surface as verbs. THE CLI OWNS NO STATE — it reads the
// ledgers (claim inventory, GADGETS, corpus provenance, probe-results.jsonl)
// and never writes anything, anywhere (statically asserted in tests).
// Spec: grimoires/loa/specs/finn-cli-v0.md (ratified via PR #264).
// v0 verbs: doctor · gadgets. (consult/settles are V2 — spec'd, not built.)
//
// Exit semantics: 0 green · 1 red finding · 2 usage/unknown id · 4 substrate
// missing (names the artifact). Privacy: output is citations/metadata only —
// nothing here opens corpus content files at all (refOnly by construction).

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { checkYamlFile, report } from "./cite-check.js"
import { checkLedger, parseLedger } from "./ledger-check.js"
import { SHOP_SCHEMA_VERSION, type GadgetRow } from "./types.js"

const INVENTORY = "grimoires/loa/identity/claim-inventory.yaml"
const LEDGER = "grimoires/loa/lab/GADGETS.md"
const CORPUS = "grimoires/loa/lab/corpus"
const RESULTS = "grimoires/loa/lab/probe-results.jsonl"

export interface DoctorReport {
  schema_version: typeof SHOP_SCHEMA_VERSION
  tool: "finn-doctor"
  checks: {
    identity: { pass: boolean; claims: number; failing: number }
    ledger: { pass: boolean; rows: number; errors: number }
    corpus: { sources: number; tiers: Record<string, number> }
    probe: { present: boolean; pass: boolean; ts?: string }
  }
  pass: boolean
}

function requireSubstrate(repoRoot: string, rel: string, builtBy: string): void {
  if (!existsSync(join(repoRoot, rel))) {
    process.stderr.write(`missing substrate: ${rel} (built by ${builtBy})\n`)
    process.exit(4)
  }
}

export function doctor(repoRoot: string): DoctorReport {
  const inv = checkYamlFile(join(repoRoot, INVENTORY), repoRoot)
  const invPass = report(inv).pass
  const led = checkLedger(LEDGER, repoRoot)
  const tiers: Record<string, number> = {}
  let sources = 0
  const corpusDir = join(repoRoot, CORPUS)
  if (existsSync(corpusDir)) {
    for (const d of readdirSync(corpusDir)) {
      const prov = join(corpusDir, d, "provenance.yaml")
      if (!existsSync(prov)) continue
      sources += 1
      const tier = (parseYaml(readFileSync(prov, "utf8")) as { tier?: string })?.tier ?? "unknown"
      tiers[tier] = (tiers[tier] ?? 0) + 1
    }
  }
  let probe: DoctorReport["checks"]["probe"] = { present: false, pass: false }
  const resultsPath = join(repoRoot, RESULTS)
  if (existsSync(resultsPath)) {
    const lines = readFileSync(resultsPath, "utf8").trim().split("\n").filter(Boolean)
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]) as { pass?: boolean; ts?: string }
      probe = { present: true, pass: last.pass === true, ts: last.ts }
    }
  }
  return {
    schema_version: SHOP_SCHEMA_VERSION,
    tool: "finn-doctor",
    checks: {
      identity: { pass: invPass, claims: inv.length, failing: inv.filter((r) => r.status !== "ok").length },
      ledger: { pass: led.pass, rows: led.rows, errors: led.errors.length },
      corpus: { sources, tiers },
      probe,
    },
    pass: invPass && led.pass && probe.present && probe.pass,
  }
}

function renderDoctor(d: DoctorReport): string {
  const mark = (ok: boolean): string => (ok ? "✓" : "✗")
  return [
    "finn doctor",
    `  ${mark(d.checks.identity.pass)} identity   ${d.checks.identity.claims} claims, ${d.checks.identity.failing} failing`,
    `  ${mark(d.checks.ledger.pass)} ledger     ${d.checks.ledger.rows} rows, ${d.checks.ledger.errors} errors`,
    `  · corpus     ${d.checks.corpus.sources} sources ${JSON.stringify(d.checks.corpus.tiers)}`,
    `  ${mark(d.checks.probe.present && d.checks.probe.pass)} probe      ${d.checks.probe.present ? `last=${d.checks.probe.ts} pass=${d.checks.probe.pass}` : "no recorded run"}`,
    d.pass ? "PASS" : "RED",
  ].join("\n")
}

export function gadgetRows(repoRoot: string): GadgetRow[] {
  return parseLedger(readFileSync(join(repoRoot, LEDGER), "utf8"))
}

export function runCheck(row: GadgetRow, repoRoot: string): number {
  const c = row.check
  const argv =
    c.runner === "vitest"
      ? ["npx", "vitest", "run", c.target, ...(c.args ?? [])]
      : c.runner === "node-script"
        ? ["npx", "tsx", c.target, ...(c.args ?? [])]
        : ["python3", "-m", "py_compile", c.target, ...(c.args ?? [])]
  try {
    execFileSync(argv[0], argv.slice(1), { cwd: repoRoot, stdio: "inherit", timeout: c.timeout_s * 1000 })
    return 0
  } catch (e) {
    const status = (e as { status?: number }).status
    return typeof status === "number" ? status : 1
  }
}

export function main(args: string[], repoRoot: string): number {
  const [verb, ...rest] = args
  if (verb === "doctor") {
    requireSubstrate(repoRoot, INVENTORY, "sprint-1 T1.4")
    requireSubstrate(repoRoot, LEDGER, "sprint-1 T1.3")
    const d = doctor(repoRoot)
    console.log(rest.includes("--json") ? JSON.stringify(d, null, 2) : renderDoctor(d))
    return d.pass ? 0 : 1
  }
  if (verb === "gadgets") {
    requireSubstrate(repoRoot, LEDGER, "sprint-1 T1.3")
    const rows = gadgetRows(repoRoot)
    const runIdx = rest.indexOf("--run-check")
    if (runIdx !== -1) {
      const id = rest[runIdx + 1]
      const row = rows.find((r) => r.id === id)
      if (!row) {
        process.stderr.write(`unknown gadget id: ${id}\n`)
        return 2
      }
      return runCheck(row, repoRoot)
    }
    const id = rest.find((a) => !a.startsWith("--"))
    if (id) {
      const row = rows.find((r) => r.id === id)
      if (!row) {
        process.stderr.write(`unknown gadget id: ${id}\n`)
        return 2
      }
      console.log(JSON.stringify(row, null, 2))
      return 0
    }
    for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.check.contract.padEnd(8)} ${r.graduation.padEnd(12)} ${r.id}`)
    return 0
  }
  process.stderr.write("usage: finn <doctor|gadgets> [id] [--run-check <id>] [--json]\n")
  return 2
}

if (process.argv[1]?.endsWith("finn-cli.ts") || process.argv[1]?.endsWith("finn-cli.js")) {
  process.exit(main(process.argv.slice(2), process.cwd()))
}
