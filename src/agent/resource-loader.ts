// src/agent/resource-loader.ts — Custom ResourceLoader that injects Loa identity (SDD §3.1.3)
// Uses DefaultResourceLoader with overrides to prevent Pi from loading AGENTS.md/.pi defaults

import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent"
import type { ResourceLoader } from "@mariozechner/pi-coding-agent"
import { readFile } from "node:fs/promises"

export interface LoaResourceLoaderOptions {
  cwd: string
  beauvoirPath: string
  notesPath?: string
  /** Override system prompt with a pre-resolved personality (Issue #138) */
  systemPromptOverride?: string
}

export async function createLoaResourceLoader(
  options: LoaResourceLoaderOptions,
): Promise<ResourceLoader> {
  // Load system prompt: use override if provided (per-NFT personality), else read BEAUVOIR.md
  let systemPrompt: string | undefined
  if (options.systemPromptOverride) {
    systemPrompt = options.systemPromptOverride
  } else {
    try {
      systemPrompt = await readFile(options.beauvoirPath, "utf-8")
      if (!systemPrompt.trim()) systemPrompt = undefined
    } catch {
      // BEAUVOIR.md doesn't exist yet, that's fine
    }
  }

  // Build context from grimoires if NOTES.md exists
  let appendPrompt: string | undefined
  if (options.notesPath) {
    try {
      const notes = await readFile(options.notesPath, "utf-8")
      if (notes.trim()) {
        appendPrompt = `\n\n## Recent Learnings\n\n${notes.slice(0, 4000)}`
      }
    } catch {
      // NOTES.md doesn't exist yet, that's fine
    }
  }

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    systemPrompt,
    appendSystemPrompt: appendPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  })

  return loader
}
