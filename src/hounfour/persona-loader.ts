// src/hounfour/persona-loader.ts — Persona Loader (SDD §4.11, T-15.5)

import { readFile, lstat, realpath } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import { HounfourError } from "./errors.js"
import type { AgentBinding } from "./types.js"

// --- Injection Detection ---

const INJECTION_PATTERNS: RegExp[] = [
  // Instruction override attempts
  /ignore (all )?previous instructions/i,
  /disregard (all )?previous (instructions|context)/i,
  /new instructions:/i,
  /system: /i,

  // Role confusion
  /you are now/i,
  /act as (if you are )?a/i,
  /pretend (you are|to be)/i,

  // Delimiter injection
  /```\s*system/i,
  /<\|system\|>/i,
  /\[SYSTEM\]/i,

  // Jail-breaking patterns
  /developer mode/i,
  /sudo mode/i,
  /unrestricted/i,
]

export function detectInjection(content: string): { detected: boolean; pattern: string | null } {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return { detected: true, pattern: pattern.toString() }
    }
  }
  return { detected: false, pattern: null }
}

// --- Persona Loader ---

/**
 * Load persona content for an agent.
 *
 * @param binding - Agent binding with persona path
 * @param projectRoot - Project root directory for path resolution
 * @returns Persona content string, or null if not configured/missing
 * @throws HounfourError PERSONA_INJECTION if injection patterns detected
 */
export async function loadPersona(binding: AgentBinding, projectRoot: string): Promise<string | null> {
  if (!binding.persona) {
    return null
  }

  // Absolute paths not allowed (security: prevent reading arbitrary files)
  if (isAbsolute(binding.persona)) {
    console.error(`[hounfour] Persona path must be relative: ${binding.persona}`)
    throw new HounfourError("CONFIG_INVALID", `Persona path must be relative: ${binding.persona}`, {
      agent: binding.agent,
      persona: binding.persona,
    })
  }

  const root = resolve(projectRoot)
  const personaPath = resolve(root, binding.persona)

  // Verify resolved path is within project root (relative() check, not startsWith)
  const rel = relative(root, personaPath)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    console.error(`[hounfour] Persona path escapes project root: ${binding.persona}`)
    throw new HounfourError("CONFIG_INVALID", `Persona path escapes project root: ${binding.persona}`, {
      agent: binding.agent,
      persona: binding.persona,
    })
  }

  let content: string
  try {
    // Reject symlinks to prevent symlink traversal attacks
    const stat = await lstat(personaPath)
    if (stat.isSymbolicLink()) {
      throw new HounfourError("CONFIG_INVALID", `Persona path must not be a symlink: ${binding.persona}`, {
        agent: binding.agent,
        persona: binding.persona,
      })
    }

    // Verify real path also stays within project root
    const rootReal = await realpath(root)
    const personaReal = await realpath(personaPath)
    const relReal = relative(rootReal, personaReal)
    if (relReal.startsWith("..") || isAbsolute(relReal)) {
      throw new HounfourError("CONFIG_INVALID", `Persona real path escapes project root: ${binding.persona}`, {
        agent: binding.agent,
        persona: binding.persona,
      })
    }

    content = await readFile(personaReal, "utf-8")
  } catch (err: unknown) {
    if (err instanceof HounfourError) throw err
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`[hounfour] Persona file not found: ${personaPath} — proceeding without persona`)
      return null
    }
    throw err // Permissions or I/O errors are fatal
  }

  // Injection detection
  const result = detectInjection(content)
  if (result.detected) {
    console.error(`[hounfour] Persona injection detected in ${personaPath}: ${result.pattern}`)
    throw new HounfourError("PERSONA_INJECTION", `Injection detected in persona: ${result.pattern}`, {
      agent: binding.agent,
      persona: personaPath,
      pattern: result.pattern,
    })
  }

  return content
}
