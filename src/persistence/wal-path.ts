// src/persistence/wal-path.ts — Canonical WAL path builder (SDD DD-13)

const VALID_PREFIXES = ["sessions", "config", "learnings", ".beads"] as const
type WalPrefix = typeof VALID_PREFIXES[number]

/**
 * Build a canonical WAL path from a prefix and segments.
 * Rejects path traversal and double separators.
 *
 * Usage: walPath("sessions", sessionId, "msg") → "sessions/<id>/msg"
 */
export function walPath(prefix: WalPrefix, ...segments: string[]): string {
  if (!VALID_PREFIXES.includes(prefix)) {
    throw new Error(`Invalid WAL prefix "${prefix}". Must be one of: ${VALID_PREFIXES.join(", ")}`)
  }

  const parts = [prefix, ...segments]

  for (const part of parts) {
    if (part.includes("..")) {
      throw new Error(`WAL path traversal rejected: "${part}"`)
    }
    if (part.includes("//")) {
      throw new Error(`WAL path double separator rejected: "${part}"`)
    }
    if (part !== prefix && !/^[a-zA-Z0-9_\-]+$/.test(part)) {
      throw new Error(`WAL path segment contains invalid characters: "${part}"`)
    }
  }

  return parts.join("/")
}
