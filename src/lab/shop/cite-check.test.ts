// src/lab/shop/cite-check.test.ts — negative-first tests per sprint T1.1 ACs:
// dead / moved / dirty / symlink / unknown-schema all FAIL, distinctly.
// Uses a throwaway git repo fixture (mkdtemp) — no fixtures directory needed.

import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { checkYamlFile, extractCites, report, resolveCite } from "./cite-check.js"

let root: string
let sha: string

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cite-check-"))
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "docs/a.md"), "line1\nline2\nline3\n")
  git("add", ".")
  git("commit", "-qm", "seed")
  sha = git("rev-parse", "HEAD").trim()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("resolveCite — positive", () => {
  it("resolves a clean tracked path", () => {
    expect(resolveCite("docs/a.md", root).status).toBe("ok")
  })
  it("resolves a fitting line range", () => {
    expect(resolveCite("docs/a.md:L1-L3", root).status).toBe("ok")
  })
  it(":Ln sugar resolves as Ln-Ln (probe run #1 gap)", () => {
    expect(resolveCite("docs/a.md:L1", root).status).toBe("ok")
    expect(resolveCite("docs/a.md:L9", root).status).toBe("moved")
  })
  it("comma-list ranges stay illegal", () => {
    expect(resolveCite("docs/a.md:L1,L2-L3", root).status).toBe("dead")
  })
  it("resolves path@sha immune to later edits", () => {
    writeFileSync(join(root, "docs/a.md"), "line1\n")
    expect(resolveCite(`docs/a.md:L1-L3@${sha}`, root).status).toBe("ok")
    git("checkout", "-q", "--", "docs/a.md")
  })
  it("resolves an ancestor commit", () => {
    expect(resolveCite(`commit:${sha}`, root).status).toBe("ok")
  })
})

describe("resolveCite — negative (the ACs)", () => {
  it("dead: missing path", () => {
    expect(resolveCite("docs/nope.md", root).status).toBe("dead")
  })
  it("dead: unknown commit", () => {
    expect(resolveCite("commit:deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", root).status).toBe("dead")
  })
  it("moved: drifted range (exists, range no longer fits)", () => {
    writeFileSync(join(root, "docs/a.md"), "only\n")
    git("add", "docs/a.md")
    git("commit", "-qm", "shrink")
    expect(resolveCite("docs/a.md:L1-L3", root).status).toBe("moved")
  })
  it("dirty: uncommitted modification fails, not passes", () => {
    writeFileSync(join(root, "docs/a.md"), "only\nplus dirt\n")
    expect(resolveCite("docs/a.md", root).status).toBe("dirty")
    git("checkout", "-q", "--", "docs/a.md")
  })
  it("dead: symlink is not followed", () => {
    symlinkSync(join(root, "docs/a.md"), join(root, "docs/link.md"))
    expect(resolveCite("docs/link.md", root).status).toBe("dead")
  })
  it("dead: untracked file", () => {
    writeFileSync(join(root, "docs/untracked.md"), "x\n")
    expect(resolveCite("docs/untracked.md", root).status).toBe("dead")
  })
  it("dead: unparseable token", () => {
    expect(resolveCite("not a citation!!", root).status).toBe("dead")
  })
  it("dead: malformed citation ATTEMPT surfaces, never silently dropped (adversarial #1)", () => {
    const cites = extractCites("see `docs/design.md:L10-L20@NOT_A_SHA` for details")
    expect(cites).toEqual(["docs/design.md:L10-L20@NOT_A_SHA"])
    const rep = report(cites.map((c) => resolveCite(c, root)))
    expect(rep.pass).toBe(false)
  })
  it("moved: trailing newline does not create a phantom line (adversarial #3)", () => {
    // docs/a.md at this point is 'only\n' (1 real line)
    expect(resolveCite("docs/a.md:L2-L2", root).status).toBe("moved")
  })
  it("dead: a blob sha (treeish, not a commit) does not resolve path@sha (adversarial #4)", () => {
    const blobSha = git("rev-parse", "HEAD:docs/a.md").trim()
    const r = resolveCite(`docs/a.md@${blobSha}`, root)
    expect(r.status).toBe("dead")
    expect(r.detail).toMatch(/not a commit/)
  })
})

describe("claim-inventory YAML mode", () => {
  it("rejects unknown schema_version (fail-closed)", () => {
    const f = join(root, "inv.yaml")
    writeFileSync(f, "schema_version: 99\nclaims:\n  - {claim: x, cite: docs/a.md}\n")
    const res = checkYamlFile(f, root)
    expect(res).toHaveLength(1)
    expect(res[0].status).toBe("dead")
    expect(res[0].detail).toMatch(/schema_version/)
  })
  it("resolves entries under schema_version 1", () => {
    const f = join(root, "inv.yaml")
    writeFileSync(f, "schema_version: 1\nclaims:\n  - {claim: x, cite: docs/a.md}\n")
    expect(checkYamlFile(f, root)[0].status).toBe("ok")
  })
  it("flags an entry missing its cite", () => {
    const f = join(root, "inv.yaml")
    writeFileSync(f, "schema_version: 1\nclaims:\n  - {claim: citeless}\n")
    expect(checkYamlFile(f, root)[0].status).toBe("dead")
  })
})

describe("markdown extraction + report", () => {
  it("extracts only grammar-valid backticked tokens", () => {
    const cites = extractCites(
      "See `docs/a.md:L1-L3` and `commit:abc1234` but not `someFunction()` or `n/a`.",
    )
    expect(cites).toEqual(["docs/a.md:L1-L3", "commit:abc1234"])
  })
  it("report pass iff all ok; carries citations only (refOnly)", () => {
    const rep = report([{ cite: "docs/a.md", status: "ok" }])
    expect(rep.pass).toBe(true)
    expect(JSON.stringify(rep)).not.toContain("line1")
    expect(report([{ cite: "x", status: "dead" }]).pass).toBe(false)
  })
})
