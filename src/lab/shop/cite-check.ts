// src/lab/shop/cite-check.ts — the citation validator (Shop tool #1).
//
// The primary gate of the self-legibility probe (PRD §7): every claim must
// cite a resolvable reference, and this tool resolves ALL of them mechanically
// — one dangling citation fails the run. Human/LLM spot-check is secondary
// sampling only. Deterministic: no LLM, no network; git + fs reads only.
//
// Citation grammar (one grammar everywhere — markdown backticks and YAML):
//   commit:<sha>                     commit exists AND is ancestor of HEAD
//   ledger:<row-id>                  row exists in the GADGETS.md YAML block
//   <path>                           tracked file, clean, not a symlink
//   <path>:L<a>-L<b>                 + line range fits the current file
//   <path>@<sha>                     path readable at that commit (rewrite-immune)
//   <path>:L<a>-L<b>@<sha>           + range fits the blob at that commit
//
// Resolution semantics (SDD 2.5): working-tree citations require a CLEAN
// tracked target (`dirty` is a failure, not a pass); symlinks are not
// followed (`dead`); a path that exists with a drifted range reports `moved`,
// a missing path/commit reports `dead` — both fail, distinctly.
//
// Egress discipline: the report carries citations + statuses ONLY — never
// file content (refOnly; SDD §4).

import { execFileSync } from "node:child_process"
import { lstatSync, readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import {
  SHOP_SCHEMA_VERSION,
  type CiteReport,
  type CiteResult,
  type CiteStatus,
} from "./types.js"

const CITE_RE =
  /^(?:commit:(?<commit>[0-9a-f]{7,40})|ledger:(?<ledger>[A-Za-z0-9][A-Za-z0-9._-]*)|(?<path>[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+?)(?::L(?<a>\d+)-L(?<b>\d+))?(?:@(?<sha>[0-9a-f]{7,40}))?)$/

const DEFAULT_LEDGER = "grimoires/loa/lab/GADGETS.md"

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    return null
  }
}

/** Extract backticked citation tokens from markdown text. Only tokens that
 *  match the grammar AND contain a path separator or a commit:/ledger: prefix
 *  are citations; other code spans are ignored. */
export function extractCites(md: string): string[] {
  const out: string[] = []
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim()
    if (!CITE_RE.test(tok)) continue
    const prefixed = tok.startsWith("commit:") || tok.startsWith("ledger:")
    const qualified = /:L\d+-L\d+/.test(tok) || /@[0-9a-f]{7,40}$/.test(tok)
    const lastSegHasExt = tok.includes("/") && (tok.split("@")[0].split(":")[0].split("/").pop() ?? "").includes(".")
    // A bare a/b span without extension or qualifier (e.g. `n/a`) is prose, not a citation.
    if (!prefixed && !qualified && !lastSegHasExt) continue
    out.push(tok)
  }
  return out
}

function ledgerIds(repoRoot: string, ledgerPath: string): Set<string> {
  try {
    const md = readFileSync(`${repoRoot}/${ledgerPath}`, "utf8")
    const block = md.match(/```yaml\n([\s\S]*?)```/)
    if (!block) return new Set()
    const rows = parseYaml(block[1]) as Array<{ id?: string }> | null
    return new Set((rows ?? []).map((r) => r?.id).filter((x): x is string => typeof x === "string"))
  } catch {
    return new Set()
  }
}

