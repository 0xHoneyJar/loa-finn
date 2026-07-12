// src/lab/shop/ledger-check.test.ts — T1.2 ACs, negative-first: free-string
// cmd rejected, out-of-root home rejected, duplicate ids rejected, unenrolled
// instrument fails, phantom row fails, stale table fails; --render idempotent.

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkLedger, renderTable, parseLedger } from "./ledger-check.js"

let root: string
const LEDGER = "grimoires/loa/lab/GADGETS.md"

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gadget-x",
    what: "a thing",
    status: "KEEP",
    home: "grimoires/loa/lab/gadgets/x",
    check: { runner: "vitest", target: "grimoires/loa/lab/gadgets/x", args: [], exit: "zero-is-pass", timeout_s: 60, contract: "declared" },
    graduation: "lab-only",
    ...over,
  }
}

function writeLedger(rows: unknown[], table?: string): void {
  const yaml = "```yaml\n" + JSON.stringify(rows, null, 2) + "\n```"
  const t = table ?? renderTable(rows as never)
  writeFileSync(
    join(root, LEDGER),
    `# Gadgets\n\n${yaml}\n\n<!-- ledger-table:start -->\n${t}\n<!-- ledger-table:end -->\n`,
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ledger-check-"))
  mkdirSync(join(root, "grimoires/loa/lab/gadgets/x"), { recursive: true })
  mkdirSync(join(root, "src/lab/metabolism"), { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("positive", () => {
  it("clean ledger reconciles", () => {
    writeLedger([row()])
    const rep = checkLedger(LEDGER, root)
    expect(rep.errors).toEqual([])
    expect(rep.pass).toBe(true)
  })
  it("--render is idempotent", () => {
    writeLedger([row()], "STALE")
    expect(checkLedger(LEDGER, root).pass).toBe(false)
    expect(checkLedger(LEDGER, root, { render: true }).pass).toBe(true)
    const after = readFileSync(join(root, LEDGER), "utf8")
    expect(checkLedger(LEDGER, root).pass).toBe(true)
    checkLedger(LEDGER, root, { render: true })
    expect(readFileSync(join(root, LEDGER), "utf8")).toBe(after)
  })
})

describe("negative (the ACs)", () => {
  it("rejects free-string check.cmd", () => {
    writeLedger([row({ check: { cmd: "rm -rf /", runner: "vitest", target: "src", exit: "zero-is-pass", timeout_s: 5, contract: "declared" } })])
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/free-string/)
  })
  it("rejects out-of-root home", () => {
    writeLedger([row({ home: "../../etc" })])
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/outside repo root/)
  })
  it("rejects duplicate ids", () => {
    writeLedger([row(), row()])
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/duplicate id/)
  })
  it("rejects unknown status enum", () => {
    writeLedger([row({ status: "BUILT" })])
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/closed vocab/)
  })
  it("fails on unenrolled instrument (boundary → row)", () => {
    mkdirSync(join(root, "grimoires/loa/lab/gadgets/orphan"))
    writeLedger([row()])
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/unenrolled instrument.*orphan/)
  })
  it("fails on phantom row (row → disk)", () => {
    writeLedger([row({ home: "grimoires/loa/lab/gadgets/ghost", check: { runner: "vitest", target: "grimoires/loa/lab", exit: "zero-is-pass", timeout_s: 5, contract: "declared" } })])
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/home does not exist/)
  })
  it("fails on stale rendered table", () => {
    writeLedger([row()], "old table")
    expect(checkLedger(LEDGER, root).errors.join()).toMatch(/stale/)
  })
  it("metabolism .ts modules are enumerated (tests and types excluded)", () => {
    writeFileSync(join(root, "src/lab/metabolism/solver.ts"), "x")
    writeFileSync(join(root, "src/lab/metabolism/solver.test.ts"), "x")
    writeFileSync(join(root, "src/lab/metabolism/types.ts"), "x")
    writeLedger([row()])
    const errs = checkLedger(LEDGER, root).errors.join()
    expect(errs).toMatch(/unenrolled instrument.*solver\.ts/)
    expect(errs).not.toMatch(/test|types/)
  })
})

describe("parseLedger", () => {
  it("throws without a yaml block", () => {
    writeFileSync(join(root, LEDGER), "# no block\n")
    expect(() => parseLedger(readFileSync(join(root, LEDGER), "utf8"))).toThrow(/no yaml block/)
  })
})
