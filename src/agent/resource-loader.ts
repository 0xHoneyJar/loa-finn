// src/agent/resource-loader.ts — Custom ResourceLoader that injects Loa identity (SDD §3.1.3)
// Uses DefaultResourceLoader with overrides to prevent Pi from loading AGENTS.md/.pi defaults

import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent"
import type { ResourceLoader } from "@mariozechner/pi-coding-agent"
import { IdentityLoader } from "./identity.js"

export interface LoaResourceLoaderOptions {
  cwd: string
  beauvoirPath: string
  notesPath?: string
}

export async function createLoaResourceLoader(
  options: LoaResourceLoaderOptions,
): Promise<ResourceLoader> {
  const identity = new IdentityLoader(options.beauvoirPath)
  const systemPrompt = await identity.load()

  // Build context from grimoires if NOTES.md exists
  let appendPrompt: string | undefined
  if (options.notesPath) {
    try {
      const { readFile } = await import("node:fs/promises")
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
    systemPrompt: systemPrompt || undefined,
    appendSystemPrompt: appendPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  })

  return loader
}
