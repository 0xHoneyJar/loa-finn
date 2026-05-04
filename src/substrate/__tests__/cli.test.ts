// src/substrate/__tests__/cli.test.ts — CLI argv parsing + output protocol tests.
//
// Cycle-032 Sprint-6 Task 6.4. See PRD FR-6 + build doc §9 ALEXANDER craft.

import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgv, runCli, type CliIO } from "../cli.js"

// ── Test I/O capture ────────────────────────────────────────────────

function makeCapturingIO(opts: { isatty?: boolean } = {}): {
  io: CliIO
  stdout: string[]
  stderr: string[]
  exitCode: number | null
} {
  const stdout: string[] = []
  const stderr: string[] = []
  let exitCode: number | null = null
  const io: CliIO = {
    stdout: { write: (s) => stdout.push(s) },
    stderr: { write: (s) => stderr.push(s) },
    isatty: opts.isatty ?? false,
    exit: ((code: number) => {
      exitCode = code
      throw new ExitMarker(code)
    }) as never,
  }
  return {
    io,
    stdout,
    stderr,
    get exitCode() {
      return exitCode
    },
  } as unknown as { io: CliIO; stdout: string[]; stderr: string[]; exitCode: number | null }
}

class ExitMarker extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`)
  }
}

// ── parseArgv ───────────────────────────────────────────────────────

describe("parseArgv", () => {
  it("accepts well-formed invoke command", () => {
    const r = parseArgv(["substrate-construct", "invoke", "lore-essay-grader", "--input", "essay.json"])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command).toBe("invoke")
      expect(r.slug).toBe("lore-essay-grader")
      expect(r.inputPath).toBe("essay.json")
    }
  })

  it("accepts --input=file syntax", () => {
    const r = parseArgv(["substrate-construct", "invoke", "x", "--input=foo.json"])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.inputPath).toBe("foo.json")
  })

  it("rejects empty argv", () => {
    const r = parseArgv([])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.exitCode).toBe(64)
  })

  it("rejects unknown command", () => {
    const r = parseArgv(["bogus", "invoke"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("unknown command")
  })

  it("rejects unknown subcommand", () => {
    const r = parseArgv(["substrate-construct", "list"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("unknown subcommand")
  })

  it("rejects missing slug", () => {
    const r = parseArgv(["substrate-construct", "invoke", "--input", "x.json"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("missing <slug>")
  })

  it("rejects missing --input", () => {
    const r = parseArgv(["substrate-construct", "invoke", "myslug"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain("missing --input")
  })
})

// ── runCli ──────────────────────────────────────────────────────────

describe("runCli", () => {
  const tmp = mkdtempSync(join(tmpdir(), "substrate-cli-test-"))

  function makeInputFile(name: string, body: unknown): string {
    const p = join(tmp, name)
    writeFileSync(p, JSON.stringify(body))
    return p
  }

  it("exits 0 on APPROVED status, prints JSON to stdout", async () => {
    const inputPath = makeInputFile("essay-1.json", { essay: "x", rubric: { prompt: "p" } })
    const cap = makeCapturingIO()
    const invoke = vi.fn(async () => ({
      status: "APPROVED",
      confidence: 0.85,
      reasoning: "good",
      dimensions: { loreFit: 0.9 },
    }))

    await expect(
      runCli(["substrate-construct", "invoke", "test-slug", "--input", inputPath], cap.io, invoke),
    ).rejects.toBeInstanceOf(ExitMarker)
    expect(cap.exitCode).toBe(0)

    const stdout = cap.stdout.join("")
    expect(stdout).toContain('"status": "APPROVED"')
    expect(stdout).toContain('"confidence": 0.85')

    expect(invoke).toHaveBeenCalledWith("test-slug", { essay: "x", rubric: { prompt: "p" } })
  })

  it("exits 1 on REJECTED status", async () => {
    const inputPath = makeInputFile("essay-2.json", { essay: "y", rubric: { prompt: "p" } })
    const cap = makeCapturingIO()
    const invoke = vi.fn(async () => ({ status: "REJECTED", confidence: 0.2 }))
    await expect(runCli(["substrate-construct", "invoke", "x", "--input", inputPath], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    expect(cap.exitCode).toBe(1)
  })

  it("exits 2 on NEEDS_HUMAN status", async () => {
    const inputPath = makeInputFile("essay-3.json", { essay: "z", rubric: { prompt: "p" } })
    const cap = makeCapturingIO()
    const invoke = vi.fn(async () => ({ status: "NEEDS_HUMAN", confidence: 0.5 }))
    await expect(runCli(["substrate-construct", "invoke", "x", "--input", inputPath], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    expect(cap.exitCode).toBe(2)
  })

  it("exits 3 on invocation failure (system error)", async () => {
    const inputPath = makeInputFile("essay-4.json", { essay: "z", rubric: { prompt: "p" } })
    const cap = makeCapturingIO()
    const invoke = vi.fn(async () => {
      throw new Error("cheval crashed")
    })
    await expect(runCli(["substrate-construct", "invoke", "x", "--input", inputPath], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    expect(cap.exitCode).toBe(3)
    const stderr = cap.stderr.join("")
    expect(stderr).toContain("cheval crashed")
  })

  it("exits 3 on missing input file", async () => {
    const cap = makeCapturingIO()
    const invoke = vi.fn()
    await expect(
      runCli(["substrate-construct", "invoke", "x", "--input", "/no/such/file.json"], cap.io, invoke),
    ).rejects.toBeInstanceOf(ExitMarker)
    expect(cap.exitCode).toBe(3)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("emits human progress on stderr (Loading/Composing/Invoking)", async () => {
    const inputPath = makeInputFile("essay-5.json", {})
    const cap = makeCapturingIO()
    const invoke = vi.fn(async () => ({ status: "APPROVED" }))
    await expect(runCli(["substrate-construct", "invoke", "x", "--input", inputPath], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    const stderr = cap.stderr.join("")
    expect(stderr).toContain("Loading construct")
    expect(stderr).toContain("Composing runtime")
    expect(stderr).toContain("Invoking")
  })

  it("does NOT emit ANSI color when isatty=false (no painting pipes)", async () => {
    const inputPath = makeInputFile("essay-6.json", {})
    const cap = makeCapturingIO({ isatty: false })
    const invoke = vi.fn(async () => ({ status: "APPROVED" }))
    await expect(runCli(["substrate-construct", "invoke", "x", "--input", inputPath], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    const all = cap.stdout.join("") + cap.stderr.join("")
    expect(all).not.toContain("\x1b[")
  })

  it("emits ANSI color when isatty=true", async () => {
    const inputPath = makeInputFile("essay-7.json", {})
    const cap = makeCapturingIO({ isatty: true })
    const invoke = vi.fn(async () => ({ status: "APPROVED" }))
    await expect(runCli(["substrate-construct", "invoke", "x", "--input", inputPath], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    const stderr = cap.stderr.join("")
    expect(stderr).toContain("\x1b[32m") // green for APPROVED
    expect(stderr).toContain("\x1b[0m") // reset
  })

  it("CLI argv parse error exits 64 (EX_USAGE) without invoking", async () => {
    const cap = makeCapturingIO()
    const invoke = vi.fn()
    await expect(runCli(["bogus"], cap.io, invoke)).rejects.toBeInstanceOf(ExitMarker)
    expect(cap.exitCode).toBe(64)
    expect(invoke).not.toHaveBeenCalled()
  })

  // Cleanup tmp dir after all tests
  it("cleanup", () => {
    rmSync(tmp, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})
