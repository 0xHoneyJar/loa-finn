// src/substrate/cli.ts — Operator CLI for substrate-construct invocation.
//
// Cycle-032 Sprint-6. See PRD FR-6 + SDD §4.10 + build doc §5.6 (ALEXANDER craft).
//
// Usage:
//   loa-finn substrate-construct invoke <slug> --input <file>
//
// Output discipline (build doc §9):
//   - stdout: JSON only (machine-parseable SubstrateStepVerdict)
//   - stderr: human progress (Loading... / Composing... / Invoking...)
//   - color-as-information: ONLY status (APPROVED green, REJECTED red, NEEDS_HUMAN yellow)
//   - silence: NO emoji, NO progress bars
//   - exit codes: 0 APPROVED · 1 REJECTED · 2 NEEDS_HUMAN · 3+ system error

import { readFile } from "node:fs/promises"

// ── Public surface (testable) ───────────────────────────────────────

export interface CliInvokeFn {
  (slug: string, input: unknown): Promise<unknown>
}

export interface CliIO {
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
  isatty: boolean
  exit: (code: number) => never
}

export interface CliVerdict {
  status?: "APPROVED" | "REJECTED" | "NEEDS_HUMAN" | string
  confidence?: number
  reasoning?: string
  dimensions?: Record<string, number>
}

// ── ANSI color helpers (color only when isatty) ─────────────────────

const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
} as const

function statusColor(status: string | undefined, isatty: boolean): string {
  if (!isatty) return ""
  switch (status) {
    case "APPROVED": return ANSI.green
    case "REJECTED": return ANSI.red
    case "NEEDS_HUMAN": return ANSI.yellow
    default: return ""
  }
}

function exitCodeForStatus(status: string | undefined): number {
  switch (status) {
    case "APPROVED": return 0
    case "REJECTED": return 1
    case "NEEDS_HUMAN": return 2
    default: return 3 // unrecognized status → system error
  }
}

// ── Argv parsing ────────────────────────────────────────────────────

export interface ParsedArgs {
  ok: true
  command: "invoke"
  slug: string
  inputPath: string
}

export interface ParseError {
  ok: false
  message: string
  exitCode: number
}

export function parseArgv(argv: string[]): ParsedArgs | ParseError {
  // Expected shape: ["substrate-construct", "invoke", "<slug>", "--input", "<file>"]
  // Tolerate flag in any position after slug.
  if (argv.length < 2) {
    return {
      ok: false,
      message: "usage: substrate-construct invoke <slug> --input <file>",
      exitCode: 64, // EX_USAGE
    }
  }
  if (argv[0] !== "substrate-construct") {
    return { ok: false, message: `unknown command "${argv[0]}"`, exitCode: 64 }
  }
  if (argv[1] !== "invoke") {
    return { ok: false, message: `unknown subcommand "${argv[1]}"`, exitCode: 64 }
  }
  if (!argv[2] || argv[2].startsWith("--")) {
    return { ok: false, message: "missing <slug> argument", exitCode: 64 }
  }
  const slug = argv[2]

  let inputPath: string | null = null
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--input") {
      inputPath = argv[i + 1] ?? null
      i++
    } else if (argv[i]!.startsWith("--input=")) {
      inputPath = argv[i]!.slice("--input=".length)
    }
  }

  if (!inputPath) {
    return { ok: false, message: "missing --input <file>", exitCode: 64 }
  }
  return { ok: true, command: "invoke", slug, inputPath }
}

// ── Main CLI entry (testable via injected I/O) ──────────────────────

export async function runCli(argv: string[], io: CliIO, invokeFn: CliInvokeFn): Promise<void> {
  const parsed = parseArgv(argv)
  if (!parsed.ok) {
    io.stderr.write(`ERROR: ${parsed.message}\n`)
    return io.exit(parsed.exitCode)
  }

  const { slug, inputPath } = parsed

  io.stderr.write(`Loading construct ${slug}...\n`)
  let input: unknown
  try {
    const text = await readFile(inputPath, "utf-8")
    input = JSON.parse(text)
  } catch (cause) {
    io.stderr.write(`ERROR: cannot read --input file ${inputPath}: ${errMsg(cause)}\n`)
    return io.exit(3)
  }

  io.stderr.write("Composing runtime...\n")
  io.stderr.write(`Invoking ${slug}...\n\n`)

  let verdict: unknown
  try {
    verdict = await invokeFn(slug, input)
  } catch (cause) {
    io.stderr.write(`\nERROR: invocation failed: ${errMsg(cause)}\n`)
    if (cause instanceof Error && cause.stack) {
      io.stderr.write(`${cause.stack}\n`)
    }
    return io.exit(3)
  }

  // Render verdict to stdout as JSON. Apply color to a single trailing
  // status indicator on stderr so the JSON stays parseable.
  io.stdout.write(JSON.stringify(verdict, null, 2) + "\n")

  const v = verdict as CliVerdict
  const color = statusColor(v.status, io.isatty)
  if (color) {
    io.stderr.write(`\nstatus: ${color}${v.status}${ANSI.reset}\n`)
  }

  return io.exit(exitCodeForStatus(v.status))
}

function errMsg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
