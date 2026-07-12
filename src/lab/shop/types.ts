// src/lab/shop/types.ts — shared shapes for the shop's deterministic tools
// (cite-check · ledger-check · probe · corpus-scrub). SDD: sdd-narrative-
// historical-architecture.md §2.5/§3. Every serialized shape carries
// schema_version: 1 with closed enums; validators reject unknown versions
// (fail-closed compat).

/** The one report schema version these tools speak. */
export const SHOP_SCHEMA_VERSION = 1 as const

/** Citation resolution statuses — closed enum (SDD 2.5).
 *  ok    — resolves mechanically
 *  dead  — path/commit/row does not exist (or path is a symlink — not followed)
 *  moved — path exists but the cited line range no longer fits
 *  dirty — working-tree citation whose target has uncommitted modifications */
export type CiteStatus = "ok" | "dead" | "moved" | "dirty"

export interface CiteResult {
  cite: string
  status: CiteStatus
  detail?: string
}

export interface CiteReport {
  schema_version: typeof SHOP_SCHEMA_VERSION
  tool: "cite-check"
  pass: boolean
  results: CiteResult[]
}

/** Gadget ledger row statuses — closed vocab (PRD FR-2). Build maturity is a
 *  check-column fact, never a status. */
export type GadgetStatus = "CANDIDATE" | "KEEP" | "SELL" | "THROW"

/** Constrained check runner — closed enum; NEVER a free shell string
 *  (flatline SDD finding, injection surface closed). */
export type CheckRunner = "vitest" | "node-script" | "py-compile"

export interface GadgetCheck {
  runner: CheckRunner
  /** Must resolve INSIDE the repo root. */
  target: string
  /** argv list, no shell interpolation. */
  args?: string[]
  exit: "zero-is-pass"
  timeout_s: number
  contract: "declared" | "pending"
}

export interface GadgetRow {
  id: string
  what: string
  status: GadgetStatus
  home: string
  check: GadgetCheck
  graduation: "lab-only" | "src-imported" | "pending"
  evidence?: { commit?: string; note?: string }
  /** LOC ceiling for shop tools enrolled in their own ledger (FR-7). */
  loc_ceiling?: number
}

export interface LedgerReport {
  schema_version: typeof SHOP_SCHEMA_VERSION
  tool: "ledger-check"
  pass: boolean
  errors: string[]
  rows: number
  enumerated: number
}
