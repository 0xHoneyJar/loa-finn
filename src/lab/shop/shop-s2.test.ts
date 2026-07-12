// src/lab/shop/shop-s2.test.ts — Sprint 2 ACs for corpus-scrub + probe,
// negative-first: pattern miss detection, manifest hashes, missing dimension,
// missing citation class, dangling citation, unknown fixtures version.

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { scrubDir, scrubText, loadPatterns } from "./corpus-scrub.js"
import { classifyCite, loadFixtures, runProbe } from "./probe.js"

let root: string

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "shop-s2-"))
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(
    join(root, ".loa.config.yaml"),
    `flatline_protocol:\n  secret_scanning:\n    patterns:\n      - "AKIA[0-9A-Z]{16}"\n      - "ghp_[A-Za-z0-9]{36}"\n`,
  )
  mkdirSync(join(root, "grimoires/loa/lab"), { recursive: true })
  writeFileSync(join(root, "docs.md"), "hello\n")
  git("add", ".")
  git("commit", "-qm", "seed")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("corpus-scrub", () => {
  it("redacts planted secrets, writes manifest with correct hashes (T2.1 AC+)", () => {
    const dir = join(root, "intake")
    mkdirSync(dir)
    const raw = "key AKIAABCDEFGHIJKLMNOP and token ghp_" + "a".repeat(36) + "\n"
    writeFileSync(join(dir, "export.txt"), raw)
    const m = scrubDir(dir, root)
    const scrubbed = readFileSync(join(dir, "export.txt"), "utf8")
    expect(scrubbed).not.toContain("AKIA")
    expect(scrubbed).not.toContain("ghp_")
    expect(m.entries[0].redactions).toBe(2)
    const onDisk = parseYaml(readFileSync(join(dir, "manifest.yaml"), "utf8"))
    expect(onDisk.entries[0].raw_sha256).toBe(m.entries[0].raw_sha256)
    expect(m.entries[0].raw_sha256).not.toBe(m.entries[0].redacted_sha256)
  })
  it("detects a known-format secret (pattern-miss guard, T2.1 AC−)", () => {
    const pats = loadPatterns(root)
    expect(scrubText("AKIAABCDEFGHIJKLMNOP", pats).count).toBe(1)
  })
  it("refuses to scrub blind when config has no patterns", () => {
    const bare = mkdtempSync(join(tmpdir(), "bare-"))
    writeFileSync(join(bare, ".loa.config.yaml"), "x: 1\n")
    expect(() => loadPatterns(bare)).toThrow(/refusing to scrub blind/)
    rmSync(bare, { recursive: true, force: true })
  })
})

describe("probe", () => {
  const FIXTURES = `schema_version: 1
fixtures:
  - {dimension: purpose, question: what is finn for, required_citation_classes: [doc]}
  - {dimension: gadgets, question: what gadgets exist, required_citation_classes: [ledger]}
`
  beforeAll(() => {
    writeFileSync(join(root, "grimoires/loa/lab/probe-fixtures.yaml"), FIXTURES)
    // a ledger so ledger: cites resolve
    mkdirSync(join(root, "grimoires/loa/lab/gadgets/x"), { recursive: true })
    writeFileSync(
      join(root, "grimoires/loa/lab/GADGETS.md"),
      "```yaml\n- id: gadget-x\n```\n",
    )
    git("add", ".")
    git("commit", "-qm", "fixtures")
  })
  it("classifies citation classes", () => {
    expect(classifyCite("docs.md")).toBe("doc")
    expect(classifyCite("commit:abc1234")).toBe("commit")
    expect(classifyCite("ledger:gadget-x")).toBe("ledger")
  })
  it("passes a complete answer (AC+)", () => {
    const f = join(root, "answer.md")
    writeFileSync(f, "## purpose\nsee `docs.md`\n## gadgets\nsee `ledger:gadget-x`\n")
    const r = runProbe(f, root, "2026-07-12T00:00:00Z")
    expect(r.pass).toBe(true)
    expect(r.citations.failing).toBe(0)
  })
  it("fails when a dimension is missing (AC−)", () => {
    const f = join(root, "answer-missing.md")
    writeFileSync(f, "## purpose\nsee `docs.md`\n")
    expect(runProbe(f, root, "t").pass).toBe(false)
  })
  it("fails when a required citation class is absent (AC−)", () => {
    const f = join(root, "answer-class.md")
    writeFileSync(f, "## purpose\nsee `docs.md`\n## gadgets\nno ledger cite here\n")
    const r = runProbe(f, root, "t")
    expect(r.pass).toBe(false)
    expect(r.dimensions.gadgets.missing_classes).toContain("ledger")
  })
  it("fails on a dangling citation anywhere in the answer (AC−)", () => {
    const f = join(root, "answer-dangling.md")
    writeFileSync(f, "## purpose\nsee `docs.md` and `docs/nope.md`\n## gadgets\n`ledger:gadget-x`\n")
    const r = runProbe(f, root, "t")
    expect(r.pass).toBe(false)
    expect(r.citations.failing).toBe(1)
  })
  it("rejects unknown fixtures schema_version (AC−)", () => {
    writeFileSync(join(root, "grimoires/loa/lab/probe-fixtures.yaml"), "schema_version: 9\nfixtures: []\n")
    expect(() => loadFixtures(root)).toThrow(/schema_version/)
    writeFileSync(join(root, "grimoires/loa/lab/probe-fixtures.yaml"), FIXTURES)
  })
})
