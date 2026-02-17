// src/hounfour/knowledge-loader.ts — Knowledge source loader (SDD §3.2)
// Mirrors persona-loader.ts security model with advisory mode for curated content.

import { readFile, lstat, realpath } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import { HounfourError } from "./errors.js"
import { detectInjection } from "./persona-loader.js"
import type { KnowledgeSource, LoadedKnowledgeSource } from "./knowledge-types.js"

// Curated content prefix — advisory mode (WARN, not throw) for injection
const CURATED_PREFIX = "grimoires/oracle/"

// Frontmatter regex — minimal extraction, no YAML parser dependency
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/

function extractGeneratedDate(content: string): string | null {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return null
  const frontmatter = match[1]
  // Extract generated_date from frontmatter lines
  const dateMatch = frontmatter.match(/generated_date:\s*(.+)/)
  if (!dateMatch) return null
  return dateMatch[1].trim().replace(/^["']|["']$/g, "")
}

function isStale(generatedDateStr: string | null, maxAgeDays: number | undefined): boolean {
  if (!maxAgeDays) return false
  if (!generatedDateStr) {
    // Missing date → fail-open (not stale), log WARN
    console.warn("[hounfour] knowledge source missing generated_date — treating as fresh (fail-open)")
    return false
  }
  const date = new Date(generatedDateStr)
  if (isNaN(date.getTime())) {
    console.warn(`[hounfour] knowledge source has unparseable generated_date: "${generatedDateStr}" — treating as fresh (fail-open)`)
    return false
  }
  const ageMs = Date.now() - date.getTime()
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000
}

/**
 * Load a single knowledge source from disk with full security gates.
 * Returns null on ENOENT (caller logs WARN).
 * Throws on security violations and I/O errors.
 */
export async function loadKnowledgeSource(
  source: KnowledgeSource,
  projectRoot: string,
): Promise<LoadedKnowledgeSource | null> {
  // Gate 1: Absolute path rejection
  if (isAbsolute(source.path)) {
    throw new HounfourError("CONFIG_INVALID",
      `Knowledge source path must be relative: ${source.path}`, {
        source_id: source.id,
        path: source.path,
      })
  }

  const root = resolve(projectRoot)
  const sourcePath = resolve(root, source.path)

  // Gate 2: Path escape detection
  const rel = relative(root, sourcePath)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new HounfourError("CONFIG_INVALID",
      `Knowledge source path escapes project root: ${source.path}`, {
        source_id: source.id,
        path: source.path,
      })
  }

  let content: string
  try {
    // Gate 3: Symlink rejection on file
    const stat = await lstat(sourcePath)
    if (stat.isSymbolicLink()) {
      throw new HounfourError("CONFIG_INVALID",
        `Knowledge source must not be a symlink: ${source.path}`, {
          source_id: source.id,
          path: source.path,
        })
    }

    // Gate 4: Symlink rejection on parent (realpath escape check)
    const rootReal = await realpath(root)
    const sourceReal = await realpath(sourcePath)
    const relReal = relative(rootReal, sourceReal)
    if (relReal.startsWith("..") || isAbsolute(relReal)) {
      throw new HounfourError("CONFIG_INVALID",
        `Knowledge source real path escapes project root: ${source.path}`, {
          source_id: source.id,
          path: source.path,
        })
    }

    content = await readFile(sourceReal, "utf-8")
  } catch (err: unknown) {
    if (err instanceof HounfourError) throw err
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null // Caller logs WARN
    }
    throw err // EPERM/IO errors are fatal
  }

  // Gate 5: Injection detection
  const injection = detectInjection(content)
  if (injection.detected) {
    const isCurated = source.path.startsWith(CURATED_PREFIX)
    if (isCurated) {
      // Advisory mode: log WARN, still load the source
      console.warn(`[hounfour] Injection pattern in curated source ${source.id}: ${injection.pattern} — loading anyway (advisory)`)
    } else {
      // Hard gate: throw for non-curated sources
      throw new HounfourError("KNOWLEDGE_INJECTION",
        `Injection detected in knowledge source: ${injection.pattern}`, {
          source_id: source.id,
          path: source.path,
          pattern: injection.pattern,
        })
    }
  }

  // Token estimation (~4 chars per token)
  const tokenCount = Math.ceil(content.length / 4)

  // Freshness check
  const generatedDate = extractGeneratedDate(content)
  const stale = isStale(generatedDate, source.max_age_days)
  if (stale) {
    console.warn(`[hounfour] Knowledge source ${source.id} is stale (generated_date: ${generatedDate})`)
  }

  return {
    source,
    content,
    tokenCount,
    loadedAt: new Date(),
    stale,
  }
}
