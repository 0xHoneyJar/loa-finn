// src/nft/codex-data/checksums.ts — SHA-256 Checksum Utility (Sprint 1 Task 1.5)
//
// Shared checksum utility for codex artifact integrity validation.
// Reused by Tasks 7.2 and 9.0 for their checksum validation.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

/**
 * Compute SHA-256 hex digest of raw file bytes.
 */
export function computeSha256(filePath: string): string {
  const bytes = readFileSync(filePath)
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Verify that a file matches the expected SHA-256 hex string.
 * Reads raw file bytes, computes SHA-256, compares to expected hex.
 *
 * @param filePath - Path to the file to verify
 * @param expectedHex - Expected 64-char hex string
 * @returns true if the computed hash matches
 */
export function verifySha256(filePath: string, expectedHex: string): boolean {
  const actual = computeSha256(filePath)
  return actual === expectedHex.toLowerCase().trim()
}

/**
 * Read a .sha256 checksum file (plain hex string, 64 chars, no filename suffix).
 */
export function readSha256File(checksumPath: string): string {
  return readFileSync(checksumPath, "utf-8").trim().toLowerCase()
}
