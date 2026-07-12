// src/lab/shop/ledger-check.ts — the gadget-ledger validator (Shop tool #2).
//
// GADGETS.md is one file with two representations: a fenced ```yaml block (the
// machine source of truth) and a human table GENERATED from it between the
// <!-- ledger-table:start --> / <!-- ledger-table:end --> markers. A stale
// table is a failure, not a judgment call (--render rewrites it).
//
// Validation (all deterministic; SDD 2.2):
//  · closed enums: status, runner, exit, contract, graduation
//  · check.target and home must resolve INSIDE the repo root (no free shell
//    strings anywhere — runner + argv list only; the injection surface is closed)
//  · closed discovery boundary reconciles BOTH ways: every enumerated
//    instrument has a row, every row's home exists on disk
//  · enumeration rules: depth-1 dirs under lab/gadgets/; .ts modules under
//    src/lab/metabolism/ excluding *.test.ts and types.ts; symlinks not
//    followed; duplicate ids are errors.

import { lstatSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { parse as parseYaml } from "yaml"
import { SHOP_SCHEMA_VERSION, type GadgetRow, type LedgerReport } from "./types.js"

const GADGET_DIRS = "grimoires/loa/lab/gadgets"
const METABOLISM = "src/lab/metabolism"
const TABLE_START = "<!-- ledger-table:start -->"
const TABLE_END = "<!-- ledger-table:end -->"

const STATUSES = new Set(["CANDIDATE", "KEEP", "SELL", "THROW"])
const RUNNERS = new Set(["vitest", "node-script", "py-compile"])
const GRADUATIONS = new Set(["lab-only", "src-imported", "pending"])

export function parseLedger(md: string): GadgetRow[] {
  const block = md.match(/```yaml\n([\s\S]*?)```/)
  if (!block) throw new Error("no yaml block in ledger")
  const rows = parseYaml(block[1])
  if (!Array.isArray(rows)) throw new Error("yaml block is not a row list")
  return rows as GadgetRow[]
}

/** Closed discovery boundary (deterministic enumeration; symlinks not followed). */
export function enumerateBoundary(repoRoot: string): string[] {
  const found: string[] = []
  const gdir = join(repoRoot, GADGET_DIRS)
  if (existsSync(gdir)) {
    for (const e of readdirSync(gdir)) {
      const p = join(gdir, e)
      const st = lstatSync(p)
      if (st.isDirectory() && !st.isSymbolicLink()) found.push(`${GADGET_DIRS}/${e}`)
    }
  }
  const mdir = join(repoRoot, METABOLISM)
  if (existsSync(mdir)) {
    for (const e of readdirSync(mdir)) {
      if (!e.endsWith(".ts") || e.endsWith(".test.ts") || e === "types.ts") continue
      const st = lstatSync(join(mdir, e))
      if (st.isSymbolicLink()) continue
      found.push(`${METABOLISM}/${e}`)
    }
  }
  return found.sort()
}

function insideRepo(repoRoot: string, p: string): boolean {
  const abs = resolve(repoRoot, p)
  return abs === resolve(repoRoot) || abs.startsWith(resolve(repoRoot) + "/")
}

export function validate(rows: GadgetRow[], repoRoot: string): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const at = `row ${r?.id ?? "?"}`
    if (!r?.id) { errors.push(`${at}: missing id`); continue }
    if (seen.has(r.id)) errors.push(`${at}: duplicate id`)
    seen.add(r.id)
    if (!STATUSES.has(r.status)) errors.push(`${at}: status '${r.status}' not in closed vocab`)
    if (!GRADUATIONS.has(r.graduation)) errors.push(`${at}: graduation '${r.graduation}' invalid`)
    if (!r.home || !insideRepo(repoRoot, r.home)) errors.push(`${at}: home outside repo root`)
    else if (!existsSync(join(repoRoot, r.home))) errors.push(`${at}: home does not exist`)
    const c = r.check as GadgetRow["check"] & { cmd?: string }
    if (!c) { errors.push(`${at}: missing check`); continue }
    if (typeof c.cmd === "string") errors.push(`${at}: free-string check.cmd is forbidden (constrained runner only)`)
    if (!RUNNERS.has(c.runner)) errors.push(`${at}: runner '${c.runner}' not in closed enum`)
    if (!c.target || !insideRepo(repoRoot, c.target)) errors.push(`${at}: check.target outside repo root`)
    if (c.args && !Array.isArray(c.args)) errors.push(`${at}: check.args must be an argv list`)
    if (c.exit !== "zero-is-pass") errors.push(`${at}: check.exit must be 'zero-is-pass'`)
    if (typeof c.timeout_s !== "number" || c.timeout_s <= 0) errors.push(`${at}: check.timeout_s invalid`)
    if (c.contract !== "declared" && c.contract !== "pending") errors.push(`${at}: check.contract invalid`)
  }
  return errors
}

export function reconcile(rows: GadgetRow[], repoRoot: string): string[] {
  const errors: string[] = []
  const homes = new Set(rows.map((r) => r.home))
  for (const inst of enumerateBoundary(repoRoot)) {
    if (!homes.has(inst)) errors.push(`unenrolled instrument: ${inst}`)
  }
  return errors
}

export function renderTable(rows: GadgetRow[]): string {
  const lines = [
    "| id | what | status | runner | contract | graduation |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.id} | ${r.what} | ${r.status} | ${r.check?.runner ?? "?"} | ${r.check?.contract ?? "?"} | ${r.graduation} |`,
    ),
  ]
  return lines.join("\n")
}

export function checkLedger(
  ledgerPath: string,
  repoRoot: string,
  opts: { render?: boolean } = {},
): LedgerReport {
  const errors: string[] = []
  let rows: GadgetRow[] = []
  let md = ""
  try {
    md = readFileSync(join(repoRoot, ledgerPath), "utf8")
    rows = parseLedger(md)
  } catch (e) {
    errors.push(String(e instanceof Error ? e.message : e))
  }
  if (rows.length) {
    errors.push(...validate(rows, repoRoot))
    errors.push(...reconcile(rows, repoRoot))
    const start = md.indexOf(TABLE_START)
    const end = md.indexOf(TABLE_END)
    if (start === -1 || end === -1) errors.push("table markers missing")
    else {
      const current = md.slice(start + TABLE_START.length, end).trim()
      const expected = renderTable(rows).trim()
      if (current !== expected) {
        if (opts.render) {
          writeFileSync(
            join(repoRoot, ledgerPath),
            md.slice(0, start + TABLE_START.length) + "\n" + expected + "\n" + md.slice(end),
          )
        } else {
          errors.push("rendered table is stale (run --render)")
        }
      }
    }
  }
  return {
    schema_version: SHOP_SCHEMA_VERSION,
    tool: "ledger-check",
    pass: errors.length === 0,
    errors,
    rows: rows.length,
    enumerated: enumerateBoundary(repoRoot).length,
  }
}

// CLI: ledger-check [--render] [ledger-path]   (repo root = cwd)
if (process.argv[1]?.endsWith("ledger-check.ts") || process.argv[1]?.endsWith("ledger-check.js")) {
  const args = process.argv.slice(2)
  const render = args.includes("--render")
  const path = args.find((a) => !a.startsWith("--")) ?? "grimoires/loa/lab/GADGETS.md"
  const rep = checkLedger(path, process.cwd(), { render })
  console.log(JSON.stringify(rep, null, 2))
  process.exit(rep.pass ? 0 : 1)
}
