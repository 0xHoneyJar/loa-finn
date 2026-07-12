// src/lab/shop/finn-cli.test.ts — S4 T4.1/T4.2 ACs: doctor red/green against
// planted substrate, gadgets list/show/unknown-id, probe surfacing, and the
// no-writes guarantee (static: the CLI source imports no write APIs).

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { doctor, gadgetRows, main } from "./finn-cli.js"
import { renderTable } from "./ledger-check.js"

let root: string

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
}

function writeSubstrate(opts: { probePass?: boolean; probeAbsent?: boolean; badClaim?: boolean } = {}): void {
  const rows = [
    {
      id: "gadget-x",
      what: "a thing",
      status: "KEEP",
      home: "grimoires/loa/lab/gadgets/x",
      check: { runner: "vitest", target: "grimoires/loa/lab/gadgets/x", args: [], exit: "zero-is-pass", timeout_s: 60, contract: "declared" },
      graduation: "lab-only",
    },
  ]
  writeFileSync(
    join(root, "grimoires/loa/lab/GADGETS.md"),
    `# G\n\n\`\`\`yaml\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n\n<!-- ledger-table:start -->\n${renderTable(rows as never)}\n<!-- ledger-table:end -->\n`,
  )
  writeFileSync(
    join(root, "grimoires/loa/identity/claim-inventory.yaml"),
    `schema_version: 1\nclaims:\n  - {claim: x, cite: ${opts.badClaim ? "docs/nope.md" : "docs.md"}}\n`,
  )
  if (!opts.probeAbsent) {
    writeFileSync(
      join(root, "grimoires/loa/lab/probe-results.jsonl"),
      JSON.stringify({ schema_version: 1, tool: "probe", ts: "2026-07-12T00:00:00Z", pass: opts.probePass !== false }) + "\n",
    )
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "finn-cli-"))
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  mkdirSync(join(root, "grimoires/loa/lab/gadgets/x"), { recursive: true })
  mkdirSync(join(root, "grimoires/loa/identity"), { recursive: true })
  writeFileSync(join(root, "docs.md"), "hello\n")
  writeSubstrate()
  git("add", ".")
  git("commit", "-qm", "seed")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("doctor", () => {
  it("green when substrate green (T4.1 AC+)", () => {
    writeSubstrate({ probePass: true })
    git("add", ".")
    git("commit", "-qm", "s", "--allow-empty")
    const d = doctor(root)
    expect(d.checks.identity.pass).toBe(true)
    expect(d.checks.ledger.pass).toBe(true)
    expect(d.pass).toBe(true)
  })
  it("red when a planted claim dangles (T4.1 AC−)", () => {
    writeSubstrate({ badClaim: true })
    expect(doctor(root).pass).toBe(false)
    writeSubstrate()
    git("add", ".")
    git("commit", "-qm", "restore", "--allow-empty")
  })
  it("red when no probe run recorded (T4.2 AC)", () => {
    rmSync(join(root, "grimoires/loa/lab/probe-results.jsonl"), { force: true })
    const d = doctor(root)
    expect(d.checks.probe.present).toBe(false)
    expect(d.pass).toBe(false)
  })
  it("surfaces the LAST probe result (T4.2 AC)", () => {
    writeFileSync(
      join(root, "grimoires/loa/lab/probe-results.jsonl"),
      [
        JSON.stringify({ pass: true, ts: "t1" }),
        JSON.stringify({ pass: false, ts: "t2" }),
      ].join("\n") + "\n",
    )
    const d = doctor(root)
    expect(d.checks.probe).toEqual({ present: true, pass: false, ts: "t2" })
    expect(d.pass).toBe(false)
  })
})

describe("gadgets", () => {
  it("lists rows and shows one", () => {
    expect(gadgetRows(root).map((r) => r.id)).toEqual(["gadget-x"])
    expect(main(["gadgets", "gadget-x"], root)).toBe(0)
  })
  it("unknown id → exit 2 (T4.1 AC−)", () => {
    expect(main(["gadgets", "nope"], root)).toBe(2)
    expect(main(["gadgets", "--run-check", "nope"], root)).toBe(2)
  })
  it("usage → exit 2", () => {
    expect(main([], root)).toBe(2)
  })
})

describe("no-writes guarantee (T4.1 AC−)", () => {
  it("the CLI source imports no write APIs", () => {
    const src = readFileSync(join(__dirname, "finn-cli.ts"), "utf8")
    for (const banned of ["writeFileSync", "appendFileSync", "createWriteStream", "mkdirSync", "rmSync", "unlink"]) {
      expect(src, `finn-cli.ts must not use ${banned}`).not.toContain(banned)
    }
  })
})
