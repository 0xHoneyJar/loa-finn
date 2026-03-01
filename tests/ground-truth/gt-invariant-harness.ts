// tests/ground-truth/gt-invariant-harness.ts — GT-derived test harness (Sprint 3 T-3.1)
//
// Loads contracts.yaml and provides typed invariant objects for GT-derived tests.
// Naming convention: test descriptions use "[INV-ID] invariant name" for traceability.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

// --- Types ---

export interface GTSource {
  file: string
  line?: number
  lines?: number[]
}

export interface GTEnforcement {
  file: string
  lines: number[]
  function: string
}

export interface GTFailure {
  detection: string
  recovery: string
  blast_radius: string
}

export interface GTInvariant {
  id: string
  name: string
  statement: string
  source: GTSource
  enforcement: GTEnforcement
  preconditions?: string[]
  postconditions?: string[]
  failure?: GTFailure
  severity: "error" | "warning" | "info"
}

export interface GTDomain {
  name: string
  description: string
  evidence: string
  invariants: GTInvariant[]
}

export interface GTContracts {
  version: string
  commit: string
  hounfour_version: string
  generated_at: string
  domains: GTDomain[]
}

// --- Loader ---

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CONTRACTS_PATH = join(__dirname, "../../grimoires/loa/ground-truth/contracts.yaml")

let _cached: GTContracts | null = null

/**
 * Load GT invariants from contracts.yaml.
 * Cached after first call for test performance.
 */
export function loadGTInvariants(): GTContracts {
  if (_cached) return _cached

  const raw = readFileSync(CONTRACTS_PATH, "utf-8")
  _cached = parse(raw) as GTContracts
  return _cached
}

/**
 * Get all invariants across all domains as a flat array.
 */
export function getAllInvariants(): GTInvariant[] {
  const contracts = loadGTInvariants()
  return contracts.domains.flatMap(d => d.invariants)
}

/**
 * Get invariant by ID (e.g., "INV-1", "WAL-SEQ", "CREDIT-SUM").
 */
export function getInvariant(id: string): GTInvariant | undefined {
  return getAllInvariants().find(inv => inv.id === id)
}

/**
 * Get all invariants for a specific domain.
 */
export function getDomainInvariants(domain: string): GTInvariant[] {
  const contracts = loadGTInvariants()
  const d = contracts.domains.find(d => d.name === domain)
  return d?.invariants ?? []
}

/**
 * Format test description with GT traceability.
 * Convention: "[INV-1] COMPLETENESS: Every finalize() returns..."
 */
export function gtTestName(inv: GTInvariant): string {
  return `[${inv.id}] ${inv.name}: ${inv.statement}`
}