/** Resolve ONE citation token. Deterministic; never throws. */
export function resolveCite(tok: string, repoRoot: string, ledgerPath = DEFAULT_LEDGER): CiteResult {
  const m = CITE_RE.exec(tok)
  if (!m || !m.groups) return { cite: tok, status: "dead", detail: "unparseable citation" }
  const g = m.groups

  if (g.commit) {
    if (git(["cat-file", "-e", `${g.commit}^{commit}`], repoRoot) === null)
      return { cite: tok, status: "dead", detail: "commit not found" }
    if (git(["merge-base", "--is-ancestor", g.commit, "HEAD"], repoRoot) === null)
      return { cite: tok, status: "dead", detail: "commit not an ancestor of HEAD" }
    return { cite: tok, status: "ok" }
  }

  if (g.ledger) {
    return ledgerIds(repoRoot, ledgerPath).has(g.ledger)
      ? { cite: tok, status: "ok" }
      : { cite: tok, status: "dead", detail: "no such ledger row" }
  }

  const path = g.path
  const a = g.a ? parseInt(g.a, 10) : null
  const b = g.b ? parseInt(g.b, 10) : null
  if (a !== null && b !== null && (a < 1 || b < a))
    return { cite: tok, status: "dead", detail: "invalid line range" }

  if (g.sha) {
    const blob = git(["show", `${g.sha}:${path}`], repoRoot)
    if (blob === null) return { cite: tok, status: "dead", detail: "path unreadable at sha" }
    if (b !== null && blob.split("\n").length < b)
      return { cite: tok, status: "moved", detail: "range exceeds blob at sha" }
    return { cite: tok, status: "ok" }
  }

  // Working-tree citation: symlinks not followed; must be tracked AND clean.
  let st
  try {
    st = lstatSync(`${repoRoot}/${path}`)
  } catch {
    return { cite: tok, status: "dead", detail: "path missing" }
  }
  if (st.isSymbolicLink()) return { cite: tok, status: "dead", detail: "symlink (not followed)" }
  if (git(["ls-files", "--error-unmatch", path], repoRoot) === null)
    return { cite: tok, status: "dead", detail: "untracked" }
  const porcelain = git(["status", "--porcelain", "--", path], repoRoot)
  if (porcelain !== null && porcelain.trim() !== "")
    return { cite: tok, status: "dirty", detail: "uncommitted modifications" }
  if (b !== null) {
    const lines = readFileSync(`${repoRoot}/${path}`, "utf8").split("\n").length
    if (lines < b) return { cite: tok, status: "moved", detail: "range exceeds current file" }
  }
  return { cite: tok, status: "ok" }
}

/** Check a claim-inventory YAML file: {schema_version: 1, claims: [{claim, cite, class}]}.
 *  Unknown schema_version → every entry rejected (fail-closed). */
export function checkYamlFile(file: string, repoRoot: string): CiteResult[] {
  const doc = parseYaml(readFileSync(file, "utf8")) as {
    schema_version?: number
    claims?: Array<{ claim?: string; cite?: string }>
  } | null
  if (!doc || doc.schema_version !== SHOP_SCHEMA_VERSION)
    return [{ cite: file, status: "dead", detail: `unknown schema_version (want ${SHOP_SCHEMA_VERSION})` }]
  return (doc.claims ?? []).map((c) =>
    typeof c?.cite === "string"
      ? resolveCite(c.cite, repoRoot)
      : { cite: JSON.stringify(c ?? null), status: "dead" as CiteStatus, detail: "entry missing cite" },
  )
}

export function checkMarkdownFile(file: string, repoRoot: string): CiteResult[] {
  return extractCites(readFileSync(file, "utf8")).map((tok) => resolveCite(tok, repoRoot))
}

export function report(results: CiteResult[]): CiteReport {
  return {
    schema_version: SHOP_SCHEMA_VERSION,
    tool: "cite-check",
    pass: results.every((r) => r.status === "ok"),
    results,
  }
}

// CLI: cite-check [--yaml] <file...>   (repo root = cwd)
if (process.argv[1]?.endsWith("cite-check.ts") || process.argv[1]?.endsWith("cite-check.js")) {
  const args = process.argv.slice(2)
  const yamlMode = args[0] === "--yaml"
  const files = yamlMode ? args.slice(1) : args
  const root = process.cwd()
  const results = files.flatMap((f) => (yamlMode ? checkYamlFile(f, root) : checkMarkdownFile(f, root)))
  const rep = report(results)
  console.log(JSON.stringify(rep, null, 2))
  process.exit(rep.pass ? 0 : 1)
}
