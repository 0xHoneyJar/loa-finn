// src/persistence/upstream-check.ts — Startup self-check (SDD DD-1)
// Validates that upstream persistence symbols exist at boot time.

import {
  WALManager,
  createWALManager,
  CircuitBreaker,
  PersistenceError,
} from "./upstream.js"

/**
 * Validate that upstream persistence framework symbols are present.
 * Throws at boot if upstream API surface has changed.
 */
export function validateUpstreamPersistence(): void {
  const missing: string[] = []

  if (typeof WALManager !== "function") missing.push("WALManager")
  if (typeof createWALManager !== "function") missing.push("createWALManager")
  if (typeof CircuitBreaker !== "function") missing.push("CircuitBreaker")
  if (typeof PersistenceError !== "function") missing.push("PersistenceError")

  if (missing.length > 0) {
    throw new Error(
      `Upstream persistence framework validation failed. Missing symbols: ${missing.join(", ")}. ` +
      `Pin: PR #7 commit 5fd0dac. Check .claude/lib/persistence/ integrity.`
    )
  }
}
