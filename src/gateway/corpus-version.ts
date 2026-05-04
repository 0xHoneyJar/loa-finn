// src/gateway/corpus-version.ts — Corpus Version Header Middleware (Sprint 3 T3.3)
//
// Adds x-corpus-version response header sourced from DIXIE_REF env var.
// Fallback: "unknown" when env var is not set.

import type { Context, Next } from "hono"

/** Resolved once at module load — no per-request overhead. */
const CORPUS_VERSION = process.env.DIXIE_REF ?? "unknown"

/**
 * Hono middleware that sets x-corpus-version response header.
 * Use on /api/knowledge/* and /api/v1/oracle routes.
 */
export function corpusVersionMiddleware() {
  return async (c: Context, next: Next) => {
    await next()
    c.header("x-corpus-version", CORPUS_VERSION)
  }
}

/** Get the current corpus version string (for tests). */
export function getCorpusVersion(): string {
  return CORPUS_VERSION
}
